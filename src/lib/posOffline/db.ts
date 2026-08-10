'use client'

import Dexie, { type Table } from 'dexie'
import type { OutboxReturn, OutboxSale } from './types'
import type { TillProduct } from '../site/tillSearch'

/**
 * The till's local database.
 *
 * ── ONE DATABASE PER SITE ─────────────────────────────────────────────────
 *
 * `odyssey-pos-{siteId}`, not one shared database with a siteId column. A machine
 * that switches shops must not be able to mix catalogs, and — far worse — must not
 * be able to mix OUTBOXES: an unsynced sale flushed against the wrong site posts
 * real money into somebody else's books. Separate databases make that impossible
 * rather than merely unlikely.
 *
 * ── THE OUTBOX RULE ───────────────────────────────────────────────────────
 *
 * A `pending` row is a sale that HAPPENED. The customer has the goods and the
 * drawer has the cash; the only record of it is here. So:
 *
 *   · nothing ever deletes a pending row — not a version upgrade, not a prune,
 *     not a "clear cache" convenience;
 *   · `synced` rows are deletable, because the server has them;
 *   · every future schema version gets an `upgrade()` that may drop synced rows
 *     and must not touch pending ones.
 *
 * The reference POS learned this the hard way: two of its early migrations dropped
 * rows by status, and getting that predicate backwards loses a real sale off the
 * floor with nothing to reconstruct it from.
 *
 * ── WHY THE CATALOG IS HERE TOO ───────────────────────────────────────────
 *
 * Products, departments, tenders and specials are a CACHE — losing them costs a
 * catalog refresh and nothing else. They share the database so one `open()` gets
 * everything, and so a site switch drops the cache and the queue together.
 */

/** A singleton, keyed. Holds the catalog cursor, the operator, settings, terminal. */
export type KvRow = { key: string; value: unknown }

/**
 * A basket parked while the till had no network.
 *
 * NOT an outbox row — it is not a sale. Nobody has paid, no number has been issued
 * and nothing needs to reach the books; it is a shopping basket set aside so the
 * next customer can be served. Which is also why it may safely be deleted once
 * recalled, unlike a pending sale.
 *
 * It gets its own table rather than a `kv` document because a till parks several at
 * once and each is recalled individually.
 */
export type LocalParkedSale = {
  /** Client-generated. Never collides with a server document id, which is numeric. */
  uid: string
  parkedAt: string
  customerId: number | null
  customerName: string
  customerVatNo: string | null
  customerPhone: string | null
  priceStructureId: number | null
  /** The basket, in the same shape an offline sale's lines take. */
  lines: unknown[]
  /** For the list: "2 items · R40.50" without rehydrating the basket. */
  itemCount: number
  totalIncl: number
}

export class PosDatabase extends Dexie {
  products!: Table<TillProduct, number>
  outbox!: Table<OutboxSale, string>
  parked!: Table<LocalParkedSale, string>
  returns!: Table<OutboxReturn, string>
  kv!: Table<KvRow, string>

  constructor(siteId: number) {
    super(`odyssey-pos-${siteId}`)

    /*
     * Version 1.
     *
     * Only what phase 4 actually uses. Departments, tenders, specials and
     * customers ride in `kv` as single documents rather than as tables: they are
     * read whole on every load and never queried by field, so an indexed table
     * would buy nothing and cost a migration each time their shape changed.
     *
     * `products` IS a table — it is 20,000 rows queried by code and barcode, which
     * is exactly what an index is for.
     */
    this.version(1).stores({
      // `code` and `barcode` are what a scan looks up. Not unique: a shop with two
      // rows sharing a barcode is a data problem the till must survive rather than
      // refuse to open for.
      products: 'id, code, barcode, departmentId',
      // Indexed on status so the sync engine can find pending rows without reading
      // the whole outbox, and on takenAt because it flushes OLDEST FIRST.
      outbox: 'saleUid, status, takenAt',
      kv: 'key',
    })

    /*
     * Version 2 — parked baskets.
     *
     * An additive version: it declares the new table and RESTATES the existing ones
     * unchanged, which is how Dexie versions work. No `upgrade()` because nothing
     * needs transforming — and note what this deliberately does not do: it does not
     * touch `outbox`. Every future version must keep that property. A pending row is
     * a sale that happened and the only record of it, so a version bump that dropped
     * one would lose real money off the shop floor.
     */
    this.version(2).stores({
      products: 'id, code, barcode, departmentId',
      outbox: 'saleUid, status, takenAt',
      // Ordered by when it was set aside, which is how the recall list reads.
      parked: 'uid, parkedAt',
      kv: 'key',
    })

    /*
     * Version 3 — returns taken offline.
     *
     * Its OWN table rather than a kind flag on `outbox`, and the reason is the
     * flush: sales and returns post through different server functions in a fixed
     * order (sales first — see the sync route), so a single mixed table would have
     * every read filtering by kind and the ordering rule would live in the client
     * instead of on the server where it belongs.
     *
     * Same indexes and the same reasoning as `outbox`: `status` so the engine finds
     * pending rows without reading the table, `takenAt` because returns flush oldest
     * first too.
     *
     * Additive, and it does not touch `outbox` or `returns` destructively — the
     * invariant from version 2 now covers both. A pending return is the only record
     * that money left the drawer.
     */
    this.version(3).stores({
      products: 'id, code, barcode, departmentId',
      outbox: 'saleUid, status, takenAt',
      parked: 'uid, parkedAt',
      returns: 'returnUid, status, takenAt',
      kv: 'key',
    })
  }
}

/* ── One instance per site, reused ───────────────────────────────────────── */

const open = new Map<number, PosDatabase>()

/**
 * The database for one site.
 *
 * Cached because Dexie's `open()` is not free and a new instance per call would
 * leak connections. Keyed by site so switching shops opens a different database
 * rather than reusing the first one under a new name.
 */
export function posDb(siteId: number): PosDatabase {
  const existing = open.get(siteId)
  if (existing) return existing
  const db = new PosDatabase(siteId)
  open.set(siteId, db)
  return db
}

/**
 * Whether IndexedDB is usable at all.
 *
 * Private browsing and locked-down kiosk profiles can have `indexedDB` present but
 * throw on open. Checked rather than assumed so the till can say "this machine
 * cannot trade offline" on the screen instead of failing at the moment the network
 * drops, which is the worst possible time to discover it.
 */
export async function offlineStorageWorks(siteId: number): Promise<boolean> {
  try {
    const db = posDb(siteId)
    await db.open()
    return true
  } catch {
    return false
  }
}

/* ── kv helpers ──────────────────────────────────────────────────────────── */

export async function kvGet<T>(siteId: number, key: string): Promise<T | null> {
  try {
    const row = await posDb(siteId).kv.get(key)
    return (row?.value as T | undefined) ?? null
  } catch {
    // A read failure is a missing value, not an error worth propagating: every
    // caller's fallback is "fetch it from the server", which is correct anyway.
    return null
  }
}

export async function kvPut(siteId: number, key: string, value: unknown): Promise<void> {
  await posDb(siteId).kv.put({ key, value })
}

/** The keys `kv` holds, named so a typo is a compile error rather than a null. */
export const KV = {
  /** { cursor, fullLoadedAt, productCount, schemaVersion } */
  catalogMeta: 'catalogMeta',
  /** The signed-in operator: { userId, name, capabilities, expiresAt } */
  operator: 'operator',
  /** Which till this machine is: { id, code, tillNumber } */
  terminal: 'terminal',
  /** This till's own invoice counter: { prefix, storeNumber, tillNumber, padding, counter } */
  numberSeq: 'numberSeq',
  /** Store settings the till needs offline — VAT rounding, barcode config. */
  settings: 'settings',
  /** Departments, flat with parent ids. */
  departments: 'departments',
  /** Tender types, whole. */
  tenders: 'tenders',
  /** Live specials, windows UNevaluated — the till re-checks against its clock. */
  specials: 'specials',
  /** Operators who may sign in here, with their verifiers. */
  operators: 'operators',
  /** The shift to bank into. */
  shift: 'shift',
  /** The shop's own till buttons, so an offline reload still opens on them. */
  quickKeys: 'quickKeys',
  /** Captions the keys fall back to: { products: {}, departments: {} }. */
  quickKeyNames: 'quickKeyNames',
} as const
