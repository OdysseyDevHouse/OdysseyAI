import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { toNum } from '../decimals'
import {
  AGE_BANDS,
  ageLayers,
  bandFor,
  classifyAbc,
  daysOfStock,
  sellThrough,
  stockTurn,
  type AbcClass,
  type AgeBandKey,
  type Arrival,
} from '../stockIntel'

/**
 * Stock intelligence — the four questions a shelf full of money keeps asking.
 *
 * Every figure here is at COST from the movement log, not at retail from the
 * sales file: these reports are about the capital tied up in stock, and the
 * one line that carries what stock cost as it moved is stock_movements.
 * The math lives in ../stockIntel (pure); this file is the queries.
 */

type Row = RowDataPacket & Record<string, unknown>

function localTodayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/* ── 1. Stock age ────────────────────────────────────────────────────────── */

export type AgeBandRow = {
  key: AgeBandKey
  label: string
  qty: number
  value: number
  products: number
}

export type StaleProductRow = {
  productId: number
  code: string | null
  description: string
  department: string
  onHand: number
  /** Units older than 90 days (unknown-age units included — they are older still). */
  staleQty: number
  staleValue: number
  /** Age of the oldest DATED layer; null when the oldest stock predates the log. */
  oldestDays: number | null
}

export type StockAgeReport = {
  bands: AgeBandRow[]
  /** Value-ranked products holding stock older than 90 days. */
  stale: StaleProductRow[]
  totalValue: number
}

/**
 * Peels every stocked product's pile into arrival layers (newest first — the
 * FIFO assumption run backwards) and sums the layers into age bands. This is
 * TRUE aging from movement history, where the `ageBand` field in the report
 * builder is the cheap proxy from last_sold_date: a product that sold one
 * unit yesterday looks fresh to the proxy while eleven months of its pile
 * sits in the 181–365 band here.
 */
export async function stockAgeReport(
  siteId: number,
  opts: { departmentId?: number } = {},
): Promise<StockAgeReport> {
  const asAt = localTodayIso()
  const deptClause = opts.departmentId ? 'AND p.department_id = ?' : ''
  const deptParams = opts.departmentId ? [opts.departmentId] : []

  const products = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.stock_on_hand, p.average_cost,
            COALESCE(d.name, 'No department') AS department
       FROM products p
       LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.stock_on_hand > 0 AND p.is_archived = 0 ${deptClause}`,
    deptParams,
  )

  // One sweep for every product's arrivals, newest first. DATE_FORMAT so the
  // driver hands back a plain string — a DATETIME read as a Date here would
  // arrive parsed as UTC and shift the day (the pool pins timezone to Z).
  const arrivalRows = await siteQuery<Row>(
    siteId,
    `SELECT m.product_id, DATE_FORMAT(m.created_at, '%Y-%m-%d') AS arrived_on,
            m.qty_change, m.unit_cost_excl
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id AND p.stock_on_hand > 0 AND p.is_archived = 0
      WHERE m.qty_change > 0 ${deptClause}
      ORDER BY m.product_id, m.created_at DESC, m.id DESC`,
    deptParams,
  )

  const arrivalsByProduct = new Map<number, Arrival[]>()
  for (const r of arrivalRows) {
    const pid = Number(r.product_id)
    const list = arrivalsByProduct.get(pid) ?? []
    list.push({ date: String(r.arrived_on), qty: toNum(r.qty_change), unitCost: toNum(r.unit_cost_excl) })
    arrivalsByProduct.set(pid, list)
  }

  const bandTotals = new Map<AgeBandKey, { qty: number; value: number; products: Set<number> }>()
  const bump = (key: AgeBandKey, pid: number, qty: number, value: number) => {
    const slot = bandTotals.get(key) ?? { qty: 0, value: 0, products: new Set<number>() }
    slot.qty += qty
    slot.value += value
    slot.products.add(pid)
    bandTotals.set(key, slot)
  }

  const stale: StaleProductRow[] = []
  let totalValue = 0

  for (const p of products) {
    const pid = Number(p.id)
    const onHand = toNum(p.stock_on_hand)
    const layers = ageLayers(onHand, arrivalsByProduct.get(pid) ?? [], asAt)

    let staleQty = 0
    let staleValue = 0
    let oldestDays: number | null = 0
    for (const layer of layers) {
      // A layer with no recorded cost is still stock; average cost is the
      // honest fallback for units that predate the movement log.
      const unitCost = layer.unitCost > 0 ? layer.unitCost : toNum(p.average_cost)
      const value = layer.qty * unitCost
      totalValue += value
      bump(bandFor(layer.days), pid, layer.qty, value)
      if (layer.days === null || layer.days > 90) {
        staleQty += layer.qty
        staleValue += value
      }
      if (layer.days === null) oldestDays = null
      else if (oldestDays !== null && layer.days > oldestDays) oldestDays = layer.days
    }

    if (staleQty > 0) {
      stale.push({
        productId: pid,
        code: (p.code as string | null) ?? null,
        description: String(p.description),
        department: String(p.department),
        onHand,
        staleQty,
        staleValue,
        oldestDays,
      })
    }
  }

  const bands: AgeBandRow[] = [...AGE_BANDS, { key: 'unknown' as const, label: 'Age unknown', maxDays: null }]
    .map((band) => {
      const slot = bandTotals.get(band.key)
      return {
        key: band.key,
        label: band.label,
        qty: slot?.qty ?? 0,
        value: slot?.value ?? 0,
        products: slot?.products.size ?? 0,
      }
    })
    // The unknown band earns its row only when it holds something.
    .filter((b) => b.key !== 'unknown' || b.qty > 0)

  stale.sort((a, b) => b.staleValue - a.staleValue)
  return { bands, stale: stale.slice(0, 200), totalValue }
}

/* ── 2. ABC classification ───────────────────────────────────────────────── */

export type AbcRow = {
  productId: number
  code: string | null
  description: string
  department: string
  cls: AbcClass
  unitsSold: number
  /** Consumption at cost over the window. */
  value: number
  sharePct: number
}

export type AbcReport = {
  windowDays: number
  rows: AbcRow[]
  summary: { cls: AbcClass; products: number; value: number; sharePct: number }[]
}

/**
 * Pareto cut on consumption value at cost over the window: the A products
 * are where the buying, counting and shelf attention belong; the C tail is
 * where range reviews start. Returns are netted off (a sale that came back
 * moved nothing).
 */
export async function abcReport(
  siteId: number,
  windowDays = 90,
  opts: { departmentId?: number } = {},
): Promise<AbcReport> {
  const deptClause = opts.departmentId ? 'AND p.department_id = ?' : ''
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT m.product_id, p.code, p.description,
            COALESCE(d.name, 'No department') AS department,
            SUM(-m.qty_change) AS units_sold,
            SUM(-m.qty_change * m.unit_cost_excl) AS value
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN departments d ON d.id = p.department_id
      WHERE m.movement_type IN ('sale', 'sale_return')
        AND m.created_at >= NOW() - INTERVAL ? DAY ${deptClause}
      GROUP BY m.product_id, p.code, p.description, d.name
     HAVING SUM(-m.qty_change) > 0`,
    opts.departmentId ? [windowDays, opts.departmentId] : [windowDays],
  )

  const values = rows.map((r) => ({ id: Number(r.product_id), value: toNum(r.value) }))
  const classes = classifyAbc(values)
  const total = values.reduce((sum, v) => sum + Math.max(0, v.value), 0)

  const out: AbcRow[] = rows
    .map((r) => ({
      productId: Number(r.product_id),
      code: (r.code as string | null) ?? null,
      description: String(r.description),
      department: String(r.department),
      cls: classes.get(Number(r.product_id)) ?? ('C' as const),
      unitsSold: toNum(r.units_sold),
      value: toNum(r.value),
      sharePct: total > 0 ? (toNum(r.value) / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)

  const summary = (['A', 'B', 'C'] as const).map((cls) => {
    const members = out.filter((r) => r.cls === cls)
    const value = members.reduce((sum, r) => sum + r.value, 0)
    return { cls, products: members.length, value, sharePct: total > 0 ? (value / total) * 100 : 0 }
  })

  return { windowDays, rows: out.slice(0, 300), summary }
}

/* ── 3. Stock turn ───────────────────────────────────────────────────────── */

export type StockTurnRow = {
  department: string
  cogs: number
  stockValue: number
  /** Annualised; null when the department holds no stock. */
  turn: number | null
  /** How long the shelf lasts at the window's rate of sale; null when nothing sold. */
  daysOfStock: number | null
}

export type StockTurnReport = { windowDays: number; rows: StockTurnRow[] }

/**
 * Annualised turn per department: cost of goods sold over the window scaled
 * to a year, against what the department's shelf is worth NOW. Current value
 * stands in for average inventory — the movement log could reconstruct a true
 * daily average, but for "which department is a warehouse and which is a
 * conveyor belt" the snapshot answers the same question for far less work.
 */
export async function stockTurnReport(siteId: number, windowDays = 90): Promise<StockTurnReport> {
  const [cogsRows, valueRows] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(d.name, 'No department') AS department,
              SUM(-m.qty_change * m.unit_cost_excl) AS cogs
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN departments d ON d.id = p.department_id
        WHERE m.movement_type IN ('sale', 'sale_return')
          AND m.created_at >= NOW() - INTERVAL ? DAY
        GROUP BY d.name`,
      [windowDays],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(d.name, 'No department') AS department,
              SUM(p.stock_on_hand * p.average_cost) AS stock_value
         FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.stock_on_hand > 0 AND p.is_archived = 0
        GROUP BY d.name`,
    ),
  ])

  const departments = new Map<string, { cogs: number; stockValue: number }>()
  for (const r of cogsRows) {
    departments.set(String(r.department), { cogs: toNum(r.cogs), stockValue: 0 })
  }
  for (const r of valueRows) {
    const slot = departments.get(String(r.department)) ?? { cogs: 0, stockValue: 0 }
    slot.stockValue = toNum(r.stock_value)
    departments.set(String(r.department), slot)
  }

  const rows: StockTurnRow[] = [...departments.entries()]
    .map(([department, { cogs, stockValue }]) => ({
      department,
      cogs,
      stockValue,
      turn: stockTurn(cogs, stockValue, windowDays),
      daysOfStock: daysOfStock(cogs, stockValue, windowDays),
    }))
    .sort((a, b) => (b.turn ?? -1) - (a.turn ?? -1))

  return { windowDays, rows }
}

/* ── 4. Sell-through ─────────────────────────────────────────────────────── */

export type SellThroughRow = {
  department: string
  unitsReceived: number
  unitsSold: number
  unitsOnHand: number
  /** sold ÷ (sold + on hand); null when there is nothing to measure. */
  sellThroughPct: number | null
}

export type SellThroughReport = { windowDays: number; rows: SellThroughRow[] }

/**
 * What share of the available pile actually sold, per department, alongside
 * what arrived in the window — the pairing that shows a department being
 * bought faster than it sells.
 */
export async function sellThroughReport(siteId: number, windowDays = 90): Promise<SellThroughReport> {
  const [flowRows, onHandRows] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(d.name, 'No department') AS department,
              SUM(CASE WHEN m.movement_type IN ('sale','sale_return') THEN -m.qty_change ELSE 0 END) AS units_sold,
              SUM(CASE WHEN m.movement_type = 'receipt' AND m.qty_change > 0 THEN m.qty_change ELSE 0 END) AS units_received
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN departments d ON d.id = p.department_id
        WHERE m.created_at >= NOW() - INTERVAL ? DAY
        GROUP BY d.name`,
      [windowDays],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(d.name, 'No department') AS department,
              SUM(p.stock_on_hand) AS on_hand
         FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.stock_on_hand > 0 AND p.is_archived = 0
        GROUP BY d.name`,
    ),
  ])

  const departments = new Map<string, { sold: number; received: number; onHand: number }>()
  for (const r of flowRows) {
    departments.set(String(r.department), {
      sold: toNum(r.units_sold),
      received: toNum(r.units_received),
      onHand: 0,
    })
  }
  for (const r of onHandRows) {
    const slot = departments.get(String(r.department)) ?? { sold: 0, received: 0, onHand: 0 }
    slot.onHand = toNum(r.on_hand)
    departments.set(String(r.department), slot)
  }

  const rows: SellThroughRow[] = [...departments.entries()]
    .map(([department, { sold, received, onHand }]) => {
      const ratio = sellThrough(sold, onHand)
      return {
        department,
        unitsReceived: received,
        unitsSold: sold,
        unitsOnHand: onHand,
        sellThroughPct: ratio === null ? null : ratio * 100,
      }
    })
    .sort((a, b) => (b.sellThroughPct ?? -1) - (a.sellThroughPct ?? -1))

  return { windowDays, rows }
}
