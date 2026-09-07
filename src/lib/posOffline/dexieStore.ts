'use client'

import type { TillProduct } from '../site/tillSearch'
import { posDb, type KvRow, type LocalDraft, type LocalParkedSale } from './db'
import type { PosStore } from './store'
import type { OutboxMovement, OutboxReturn, OutboxSale, OutboxShift } from './types'
import type { OfflineCustomer } from '../site/tillCustomers'

/**
 * The IndexedDB store, behind `PosStore`.
 *
 * ── THIS FILE MOVED CODE, IT DID NOT WRITE ANY ────────────────────────────
 *
 * Every query below is the one that was inline in `catalog.ts`, `sync.ts`,
 * `cancelOffline.ts`, `parkOffline.ts` or `draftOffline.ts` before the port
 * existed, carried across unchanged. That is deliberate and worth stating: the
 * point of the first pass is that a till behaves EXACTLY as it did, so that
 * when the SQLite store lands beside it, any difference in behaviour is the new
 * store's doing and not a rewrite's.
 *
 * So the odd-looking things are odd on purpose:
 *
 *   · `sortBy` then `slice` rather than `limit`, in the pending queues. Dexie
 *     cannot order by one field while filtering on another index, and the
 *     ordering is what matters — a queue that flushed out of order would put a
 *     shop's takings on the books in the wrong sequence.
 *   · `.catch(() => undefined)` on the `barcodes` lookup, because that index is
 *     multi-entry and a till that has never stored an alias throws rather than
 *     missing.
 *   · `kvGet` swallowing read failures. Every caller's fallback is "ask the
 *     server", which is the right answer anyway.
 *
 * If any of those look wrong, they are questions about the original code and
 * should be changed there — in BOTH stores at once, and with a reason.
 */
export function dexieStore(siteId: number): PosStore {
  const db = () => posDb(siteId)

  return {
    /* ── Catalog ──────────────────────────────────────────────────────── */

    async applyCatalog({
      full,
      products,
      deletedIds,
      customersSent = false,
      customers = [],
      closedCustomerIds = [],
      kv,
    }) {
      const d = db()
      await d.transaction('rw', d.products, d.customers, d.kv, async () => {
        if (full) {
          await d.products.clear()
          await d.products.bulkPut(products)
        } else {
          if (products.length > 0) await d.products.bulkPut(products)
          if (deletedIds.length > 0) await d.products.bulkDelete(deletedIds)
        }
        /* Guarded on `customersSent`, not on `customers.length`. A full load from
           a server that sent no customer file at all must leave the table alone;
           clearing it on an empty array would empty the book every time a till on
           this build talked to a server on the old one. */
        if (customersSent) {
          if (full) {
            await d.customers.clear()
            await d.customers.bulkPut(customers)
          } else {
            if (customers.length > 0) await d.customers.bulkPut(customers)
            if (closedCustomerIds.length > 0) await d.customers.bulkDelete(closedCustomerIds)
          }
        }
        await d.kv.bulkPut(kv as KvRow[])
      })
    },

    productCount() {
      return db().products.count()
    },

    productById(id) {
      return db().products.get(id)
    },

    productByBarcode(code) {
      return db().products.where('barcode').equals(code).first()
    },

    productByAlias(code) {
      /* Multi-entry index: absent on a till that has never stored an alias,
         where Dexie throws rather than returning nothing. */
      return db()
        .products.where('barcodes')
        .equals(code)
        .first()
        .catch(() => undefined)
    },

    productByCode(code) {
      return db().products.where('code').equals(code).first()
    },

    productsByDepartments(ids) {
      return db().products.where('departmentId').anyOf(ids).toArray()
    },

    productsByParent(parentId) {
      return db().products.where('parentId').equals(parentId).toArray()
    },

    productsByCodePrefix(prefix, limit) {
      return db().products.where('code').startsWithIgnoreCase(prefix).limit(limit).toArray()
    },

    productsByDescription(needle, limit, exclude) {
      const lowered = needle.toLowerCase()
      return db()
        .products.filter(
          (p: TillProduct) =>
            !exclude.has(p.id) && p.description.toLowerCase().includes(lowered),
        )
        .limit(limit)
        .toArray()
    },

    async adjustStock(deltas) {
      const d = db()
      await d.transaction('rw', d.products, async () => {
        for (const delta of deltas) {
          const product = await d.products.get(delta.productId)
          if (!product) continue
          await d.products.put({ ...product, stockOnHand: product.stockOnHand - delta.qty })
        }
      })
    },

    /* ── Customers ────────────────────────────────────────────────────── */

    customerCount() {
      return db().customers.count()
    },

    customerById(id) {
      return db().customers.get(id)
    },

    customerByCode(code) {
      return db().customers.where('code').equalsIgnoreCase(code).first()
    },

    customerSearch(needle, limit) {
      const lowered = needle.toLowerCase()
      /* A scan, and knowingly. Dexie can only use an index for a PREFIX, and the
         server matches the middle of a name — so an indexed query here would
         find a different set of people than the same search box does online,
         which is a worse failure than a scan of a book capped at 20,000 rows. */
      return db()
        .customers.filter(
          (c: OfflineCustomer) =>
            c.code.toLowerCase().includes(lowered) ||
            c.name.toLowerCase().includes(lowered) ||
            (c.phone ?? '').toLowerCase().includes(lowered),
        )
        .limit(limit)
        .toArray()
    },

    customerFirstPage(limit) {
      /* `name` is indexed, so this is an ordered cursor rather than a sort. */
      return db().customers.orderBy('name').limit(limit).toArray()
    },

    /* ── kv ───────────────────────────────────────────────────────────── */

    async kvGet<T>(key: string): Promise<T | null> {
      try {
        const row = await db().kv.get(key)
        return (row?.value as T | undefined) ?? null
      } catch {
        return null
      }
    },

    async kvPut(key, value) {
      await db().kv.put({ key, value })
    },

    /* ── Outbox ───────────────────────────────────────────────────────── */

    async outboxPut(entry) {
      await db().outbox.put(entry)
    },

    outboxGet(saleUid) {
      return db().outbox.get(saleUid)
    },

    async outboxUpdate(saleUid, changes) {
      await db().outbox.update(saleUid, changes)
    },

    outboxPending(limit) {
      return db()
        .outbox.where('status')
        .equals('pending')
        .sortBy('takenAt')
        .then((rows: OutboxSale[]) => rows.slice(0, limit))
    },

    outboxRecent() {
      return db().outbox.orderBy('takenAt').reverse().toArray()
    },

    outboxCount(status) {
      return db().outbox.where('status').equals(status).count()
    },

    async outboxDropPending(saleUid) {
      const removed = await db()
        .outbox.where('saleUid')
        .equals(saleUid)
        .and((row: OutboxSale) => row.status === 'pending')
        .delete()
      return removed > 0
    },

    outboxCancelledUnsynced(limit) {
      return db()
        .outbox.where('status')
        .equals('cancelled')
        .filter((row: OutboxSale) => row.syncedAt === null)
        .limit(limit)
        .toArray()
    },

    outboxCancelledUnsyncedCount() {
      return db()
        .outbox.where('status')
        .equals('cancelled')
        .filter((row: OutboxSale) => row.syncedAt === null)
        .count()
    },

    outboxPruneSynced(before) {
      return db()
        .outbox.where('status')
        .equals('synced')
        .filter((row: OutboxSale) => (row.syncedAt ?? '') < before)
        .delete()
    },

    /* ── Returns ──────────────────────────────────────────────────────── */

    async returnPut(entry) {
      await db().returns.put(entry)
    },

    async returnUpdate(returnUid, changes) {
      await db().returns.update(returnUid, changes)
    },

    returnPending(limit) {
      return db()
        .returns.where('status')
        .equals('pending')
        .sortBy('takenAt')
        .then((rows: OutboxReturn[]) => rows.slice(0, limit))
    },

    returnCount(status) {
      return db().returns.where('status').equals(status).count()
    },

    returnPruneSynced(before) {
      return db()
        .returns.where('status')
        .equals('synced')
        .filter((row: OutboxReturn) => (row.syncedAt ?? '') < before)
        .delete()
    },

    /* ── The shift queue ──────────────────────────────────────────────── */

    async shiftPut(row) {
      await db().shifts.put(row)
    },

    shiftGet(shiftUid) {
      return db().shifts.get(shiftUid)
    },

    async shiftUpdate(shiftUid, changes) {
      await db().shifts.update(shiftUid, changes)
    },

    async shiftPending(limit) {
      /* `sortBy` then `slice`, matching the sale queue above: Dexie cannot order
         by one field while filtering on another index, and the ORDER is what
         matters — a shift has to reach the server before the sales on it. */
      const rows = await db().shifts.where('status').equals('pending').sortBy('openedAt')
      return rows.slice(0, limit)
    },

    shiftCount(status) {
      return db().shifts.where('status').equals(status).count()
    },

    async shiftPruneSynced(before) {
      const stale = await db()
        .shifts.where('status')
        .equals('synced')
        .filter((s: OutboxShift) => (s.syncedAt ?? '') < before)
        .toArray()
      await db().shifts.bulkDelete(stale.map((s) => s.shiftUid))
      return stale.length
    },

    /* ── Drawer movements ─────────────────────────────────────────────── */

    async movementPut(row) {
      await db().movements.put(row)
    },

    async movementUpdate(movementUid, changes) {
      await db().movements.update(movementUid, changes)
    },

    async movementPending(limit) {
      const rows = await db().movements.where('status').equals('pending').sortBy('takenAt')
      return rows.slice(0, limit)
    },

    movementCount(status) {
      return db().movements.where('status').equals(status).count()
    },

    async movementPruneSynced(before) {
      const stale = await db()
        .movements.where('status')
        .equals('synced')
        .filter((m: OutboxMovement) => (m.syncedAt ?? '') < before)
        .toArray()
      await db().movements.bulkDelete(stale.map((m) => m.movementUid))
      return stale.length
    },

    /* ── Parked ───────────────────────────────────────────────────────── */

    async parkedPut(row) {
      await db().parked.put(row)
    },

    parkedList() {
      return db().parked.orderBy('parkedAt').reverse().toArray()
    },

    parkedCount() {
      return db().parked.count()
    },

    async parkedDelete(uid) {
      await db().parked.delete(uid)
    },

    async recallParked(uid) {
      const d = db()
      return d.transaction('rw', d.parked, async () => {
        const row = await d.parked.get(uid)
        if (!row) return null
        await d.parked.delete(uid)
        return row as LocalParkedSale
      })
    },

    /* ── Drafts ───────────────────────────────────────────────────────── */

    async draftPut(row: LocalDraft) {
      await db().drafts.put(row)
    },

    draftGet(key) {
      return db().drafts.get(key)
    },

    async draftDelete(key) {
      await db().drafts.delete(key)
    },

    /* ── Capability ───────────────────────────────────────────────────── */

    async storageWorks() {
      try {
        await db().open()
        return true
      } catch {
        return false
      }
    },
  }
}
