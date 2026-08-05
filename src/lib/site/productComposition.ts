import 'server-only'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '@/lib/siteDb'
import { round, toNum } from '@/lib/decimals'
import type { ProductTypeId } from '@/lib/productTypes'

/**
 * What actually leaves the shelf when a composed product sells.
 *
 * Two product types have waited since the beginning for this:
 *
 *   recipe — a made item consumes several others in fixed quantities. Selling
 *            one burger moves a patty, a bun and a slice of cheese, and moves
 *            nothing of the burger itself, because there is no pile of burgers.
 *
 *   refer  — one product IS another, counted differently. A six-pack is six
 *            singles. Selling one moves six of the single, and again nothing
 *            of its own, because there is only one pile and it is counted in
 *            singles.
 *
 * Both resolve to the same answer — a list of (real product, real quantity) —
 * which is why they share this file and why the posting engine only has to
 * learn one new idea rather than two.
 *
 * ── THE INVARIANT THIS PROTECTS ──────────────────────────────────────────
 *
 * Σ stock_movements.qty_change per product still equals stock_on_hand. A
 * recipe sale writes movements for its COMPONENTS, each a real quantity of a
 * real product. It writes none for the parent. So the reconciliation report
 * keeps working, and a burger never accumulates a phantom negative stock
 * figure that nobody can explain.
 */

type Row = Record<string, unknown>

/** How deep nesting may go before we call it a cycle. */
const MAX_DEPTH = 5

export type RecipeLine = {
  id: number
  parentId: number
  componentId: number
  componentCode: string
  componentDescription: string
  componentType: ProductTypeId
  qty: number
  wastagePct: number
  position: number
  /** Cost of one component unit, for costing the made item. */
  unitCostExcl: number
  stockOnHand: number
}

export type ReferLink = {
  productId: number
  targetId: number
  targetCode: string
  targetDescription: string
  targetType: ProductTypeId
  factor: number
  unitCostExcl: number
  /** The target's stock, in the target's own units. */
  targetStockOnHand: number
}

/** One real product and the real quantity of it that a sale consumes. */
export type ResolvedComponent = {
  productId: number
  code: string
  description: string
  /** Per ONE of the thing being sold. Multiply by the sale quantity. */
  qtyPerUnit: number
  unitCostExcl: number
}

export async function listRecipe(siteId: number, parentId: number): Promise<RecipeLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.id, r.parent_id, r.component_id, r.qty, r.wastage_pct, r.position,
            p.code, p.description, p.product_type, p.average_cost, p.stock_on_hand
       FROM product_recipes r
       JOIN products p ON p.id = r.component_id
      WHERE r.parent_id = ?
      ORDER BY r.position, r.id`,
    [parentId],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    parentId: Number(r.parent_id),
    componentId: Number(r.component_id),
    componentCode: String(r.code),
    componentDescription: String(r.description),
    componentType: String(r.product_type) as ProductTypeId,
    qty: toNum(r.qty),
    wastagePct: toNum(r.wastage_pct),
    position: Number(r.position),
    unitCostExcl: toNum(r.average_cost),
    stockOnHand: toNum(r.stock_on_hand),
  }))
}

export async function getRefer(siteId: number, productId: number): Promise<ReferLink | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT f.product_id, f.target_id, f.factor,
            p.code, p.description, p.product_type, p.average_cost, p.stock_on_hand
       FROM product_refers f
       JOIN products p ON p.id = f.target_id
      WHERE f.product_id = ?`,
    [productId],
  )
  if (!row) return null

  return {
    productId: Number(row.product_id),
    targetId: Number(row.target_id),
    targetCode: String(row.code),
    targetDescription: String(row.description),
    targetType: String(row.product_type) as ProductTypeId,
    factor: toNum(row.factor),
    unitCostExcl: toNum(row.average_cost),
    targetStockOnHand: toNum(row.stock_on_hand),
  }
}

export type ResolveResult =
  | { ok: true; components: ResolvedComponent[] }
  | { ok: false; error: string }

/**
 * Resolves a product to the real stock it consumes, per one unit sold.
 *
 * A plain stocked product resolves to itself at qty 1 — so the caller has one
 * code path rather than a branch per product type.
 *
 * Nesting is allowed (a recipe whose component is itself a recipe) and is
 * depth-capped rather than cycle-detected by graph search. The cap is simpler,
 * it cannot be defeated by a cycle that is longer than the detector expects,
 * and five levels is far beyond anything a shop will legitimately build.
 */
export async function resolveComponents(
  siteId: number,
  productId: number,
  productType: ProductTypeId,
  depth = 0,
): Promise<ResolveResult> {
  if (depth > MAX_DEPTH) {
    return {
      ok: false,
      error: 'This product refers to itself, directly or through another product. Fix the setup before selling it.',
    }
  }

  if (productType === 'refer') {
    const link = await getRefer(siteId, productId)
    if (!link) {
      return { ok: false, error: 'This refer product has no linked product set up yet.' }
    }
    if (link.factor <= 0) {
      return { ok: false, error: 'The refer factor must be more than zero.' }
    }
    if (link.targetId === productId) {
      return { ok: false, error: 'A refer product cannot point at itself.' }
    }

    const nested = await resolveComponents(siteId, link.targetId, link.targetType, depth + 1)
    if (!nested.ok) return nested

    // The factor multiplies whatever the target resolves to, so a six-pack of
    // a made item consumes six recipes' worth of ingredients.
    return {
      ok: true,
      components: nested.components.map((c) => ({
        ...c,
        qtyPerUnit: round(c.qtyPerUnit * link.factor, 4),
      })),
    }
  }

  if (productType === 'recipe') {
    const lines = await listRecipe(siteId, productId)
    if (lines.length === 0) {
      return { ok: false, error: 'This recipe has no ingredients set up yet.' }
    }

    const components: ResolvedComponent[] = []
    for (const line of lines) {
      if (line.componentId === productId) {
        return { ok: false, error: 'A recipe cannot contain itself.' }
      }
      // Wastage is on top of the quantity used: 10% wastage on 1kg means 1.1kg
      // leaves the shelf to put 1kg in the product.
      const withWastage = round(line.qty * (1 + line.wastagePct / 100), 4)

      const nested = await resolveComponents(siteId, line.componentId, line.componentType, depth + 1)
      if (!nested.ok) return nested

      for (const c of nested.components) {
        components.push({ ...c, qtyPerUnit: round(c.qtyPerUnit * withWastage, 4) })
      }
    }

    return { ok: true, components: merge(components) }
  }

  // Everything else is its own component: one of it consumes one of it.
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, description, average_cost FROM products WHERE id = ?',
    [productId],
  )
  if (!row) return { ok: false, error: 'That product no longer exists.' }

  return {
    ok: true,
    components: [
      {
        productId: Number(row.id),
        code: String(row.code),
        description: String(row.description),
        qtyPerUnit: 1,
        unitCostExcl: toNum(row.average_cost),
      },
    ],
  }
}

/**
 * Sums repeated components.
 *
 * A recipe using onion twice — once in the filling, once as garnish — must
 * deduct one combined quantity, not write two movements. Two movements would
 * reconcile fine but read as a bug on the product's history.
 */
function merge(components: readonly ResolvedComponent[]): ResolvedComponent[] {
  const byId = new Map<number, ResolvedComponent>()
  for (const c of components) {
    const existing = byId.get(c.productId)
    if (existing) existing.qtyPerUnit = round(existing.qtyPerUnit + c.qtyPerUnit, 4)
    else byId.set(c.productId, { ...c })
  }
  return [...byId.values()]
}

/**
 * What one of a composed product costs to make.
 *
 * Used when a recipe product is sold, because its own `average_cost` is
 * meaningless — nothing was ever bought called "burger". The GP report needs a
 * real cost, and the only true one is the sum of what went into it.
 */
export async function compositionCost(
  siteId: number,
  productId: number,
  productType: ProductTypeId,
): Promise<number | null> {
  const resolved = await resolveComponents(siteId, productId, productType)
  if (!resolved.ok) return null

  return round(
    resolved.components.reduce((sum, c) => sum + c.qtyPerUnit * c.unitCostExcl, 0),
    4,
  )
}

/**
 * How many of a composed product could be made from what is on hand.
 *
 * The binding ingredient decides: two buns and ten patties makes two burgers.
 * A recipe product's own `stock_on_hand` is always zero, so this is the only
 * meaningful availability figure for one.
 */
export async function buildableQty(
  siteId: number,
  productId: number,
  productType: ProductTypeId,
): Promise<number | null> {
  const resolved = await resolveComponents(siteId, productId, productType)
  if (!resolved.ok || resolved.components.length === 0) return null

  const stocks = await siteQuery<Row>(
    siteId,
    `SELECT id, stock_on_hand FROM products
      WHERE id IN (${resolved.components.map(() => '?').join(',')})`,
    resolved.components.map((c) => c.productId),
  )
  const byId = new Map(stocks.map((r) => [Number(r.id), toNum(r.stock_on_hand)]))

  let buildable = Infinity
  for (const c of resolved.components) {
    if (c.qtyPerUnit <= 0) continue
    buildable = Math.min(buildable, (byId.get(c.productId) ?? 0) / c.qtyPerUnit)
  }

  return Number.isFinite(buildable) ? round(buildable, 3) : null
}

/* ── Setup ──────────────────────────────────────────────────────────────── */

export type RecipeInput = { componentId: number; qty: number; wastagePct?: number }
export type SaveResult = { ok: true } | { ok: false; error: string }

export async function saveRecipe(
  siteId: number,
  parentId: number,
  lines: readonly RecipeInput[],
): Promise<SaveResult> {
  const parent = await siteQueryOne<Row>(
    siteId,
    'SELECT id, product_type FROM products WHERE id = ?',
    [parentId],
  )
  if (!parent) return { ok: false, error: 'That product no longer exists.' }
  if (String(parent.product_type) !== 'recipe') {
    return { ok: false, error: 'Only a recipe product carries a component list.' }
  }

  const seen = new Set<number>()
  for (const line of lines) {
    if (!Number.isFinite(line.componentId) || line.componentId <= 0) {
      return { ok: false, error: 'Choose a product for every ingredient line.' }
    }
    if (line.componentId === parentId) {
      return { ok: false, error: 'A recipe cannot contain itself.' }
    }
    if (seen.has(line.componentId)) {
      return { ok: false, error: 'The same ingredient is listed twice. Combine the quantities.' }
    }
    seen.add(line.componentId)

    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      return { ok: false, error: 'Every ingredient needs a quantity of more than zero.' }
    }
    const wastage = line.wastagePct ?? 0
    if (wastage < 0 || wastage >= 100) {
      return { ok: false, error: 'Wastage must be between 0 and 100 percent.' }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_recipes WHERE parent_id = ?', [parentId] as never)

    for (const [index, line] of lines.entries()) {
      await tx.execute(
        `INSERT INTO product_recipes (parent_id, component_id, qty, wastage_pct, position)
         VALUES (?,?,?,?,?)`,
        [
          parentId,
          line.componentId,
          round(line.qty, 3).toFixed(3),
          round(line.wastagePct ?? 0, 3).toFixed(3),
          index,
        ] as never,
      )
    }
  })

  // Checked AFTER saving, because a cycle can only be seen once the rows exist
  // — and reported so the user fixes it before selling rather than at the till.
  const check = await resolveComponents(siteId, parentId, 'recipe')
  if (!check.ok) return { ok: false, error: check.error }

  return { ok: true }
}

export async function saveRefer(
  siteId: number,
  productId: number,
  targetId: number,
  factor: number,
): Promise<SaveResult> {
  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id, product_type FROM products WHERE id = ?',
    [productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }
  if (String(product.product_type) !== 'refer') {
    return { ok: false, error: 'Only a refer product links to another product.' }
  }
  if (targetId === productId) return { ok: false, error: 'A refer product cannot point at itself.' }

  const target = await siteQueryOne<Row>(
    siteId,
    'SELECT id, product_type FROM products WHERE id = ?',
    [targetId],
  )
  if (!target) return { ok: false, error: 'Choose the product this one refers to.' }
  if (!Number.isFinite(factor) || factor <= 0) {
    return { ok: false, error: 'The factor must be more than zero — it is how many of the target this is.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO product_refers (product_id, target_id, factor)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE target_id = VALUES(target_id), factor = VALUES(factor)`,
    [productId, targetId, round(factor, 3).toFixed(3)],
  )

  const check = await resolveComponents(siteId, productId, 'refer')
  if (!check.ok) return { ok: false, error: check.error }

  return { ok: true }
}

export async function clearRefer(siteId: number, productId: number): Promise<SaveResult> {
  await siteExecute(siteId, 'DELETE FROM product_refers WHERE product_id = ?', [productId])
  return { ok: true }
}

/** Products that use this one as an ingredient — shown before deleting it. */
export async function usedInRecipes(
  siteId: number,
  componentId: number,
): Promise<{ id: number; code: string; description: string }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description
       FROM product_recipes r
       JOIN products p ON p.id = r.parent_id
      WHERE r.component_id = ?
      UNION
     SELECT p.id, p.code, p.description
       FROM product_refers f
       JOIN products p ON p.id = f.product_id
      WHERE f.target_id = ?`,
    [componentId, componentId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
  }))
}
