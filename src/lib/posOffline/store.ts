'use client'

import type { TillProduct } from '../site/tillSearch'
import type { KvRow, LocalDraft, LocalParkedSale } from './db'
import type { OutboxReturn, OutboxSale } from './types'
import { Capacitor } from '@capacitor/core'
import { dexieStore } from './dexieStore'
import { sqliteStore } from './sqliteStore'

/**
 * Where a till keeps its own data.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * An Android till is about to keep its rows in SQLite rather than IndexedDB,
 * because an Android WebView may EVICT IndexedDB under storage pressure and a
 * pending outbox row is a sale that happened — see the header of `db.ts`, and
 * `docs/plans/android-till-sqlite.md` for the whole argument. Chrome and
 * Electron keep Dexie, where OPFS would buy nothing: it sits in the same
 * evictable bucket.
 *
 * So there will be two stores. This is the seam between them, and everything
 * about it is shaped by one rule: THE STORE DIFFERS, THE POLICY DOES NOT.
 * `lib/site/boxOutbox.ts` already says exactly that about the same outbox
 * reimplemented against MariaDB, so the shape is proven here rather than new.
 *
 * ── WHAT MAY CROSS THIS LINE, AND WHAT MAY NOT ────────────────────────────
 *
 * Rows in, rows out. No Dexie concept and no SQL concept appears in these
 * types, because the moment one does, callers start reasoning about the engine
 * and the second implementation stops being swappable.
 *
 * And no POLICY. What a sale is, when a full load is forced, what may be sold
 * offline, how the cursor advances — all of that stays in `catalog.ts`,
 * `sync.ts` and `offlineCapability.ts`, engine-agnostic and written once. A
 * method here answers "put these rows away", never "should this be allowed".
 *
 * ── THE OPERATIONS ARE SEMANTIC, NOT PRIMITIVE ────────────────────────────
 *
 * There is no `transaction()` on this interface, deliberately. Three writes in
 * the till must be all-or-nothing, and each is exposed as ONE method whose
 * atomicity is the implementation's problem:
 *
 *   · `applyCatalog`  — a full load clears and repopulates. Dexie's transaction
 *                       is what stops an interrupted sync leaving half a
 *                       product file; SQLite must genuinely match that rather
 *                       than merely look like it.
 *   · `adjustStock`   — read-modify-write across several products at once.
 *   · `recallParked`  — read then delete, so two windows cannot recall one
 *                       basket twice.
 *
 * Handing out a generic transaction instead would let a caller compose its own,
 * and the guarantee would then live in five places rather than three.
 */
export interface PosStore {
  /* ── Catalog: a CACHE. Losing it costs a refresh and nothing else. ────── */

  /**
   * The whole result of one sync, written atomically.
   *
   * `full` replaces the product file; otherwise the rows are patched and
   * `deletedIds` removed. `kv` rides along because it is written on every
   * response, delta or not, and splitting the two would let a till hold a
   * catalog from one sync beside settings from another.
   */
  applyCatalog(input: {
    full: boolean
    products: TillProduct[]
    deletedIds: number[]
    kv: KvRow[]
  }): Promise<void>

  productCount(): Promise<number>
  productById(id: number): Promise<TillProduct | undefined>
  /** The product's own barcode. */
  productByBarcode(code: string): Promise<TillProduct | undefined>
  /** One of its ADDITIONAL barcodes, so an alias scans like the primary. */
  productByAlias(code: string): Promise<TillProduct | undefined>
  productByCode(code: string): Promise<TillProduct | undefined>
  /** The grid: every product in a department subtree, resolved by the caller. */
  productsByDepartments(ids: number[]): Promise<TillProduct[]>
  /** The members of one variant group, for the picker. */
  productsByParent(parentId: number): Promise<TillProduct[]>
  /** Search, first pass: codes beginning with what was typed. */
  productsByCodePrefix(prefix: string, limit: number): Promise<TillProduct[]>
  /**
   * Search, second pass: descriptions CONTAINING it.
   *
   * `exclude` carries the ids the first pass already returned, so the two
   * cannot double up. Substring rather than prefix, which is why this is the
   * one read that scans on Dexie — and the one an index can genuinely improve
   * on SQLite. See the performance phase of the plan.
   */
  productsByDescription(
    needle: string,
    limit: number,
    exclude: ReadonlySet<number>,
  ): Promise<TillProduct[]>
  /**
   * Move stock, atomically, for the lines of one sale.
   *
   * Deltas rather than absolute figures: the caller knows what was sold and the
   * store knows what it holds, so a caller computing the new total would be
   * reading and writing across a gap another sale can land in.
   */
  adjustStock(deltas: readonly { productId: number; qty: number }[]): Promise<void>

  /* ── kv: single documents, read whole, never queried by field ─────────── */

  kvGet<T>(key: string): Promise<T | null>
  kvPut(key: string, value: unknown): Promise<void>

  /* ── Outbox: NOT a cache. A pending row is money. ─────────────────────── */

  outboxPut(entry: OutboxSale): Promise<void>
  outboxGet(saleUid: string): Promise<OutboxSale | undefined>
  outboxUpdate(saleUid: string, changes: Partial<OutboxSale>): Promise<void>
  /** Oldest first — a queue, so the books read in the order the shop traded. */
  outboxPending(limit: number): Promise<OutboxSale[]>
  /** Newest first, for the recent-sales list a cashier reprints from. */
  outboxRecent(): Promise<OutboxSale[]>
  outboxCount(status: OutboxSale['status']): Promise<number>
  /**
   * Remove a sale that is still PENDING, reporting whether it was there.
   *
   * The status check is the point: a sale already sent cannot be dropped
   * locally, because the server has it and the till would be hiding a
   * discrepancy rather than resolving one.
   */
  outboxDropPending(saleUid: string): Promise<boolean>
  /** Cancelled locally but not yet told to the server. */
  outboxCancelledUnsynced(limit: number): Promise<OutboxSale[]>
  /**
   * How many of those there are.
   *
   * Its own method rather than `outboxCount('cancelled')`, because a
   * cancellation the server already has is done with and must not be counted
   * as outstanding work — the status alone does not say which it is.
   */
  outboxCancelledUnsyncedCount(): Promise<number>
  /** Synced rows older than the cutoff. Never touches a pending one. */
  outboxPruneSynced(before: string): Promise<number>

  /* ── Returns: the same rules, separately, because a till may be able to do
       one and not the other — see the credit-note sequence in catalog.ts. ── */

  returnPut(entry: OutboxReturn): Promise<void>
  returnUpdate(returnUid: string, changes: Partial<OutboxReturn>): Promise<void>
  returnPending(limit: number): Promise<OutboxReturn[]>
  returnCount(status: OutboxReturn['status']): Promise<number>
  returnPruneSynced(before: string): Promise<number>

  /* ── Parked baskets: nobody has paid, so these ARE deletable ──────────── */

  parkedPut(row: LocalParkedSale): Promise<void>
  /** Most recently parked first — the one a cashier is most likely to want. */
  parkedList(): Promise<LocalParkedSale[]>
  parkedCount(): Promise<number>
  parkedDelete(uid: string): Promise<void>
  /** Read and remove in one step, so one basket cannot be recalled twice. */
  recallParked(uid: string): Promise<LocalParkedSale | null>

  /* ── The in-progress basket, one per till ─────────────────────────────── */

  draftPut(row: LocalDraft): Promise<void>
  draftGet(key: string): Promise<LocalDraft | undefined>
  draftDelete(key: string): Promise<void>

  /**
   * Whether this machine can store anything at all.
   *
   * A browser in private mode, or one refusing site data, cannot — and the till
   * has to SAY so rather than discover it at the moment the line drops. See
   * `useOfflineTill`, which turns this into the offline blocker message.
   */
  storageWorks(): Promise<boolean>
}

/**
 * The store this machine uses.
 *
 * ── THE ONE PLACE THE PLATFORM IS DECIDED ────────────────────────────────
 *
 * Today there is one answer, so this looks like indirection for its own sake.
 * It is not: it is the seam the SQLite store arrives at, and having exactly one
 * of them is what stops the platform question being asked in twenty-eight call
 * sites. When the Android store lands, it is decided HERE and nowhere else.
 *
 * Decided once and held, never per call. The check will be "the SQLite plugin
 * is present and its database opens", which is a real I/O operation — and it
 * must never be inferred from the user agent, because the same bundle runs in
 * Chrome against the same site.
 *
 * ⚠ The instance is per SITE, not per app: `posDb` keys its database on the
 * site id so a machine that switches shops cannot mix two catalogs or, far
 * worse, two OUTBOXES. Any future implementation inherits that rule.
 */
export function posStore(siteId: number): PosStore {
  return useSqlite() ? sqliteStore(siteId) : dexieStore(siteId)
}

/** What the active store is called, for a diagnostics screen to report. */
export function activeEngineName(): string {
  return useSqlite() ? 'SQLite (native)' : 'Dexie / IndexedDB'
}

let sqliteDecision: boolean | null = null

/**
 * Whether this machine uses SQLite. Decided once and held.
 *
 * ── WHAT IS BEING ASKED, AND WHAT IS NOT ─────────────────────────────────
 *
 * "Am I inside the native shell, with the SQLite plugin registered." Both
 * facts come from the Capacitor runtime, which knows; neither is inferred
 * from the user agent, which would be a guess — the same bundle is served to
 * Chrome against the same site, and an Android WebView announces itself as
 * Linux besides.
 *
 * ── AND THERE IS DELIBERATELY NO FALLBACK ────────────────────────────────
 *
 * If the plugin is there but the database will not open, this still says
 * SQLite and the store reports the failure through `storageWorks()`, which
 * the till already turns into "this machine cannot trade offline". Quietly
 * dropping back to Dexie would be worse than the error: the whole reason for
 * this store is that IndexedDB may be evicted on Android, so a silent
 * fallback would put real sales in exactly the place judged unsafe, and say
 * nothing.
 */
function useSqlite(): boolean {
  if (sqliteDecision === null) {
    sqliteDecision = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('CapacitorSQLite')
  }
  return sqliteDecision
}

/**
 * Read and write one `kv` document.
 *
 * Free functions rather than methods on a caller-held store, because thirty
 * call sites across the till read a single key and nothing else — the operator
 * session, the shift, the number sequence — and making each of them resolve a
 * store first would be ceremony around a one-line read.
 *
 * ⚠ These MUST go through `posStore`. They used to live in `db.ts` and talk to
 * Dexie directly, which was harmless while Dexie was the only store and
 * actively dangerous the moment it stopped being: the products and the outbox
 * would have moved to SQLite while the operator session, the offline PIN
 * lockout and the invoice counter stayed behind in IndexedDB. A till would
 * then hold its sales in one place and its numbering in another.
 */
export async function kvGet<T>(siteId: number, key: string): Promise<T | null> {
  return posStore(siteId).kvGet<T>(key)
}

export async function kvPut(siteId: number, key: string, value: unknown): Promise<void> {
  await posStore(siteId).kvPut(key, value)
}

/**
 * Whether this machine can store anything locally at all.
 *
 * Moved here for the same reason as the two above: the answer depends on which
 * store is in use, and a browser that refuses site data and a device whose
 * SQLite file will not open are the same fact to the cashier being told the
 * till cannot trade offline.
 */
export async function offlineStorageWorks(siteId: number): Promise<boolean> {
  return posStore(siteId).storageWorks()
}
