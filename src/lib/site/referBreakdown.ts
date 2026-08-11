import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { round, toNum } from '../decimals'
import { weightedAverageCost } from '../documentMath'
import { recordMovement } from './stockMovements'
import type { Actor } from './activityLog'

/**
 * Breaking a pack open, on demand, at the till.
 *
 * This is the NORMAL REFERS half of refer codes. See 103_refer_methods.sql for
 * why two methods exist and what the other one does.
 *
 * Under normal refers every pack size carries its own real pile. A shop
 * receives ten cases of beer and owns ten cases — not 240 singles. When
 * somebody buys one single, the physical shop opens a case, takes out a
 * six-pack, opens that, and sells one bottle. This module is that verb.
 *
 *   before:  10 cases    0 six-packs   0 singles
 *   sell 1 single
 *   after:    9 cases    3 six-packs   5 singles
 *
 * ── A BREAK-DOWN IS A TRANSFER BETWEEN PRODUCTS ──────────────────────────
 *
 * Structurally this is manufacturing.ts with pack sizes where that has
 * recipes: the outer out, the inner in, one transaction, every write through
 * recordMovement(). The pair is balanced, so Σ qty_change = stock_on_hand
 * still holds at BOTH levels and reconcileStock() needs no change.
 *
 * ── WHY IT LOCKS WHEN THE REST OF THE SALE DOES NOT ──────────────────────
 *
 * salesPosting.ts takes no FOR UPDATE anywhere and never reads stock_on_hand —
 * stock is allowed to go negative and a sale never refuses on quantity. That
 * is deliberate and this module does not change it.
 *
 * But a break-down READS TO DECIDE: "are there singles? no — is there a
 * six-pack?". A read-then-write with no lock is a race, and two tills selling
 * the last single would both open the same case, leaving one case of stock
 * where two were consumed. So every level this touches is locked FOR UPDATE,
 * in the caller's transaction, ascending the chain in one fixed order so two
 * tills can never take the same two locks in opposite orders and deadlock.
 *
 * ── IT NEVER REFUSES ─────────────────────────────────────────────────────
 *
 * If the whole chain is empty the single simply goes negative, exactly as it
 * does today. A till that refuses to sell because head office set up a refer
 * code badly is worse than a till that sells and reports a negative. This
 * module opens what it can and gets out of the way.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * Deep enough for single → six-pack → case → pallet → container and one more,
 * matching MAX_DEPTH in productComposition.ts. A chain longer than this is a
 * setup mistake, and the cap is what stops a cycle spinning forever.
 */
const MAX_LEVELS = 5

type ReferParent = {
  /** The outer pack — the thing that gets opened. */
  productId: number
  code: string
  description: string
  /** How many of the CHILD come out of one parent. */
  factor: number
}

/**
 * Who refers to this product with method 'normal' — the next size up.
 *
 * Walks UP the chain, which is the opposite direction to resolveComponents().
 * ix_refer_target_method (103) covers exactly this lookup.
 *
 * The chain is 1:1 by PRIMARY KEY (product_id) on the referring side, but
 * nothing stops two packs pointing at the same target, so this orders by
 * factor to make the choice deterministic: open the SMALLEST pack that
 * contains this one. Opening a pallet to sell one bottle when a six-pack was
 * available would be obtuse, and an arbitrary order would make the same sale
 * behave differently on two tills.
 */
async function referParentOf(
  tx: PoolConnection,
  productId: number,
): Promise<ReferParent | null> {
  const [rows] = await tx.execute(
    `SELECT f.product_id, f.factor, p.code, p.description
       FROM product_refers f
       JOIN products p ON p.id = f.product_id
      WHERE f.target_id = ?
        AND f.method = 'normal'
        AND f.factor > 0
        AND p.is_archived = 0
      ORDER BY f.factor ASC, f.product_id ASC
      LIMIT 1`,
    [productId] as never,
  )

  const row = (rows as Row[])[0]
  if (!row) return null

  return {
    productId: Number(row.product_id),
    code: String(row.code ?? ''),
    description: String(row.description ?? ''),
    factor: toNum(row.factor),
  }
}

/** What one pack is worth, and how much of it is on the shelf right now. */
async function lockPosition(
  tx: PoolConnection,
  productId: number,
): Promise<{ stockOnHand: number; averageCost: number }> {
  const [rows] = await tx.execute(
    'SELECT stock_on_hand, average_cost FROM products WHERE id = ? FOR UPDATE',
    [productId] as never,
  )
  const row = (rows as Row[])[0]
  return {
    stockOnHand: toNum(row?.stock_on_hand),
    averageCost: toNum(row?.average_cost),
  }
}

export type BreakdownStep = {
  /** The pack that was opened. */
  parentId: number
  parentCode: string
  /** How many of it were opened. */
  packsOpened: number
  /** The product they became. */
  childId: number
  /** How many of the child came out. */
  unitsGained: number
}

export type EnsureStockContext = {
  source?: string
  sourceDocId?: number | null
  sourceLineId?: number | null
  terminalId?: number | null
  shiftId?: number | null
  locationId?: number | null
}

/**
 * Make sure `needed` of a product is on the shelf, opening larger packs if it
 * is not.
 *
 * Returns what it opened, innermost first, so the caller can note it on the
 * movement or show it on a slip. An empty array means nothing had to be
 * opened — either there was already enough, or there is nothing above this
 * product to open.
 *
 * Recursive: filling a six-pack shortfall may require opening a case, which
 * may require opening a pallet. Each level asks the level above for exactly as
 * many packs as it needs and no more, so a sale of one single out of a full
 * pallet opens one of each and not the whole stack.
 */
export async function ensureStock(
  tx: PoolConnection,
  actor: Actor,
  productId: number,
  needed: number,
  ctx: EnsureStockContext = {},
  depth = 0,
): Promise<BreakdownStep[]> {
  if (depth > MAX_LEVELS) return []
  if (!Number.isFinite(needed) || needed <= 0) return []

  const here = await lockPosition(tx, productId)
  const shortfall = round(needed - here.stockOnHand, 3)
  if (shortfall <= 0) return []

  const parent = await referParentOf(tx, productId)
  if (!parent) return []

  /*
   * Round UP. A shortfall of one single out of a six-pack needs a whole
   * six-pack opened — you cannot open a sixth of one, and the other five
   * bottles stay on the shelf as stock. That remainder is the whole point of
   * normal refers: it is what the next four customers buy.
   */
  const packsNeeded = Math.ceil(round(shortfall / parent.factor, 6))

  // The parent may be short too. Ask it to fill itself first, and only then
  // open it — so the recursion bottoms out at whatever level actually has
  // stock, or at the top of the chain if none of them do.
  const upstream = await ensureStock(tx, actor, parent.productId, packsNeeded, ctx, depth + 1)

  // Re-read AFTER the recursion: opening a pallet just changed how many cases
  // are on the shelf, and this is the figure that decides how many we may open.
  const parentNow = await lockPosition(tx, parent.productId)

  // Open only what is actually there. If the chain ran dry we open what we
  // found and let the child go negative for the rest — see the module note.
  const packsToOpen = Math.min(packsNeeded, Math.floor(round(parentNow.stockOnHand, 3)))
  if (packsToOpen <= 0) return upstream

  const unitsGained = round(packsToOpen * parent.factor, 3)

  /*
   * Cost travels with the units, or the child's average cost is a lie.
   *
   * A case at R240 holding four six-packs makes each six-pack worth R60. A
   * six-pack that appeared from nowhere at cost 0 would poison the GP on every
   * sale of it and on every report downstream, and nothing else in the system
   * would ever correct it — recordMovement() records a cost but never blends
   * one. So this module is a deliberate writer of products.average_cost,
   * alongside purchasePosting, manufacturing, storeTransfers and products.
   */
  const unitCost = round(parentNow.averageCost / parent.factor, 4)

  const note = `Opened ${packsToOpen} × ${parent.code || parent.description}`.slice(0, 190)

  await recordMovement(tx, actor, {
    productId: parent.productId,
    locationId: ctx.locationId ?? null,
    movementType: 'unpack_out',
    qtyChange: -packsToOpen,
    unitCostExcl: parentNow.averageCost,
    source: ctx.source ?? 'unpack',
    sourceDocId: ctx.sourceDocId ?? null,
    sourceLineId: ctx.sourceLineId ?? null,
    terminalId: ctx.terminalId ?? null,
    shiftId: ctx.shiftId ?? null,
    note: `Broken into ${unitsGained}`.slice(0, 190),
  })

  await recordMovement(tx, actor, {
    productId,
    locationId: ctx.locationId ?? null,
    movementType: 'unpack_in',
    qtyChange: unitsGained,
    unitCostExcl: unitCost,
    source: ctx.source ?? 'unpack',
    sourceDocId: ctx.sourceDocId ?? null,
    sourceLineId: ctx.sourceLineId ?? null,
    terminalId: ctx.terminalId ?? null,
    shiftId: ctx.shiftId ?? null,
    note,
  })

  // Blend the child's cost against what was already there, exactly as a
  // receipt does. `here` was read before the movement, which is the position
  // the blend has to weigh against.
  const blended = weightedAverageCost({
    existingQty: here.stockOnHand,
    existingCostExcl: here.averageCost,
    receivedQty: unitsGained,
    receivedCostExcl: unitCost,
  })

  await tx.execute('UPDATE products SET average_cost = ? WHERE id = ?', [
    blended.toFixed(4),
    productId,
  ] as never)

  return [
    ...upstream,
    {
      parentId: parent.productId,
      parentCode: parent.code,
      packsOpened: packsToOpen,
      childId: productId,
      unitsGained,
    },
  ]
}
