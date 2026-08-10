import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { weightedAverageCost } from '../documentMath'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { resolveComponents, type ResolvedComponent } from './productComposition'
import { isPeriodLocked } from './settings'
import type { Actor } from './activityLog'
import type { ProductTypeId } from '../productTypes'

/**
 * Making things: turning a recipe into stock you can count.
 *
 * ── WHAT THIS IS, STRUCTURALLY ─────────────────────────────────────────────
 *
 * A transfer between PRODUCTS, where stockTransfers.ts is a transfer between
 * LOCATIONS. Components out, finished goods in, one transaction, every write
 * through recordMovement(). That framing is worth holding onto because it makes
 * the invariant obvious.
 *
 * The difference from a transfer is that the site total DOES move: 25kg of
 * flour leaves and 50 loaves arrive, and those are not the same goods. Value is
 * transformed rather than relocated. All three stock invariants still hold, for
 * the same reason they hold everywhere else — nothing here writes
 * products.stock_on_hand except recordMovement().
 *
 * ── WHY A RECIPE PRODUCT MIGHT NOT WANT THIS ───────────────────────────────
 *
 * 020 built recipes to explode AT THE TILL: sell a burger and a patty, a bun
 * and a slice of cheese move, while the burger itself moves nothing because
 * there is no pile of burgers. That is right for a burger and wrong for a loaf
 * of bread, which is baked on Monday and sold on Wednesday.
 *
 * products.is_manufactured decides which. It defaults to 0, so every recipe
 * product already in the field keeps exploding exactly as it does today, and
 * only a product somebody has deliberately ticked ever reaches this module.
 *
 * ── THE COST RULE, AND THE RULE IT BREAKS ──────────────────────────────────
 *
 * purchasePosting.ts calls itself the only writer of products.average_cost.
 * This module is the second, deliberately: a made item has no purchase price
 * because nothing is ever bought called "loaf". If a build did not set the
 * cost, average_cost would stay at 0.0000 forever and every loaf sold would
 * report 100% gross profit.
 *
 * The blend uses the SAME weightedAverageCost() helper the GRV uses, including
 * its edge cases, so the two writers cannot drift apart in their arithmetic.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ManufacturingStatus = 'draft' | 'posted' | 'cancelled'

/** A component as it will be consumed, with the pile it will come out of. */
export type BuildComponent = {
  productId: number
  code: string
  description: string
  /** Per ONE of the parent, wastage already applied. */
  qtyPerUnit: number
  /** qtyPerUnit x the build quantity. */
  qtyRequired: number
  unitCostExcl: number
  lineCostExcl: number
  /** What the FROM location actually holds. */
  available: number
  /** How much is missing. Zero when there is enough. */
  shortBy: number
}

export type BuildPreview = {
  productId: number
  code: string
  description: string
  qty: number
  components: BuildComponent[]
  componentCost: number
  /** Cost of ONE made unit, before overhead. */
  unitCostExcl: number
  /** How many could be made from what is on hand — the binding ingredient. */
  buildable: number
  /** Every component that is short, so the screen can say so in one place. */
  shortages: BuildComponent[]
}

export type OverheadInput = { description: string; amountExcl: number; accountId?: number | null }

export type BuildInput = {
  productId: number
  qty: number
  fromLocationId: number
  toLocationId: number
  documentDate?: string
  reference?: string | null
  note?: string | null
  overheads?: readonly OverheadInput[]
}

export type ManufacturingOrderLine = {
  id: number
  productId: number
  productCode: string
  description: string
  qtyPerUnit: number
  qtyConsumed: number
  unitCostExcl: number
  lineCostExcl: number
  movementId: number | null
}

export type ManufacturingOrderCost = {
  id: number
  description: string
  amountExcl: number
  accountId: number | null
}

export type ManufacturingOrder = {
  id: number
  documentNumber: string | null
  documentDate: string
  productId: number
  productCode: string
  description: string
  qty: number
  status: ManufacturingStatus
  fromLocationId: number
  fromLocationCode: string
  fromLocationName: string
  toLocationId: number
  toLocationCode: string
  toLocationName: string
  componentCost: number
  overheadCost: number
  unitCostExcl: number
  reference: string | null
  note: string | null
  postedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
  userName: string
  createdAt: Date
  lines: ManufacturingOrderLine[]
  overheads: ManufacturingOrderCost[]
}

export type PostResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

export type SimpleResult = { ok: true } | { ok: false; error: string }

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Validates a build without touching the database.
 *
 * Kept separate so the screen refuses the same things for the same reasons
 * before anyone clicks post — the same split stockTransfers.ts makes.
 */
export function validateBuild(input: BuildInput): string | null {
  if (!input.productId) return 'Choose what you are making.'
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    return 'Enter how many you are making — it must be more than zero.'
  }
  if (!input.fromLocationId) return 'Choose where the ingredients come from.'
  if (!input.toLocationId) return 'Choose where the finished goods go.'

  // Unlike a transfer, the same location on both sides is not just legal but
  // usual: a kitchen takes ingredients off its own shelf and puts the made item
  // back on it. So there is deliberately no same-location refusal here.

  for (const o of input.overheads ?? []) {
    if (!o.description.trim()) return 'Every extra cost needs a description.'
    if (!Number.isFinite(o.amountExcl)) return 'Every extra cost needs an amount.'
    if (o.amountExcl < 0) return 'An extra cost cannot be negative.'
  }
  return null
}

/**
 * What a build would consume, what it would cost, and what is short.
 *
 * This is both the screen's live feedback and the validator's data source, so
 * the panel a user reads and the check that refuses the post cannot disagree.
 *
 * The pile is read with a LEFT JOIN so a component with no product_location_stock
 * row for this location shows as zero available rather than vanishing from the
 * list — a missing pile is exactly the case a shortfall report must surface.
 */
export async function previewBuild(
  siteId: number,
  productId: number,
  qty: number,
  fromLocationId: number,
): Promise<{ ok: true; preview: BuildPreview } | { ok: false; error: string }> {
  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, description, product_type, is_manufactured FROM products WHERE id = ?',
    [productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }

  const notBuildable = manufacturableRefusal(product)
  if (notBuildable) return { ok: false, error: notBuildable }

  const resolved = await resolveComponents(
    siteId,
    productId,
    String(product.product_type) as ProductTypeId,
  )
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.components.length === 0) {
    return { ok: false, error: 'This recipe has no ingredients set up yet.' }
  }

  const buildQty = round(qty, 3)
  const available = await availableAt(siteId, resolved.components, fromLocationId)

  const components: BuildComponent[] = resolved.components.map((c) => {
    const qtyRequired = round(c.qtyPerUnit * buildQty, 3)
    const have = available.get(c.productId) ?? 0
    return {
      productId: c.productId,
      code: c.code,
      description: c.description,
      qtyPerUnit: c.qtyPerUnit,
      qtyRequired,
      unitCostExcl: c.unitCostExcl,
      lineCostExcl: round(qtyRequired * c.unitCostExcl, 4),
      available: have,
      shortBy: have >= qtyRequired ? 0 : round(qtyRequired - have, 3),
    }
  })

  return {
    ok: true,
    preview: {
      productId,
      code: String(product.code),
      description: String(product.description),
      qty: buildQty,
      components,
      componentCost: round(
        components.reduce((sum, c) => sum + c.lineCostExcl, 0),
        4,
      ),
      unitCostExcl: round(
        resolved.components.reduce((sum, c) => sum + c.qtyPerUnit * c.unitCostExcl, 0),
        4,
      ),
      buildable: buildableFrom(resolved.components, available),
      shortages: components.filter((c) => c.shortBy > 0),
    },
  }
}

/**
 * Why this product cannot be built, or null when it can.
 *
 * Both conditions matter and they fail differently: a normal product has no
 * recipe to resolve, and an un-ticked recipe product explodes at the till, so
 * building it would put stock on a pile that sales never touch.
 */
function manufacturableRefusal(product: Row): string | null {
  if (String(product.product_type) !== 'recipe') {
    return 'Only a recipe product can be manufactured. Change its type and give it a component list first.'
  }
  if (!Number(product.is_manufactured)) {
    return 'This recipe is not made in batches — its ingredients come off the shelf when it sells. Turn on "Made in batches" on the product to build it ahead of time.'
  }
  return null
}

/** What one named location holds of each component. */
async function availableAt(
  siteId: number,
  components: readonly ResolvedComponent[],
  locationId: number,
): Promise<Map<number, number>> {
  if (components.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, COALESCE(pls.stock_on_hand, 0) AS on_hand
       FROM products p
       LEFT JOIN product_location_stock pls
              ON pls.product_id = p.id AND pls.location_id = ?
      WHERE p.id IN (${components.map(() => '?').join(',')})`,
    [locationId, ...components.map((c) => c.productId)],
  )
  return new Map(rows.map((r) => [Number(r.id), toNum(r.on_hand)]))
}

/**
 * How many could be made from these piles — the binding ingredient decides.
 *
 * This is buildableQty() from productComposition.ts narrowed to ONE location.
 * That helper reads products.stock_on_hand, the site total, which would promise
 * a bakery flour that is sitting in another building.
 */
function buildableFrom(
  components: readonly ResolvedComponent[],
  available: Map<number, number>,
): number {
  let buildable = Infinity
  for (const c of components) {
    if (c.qtyPerUnit <= 0) continue
    buildable = Math.min(buildable, (available.get(c.productId) ?? 0) / c.qtyPerUnit)
  }
  // Floored, not rounded: you cannot bake 12.7 loaves, and rounding up would
  // offer a quantity the post path is about to refuse.
  return Number.isFinite(buildable) ? Math.max(0, Math.floor(buildable * 1000) / 1000) : 0
}

/**
 * Posts a build: components out, finished goods in, cost blended.
 *
 * ── WHY IT REFUSES TO OVERDRAW ─────────────────────────────────────────────
 *
 * Sales may take a pile negative — a till that refuses to sell what is in the
 * customer's hand is worse than a stock figure that needs correcting. A build
 * has no such excuse and a stronger reason to refuse than a transfer does: you
 * genuinely cannot bake bread with flour you do not have, so a build that
 * overdraws is a data-entry error and catching it IS the feature.
 *
 * Every component pile is locked FOR UPDATE in product_id order before anything
 * is written. The ordering is what stops two concurrent builds sharing an
 * ingredient from deadlocking; the lock is what stops them both passing the
 * check against the same stale figure.
 *
 * ── THE ORDER OF WRITES ────────────────────────────────────────────────────
 *
 * The recipe is resolved BEFORE the transaction opens, so a half-built recipe
 * is refused while nothing has moved. salesPosting.ts:255 does the same thing
 * for the same reason.
 *
 * The document number is the LAST write before commit. nextDocumentNumber takes
 * an exclusive row lock held until COMMIT, so claiming it early would serialise
 * every other posting in the shop behind a build. This follows the GRV, not the
 * transfer — the transfer claims it early and gets away with it because a
 * transfer is short.
 */
export async function postBuild(
  siteId: number,
  actor: Actor,
  input: BuildInput,
): Promise<PostResult> {
  const invalid = validateBuild(input)
  if (invalid) return { ok: false, error: invalid }

  const docDate = input.documentDate ?? todayIso()
  if (await isPeriodLocked(siteId, docDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, description, product_type, is_manufactured FROM products WHERE id = ?',
    [input.productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }

  const notBuildable = manufacturableRefusal(product)
  if (notBuildable) return { ok: false, error: notBuildable }

  // Resolved out here, before the transaction opens, so a recipe with a cycle
  // or a missing component list is refused while nothing has moved.
  const resolved = await resolveComponents(
    siteId,
    input.productId,
    String(product.product_type) as ProductTypeId,
  )
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.components.length === 0) {
    return { ok: false, error: 'This recipe has no ingredients set up yet.' }
  }

  // A component that is itself the thing being made would consume the pile it
  // is about to fill. resolveComponents caps depth and refuses direct
  // self-reference, but a manufactured item can legitimately appear deeper in
  // its own tree through a refer, and that has to be refused here.
  if (resolved.components.some((c) => c.productId === input.productId)) {
    return { ok: false, error: 'This recipe uses itself as an ingredient. Fix the setup before building it.' }
  }

  const locations = await siteQuery<Row>(
    siteId,
    'SELECT id, code, name, is_active FROM stock_locations WHERE id IN (?,?)',
    [input.fromLocationId, input.toLocationId],
  )
  const wanted = new Set([input.fromLocationId, input.toLocationId])
  if (locations.length !== wanted.size) {
    return { ok: false, error: 'One of those locations no longer exists.' }
  }
  const inactive = locations.find((l) => !Number(l.is_active))
  if (inactive) {
    return {
      ok: false,
      error: `${String(inactive.name)} is deactivated. Activate it before moving stock through it.`,
    }
  }
  const nameOf = (id: number) => String(locations.find((l) => Number(l.id) === id)?.name ?? 'that location')
  const codeOf = (id: number) => String(locations.find((l) => Number(l.id) === id)?.code ?? '')

  const buildQty = round(input.qty, 3)
  const overheads = (input.overheads ?? []).filter((o) => o.description.trim() || o.amountExcl)
  const overheadCost = round(
    overheads.reduce((sum, o) => sum + round(o.amountExcl, 4), 0),
    4,
  )

  // Locking in a stable order is what keeps two concurrent builds that share an
  // ingredient from deadlocking against each other.
  const components = [...resolved.components].sort((a, b) => a.productId - b.productId)

  // Set inside the transaction, read after it commits — the GL mirror runs
  // outside so a mapping gap cannot roll back a completed build.
  let mirrorInput: { orderId: number; documentNumber: string; componentCost: number } | null = null

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      // Every pile is locked and checked BEFORE anything is written, so a
      // refusal leaves no partial document behind.
      const consumption: { component: ResolvedComponent; qtyRequired: number }[] = []

      for (const component of components) {
        const qtyRequired = round(component.qtyPerUnit * buildQty, 3)

        const [rows] = await tx.execute(
          `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand, p.code, p.description
             FROM products p
             LEFT JOIN product_location_stock pls
                    ON pls.product_id = p.id AND pls.location_id = ?
            WHERE p.id = ?
            FOR UPDATE`,
          [input.fromLocationId, component.productId] as never,
        )
        const row = (rows as Row[])[0]
        if (!row) return { ok: false as const, error: 'An ingredient in this recipe no longer exists.' }

        const available = toNum(row.on_hand)
        if (available < qtyRequired) {
          return {
            ok: false as const,
            error: `${String(row.code)} — ${nameOf(input.fromLocationId)} holds ${available}, and this build needs ${qtyRequired}.`,
          }
        }

        consumption.push({ component, qtyRequired })
      }

      const componentCost = round(
        consumption.reduce((sum, c) => sum + c.qtyRequired * c.component.unitCostExcl, 0),
        4,
      )
      // What one made unit cost. buildQty cannot be zero — validateBuild
      // refuses that before the transaction opens.
      const madeUnitCost = round((componentCost + overheadCost) / buildQty, 4)

      const [res] = await tx.execute(
        `INSERT INTO manufacturing_orders
           (document_date, product_id, product_code, description, qty, status,
            from_location_id, to_location_id, component_cost, overhead_cost, unit_cost_excl,
            reference, note, posted_at, user_id, user_name)
         VALUES (?,?,?,?,?, 'posted', ?,?,?,?,?, ?,?, NOW(), ?,?)`,
        [
          docDate,
          input.productId,
          String(product.code).slice(0, 48),
          String(product.description).slice(0, 190),
          buildQty.toFixed(3),
          input.fromLocationId,
          input.toLocationId,
          componentCost.toFixed(4),
          overheadCost.toFixed(4),
          madeUnitCost.toFixed(4),
          input.reference?.trim()?.slice(0, 60) || null,
          input.note?.trim()?.slice(0, 400) || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const orderId = (res as { insertId: number }).insertId

      // ── Components out ──────────────────────────────────────────────────
      for (const [index, { component, qtyRequired }] of consumption.entries()) {
        const movementId = await recordMovement(tx, actor, {
          productId: component.productId,
          locationId: input.fromLocationId,
          movementType: 'manufacture_out',
          qtyChange: -qtyRequired,
          unitCostExcl: component.unitCostExcl,
          source: 'manufacture',
          sourceDocId: orderId,
          note: `Made ${buildQty} ${String(product.code)}`,
        })

        await tx.execute(
          `INSERT INTO manufacturing_order_lines
             (order_id, line_number, product_id, product_code, description,
              qty_per_unit, qty_consumed, unit_cost_excl, line_cost_excl, movement_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            orderId,
            index + 1,
            component.productId,
            component.code.slice(0, 48),
            component.description.slice(0, 190),
            component.qtyPerUnit.toFixed(4),
            qtyRequired.toFixed(3),
            round(component.unitCostExcl, 4).toFixed(4),
            round(qtyRequired * component.unitCostExcl, 4).toFixed(4),
            movementId,
          ] as never,
        )
      }

      // ── Overhead ────────────────────────────────────────────────────────
      for (const [index, o] of overheads.entries()) {
        await tx.execute(
          `INSERT INTO manufacturing_order_costs
             (order_id, line_number, description, amount_excl, account_id)
           VALUES (?,?,?,?,?)`,
          [
            orderId,
            index + 1,
            o.description.trim().slice(0, 190),
            round(o.amountExcl, 4).toFixed(4),
            o.accountId ?? null,
          ] as never,
        )
      }

      // ── Finished goods in ───────────────────────────────────────────────
      // The position is read BEFORE the movement, because the average has to
      // blend against what was there rather than what it is about to become.
      const [before] = await tx.execute(
        'SELECT stock_on_hand, average_cost FROM products WHERE id = ? FOR UPDATE',
        [input.productId] as never,
      )
      const current = (before as Row[])[0]
      const existingQty = toNum(current?.stock_on_hand)
      const existingCost = toNum(current?.average_cost)

      await recordMovement(tx, actor, {
        productId: input.productId,
        locationId: input.toLocationId,
        movementType: 'manufacture_in',
        qtyChange: buildQty,
        unitCostExcl: madeUnitCost,
        source: 'manufacture',
        sourceDocId: orderId,
        note: `Built into ${codeOf(input.toLocationId)}`,
      })

      // THE COST MOVE — the second writer of average_cost in the application,
      // and the module comment above says why that is deliberate.
      const newAverage = weightedAverageCost({
        existingQty,
        existingCostExcl: existingCost,
        receivedQty: buildQty,
        receivedCostExcl: madeUnitCost,
      })
      await tx.execute(
        'UPDATE products SET average_cost = ?, last_cost = ? WHERE id = ?',
        [newAverage.toFixed(4), madeUnitCost.toFixed(4), input.productId] as never,
      )

      // LAST write before commit — see the note on this function.
      const documentNumber = await nextDocumentNumber(tx, 'manufacturing_order')
      await tx.execute('UPDATE manufacturing_orders SET document_number = ? WHERE id = ?', [
        documentNumber,
        orderId,
      ] as never)

      mirrorInput = { orderId, documentNumber, componentCost }
      return { ok: true as const, id: orderId, documentNumber }
    })

    // AFTER the commit, and deliberately outside it. The goods are made either
    // way; a chart-of-accounts gap must not un-make them.
    if (result.ok && mirrorInput) {
      const { mirrorManufacture } = await import('./glPosting')
      const m = mirrorInput as { orderId: number; documentNumber: string; componentCost: number }
      await mirrorManufacture(siteId, actor, {
        orderId: m.orderId,
        documentNumber: m.documentNumber,
        documentDate: docDate,
        componentCost: m.componentCost,
        overheadCost,
      })
    }

    return result
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The build could not be posted.' }
  }
}

/**
 * Reverses a posted build: ingredients back, finished goods off.
 *
 * Writes compensating movements rather than deleting the originals — the same
 * reasoning as voiding a receipt or a transfer. The goods genuinely were made
 * and then unmade, and erasing that leaves piles whose history does not explain
 * them.
 *
 * Refuses when the finished goods are no longer there to take back. Unbuilding
 * 50 loaves after 30 have sold would drive the pile to -30 and silently reverse
 * a sale's worth of stock.
 *
 * Does NOT unwind average_cost, exactly as a GRV void does not. Reversing a
 * weighted blend needs the position at the time, and later movements have
 * already moved past it.
 */
export async function unbuild(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<SimpleResult> {
  const trimmed = reason.trim()
  if (!trimmed) return { ok: false, error: 'Give a reason for unbuilding this.' }

  const order = await siteQueryOne<Row>(
    siteId,
    `SELECT id, document_number, document_date, product_id, product_code, qty, status,
            from_location_id, to_location_id, unit_cost_excl, component_cost, overhead_cost
       FROM manufacturing_orders WHERE id = ?`,
    [id],
  )
  if (!order) return { ok: false, error: 'That build no longer exists.' }
  if (String(order.status) === 'cancelled') return { ok: false, error: 'That build is already cancelled.' }
  if (String(order.status) !== 'posted') return { ok: false, error: 'Only a posted build can be unbuilt.' }

  if (await isPeriodLocked(siteId, String(order.document_date).slice(0, 10))) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT product_id, product_code, qty_consumed, unit_cost_excl
       FROM manufacturing_order_lines WHERE order_id = ? ORDER BY product_id`,
    [id],
  )
  if (lines.length === 0) return { ok: false, error: 'That build has no lines to reverse.' }

  const builtQty = toNum(order.qty)
  const madeCost = toNum(order.unit_cost_excl)
  const productId = Number(order.product_id)
  const toLocationId = Number(order.to_location_id)
  const fromLocationId = Number(order.from_location_id)

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      // Are the finished goods still there? Checked FOR UPDATE so two unbuilds
      // of overlapping batches cannot both pass against the same figure.
      const [rows] = await tx.execute(
        `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand
           FROM products p
           LEFT JOIN product_location_stock pls
                  ON pls.product_id = p.id AND pls.location_id = ?
          WHERE p.id = ?
          FOR UPDATE`,
        [toLocationId, productId] as never,
      )
      const onHand = toNum((rows as Row[])[0]?.on_hand)
      if (onHand < builtQty) {
        const gone = round(builtQty - onHand, 3)
        return {
          ok: false as const,
          error: `${onHand} of ${builtQty} remain — ${gone} have already sold or moved on. Unbuilding would take stock that is not there.`,
        }
      }

      // Finished goods off, at the cost they were made at.
      await recordMovement(tx, actor, {
        productId,
        locationId: toLocationId,
        movementType: 'manufacture_out',
        qtyChange: -builtQty,
        unitCostExcl: madeCost,
        source: 'manufacture_cancel',
        sourceDocId: id,
        note: `Unbuilt ${String(order.document_number ?? '')}`.trim(),
      })

      // Ingredients back, each at the cost it was consumed at.
      for (const line of lines) {
        await recordMovement(tx, actor, {
          productId: Number(line.product_id),
          locationId: fromLocationId,
          movementType: 'manufacture_in',
          qtyChange: toNum(line.qty_consumed),
          unitCostExcl: toNum(line.unit_cost_excl),
          source: 'manufacture_cancel',
          sourceDocId: id,
          note: `Returned from ${String(order.document_number ?? '')}`.trim(),
        })
      }

      await tx.execute(
        `UPDATE manufacturing_orders
            SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ?
          WHERE id = ?`,
        [trimmed.slice(0, 200), id] as never,
      )

      return { ok: true as const }
    })

    // The reversing journal, after commit and fail-soft, for the same reason
    // the original was: the stock has already moved back.
    if (result.ok) {
      const { mirrorManufacture } = await import('./glPosting')
      await mirrorManufacture(siteId, actor, {
        orderId: id,
        documentNumber: (order.document_number as string | null) ?? null,
        documentDate: String(order.document_date).slice(0, 10),
        componentCost: toNum(order.component_cost),
        overheadCost: toNum(order.overhead_cost),
        isReversal: true,
      })
    }

    return result
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The build could not be unbuilt.' }
  }
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export type OrderListItem = {
  id: number
  documentNumber: string | null
  documentDate: string
  productCode: string
  description: string
  qty: number
  status: ManufacturingStatus
  totalCost: number
  unitCostExcl: number
  toLocationCode: string
  userName: string
}

export async function listBuilds(
  siteId: number,
  options: { status?: ManufacturingStatus; search?: string; limit?: number; offset?: number } = {},
): Promise<{ items: OrderListItem[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.status) {
    where.push('o.status = ?')
    params.push(options.status)
  }
  const search = options.search?.trim()
  if (search) {
    where.push('(o.document_number LIKE ? OR o.product_code LIKE ? OR o.description LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT o.id, o.document_number, o.document_date, o.product_code, o.description,
            o.qty, o.status, o.component_cost, o.overhead_cost, o.unit_cost_excl,
            o.user_name, l.code AS to_code
       FROM manufacturing_orders o
       JOIN stock_locations l ON l.id = o.to_location_id
       ${clause}
      ORDER BY o.document_date DESC, o.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  const totalRow = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM manufacturing_orders o ${clause}`,
    params,
  )

  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      documentNumber: (r.document_number as string | null) ?? null,
      documentDate: String(r.document_date).slice(0, 10),
      productCode: String(r.product_code),
      description: String(r.description),
      qty: toNum(r.qty),
      status: String(r.status) as ManufacturingStatus,
      totalCost: round(toNum(r.component_cost) + toNum(r.overhead_cost), 4),
      unitCostExcl: toNum(r.unit_cost_excl),
      toLocationCode: String(r.to_code),
      userName: String(r.user_name ?? ''),
    })),
    total: Number(totalRow?.n ?? 0),
  }
}

export async function getBuild(siteId: number, id: number): Promise<ManufacturingOrder | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT o.*, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
       FROM manufacturing_orders o
       JOIN stock_locations f ON f.id = o.from_location_id
       JOIN stock_locations t ON t.id = o.to_location_id
      WHERE o.id = ?`,
    [id],
  )
  if (!row) return null

  const [lines, costs] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, product_id, product_code, description, qty_per_unit, qty_consumed,
              unit_cost_excl, line_cost_excl, movement_id
         FROM manufacturing_order_lines WHERE order_id = ? ORDER BY line_number, id`,
      [id],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, description, amount_excl, account_id
         FROM manufacturing_order_costs WHERE order_id = ? ORDER BY line_number, id`,
      [id],
    ),
  ])

  return {
    id: Number(row.id),
    documentNumber: (row.document_number as string | null) ?? null,
    documentDate: String(row.document_date).slice(0, 10),
    productId: Number(row.product_id),
    productCode: String(row.product_code),
    description: String(row.description),
    qty: toNum(row.qty),
    status: String(row.status) as ManufacturingStatus,
    fromLocationId: Number(row.from_location_id),
    fromLocationCode: String(row.from_code),
    fromLocationName: String(row.from_name),
    toLocationId: Number(row.to_location_id),
    toLocationCode: String(row.to_code),
    toLocationName: String(row.to_name),
    componentCost: toNum(row.component_cost),
    overheadCost: toNum(row.overhead_cost),
    unitCostExcl: toNum(row.unit_cost_excl),
    reference: (row.reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    postedAt: (row.posted_at as Date | null) ?? null,
    cancelledAt: (row.cancelled_at as Date | null) ?? null,
    cancelReason: (row.cancel_reason as string | null) ?? null,
    userName: String(row.user_name ?? ''),
    createdAt: row.created_at as Date,
    lines: lines.map((l) => ({
      id: Number(l.id),
      productId: Number(l.product_id),
      productCode: String(l.product_code),
      description: String(l.description),
      qtyPerUnit: toNum(l.qty_per_unit),
      qtyConsumed: toNum(l.qty_consumed),
      unitCostExcl: toNum(l.unit_cost_excl),
      lineCostExcl: toNum(l.line_cost_excl),
      movementId: l.movement_id === null ? null : Number(l.movement_id),
    })),
    overheads: costs.map((c) => ({
      id: Number(c.id),
      description: String(c.description),
      amountExcl: toNum(c.amount_excl),
      accountId: c.account_id === null ? null : Number(c.account_id),
    })),
  }
}

/** Products that can be built — the picker on the capture screen. */
export async function listManufacturableProducts(
  siteId: number,
  search?: string,
): Promise<{ id: number; code: string; description: string }[]> {
  const term = search?.trim()
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, code, description FROM products
      WHERE product_type = 'recipe' AND is_manufactured = 1 AND is_archived = 0
        ${term ? 'AND (code LIKE ? OR description LIKE ?)' : ''}
      ORDER BY description
      LIMIT 50`,
    term ? [`%${term}%`, `%${term}%`] : [],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
  }))
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type BuildDrift = {
  orderId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted builds whose movements do not match their lines.
 *
 * Two halves, because a build can drift in two independent ways: a component
 * line whose manufacture_out does not equal what the line says it consumed, and
 * a finished quantity whose manufacture_in does not equal what was built.
 *
 * Cancelled orders are excluded rather than netted. An unbuild deliberately
 * writes compensating movements against the same source_doc_id, so the sums for
 * a cancelled order are zero by design and would report as drift against the
 * lines they reversed.
 *
 * Reports rather than repairs, like every other reconciliation here.
 */
export async function reconcileManufacturing(siteId: number): Promise<BuildDrift[]> {
  const componentDrift = await siteQuery<Row>(
    siteId,
    `SELECT o.id AS order_id, o.document_number, l.product_id, l.product_code,
            l.qty_consumed AS expected,
            COALESCE((SELECT SUM(-m.qty_change) FROM stock_movements m
                       WHERE m.source = 'manufacture' AND m.source_doc_id = o.id
                         AND m.product_id = l.product_id
                         AND m.movement_type = 'manufacture_out'), 0) AS moved
       FROM manufacturing_orders o
       JOIN manufacturing_order_lines l ON l.order_id = o.id
      WHERE o.status = 'posted'
     HAVING ABS(expected - moved) > 0.0005`,
  )

  const outputDrift = await siteQuery<Row>(
    siteId,
    `SELECT o.id AS order_id, o.document_number, o.product_id, o.product_code,
            o.qty AS expected,
            COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m
                       WHERE m.source = 'manufacture' AND m.source_doc_id = o.id
                         AND m.product_id = o.product_id
                         AND m.movement_type = 'manufacture_in'), 0) AS moved
       FROM manufacturing_orders o
      WHERE o.status = 'posted'
     HAVING ABS(expected - moved) > 0.0005`,
  )

  return [...componentDrift, ...outputDrift].map((r) => ({
    orderId: Number(r.order_id),
    documentNumber: (r.document_number as string | null) ?? null,
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    expected: toNum(r.expected),
    moved: toNum(r.moved),
  }))
}
