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

/**
 * The cost column this site prices an ingredient off.
 *
 * ── WHY THIS IS A SETTING AND NOT A CONSTANT ─────────────────────────────
 *
 * This file used to read `average_cost` unconditionally. That is right on a
 * site costing at weighted average and wrong on one costing at last — and
 * every OTHER surface that reads a cost already asks: tillSearch.ts,
 * specials.ts and onlineOrders.ts all branch on `cost_basis`. A recipe costing
 * off a different column than the till it is sold on is the two halves of the
 * same question giving different answers.
 *
 * It also made a typed cost look broken. On a `last` site, typing 180 on the
 * mince moves last_cost and leaves average_cost at what was actually paid;
 * recipes went on reading the average, so the recipe screen showed the old
 * figure and every burger kept its old cost. Nothing was wrong with the write
 * — the reader was looking at the wrong column.
 *
 * ── WHY average_cost IS STILL NOT TYPEABLE ───────────────────────────────
 *
 * On an `average` site a typed cost STILL does not move a recipe, and that is
 * correct rather than a gap: average_cost is a consequence of purchases, and
 * updateProduct refuses to let a form overwrite it precisely so a typed number
 * cannot falsify stock valuation. On such a site the honest way to move an
 * ingredient's cost is to buy it at the new price, and the GRV cascade already
 * carries that through to every recipe.
 */
async function costColumn(siteId: number): Promise<'last_cost' | 'average_cost'> {
  const { getSetting } = await import('./settings')
  const basis = await getSetting(siteId, 'cost_basis').catch(() => 'average')
  return basis === 'last' ? 'last_cost' : 'average_cost'
}

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

/**
 * How a refer link moves stock.
 *
 *   subtract — the pack carries no pile. Selling one deducts `factor` of the
 *              target, and receiving one adds `factor` of the target. All
 *              stock lives at the bottom of the chain.
 *   normal   — the pack carries its OWN pile. Selling the target when it is
 *              empty breaks one of these open instead. See referBreakdown.ts.
 */
export type ReferMethod = 'normal' | 'subtract'

export type ReferLink = {
  productId: number
  targetId: number
  targetCode: string
  targetDescription: string
  targetType: ProductTypeId
  factor: number
  method: ReferMethod
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
  // Interpolated, not bound: a column name cannot be a placeholder, and the
  // value is one of two literals this file chose — never anything a caller sent.
  const cost = await costColumn(siteId)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.id, r.parent_id, r.component_id, r.qty, r.wastage_pct, r.position,
            p.code, p.description, p.product_type, p.${cost} AS unit_cost, p.stock_on_hand
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
    unitCostExcl: toNum(r.unit_cost),
    stockOnHand: toNum(r.stock_on_hand),
  }))
}

export async function getRefer(siteId: number, productId: number): Promise<ReferLink | null> {
  const cost = await costColumn(siteId)

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT f.product_id, f.target_id, f.factor, f.method,
            p.code, p.description, p.product_type, p.${cost} AS unit_cost, p.stock_on_hand
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
    // A site that has not run 103 yet returns undefined here, and the
    // behaviour it should keep is the one it already has.
    method: row.method === 'normal' ? 'normal' : 'subtract',
    unitCostExcl: toNum(row.unit_cost),
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

  // Everything else is its own component: one of it consumes one of it. This
  // is the LEAF — the only rung that reads a real purchased cost, so it is the
  // one the site's basis actually decides.
  const cost = await costColumn(siteId)
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, description, ${cost} AS unit_cost FROM products WHERE id = ?`,
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
        unitCostExcl: toNum(row.unit_cost),
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

/**
 * Writes ONE refer link.
 *
 * This is the primitive, and it takes the method it is given. The rule that a
 * method belongs to the whole group of linked products — change it on one link
 * and every link connected to it changes with it — is enforced one level up,
 * in referRange.ts, which is what the screens call. Putting it here as well
 * would mean a caller building a chain link by link, ascending, could not set
 * the first link's method without the second one overruling it.
 */
export async function saveRefer(
  siteId: number,
  productId: number,
  targetId: number,
  factor: number,
  method: ReferMethod = 'subtract',
): Promise<SaveResult> {
  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id, product_type, stock_on_hand FROM products WHERE id = ?',
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

  /*
   * Switching method with stock on the floor is refused, because the figure
   * already counted means something different under each one. Ten cases under
   * normal refers is ten cases; the same ten under subtract pack is a label on
   * 240 singles that were never received. Silently reinterpreting them would
   * either invent stock or strand it, and neither is something a form can
   * explain afterwards. Empty the pack out first, or unlink and relink.
   */
  const existing = await getRefer(siteId, productId)
  if (existing && existing.method !== method) {
    const onHand = toNum(product.stock_on_hand)
    if (onHand !== 0) {
      return {
        ok: false,
        error:
          `This product still has ${onHand} on hand. Bring it to zero before changing the refer method, ` +
          `because that quantity means something different under each one.`,
      }
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO product_refers (product_id, target_id, factor, method)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE
       target_id = VALUES(target_id), factor = VALUES(factor), method = VALUES(method)`,
    [productId, targetId, round(factor, 3).toFixed(3), method],
  )

  const check = await resolveComponents(siteId, productId, 'refer')
  if (!check.ok) return { ok: false, error: check.error }

  return { ok: true }
}

export async function clearRefer(siteId: number, productId: number): Promise<SaveResult> {
  await siteExecute(siteId, 'DELETE FROM product_refers WHERE product_id = ?', [productId])
  return { ok: true }
}

/**
 * Which of these products explode into components when they sell.
 *
 * A `refer` does when its method is SUBTRACT PACK — a six-pack is six singles
 * and there is only one pile. It does NOT when the method is NORMAL: under
 * that method the pack carries a pile of its own, so it sells like any stocked
 * product and larger packs are broken open to refill it instead. See
 * referBreakdown.ts and 103_refer_methods.sql.
 *
 * A refer product with no link at all is treated as exploding, so the sale
 * path reaches resolveComponents() and refuses with "no linked product set up
 * yet" rather than silently selling an unconfigured pack off a pile it does
 * not have.
 *
 * A `recipe` does UNLESS it is manufactured. A manufactured recipe was built
 * ahead of time by a manufacturing order, which already consumed its
 * ingredients and put finished units on a pile of their own; exploding it again
 * at the till would deduct the ingredients twice and leave the finished pile
 * untouched. See manufacturing.ts.
 *
 * One query and one definition, shared by salesPosting, salesReversal and the
 * void path — they must agree, or a credit note returns ingredients a sale
 * never took.
 */
export async function explodingProducts(
  siteId: number,
  productIds: readonly number[],
): Promise<Set<number>> {
  const ids = [...new Set(productIds)].filter((id) => id > 0)
  if (ids.length === 0) return new Set()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id
       FROM products p
       LEFT JOIN product_refers f ON f.product_id = p.id
      WHERE p.id IN (${ids.map(() => '?').join(',')})
        AND (
          (p.product_type = 'refer' AND (f.method IS NULL OR f.method = 'subtract'))
          OR (p.product_type = 'recipe' AND p.is_manufactured = 0)
        )`,
    ids,
  )
  return new Set(rows.map((r) => Number(r.id)))
}

/**
 * A SQL fragment matching refer products that carry a real pile of their own.
 *
 * Under the normal method a pack is physically owned — ten cases of beer are
 * ten cases, sitting in the store room. It must therefore be counted on a
 * stock take and proposed by reorder, exactly like any other stocked product.
 * Under subtract pack it is a label on somebody else's pile and must be
 * excluded from both.
 *
 * ── WHY THIS IS ONE STRING AND NOT TWO EDITS ─────────────────────────────
 *
 * The two callers keep their lists in OPPOSITE polarity — stockTakes.ts has a
 * blacklist of types that cannot be counted, reorderSuggestions.ts a whitelist
 * of types that can. They are complements maintained independently, so the
 * same rule written twice would eventually be written two different ways, and
 * the failure is silent: a case counted but never reorderable, or reordered
 * but never counted, with nothing to make the disagreement visible.
 *
 * `alias` is the products table's alias in the caller's query.
 */
export function stockedReferSql(alias = 'p'): string {
  return `EXISTS (
    SELECT 1 FROM product_refers f
     WHERE f.product_id = ${alias}.id AND f.method = 'normal'
  )`
}

/**
 * Which of these products can be refilled by breaking a bigger pack open.
 *
 * ── WHY THIS IS NOT A PRODUCT-TYPE CHECK ─────────────────────────────────
 *
 * The obvious guard is `productType === 'refer'`, and it is wrong at exactly
 * the place it matters most. The BASE of a ladder is deliberately an ordinary
 * `normal` product — createReferRange forces it, because a refer with nothing
 * underneath it is refused by resolveComponents on every sale. So the single at
 * the bottom, the one a shop sells most often and the one a case exists to
 * refill, is the only rung a type check excludes.
 *
 * What matters is not what a product IS but what sits ABOVE it: any
 * normal-method pack drawing on it can be opened to refill it. That is the same
 * condition referParentOf() uses to pick a pack, so the guard and the cascade
 * agree by construction rather than by coincidence.
 *
 * One query for a whole document, because the sale path holds a transaction
 * open while it runs and a per-line round trip inside that is a lock held for
 * no reason.
 */
export async function refillableProducts(
  siteId: number,
  productIds: readonly number[],
): Promise<Set<number>> {
  const ids = [...new Set(productIds)].filter((id) => id > 0)
  if (ids.length === 0) return new Set()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT DISTINCT f.target_id AS id
       FROM product_refers f
       JOIN products p ON p.id = f.product_id
      WHERE f.target_id IN (${ids.map(() => '?').join(',')})
        AND f.method = 'normal'
        AND f.factor > 0
        AND p.is_archived = 0`,
    ids,
  )

  return new Set(rows.map((r) => Number(r.id)))
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

/* ── Cost cascade ───────────────────────────────────────────────────────── */

/**
 * Rewrites the derived cost of everything built out of a product whose own
 * cost has just moved.
 *
 * Reprice tomatoes and every burger containing tomatoes costs more, including
 * burgers reached through another made item. A GRV that lands a new tomato
 * price, or somebody typing a cost on the ingredient's own form, both end here.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * A composed product's stored cost is a CACHE. The truth is
 * compositionCost() — the same function the till charges a sale at — and the
 * stored figure exists because reports, the price list and the product grid
 * read a column rather than resolving a tree per row.
 *
 * A cache with nothing to invalidate it is just a wrong number that looks
 * authoritative. Before this, the cost was written only when the composed
 * product ITSELF was saved: repricing an ingredient moved the ingredient and
 * left every burger reporting the margin it had last time somebody opened it.
 * The till charged the right cost and every report disagreed with the till.
 *
 * ── WHY IT REPLACED cascadeReferCosts RATHER THAN JOINING IT ─────────────
 *
 * That function did exactly this for refer ladders and stopped at the recipe
 * table. But the two link kinds INTERLEAVE: a six-pack of burgers is a refer
 * onto a recipe, and a recipe can list a six-pack as an ingredient. Two walks
 * that each know one table would each stop at the first rung of the other
 * kind, so a cost would climb halfway up a mixed chain and halt — the worst
 * outcome, because a partly-updated chain looks updated.
 *
 * One walk over the UNION of both tables has no such seam. cascadeReferCosts
 * now delegates here and is kept only as its name.
 *
 * ── WHY IT WALKS EVERY DEPENDANT ─────────────────────────────────────────
 *
 * Breadth-first over all dependants, not one branch. A ladder with a 6-pack
 * and a 10-pack on the same single, or an onion used by twenty burgers, must
 * reach all of them; following one branch would leave the rest un-costed.
 *
 * Depth-capped rather than cycle-detected, matching resolveComponents. `seen`
 * also stops a diamond — two burgers in one platter — being costed twice.
 *
 * ── NEVER FAILS ITS CALLER ───────────────────────────────────────────────
 *
 * A cost that could not be recomputed leaves the stored figure alone and the
 * caller still succeeds. Refusing to receive stock because an unrelated recipe
 * upstairs is missing an ingredient would make a broken setup impossible to
 * edit your way out of — and the goods are on the shelf either way. Returns
 * how many were rewritten so a caller can say so.
 */
export async function cascadeCompositionCosts(
  siteId: number,
  changedId: number,
): Promise<number> {
  /*
   * Deeper than resolveComponents' MAX_DEPTH, and deliberately.
   *
   * That cap limits how far DOWN one product resolves; this limits how far UP
   * a change climbs, and the two are different chains. A pallet -> case ->
   * six-pack -> single ladder with a recipe at the bottom is already four
   * rungs before any nesting.
   */
  const MAX = 8

  let frontier = [changedId]
  const seen = new Set<number>([changedId])
  let written = 0

  for (let depth = 0; depth < MAX && frontier.length; depth++) {
    const placeholders = frontier.map(() => '?').join(',')

    // Both link tables in one query. UNION rather than UNION ALL: a product
    // that reaches the frontier twice — an ingredient listed by a recipe that
    // a refer also points at — is one product to recost, not two.
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT p.id, p.product_type
         FROM product_recipes r
         JOIN products p ON p.id = r.parent_id
        WHERE r.component_id IN (${placeholders})
        UNION
       SELECT p.id, p.product_type
         FROM product_refers f
         JOIN products p ON p.id = f.product_id
        WHERE f.target_id IN (${placeholders})`,
      [...frontier, ...frontier],
    )

    const next: number[] = []
    for (const r of rows) {
      const id = Number(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      next.push(id)

      // Resolved from the product's OWN type rather than assumed from which
      // table found it: a row built before the type was enforced would
      // otherwise resolve as its own single component and write the
      // ingredient's cost straight onto the made item.
      const cost = await compositionCost(
        siteId,
        id,
        String(r.product_type ?? 'normal') as ProductTypeId,
      ).catch(() => null)

      // Null is "could not resolve", and 0 is very nearly always the same
      // thing — a recipe whose ingredients genuinely cost nothing has no cost
      // to spread. Writing the zero would replace one wrong figure with
      // another while destroying whatever was there.
      if (cost === null || cost <= 0) continue

      await siteExecute(
        siteId,
        'UPDATE products SET last_cost = ?, average_cost = ? WHERE id = ?',
        [cost.toFixed(4), cost.toFixed(4), id],
      )
      written++
    }

    // The ones just rewritten are the next frontier: a burger whose cost moved
    // may itself be an ingredient in a platter. Products skipped above are
    // still walked THROUGH — an unresolvable rung must not sever the chain
    // above it.
    frontier = next
  }

  return written
}
