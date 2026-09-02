'use client'

import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite'
import type { TillProduct } from '../site/tillSearch'
import type { LocalDraft, LocalParkedSale } from './db'
import type { PosStore } from './store'
import type { OutboxReturn, OutboxSale } from './types'

/**
 * The Android till's store: a real file, not a browser's to discard.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * An Android WebView may evict IndexedDB under storage pressure, and a pending
 * outbox row is a sale that HAPPENED — the customer has the goods, the drawer
 * has the cash, and this is the only record. `docs/plans/android-till-sqlite.md`
 * carries the whole argument. Nothing else about the till changes: this answers
 * the same `PosStore` questions `dexieStore` does, and the conformance suite
 * asks both the same things.
 *
 * ── DOCUMENTS, WITH THE QUERIED FIELDS PROMOTED ───────────────────────────
 *
 * Every row is stored as JSON in a `doc` column, with only the fields something
 * actually queries lifted into real columns beside it. That is not laziness, it
 * is how the two stores stay honest with each other: Dexie stores whole objects
 * and hands them back unchanged, so a shredded relational schema here would mean
 * two different ideas of what a row IS, and a `TillProduct` that gained a field
 * would round-trip on one engine and lose it on the other.
 *
 * `TillProduct` alone carries pricing, tax, stock and a dozen basket flags. None
 * of it is the store's business. The store is asked to put a row away and give
 * it back.
 *
 * The one shape that cannot ride in the document is `barcodes` — Dexie indexes
 * it multi-entry, so an alias resolves like a primary barcode. That becomes its
 * own table, which is what a multi-entry index is.
 *
 * ── WAL, AND AN FSYNC PER SALE ────────────────────────────────────────────
 *
 * `journal_mode=WAL` for concurrency, and `synchronous=FULL` because the whole
 * point of this file is a sale that survives whatever happens next. A till is
 * not a benchmark; one fsync per sale is a trade worth making every time.
 */

const sqlite = new SQLiteConnection(CapacitorSQLite)

/**
 * One connection per site, held.
 *
 * ⚠ Keyed by site, exactly as `posDb` is. A machine that switches shops must not
 * be able to mix two catalogs or — far worse — two OUTBOXES, which would flush a
 * sale into another company's books.
 */
const connections = new Map<number, Promise<SQLiteDBConnection>>()

/** Hyphens are legal in a filename but noisy in SQL; the site id is the key. */
const dbName = (siteId: number) => `odyssey_pos_${siteId < 0 ? 'x' + Math.abs(siteId) : siteId}`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  code          TEXT,
  barcode       TEXT,
  department_id INTEGER,
  parent_id     INTEGER,
  description   TEXT,
  stock_on_hand REAL,
  doc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_code ON products (code);
CREATE INDEX IF NOT EXISTS products_barcode ON products (barcode);
CREATE INDEX IF NOT EXISTS products_department ON products (department_id);
CREATE INDEX IF NOT EXISTS products_parent ON products (parent_id);

/* The multi-entry 'barcodes' index, as its own table. */
CREATE TABLE IF NOT EXISTS product_aliases (
  product_id INTEGER NOT NULL,
  barcode    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aliases_barcode ON product_aliases (barcode);
CREATE INDEX IF NOT EXISTS aliases_product ON product_aliases (product_id);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

/* A pending row here is money. Nothing in this file deletes one. */
CREATE TABLE IF NOT EXISTS outbox (
  sale_uid  TEXT PRIMARY KEY,
  status    TEXT NOT NULL,
  taken_at  TEXT,
  synced_at TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status);
CREATE INDEX IF NOT EXISTS outbox_taken ON outbox (taken_at);

CREATE TABLE IF NOT EXISTS returns (
  return_uid TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  taken_at   TEXT,
  synced_at  TEXT,
  doc        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS returns_status ON returns (status);

CREATE TABLE IF NOT EXISTS parked (
  uid       TEXT PRIMARY KEY,
  parked_at TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parked_at ON parked (parked_at);

CREATE TABLE IF NOT EXISTS drafts (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
`

async function connect(siteId: number): Promise<SQLiteDBConnection> {
  const existing = connections.get(siteId)
  if (existing) return existing

  const opening = (async () => {
    const name = dbName(siteId)
    /* A connection may survive a reload of the page that made it, so adopt one
       rather than failing on "already exists" — which would leave a till unable
       to open its own database after a refresh. */
    const already = await sqlite.isConnection(name, false)
    const db = already.result
      ? await sqlite.retrieveConnection(name, false)
      : await sqlite.createConnection(name, false, 'no-encryption', 1, false)
    await db.open()
    await db.execute('PRAGMA journal_mode=WAL;')
    await db.execute('PRAGMA synchronous=FULL;')
    await db.execute(SCHEMA)
    return db
  })()

  connections.set(siteId, opening)
  try {
    return await opening
  } catch (err) {
    /* Never cache a failed open: the next call must be able to try again, or a
       transient failure at startup would leave the till permanently storeless. */
    connections.delete(siteId)
    throw err
  }
}

/* ── Row mapping ─────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>

const rowsOf = (res: { values?: unknown[] }): Row[] => (res.values ?? []) as Row[]
const docOf = <T>(row: Row): T => JSON.parse(String(row.doc)) as T
const docsOf = <T>(res: { values?: unknown[] }): T[] => rowsOf(res).map((r) => docOf<T>(r))
const firstDoc = <T>(res: { values?: unknown[] }): T | undefined => {
  const rows = rowsOf(res)
  return rows.length > 0 ? docOf<T>(rows[0]) : undefined
}

/** The statements that write one product row and its aliases. */
function productWrites(p: TillProduct): { statement: string; values: unknown[] }[] {
  const aliases = Array.isArray((p as unknown as { barcodes?: unknown }).barcodes)
    ? ((p as unknown as { barcodes: unknown[] }).barcodes as unknown[])
    : []
  return [
    {
      statement:
        'INSERT OR REPLACE INTO products (id, code, barcode, department_id, parent_id, description, stock_on_hand, doc) VALUES (?,?,?,?,?,?,?,?)',
      values: [
        p.id,
        p.code ?? null,
        p.barcode ?? null,
        p.departmentId ?? null,
        p.parentId ?? null,
        p.description ?? null,
        p.stockOnHand ?? null,
        JSON.stringify(p),
      ],
    },
    { statement: 'DELETE FROM product_aliases WHERE product_id = ?', values: [p.id] },
    ...aliases.map((code) => ({
      statement: 'INSERT INTO product_aliases (product_id, barcode) VALUES (?,?)',
      values: [p.id, String(code)],
    })),
  ]
}

/* ── The store ───────────────────────────────────────────────────────────── */

export function sqliteStore(siteId: number): PosStore {
  const db = () => connect(siteId)

  return {
    async applyCatalog({ full, products, deletedIds, kv }) {
      const d = await db()
      const set: { statement: string; values: unknown[] }[] = []

      if (full) {
        set.push({ statement: 'DELETE FROM products', values: [] })
        set.push({ statement: 'DELETE FROM product_aliases', values: [] })
      } else if (deletedIds.length > 0) {
        for (const id of deletedIds) {
          set.push({ statement: 'DELETE FROM products WHERE id = ?', values: [id] })
          set.push({ statement: 'DELETE FROM product_aliases WHERE product_id = ?', values: [id] })
        }
      }
      for (const p of products) set.push(...productWrites(p))
      for (const row of kv) {
        set.push({
          statement: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)',
          values: [row.key, JSON.stringify(row.value ?? null)],
        })
      }

      /* One transaction for the lot. A full load that half-applied would leave a
         cashier with part of a shop and no way to tell. */
      if (set.length > 0) await d.executeSet(set, true)
    },

    async productCount() {
      const res = await (await db()).query('SELECT COUNT(*) AS n FROM products')
      return Number(rowsOf(res)[0]?.n ?? 0)
    },

    async productById(id) {
      const res = await (await db()).query('SELECT doc FROM products WHERE id = ? LIMIT 1', [id])
      return firstDoc<TillProduct>(res)
    },

    async productByBarcode(code) {
      const res = await (await db()).query('SELECT doc FROM products WHERE barcode = ? LIMIT 1', [code])
      return firstDoc<TillProduct>(res)
    },

    async productByAlias(code) {
      const res = await (await db()).query(
        'SELECT p.doc AS doc FROM product_aliases a JOIN products p ON p.id = a.product_id WHERE a.barcode = ? LIMIT 1',
        [code],
      )
      return firstDoc<TillProduct>(res)
    },

    async productByCode(code) {
      const res = await (await db()).query('SELECT doc FROM products WHERE code = ? LIMIT 1', [code])
      return firstDoc<TillProduct>(res)
    },

    async productsByDepartments(ids) {
      if (ids.length === 0) return []
      const holes = ids.map(() => '?').join(',')
      const res = await (await db()).query(
        `SELECT doc FROM products WHERE department_id IN (${holes})`,
        ids,
      )
      return docsOf<TillProduct>(res)
    },

    async productsByParent(parentId) {
      const res = await (await db()).query('SELECT doc FROM products WHERE parent_id = ?', [parentId])
      return docsOf<TillProduct>(res)
    },

    async productsByCodePrefix(prefix, limit) {
      /* LIKE is case-insensitive for ASCII in SQLite, which is what Dexie's
         startsWithIgnoreCase gives. The escape keeps a code containing % or _
         from turning into a wildcard search. */
      const res = await (await db()).query(
        "SELECT doc FROM products WHERE code LIKE ? ESCAPE '\\' LIMIT ?",
        [escapeLike(prefix) + '%', limit],
      )
      return docsOf<TillProduct>(res)
    },

    async productsByDescription(needle, limit, exclude) {
      if (limit <= 0) return []
      const res = await (await db()).query(
        "SELECT id, doc FROM products WHERE description LIKE ? ESCAPE '\\' LIMIT ?",
        ['%' + escapeLike(needle) + '%', limit + exclude.size],
      )
      const out: TillProduct[] = []
      for (const row of rowsOf(res)) {
        if (exclude.has(Number(row.id))) continue
        out.push(docOf<TillProduct>(row))
        if (out.length >= limit) break
      }
      return out
    },

    async adjustStock(deltas) {
      if (deltas.length === 0) return
      const d = await db()
      /* Read and write inside ONE transaction, so a sale landing mid-flight
         cannot be lost between the read and the write. */
      await d.beginTransaction()
      try {
        for (const delta of deltas) {
          const res = await d.query('SELECT doc FROM products WHERE id = ? LIMIT 1', [delta.productId])
          const product = firstDoc<TillProduct>(res)
          if (!product) continue
          const next = { ...product, stockOnHand: product.stockOnHand - delta.qty }
          for (const w of productWrites(next)) await d.run(w.statement, w.values, false)
        }
        await d.commitTransaction()
      } catch (err) {
        await d.rollbackTransaction().catch(() => {})
        throw err
      }
    },

    async kvGet<T>(key: string): Promise<T | null> {
      try {
        const res = await (await db()).query('SELECT value FROM kv WHERE key = ? LIMIT 1', [key])
        const rows = rowsOf(res)
        if (rows.length === 0) return null
        return JSON.parse(String(rows[0].value)) as T
      } catch {
        /* A read failure is a missing value, exactly as on Dexie: every caller's
           fallback is "ask the server", which is right anyway. */
        return null
      }
    },

    async kvPut(key, value) {
      await (await db()).run('INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)', [
        key,
        JSON.stringify(value ?? null),
      ])
    },

    async outboxPut(entry) {
      await (await db()).run(
        'INSERT OR REPLACE INTO outbox (sale_uid, status, taken_at, synced_at, doc) VALUES (?,?,?,?,?)',
        [entry.saleUid, entry.status, entry.takenAt, entry.syncedAt ?? null, JSON.stringify(entry)],
      )
    },

    async outboxGet(saleUid) {
      const res = await (await db()).query('SELECT doc FROM outbox WHERE sale_uid = ? LIMIT 1', [saleUid])
      return firstDoc<OutboxSale>(res)
    },

    async outboxUpdate(saleUid, changes) {
      const d = await db()
      const res = await d.query('SELECT doc FROM outbox WHERE sale_uid = ? LIMIT 1', [saleUid])
      const row = firstDoc<OutboxSale>(res)
      if (!row) return
      const next = { ...row, ...changes }
      await d.run(
        'INSERT OR REPLACE INTO outbox (sale_uid, status, taken_at, synced_at, doc) VALUES (?,?,?,?,?)',
        [next.saleUid, next.status, next.takenAt, next.syncedAt ?? null, JSON.stringify(next)],
      )
    },

    async outboxPending(limit) {
      const res = await (await db()).query(
        "SELECT doc FROM outbox WHERE status = 'pending' ORDER BY taken_at ASC LIMIT ?",
        [limit],
      )
      return docsOf<OutboxSale>(res)
    },

    async outboxRecent() {
      const res = await (await db()).query('SELECT doc FROM outbox ORDER BY taken_at DESC')
      return docsOf<OutboxSale>(res)
    },

    async outboxCount(status) {
      const res = await (await db()).query('SELECT COUNT(*) AS n FROM outbox WHERE status = ?', [status])
      return Number(rowsOf(res)[0]?.n ?? 0)
    },

    async outboxDropPending(saleUid) {
      const d = await db()
      /* The status test is in the statement, not around it: a sale the server
         already has must not be droppable, and a check-then-delete could be
         overtaken by a sync in between. */
      const res = await d.run("DELETE FROM outbox WHERE sale_uid = ? AND status = 'pending'", [saleUid])
      return Number(res.changes?.changes ?? 0) > 0
    },

    async outboxCancelledUnsynced(limit) {
      const res = await (await db()).query(
        "SELECT doc FROM outbox WHERE status = 'cancelled' AND synced_at IS NULL LIMIT ?",
        [limit],
      )
      return docsOf<OutboxSale>(res)
    },

    async outboxCancelledUnsyncedCount() {
      const res = await (await db()).query(
        "SELECT COUNT(*) AS n FROM outbox WHERE status = 'cancelled' AND synced_at IS NULL",
      )
      return Number(rowsOf(res)[0]?.n ?? 0)
    },

    async outboxPruneSynced(before) {
      /* `status = 'synced'` is not decoration. A pending row is the only record
         of money taken, and no cutoff may reach one. */
      const res = await (await db()).run(
        "DELETE FROM outbox WHERE status = 'synced' AND IFNULL(synced_at, '') < ?",
        [before],
      )
      return Number(res.changes?.changes ?? 0)
    },

    async returnPut(entry) {
      await (await db()).run(
        'INSERT OR REPLACE INTO returns (return_uid, status, taken_at, synced_at, doc) VALUES (?,?,?,?,?)',
        [entry.returnUid, entry.status, entry.takenAt, entry.syncedAt ?? null, JSON.stringify(entry)],
      )
    },

    async returnUpdate(returnUid, changes) {
      const d = await db()
      const res = await d.query('SELECT doc FROM returns WHERE return_uid = ? LIMIT 1', [returnUid])
      const row = firstDoc<OutboxReturn>(res)
      if (!row) return
      const next = { ...row, ...changes }
      await d.run(
        'INSERT OR REPLACE INTO returns (return_uid, status, taken_at, synced_at, doc) VALUES (?,?,?,?,?)',
        [next.returnUid, next.status, next.takenAt, next.syncedAt ?? null, JSON.stringify(next)],
      )
    },

    async returnPending(limit) {
      const res = await (await db()).query(
        "SELECT doc FROM returns WHERE status = 'pending' ORDER BY taken_at ASC LIMIT ?",
        [limit],
      )
      return docsOf<OutboxReturn>(res)
    },

    async returnCount(status) {
      const res = await (await db()).query('SELECT COUNT(*) AS n FROM returns WHERE status = ?', [status])
      return Number(rowsOf(res)[0]?.n ?? 0)
    },

    async returnPruneSynced(before) {
      const res = await (await db()).run(
        "DELETE FROM returns WHERE status = 'synced' AND IFNULL(synced_at, '') < ?",
        [before],
      )
      return Number(res.changes?.changes ?? 0)
    },

    async parkedPut(row) {
      await (await db()).run('INSERT OR REPLACE INTO parked (uid, parked_at, doc) VALUES (?,?,?)', [
        row.uid,
        row.parkedAt,
        JSON.stringify(row),
      ])
    },

    async parkedList() {
      const res = await (await db()).query('SELECT doc FROM parked ORDER BY parked_at DESC')
      return docsOf<LocalParkedSale>(res)
    },

    async parkedCount() {
      const res = await (await db()).query('SELECT COUNT(*) AS n FROM parked')
      return Number(rowsOf(res)[0]?.n ?? 0)
    },

    async parkedDelete(uid) {
      await (await db()).run('DELETE FROM parked WHERE uid = ?', [uid])
    },

    async recallParked(uid) {
      const d = await db()
      /* Read and delete as one step. Two taps on the same row must not both come
         back with a basket — that puts it on two screens and lets it be sold
         twice. The DELETE reports whether this call was the one that won. */
      await d.beginTransaction()
      try {
        const res = await d.query('SELECT doc FROM parked WHERE uid = ? LIMIT 1', [uid])
        const row = firstDoc<LocalParkedSale>(res)
        if (!row) {
          await d.commitTransaction()
          return null
        }
        const del = await d.run('DELETE FROM parked WHERE uid = ?', [uid], false)
        await d.commitTransaction()
        return Number(del.changes?.changes ?? 0) > 0 ? row : null
      } catch (err) {
        await d.rollbackTransaction().catch(() => {})
        throw err
      }
    },

    async draftPut(row) {
      await (await db()).run('INSERT OR REPLACE INTO drafts (key, doc) VALUES (?,?)', [
        row.key,
        JSON.stringify(row),
      ])
    },

    async draftGet(key) {
      const res = await (await db()).query('SELECT doc FROM drafts WHERE key = ? LIMIT 1', [key])
      return firstDoc<LocalDraft>(res)
    },

    async draftDelete(key) {
      await (await db()).run('DELETE FROM drafts WHERE key = ?', [key])
    },

    async storageWorks() {
      try {
        await db()
        return true
      } catch {
        return false
      }
    },
  }
}

/** Keeps a % or _ inside a code from becoming a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

/**
 * Whether this machine can use SQLite at all.
 *
 * A real open, not a user-agent test: the same bundle runs in Chrome against the
 * same site, and a till that decided by user agent would try to open a plugin
 * that is not there. Asked once and remembered by `posStore`.
 */
export async function sqliteAvailable(siteId: number): Promise<boolean> {
  try {
    await connect(siteId)
    return true
  } catch {
    return false
  }
}
