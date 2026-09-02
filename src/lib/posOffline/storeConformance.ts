'use client'

import type { TillProduct } from '../site/tillSearch'
import type { PosStore } from './store'
import type { OutboxReturn, OutboxSale } from './types'

/**
 * One suite, run against whichever store this machine uses.
 *
 * ── WHY THIS IS THE GATE, NOT A NICETY ────────────────────────────────────
 *
 * `docs/plans/android-till-sqlite.md` accepts two persistence implementations —
 * SQLite on Android, Dexie in Chrome and Electron — against this codebase's own
 * instinct, which is that the copy that drifts is the one guarding the door. The
 * whole mitigation is that both answer to the same cases. So this file is the
 * reason the plan is allowed to proceed, and a store that does not pass it is
 * not a store.
 *
 * It also answers a question the port left open. Phase 1 moved twenty-eight call
 * sites onto `PosStore` and claimed behaviour was unchanged on the grounds that
 * every query was carried across verbatim. True, but unproven — a claim about a
 * diff, not about a running till. These cases prove it.
 *
 * ── WHERE IT RUNS ─────────────────────────────────────────────────────────
 *
 * In the app, on the machine. Dexie needs a real browser and the SQLite store
 * will only exist inside the Android shell, so there is no Node in which both
 * can be exercised — running it in situ is not a shortcut, it is the only place
 * the question can be asked of both engines.
 *
 * ── ⚠ IT WRITES, SO IT MUST NEVER WRITE WHERE A SALE LIVES ────────────────
 *
 * Every case here clears tables. `posDb` keys its database on the site id, so
 * the runner hands in a store opened on `CONFORMANCE_SITE_ID` — a sentinel no
 * shop can be — and the real till's outbox is in a different database entirely.
 * A pending row is a sale that happened; a test suite is not a reason to risk
 * one. Anything calling this with a real site id is a bug.
 */
export const CONFORMANCE_SITE_ID = -9999

export type CaseResult = {
  name: string
  ok: boolean
  /** What went wrong, or what was checked when it went right. */
  detail: string
}

export type ConformanceReport = {
  engine: string
  passed: number
  failed: number
  durationMs: number
  cases: CaseResult[]
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/**
 * A product with the fields the store INDEXES, and a cast for the rest.
 *
 * The cast is deliberate. `TillProduct` carries pricing, tax, stock and a dozen
 * flags the basket rules read, and none of it is the store's business — the
 * store is asked to put a row away and give it back. Spelling out forty fields
 * per fixture would test the type, not the store, and would need editing every
 * time a pricing field is added.
 */
function product(over: Partial<TillProduct> & { id: number }): TillProduct {
  return {
    code: `CODE${over.id}`,
    description: `Product ${over.id}`,
    barcode: `BC${over.id}`,
    barcodes: [],
    departmentId: 1,
    parentId: null,
    hasVariants: false,
    stockOnHand: 10,
    ...over,
  } as unknown as TillProduct
}

function sale(over: Partial<OutboxSale> & { saleUid: string }): OutboxSale {
  return {
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    takenAt: '2026-01-01T00:00:00.000Z',
    lines: [],
    tenders: [],
    ...over,
  } as unknown as OutboxSale
}

function refund(over: Partial<OutboxReturn> & { returnUid: string }): OutboxReturn {
  return {
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    takenAt: '2026-01-01T00:00:00.000Z',
    lines: [],
    ...over,
  } as unknown as OutboxReturn
}

/** Empties every table, so each case starts from a known floor. */
async function reset(store: PosStore): Promise<void> {
  await store.applyCatalog({ full: true, products: [], deletedIds: [], kv: [] })
  for (const row of await store.outboxRecent()) {
    await store.outboxUpdate(row.saleUid, { status: 'synced', syncedAt: '1970-01-01T00:00:00.000Z' })
  }
  await store.outboxPruneSynced('2100-01-01T00:00:00.000Z')
  await store.returnPruneSynced('2100-01-01T00:00:00.000Z')
  for (const row of await store.returnPending(9999)) {
    await store.returnUpdate(row.returnUid, {
      status: 'synced',
      syncedAt: '1970-01-01T00:00:00.000Z',
    })
  }
  await store.returnPruneSynced('2100-01-01T00:00:00.000Z')
  for (const row of await store.parkedList()) await store.parkedDelete(row.uid)
  await store.draftDelete('conformance')
}

/* ── The cases ───────────────────────────────────────────────────────────── */

type Case = { name: string; run: (store: PosStore) => Promise<string> }

/** Throws with a readable message; the runner turns that into a failure. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const CASES: Case[] = [
  {
    name: 'applyCatalog full replaces everything it held',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [product({ id: 1 }), product({ id: 2 })],
        deletedIds: [],
        kv: [],
      })
      await store.applyCatalog({ full: true, products: [product({ id: 3 })], deletedIds: [], kv: [] })
      const count = await store.productCount()
      expect(count === 1, `expected 1 product after a full load, held ${count}`)
      expect((await store.productById(1)) === undefined, 'a full load left a row from the previous one')
      return 'the second full load replaced the first, it did not merge with it'
    },
  },
  {
    name: 'applyCatalog delta patches and deletes without clearing',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [product({ id: 1 }), product({ id: 2 }), product({ id: 3 })],
        deletedIds: [],
        kv: [],
      })
      await store.applyCatalog({
        full: false,
        products: [product({ id: 2, description: 'Patched' })],
        deletedIds: [3],
        kv: [],
      })
      expect((await store.productCount()) === 2, 'a delta changed the number of rows it should not have')
      expect((await store.productById(1)) !== undefined, 'a delta dropped a row it never mentioned')
      expect((await store.productById(2))?.description === 'Patched', 'a delta did not apply its update')
      expect((await store.productById(3)) === undefined, 'a delta did not apply its deletion')
      return 'untouched rows survived, the named row changed, the deleted row went'
    },
  },
  {
    name: 'applyCatalog writes its kv documents with the rows',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [product({ id: 1 })],
        deletedIds: [],
        kv: [{ key: 'conformance.settings', value: { a: 1 } }],
      })
      const held = await store.kvGet<{ a: number }>('conformance.settings')
      expect(held?.a === 1, 'the kv document written alongside a catalog was not stored')
      return 'products and kv landed together, as one sync'
    },
  },
  {
    name: 'lookups by id, barcode, alias and code',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [product({ id: 7, code: 'ABC7', barcode: '5001', barcodes: ['5002', '5003'] })],
        deletedIds: [],
        kv: [],
      })
      expect((await store.productById(7))?.id === 7, 'productById missed')
      expect((await store.productByBarcode('5001'))?.id === 7, 'productByBarcode missed the primary barcode')
      expect((await store.productByAlias('5003'))?.id === 7, 'productByAlias missed an additional barcode')
      expect((await store.productByCode('ABC7'))?.id === 7, 'productByCode missed')
      expect((await store.productByBarcode('nope')) === undefined, 'a miss returned something')
      return 'all four resolve, and a miss is undefined rather than a throw'
    },
  },
  {
    name: 'productsByDepartments and productsByParent',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [
          product({ id: 1, departmentId: 10 }),
          product({ id: 2, departmentId: 11 }),
          product({ id: 3, departmentId: 12 }),
          product({ id: 4, departmentId: 10, parentId: 1 }),
        ],
        deletedIds: [],
        kv: [],
      })
      const inScope = await store.productsByDepartments([10, 11])
      expect(inScope.length === 3, `department scope returned ${inScope.length}, expected 3`)
      const kids = await store.productsByParent(1)
      expect(kids.length === 1 && kids[0].id === 4, 'variant members did not resolve by parent')
      return 'a department subtree and a variant group both resolve'
    },
  },
  {
    name: 'search: code prefix is case-insensitive, description excludes and limits',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [
          product({ id: 1, code: 'MILK1', description: 'Full cream milk' }),
          product({ id: 2, code: 'MILK2', description: 'Low fat milk' }),
          product({ id: 3, code: 'BRD1', description: 'Brown bread' }),
        ],
        deletedIds: [],
        kv: [],
      })
      const byCode = await store.productsByCodePrefix('milk', 10)
      expect(byCode.length === 2, `case-insensitive prefix returned ${byCode.length}, expected 2`)
      const byName = await store.productsByDescription('milk', 10, new Set([1]))
      expect(byName.length === 1 && byName[0].id === 2, 'description search ignored its exclude set')
      const limited = await store.productsByDescription('milk', 1, new Set())
      expect(limited.length === 1, 'description search ignored its limit')
      return 'prefix ignores case, substring honours exclude and limit'
    },
  },
  {
    name: 'adjustStock moves stock and ignores what it does not hold',
    async run(store) {
      await store.applyCatalog({
        full: true,
        products: [product({ id: 1, stockOnHand: 10 }), product({ id: 2, stockOnHand: 5 })],
        deletedIds: [],
        kv: [],
      })
      await store.adjustStock([
        { productId: 1, qty: 3 },
        { productId: 2, qty: 5 },
        { productId: 999, qty: 1 },
      ])
      expect((await store.productById(1))?.stockOnHand === 7, 'stock was not decremented')
      expect((await store.productById(2))?.stockOnHand === 0, 'stock did not reach zero')
      expect((await store.productCount()) === 2, 'an unknown product id created a row')
      return 'held rows moved, an unknown id was skipped rather than invented'
    },
  },
  {
    name: 'kv: a missing key is null, a stored value round-trips',
    async run(store) {
      expect((await store.kvGet('conformance.absent')) === null, 'a missing key was not null')
      await store.kvPut('conformance.k', { nested: { n: 2 } })
      const back = await store.kvGet<{ nested: { n: number } }>('conformance.k')
      expect(back?.nested.n === 2, 'a nested value did not survive the round trip')
      return 'absent reads as null, structure survives storage'
    },
  },
  {
    name: 'outbox: pending is oldest first, recent is newest first',
    async run(store) {
      await store.outboxPut(sale({ saleUid: 'b', takenAt: '2026-01-02T00:00:00.000Z' }))
      await store.outboxPut(sale({ saleUid: 'a', takenAt: '2026-01-01T00:00:00.000Z' }))
      await store.outboxPut(sale({ saleUid: 'c', takenAt: '2026-01-03T00:00:00.000Z' }))
      const pending = await store.outboxPending(10)
      expect(
        pending.map((r) => r.saleUid).join(',') === 'a,b,c',
        `the queue flushed out of order: ${pending.map((r) => r.saleUid).join(',')}`,
      )
      const recent = await store.outboxRecent()
      expect(
        recent.map((r) => r.saleUid).join(',') === 'c,b,a',
        `recent sales were not newest first: ${recent.map((r) => r.saleUid).join(',')}`,
      )
      expect((await store.outboxPending(2)).length === 2, 'the queue ignored its limit')
      return 'the books would be written in the order the shop traded'
    },
  },
  {
    name: 'outbox: update, count by status, and drop only while pending',
    async run(store) {
      await store.outboxPut(sale({ saleUid: 'x' }))
      await store.outboxPut(sale({ saleUid: 'y' }))
      await store.outboxUpdate('y', { status: 'synced', syncedAt: '2026-01-04T00:00:00.000Z' })
      expect((await store.outboxCount('pending')) === 1, 'pending count is wrong after an update')
      expect((await store.outboxCount('synced')) === 1, 'synced count is wrong after an update')
      expect((await store.outboxGet('y'))?.status === 'synced', 'the update did not stick')
      expect((await store.outboxDropPending('x')) === true, 'a pending sale could not be dropped')
      expect(
        (await store.outboxDropPending('y')) === false,
        'a SYNCED sale was dropped locally, hiding a discrepancy the server already knows about',
      )
      return 'a sent sale cannot be made to disappear from the till alone'
    },
  },
  {
    name: 'outbox: cancellations count only until the server has them',
    async run(store) {
      await store.outboxPut(sale({ saleUid: 'c1', status: 'cancelled', syncedAt: null }))
      await store.outboxPut(
        sale({ saleUid: 'c2', status: 'cancelled', syncedAt: '2026-01-05T00:00:00.000Z' }),
      )
      const outstanding = await store.outboxCancelledUnsynced(10)
      expect(outstanding.length === 1 && outstanding[0].saleUid === 'c1', 'a delivered cancellation was still queued')
      expect((await store.outboxCancelledUnsyncedCount()) === 1, 'the cancellation count included a delivered one')
      return 'only undelivered cancellations count as outstanding work'
    },
  },
  {
    name: 'pruning removes old synced rows and NEVER a pending one',
    async run(store) {
      await store.outboxPut(sale({ saleUid: 'keep-pending' }))
      await store.outboxPut(
        sale({ saleUid: 'old-synced', status: 'synced', syncedAt: '2020-01-01T00:00:00.000Z' }),
      )
      await store.outboxPut(
        sale({ saleUid: 'new-synced', status: 'synced', syncedAt: '2026-06-01T00:00:00.000Z' }),
      )
      await store.outboxPruneSynced('2026-01-01T00:00:00.000Z')
      expect((await store.outboxGet('old-synced')) === undefined, 'an old synced row was not pruned')
      expect((await store.outboxGet('new-synced')) !== undefined, 'a recent synced row was pruned too early')
      expect(
        (await store.outboxGet('keep-pending')) !== undefined,
        'PRUNING DELETED A PENDING SALE — the only record of money taken',
      )
      return 'the cutoff is honoured and a pending sale is untouchable'
    },
  },
  {
    name: 'returns behave as sales do, separately',
    async run(store) {
      await store.returnPut(refund({ returnUid: 'r2', takenAt: '2026-01-02T00:00:00.000Z' }))
      await store.returnPut(refund({ returnUid: 'r1', takenAt: '2026-01-01T00:00:00.000Z' }))
      const pending = await store.returnPending(10)
      expect(
        pending.map((r) => r.returnUid).join(',') === 'r1,r2',
        'refunds did not queue oldest first',
      )
      expect((await store.returnCount('pending')) === 2, 'pending refund count is wrong')
      await store.returnUpdate('r1', { status: 'synced', syncedAt: '2020-01-01T00:00:00.000Z' })
      await store.returnPruneSynced('2026-01-01T00:00:00.000Z')
      expect((await store.returnCount('pending')) === 1, 'pruning touched a pending refund')
      return 'a queued refund is treated as carefully as a sale'
    },
  },
  {
    name: 'parked: newest first, and one basket recalls exactly once',
    async run(store) {
      await store.parkedPut({ uid: 'p1', parkedAt: '2026-01-01T00:00:00.000Z' } as never)
      await store.parkedPut({ uid: 'p2', parkedAt: '2026-01-02T00:00:00.000Z' } as never)
      const list = await store.parkedList()
      expect(
        list.map((r) => r.uid).join(',') === 'p2,p1',
        `parked baskets were not newest first: ${list.map((r) => r.uid).join(',')}`,
      )
      expect((await store.parkedCount()) === 2, 'parked count is wrong')
      const first = await store.recallParked('p2')
      expect(first?.uid === 'p2', 'recall did not return the basket')
      const second = await store.recallParked('p2')
      expect(
        second === null,
        'ONE BASKET RECALLED TWICE — it would appear on two screens and could be sold twice',
      )
      expect((await store.parkedCount()) === 1, 'recall did not remove the basket it handed back')
      return 'read-and-delete really is one step'
    },
  },
  {
    name: 'drafts: put, get, delete',
    async run(store) {
      await store.draftPut({ key: 'conformance', savedAt: '2026-01-01T00:00:00.000Z' } as never)
      expect((await store.draftGet('conformance')) !== undefined, 'the draft was not stored')
      await store.draftDelete('conformance')
      expect((await store.draftGet('conformance')) === undefined, 'the draft was not removed')
      return 'the in-progress basket survives and can be cleared'
    },
  },
  {
    name: 'storageWorks answers rather than throws',
    async run(store) {
      const ok = await store.storageWorks()
      expect(typeof ok === 'boolean', 'storageWorks did not answer with a boolean')
      expect(ok === true, 'this machine reports it cannot store anything locally')
      return 'the till can say whether it may trade offline'
    },
  },
]

/**
 * Runs every case against one store, in order, resetting between each.
 *
 * Never throws: a store that is broken enough to explode is exactly the case
 * this has to REPORT rather than crash on, because the screen showing the report
 * is the only place anybody is watching.
 */
export async function runStoreConformance(
  store: PosStore,
  engine: string,
): Promise<ConformanceReport> {
  const started = Date.now()
  const cases: CaseResult[] = []

  for (const c of CASES) {
    try {
      await reset(store)
      const detail = await c.run(store)
      cases.push({ name: c.name, ok: true, detail })
    } catch (err) {
      cases.push({
        name: c.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    await reset(store)
  } catch {
    /* Best effort: a failed tidy-up must not turn a passing run into a failure. */
  }

  return {
    engine,
    passed: cases.filter((c) => c.ok).length,
    failed: cases.filter((c) => !c.ok).length,
    durationMs: Date.now() - started,
    cases,
  }
}
