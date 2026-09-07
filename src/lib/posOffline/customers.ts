'use client'

import { KV } from './db'
import { kvGet, posStore } from './store'
import type { CustomerMeta } from './catalog'
import {
  availableCredit,
  creditBlockedReason,
  remainingDaily,
  remainingMonthly,
  NO_SPEND,
} from '../creditRules'
/* Type-only, and therefore erased: both modules are `server-only`, and this
   keeps one definition of the shapes the two halves exchange rather than two
   that can drift. The same trick `catalog.ts` uses for `TillInstructionGroup`. */
import type { OfflineCustomer, TillCustomer } from '../site/tillCustomers'

/**
 * Finding a customer at a till with no network.
 *
 * ── WHAT THIS IS THE OFFLINE HALF OF ──────────────────────────────────────
 *
 * `site/tillCustomers.ts` — `searchCustomersForTill`, `listCustomersForPicker`,
 * `getTillCustomer`. Every function here answers the same question its namesake
 * there answers, in the same order, and hands back the same `TillCustomer`. That
 * is not tidiness: the picker is one component, and a search that ranked
 * differently offline would show the cashier a different person at the top of the
 * list depending on whether the line happened to be up.
 *
 * ── THE DERIVED FIELDS ARE COMPUTED, NEVER RECEIVED ───────────────────────
 *
 * `availableCredit`, `overLimit`, `remainingDaily`, `remainingMonthly` and
 * `creditBlockedReason` are not on the wire — see `project()` in tillCustomers.ts,
 * which strips them deliberately. They are pure functions of the four figures
 * beside them, so shipping both would let a till hold a credit position whose
 * halves disagree. Recomputing them here through the SAME `creditRules` module the
 * server used is what makes the two sides agree by construction.
 *
 * ── AND A CUSTOMER WITH NO `credit` IS BLOCKED, NOT BROKEN ────────────────
 *
 * A shop that has not turned on `pos_offline_account_sales` gets identity only,
 * so `credit` is absent. This does not fake zeros: zero is a real credit position
 * that `creditBlockedReason` reads as "no credit granted", which would tell the
 * cashier something confident and wrong. The row is marked blocked with a reason
 * that says the network is what is missing, which is the truth and is also
 * exactly what `offlineBlockedTender` will refuse the Account key over anyway.
 */

/** How many rows the picker's type-ahead reads. Matches the server's default. */
const SEARCH_LIMIT = 20

/** And its opening list, likewise. See `listCustomersForPicker`. */
const PAGE_LIMIT = 100

/**
 * Why a till holds no customer file, or null when it holds one.
 *
 * The three empty states are NOT the same and the picker must not present them as
 * one — see `CustomerMeta.overLimit`. A cashier told "no matches" for an account
 * that exists will ring the sale up as cash, and nobody finds out until the
 * customer queries their statement a month later.
 */
export type CustomerFileState =
  /** Rows are held; search them. */
  | { ok: true; count: number; credit: boolean }
  /** Nothing to search, with a sentence saying why. */
  | { ok: false; reason: string }

export async function customerFileState(siteId: number): Promise<CustomerFileState> {
  const meta = await kvGet<CustomerMeta>(siteId, KV.customerMeta)
  /* Never synced since the feed existed — a till on an older catalog, or one that
     has not come up yet. Not an error, and not "this shop has no accounts". */
  if (!meta) return { ok: false, reason: 'Customer search needs the network on this till.' }
  if (meta.overLimit) {
    return {
      ok: false,
      reason: 'This shop has too many accounts to hold offline — customer search needs the network.',
    }
  }
  if (meta.count === 0) return { ok: false, reason: 'No customer accounts.' }
  return { ok: true, count: meta.count, credit: meta.credit }
}

/**
 * Rebuilds the full `TillCustomer` the rest of the till works in.
 *
 * Exported because the outbox holds a customer ID and a reprint has to put a name
 * back on a slip, which is the one caller that does not come through a search.
 */
export function offlineCustomer(row: OfflineCustomer): TillCustomer {
  const account = {
    name: row.name,
    status: row.status,
    accountType: row.accountType,
    creditLimit: row.credit?.creditLimit ?? 0,
    dailyLimit: row.credit?.dailyLimit ?? 0,
    monthlyLimit: row.credit?.monthlyLimit ?? 0,
    balance: row.credit?.balance ?? 0,
  }
  const spend = row.credit?.spend ?? NO_SPEND

  return {
    id: row.id,
    code: row.code,
    ...account,
    availableCredit: availableCredit(account),
    overLimit: account.balance > account.creditLimit,
    spend,
    remainingDaily: remainingDaily(account, spend),
    remainingMonthly: remainingMonthly(account, spend),
    paymentTermsDays: row.paymentTermsDays,
    vatNumber: row.vatNumber,
    phone: row.phone,
    /*
     * The one place this deviates from the server's mapping, and deliberately.
     *
     * With no `credit` the four figures above are placeholders rather than
     * measurements, and `creditBlockedReason` applied to them would answer "no
     * credit limit set" — a statement about the ACCOUNT, when the truth is a
     * statement about this TILL. A cashier who reads the first will go and tell
     * the customer their limit was removed.
     */
    creditBlockedReason:
      row.credit === undefined
        ? `${row.name}'s credit position needs the network.`
        : creditBlockedReason(account),
    priceStructureId: row.priceStructureId,
    discountPct: row.discountPct,
    groupId: row.groupId,
  }
}

/**
 * The picker's type-ahead, offline.
 *
 * Under two characters returns nothing, matching `searchCustomersForTill` exactly
 * — the picker is a scanner-driven screen and a single keystroke would scan the
 * whole book on every letter typed.
 */
export async function searchOfflineCustomers(
  siteId: number,
  term: string,
  limit = SEARCH_LIMIT,
): Promise<TillCustomer[]> {
  const needle = term.trim()
  if (needle.length < 2) return []

  const rows = await posStore(siteId).customerSearch(needle, limit)
  return rank(rows, needle).map(offlineCustomer)
}

/** The opening list, before anything is typed. By name, as the server's is. */
export async function listOfflineCustomers(
  siteId: number,
  limit = PAGE_LIMIT,
): Promise<TillCustomer[]> {
  const rows = await posStore(siteId).customerFirstPage(limit)
  return rows.map(offlineCustomer)
}

/** One account by id — for a reprint, or a basket recalled with one attached. */
export async function offlineCustomerById(
  siteId: number,
  customerId: number,
): Promise<TillCustomer | null> {
  const row = await posStore(siteId).customerById(customerId)
  return row ? offlineCustomer(row) : null
}

/**
 * An exact account code, for a card scanned at the counter.
 *
 * Separate from the search above because a scan is not a search: it either
 * resolves or it does not, and offering the cashier a list of near matches for a
 * barcode is how the wrong account gets charged.
 */
export async function offlineCustomerByCode(
  siteId: number,
  code: string,
): Promise<TillCustomer | null> {
  const trimmed = code.trim()
  if (!trimmed) return null
  const row = await posStore(siteId).customerByCode(trimmed)
  return row ? offlineCustomer(row) : null
}

/**
 * The server's ordering, reproduced here rather than left to the store.
 *
 * `searchCustomersForTill` sorts by "an exact code first, then by name", and the
 * reason it is repeated in this module rather than pushed down into the two store
 * implementations is that it is a POLICY — see the header of `store.ts`, which is
 * explicit that the store answers "give me rows" and never "which of these did
 * they mean". Putting it in the engines would be two copies of a ranking, which is
 * exactly the kind of thing that drifts between Dexie and SQLite.
 */
function rank(rows: readonly OfflineCustomer[], needle: string): OfflineCustomer[] {
  const exact = needle.toLowerCase()
  return [...rows].sort((a, b) => {
    const aExact = a.code.toLowerCase() === exact ? 0 : 1
    const bExact = b.code.toLowerCase() === exact ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    return a.name.localeCompare(b.name)
  })
}
