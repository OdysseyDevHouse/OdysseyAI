'use client'

import type { TillProduct } from '../site/tillSearch'
import type { PosStore } from './store'
import type { OutboxSale } from './types'

/**
 * How long this machine's store takes to do what a till does.
 *
 * ── WHY THIS EXISTS, AND WHAT IT IS ALLOWED TO CONCLUDE ───────────────────
 *
 * `docs/plans/android-till-sqlite.md` names three drivers. Durability is settled
 * — a sale now sits in a file the operating system may not discard. Performance
 * is NOT settled, and the first like-for-like number went the wrong way: on one
 * Sunmi, the conformance suite ran in 1,298ms on Dexie and 3,755ms on SQLite.
 *
 * That number is not evidence about a till. It is sixteen correctness cases,
 * write-heavy, with many tiny operations — the worst possible shape for an fsync
 * per write and a call that crosses the JS/native bridge each time. A till is
 * read-heavy: it browses, it searches, it scans, and it writes once per sale.
 *
 * So this measures THAT, at a size a shop might actually have, and either
 * justifies an optimisation or shows there is nothing to fix. The plan's phase 3
 * exists to be judged against these numbers rather than against an assumption.
 *
 * ── ⚠ SAME RULE AS THE CONFORMANCE SUITE ──────────────────────────────────
 *
 * It writes, so it is handed a store opened on the throwaway site id. It must
 * never be pointed at a database holding a real outbox.
 */

export type Measurement = {
  name: string
  /** Milliseconds for the whole run of `iterations`. */
  totalMs: number
  iterations: number
  /** The number that matters to a cashier: one operation. */
  perOpMs: number
  detail: string
}

export type BenchmarkReport = {
  engine: string
  catalogSize: number
  measurements: Measurement[]
}

/** Deterministic, so two engines are asked to hold exactly the same shop. */
function catalogOf(size: number): TillProduct[] {
  const out: TillProduct[] = []
  for (let i = 1; i <= size; i += 1) {
    out.push({
      id: i,
      code: `PRD${String(i).padStart(6, '0')}`,
      description: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`,
      barcode: `600${String(i).padStart(9, '0')}`,
      barcodes: i % 5 === 0 ? [`ALT${String(i).padStart(9, '0')}`] : [],
      departmentId: (i % 20) + 1,
      parentId: null,
      hasVariants: false,
      stockOnHand: 100,
    } as unknown as TillProduct)
  }
  return out
}

const WORDS = [
  'Milk',
  'Bread',
  'Cheddar',
  'Coffee',
  'Sugar',
  'Butter',
  'Chicken',
  'Widget',
  'Rice',
  'Juice',
]

function sale(uid: string): OutboxSale {
  return {
    saleUid: uid,
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    takenAt: new Date().toISOString(),
    lines: [
      { productId: 1, qty: 1 },
      { productId: 2, qty: 2 },
      { productId: 3, qty: 1 },
    ],
    tenders: [{ amount: 100 }],
  } as unknown as OutboxSale
}

async function time(
  name: string,
  iterations: number,
  detail: string,
  fn: () => Promise<unknown>,
): Promise<Measurement> {
  const started = performance.now()
  for (let i = 0; i < iterations; i += 1) await fn()
  const totalMs = performance.now() - started
  return {
    name,
    totalMs: Math.round(totalMs),
    iterations,
    perOpMs: Math.round((totalMs / iterations) * 100) / 100,
    detail,
  }
}

/**
 * Runs the measurements in the order a till would meet them: it syncs a catalog,
 * then serves customers from it.
 */
export async function runStoreBenchmark(
  store: PosStore,
  engine: string,
  catalogSize = 2000,
): Promise<BenchmarkReport> {
  const products = catalogOf(catalogSize)
  const measurements: Measurement[] = []

  /* Start from nothing, so the first load is measured as a first load. */
  await store.applyCatalog({ full: true, products: [], deletedIds: [], kv: [] })

  measurements.push(
    await time('Full catalog load', 1, `${catalogSize} products, one sync`, () =>
      store.applyCatalog({ full: true, products, deletedIds: [], kv: [] }),
    ),
  )

  measurements.push(
    await time('Delta sync', 1, '20 changed products', () =>
      store.applyCatalog({
        full: false,
        products: products.slice(0, 20),
        deletedIds: [],
        kv: [],
      }),
    ),
  )

  measurements.push(
    await time('Open a department', 20, 'the grid a cashier taps into', () =>
      store.productsByDepartments([7]),
    ),
  )

  measurements.push(
    await time('Scan a barcode', 50, 'the single most common till action', () =>
      store.productByBarcode(`600${String(1 + Math.floor(Math.random() * catalogSize)).padStart(9, '0')}`),
    ),
  )

  measurements.push(
    await time('Search by code prefix', 20, 'first pass of the search box', () =>
      store.productsByCodePrefix('PRD00', 50),
    ),
  )

  measurements.push(
    await time('Search by description', 20, 'the scan — the read FTS5 would improve', () =>
      store.productsByDescription('widget', 50, new Set()),
    ),
  )

  let saleNo = 0
  measurements.push(
    await time('Finalise a sale', 10, 'queue the sale and move its stock', async () => {
      saleNo += 1
      await store.outboxPut(sale(`bench-${saleNo}`))
      await store.adjustStock([
        { productId: 1, qty: 1 },
        { productId: 2, qty: 2 },
        { productId: 3, qty: 1 },
      ])
    }),
  )

  measurements.push(
    await time('Read the queue', 20, 'what the sync engine asks for', () => store.outboxPending(50)),
  )

  /* Leave nothing behind: the next run must measure a first load, not a second,
     and the queued sales above are fixtures rather than takings. */
  await store.applyCatalog({ full: true, products: [], deletedIds: [], kv: [] })
  for (let i = 1; i <= saleNo; i += 1) await store.outboxDropPending(`bench-${i}`)

  return { engine, catalogSize, measurements }
}
