'use client'

import { posDb, type LocalParkedSale } from './db'
import type { OfflineSaleLine } from './types'

/**
 * Setting a basket aside with no network.
 *
 * ── WHY THIS IS NOT THE OUTBOX ────────────────────────────────────────────
 *
 * A parked basket is not a sale. Nobody has paid, no number has been issued, and
 * nothing about it needs to reach the books — it is a shopping basket put down so the
 * next customer can be served. So it lives in its own table with its own rules, and
 * the most important difference is that it MAY be deleted: recalling one removes it,
 * whereas a pending sale is never removed by anything.
 *
 * Getting that distinction wrong in either direction is a real failure. Parking into
 * the outbox would post a basket nobody paid for. Treating an unsynced SALE as a
 * parked basket would lose money that is already in the drawer.
 *
 * ── WHY IT NEVER SYNCS ────────────────────────────────────────────────────
 *
 * A basket parked offline stays on the till that parked it. Uploading them would mean
 * inventing draft documents on the server for baskets that may simply be abandoned,
 * and then reconciling those against the ones the same till parked online — two
 * sources for "what is parked here", which is how a badge comes to disagree with its
 * own list. A cashier recalls a basket at the till they parked it at, which is what
 * they do anyway.
 *
 * The honest cost, worth stating: a basket parked offline is NOT visible from another
 * till, where one parked online is. The recall list says which are local so nobody
 * hunts for it on the wrong machine.
 */

export type ParkedBasket = {
  uid: string
  parkedAt: string
  customerName: string
  itemCount: number
  totalIncl: number
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}

/** Parks a basket locally. Returns its uid so the caller can report success. */
export async function parkOffline(
  siteId: number,
  input: {
    customerId: number | null
    customerName: string
    customerVatNo: string | null
    customerPhone: string | null
    priceStructureId: number | null
    lines: OfflineSaleLine[]
    totalIncl: number
  },
): Promise<string> {
  const row: LocalParkedSale = {
    uid: uid(),
    parkedAt: new Date().toISOString(),
    customerId: input.customerId,
    customerName: input.customerName,
    customerVatNo: input.customerVatNo,
    customerPhone: input.customerPhone,
    priceStructureId: input.priceStructureId,
    lines: input.lines,
    itemCount: input.lines.length,
    totalIncl: input.totalIncl,
  }
  await posDb(siteId).parked.put(row)
  return row.uid
}

/** What is parked on this till, most recent first. */
export async function listParkedOffline(siteId: number): Promise<ParkedBasket[]> {
  const rows = await posDb(siteId).parked.orderBy('parkedAt').reverse().toArray()
  return rows.map((r) => ({
    uid: r.uid,
    parkedAt: r.parkedAt,
    customerName: r.customerName,
    itemCount: r.itemCount,
    totalIncl: r.totalIncl,
  }))
}

export async function countParkedOffline(siteId: number): Promise<number> {
  return posDb(siteId).parked.count()
}

/**
 * Takes a parked basket back, and removes it.
 *
 * Read-then-delete in one transaction, so two taps on the same row cannot both
 * recall it — which would put one basket on screen twice and let it be sold twice.
 *
 * ⚠ The lines come back EXACTLY as they were parked, including their prices. That
 * differs from the online recall, which re-reads each product's current shelf price
 * and discount ceiling — a basket parked yesterday must not smuggle back a rule that
 * has since been tightened. Offline there is nothing to re-read against, so the till
 * cannot make that check; the caller re-runs it on the next catalog refresh, and a
 * basket parked offline and recalled online goes through the normal path.
 */
export async function recallOffline(
  siteId: number,
  parkedUid: string,
): Promise<LocalParkedSale | null> {
  const db = posDb(siteId)
  return db.transaction('rw', db.parked, async () => {
    const row = await db.parked.get(parkedUid)
    if (!row) return null
    await db.parked.delete(parkedUid)
    return row
  })
}

/** Throws a parked basket away without recalling it. */
export async function discardParkedOffline(siteId: number, parkedUid: string): Promise<void> {
  await posDb(siteId).parked.delete(parkedUid)
}
