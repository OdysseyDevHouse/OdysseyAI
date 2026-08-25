import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { mainLocationId, mainLocationIdTx } from './stockLocations'
import { isParentTx } from './productVariants'
import { heldQtyFor } from './stockHolds'
import type { ProductTypeId } from '../productTypes'
// Type-only: the runtime import is dynamic inside recordMovement, so the two
// modules cannot form a load-order cycle.
import type { BatchDirective } from './batches'

/**
 * Every quantity change in the business, in one place.
 *
 * THE INVARIANT: Σ stock_movements.qty_change for a product equals
 * products.stock_on_hand. Same promise reconcileBalances makes about the debtor
 * ledger, and `reconcileStock` below proves it the same way.
 *
 * Two things are deliberately NOT movements:
 *   - A reservation. An order holding stock has moved nothing; reserved
 *     quantity is derived from open order lines. Writing reservations here
 *     would break the invariant outright.
 *   - A price or cost change. Those move value, not quantity.
 *
 * products.stock_on_hand has been non-writable by the product form since the
 * first migration, with a comment saying it is "a consequence of receipts,
 * sales and adjustments". This module is that consequence.
 */

export const MOVEMENT_TYPES = [
  'sale',
  'sale_return',
  'opening',
  'receipt',
  'adjustment',
  'transfer_in',
  'transfer_out',
  // Making things. Separate from 'adjustment' because the one table people read
  // to answer "what happened to this product" has to distinguish flour going
  // into production from a stock-take correction. See manufacturing.ts.
  'manufacture_in',
  'manufacture_out',
  // Breaking a pack open. Written as a balanced pair — a case out, four
  // six-packs in — so the invariant holds at both levels. Separate from
  // 'adjustment' for the same reason as manufacturing: a manager asking why
  // the case count dropped must see that the till opened one. See
  // referBreakdown.ts.
  'unpack_in',
  'unpack_out',
  /*
   * Breaking a carcass down (236). A balanced pair, like unpack above and for
   * the same reason: a manager asking why the hindquarter count dropped has to
   * see that it was BROKEN DOWN, not adjusted away or sold.
   *
   * Distinct from manufacture, despite looking similar, because the direction
   * is inverted — manufacturing is many inputs to one output, a block test is
   * one input to twenty outputs at twenty different values — and a yield report
   * that could not tell the two apart would average a carcass against a
   * sausage recipe. See blockTests.ts.
   */
  'block_test_in',
  'block_test_out',
] as const
export type MovementType = (typeof MOVEMENT_TYPES)[number]

export type StockMovement = {
  id: number
  productId: number
  movementType: MovementType
  qtyChange: number
  qtyAfter: number
  unitCostExcl: number
  source: string
  sourceDocId: number | null
  terminalId: number | null
  userName: string
  note: string | null
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapMovement(r: Row): StockMovement {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    movementType: String(r.movement_type) as MovementType,
    qtyChange: toNum(r.qty_change),
    qtyAfter: toNum(r.qty_after),
    unitCostExcl: toNum(r.unit_cost_excl),
    source: String(r.source),
    sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
    terminalId: r.terminal_id === null ? null : Number(r.terminal_id),
    userName: String(r.user_name ?? ''),
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

/**
 * How a sale of one unit changes stock, by product type.
 *
 * productTypes.ts declares the behaviour and says explicitly that "the stock
 * behaviour it describes lives with whatever processes sales". This is that
 * place, and it is the only place — a second copy of this table is how a
 * returnable ends up decrementing.
 *
 *   -1  sale takes stock out       (normal, calcqty, serial)
 *   +1  sale puts stock IN         (returnable — a deposit coming back)
 *    0  no stock is carried        (service, buyout, refer, recipe)
 *
 * ── THE ONE TYPE THAT DEPENDS ON MORE THAN THE TYPE ────────────────────────
 *
 * A recipe product answers this question two ways, and the product says which.
 *
 * By default it returns 0: selling a burger moves a patty, a bun and a slice of
 * cheese, resolved by productComposition.ts at finalise, and moves nothing of
 * the burger because there is no pile of burgers.
 *
 * The second argument is the exception, and it means ONE thing: this product
 * carries a pile of its own after all, so sell it like any stocked item.
 *
 * Two cases set it, and they are the same case wearing different clothes:
 *
 *   - A MANUFACTURED recipe (products.is_manufactured) was built ahead of time
 *     by a manufacturing order, its ingredients were consumed then, and the
 *     finished units are on a shelf. See manufacturing.ts.
 *   - A NORMAL-METHOD refer (product_refers.method) is a pack the shop
 *     physically owns — ten cases of beer are ten cases. Larger packs are
 *     broken open to refill it rather than it being a view onto a single pile.
 *     See referBreakdown.ts.
 *
 * Both are resolved by the CALLER, because this is a pure function of a
 * product type and cannot read a link or a flag. The exploding set from
 * productComposition.ts is what decides in the sale path.
 *
 * The argument is optional and defaults to false, so every existing call site
 * keeps the behaviour it has today.
 */
export function stockDirectionFor(
  productType: ProductTypeId,
  carriesOwnStock = false,
): -1 | 0 | 1 {
  switch (productType) {
    case 'normal':
    case 'calcqty':
      return -1
    case 'returnable':
      return 1
    // A serial product is an ordinary stocked item; the serial table records
    // WHICH unit moved, it does not replace the movement.
    case 'serial':
      return -1
    // A batch product likewise: the batch table records WHICH lot moved,
    // via the hook inside recordMovement — the movement itself is ordinary.
    case 'batch':
      return -1
    // A made item that is stocked behaves like a normal product: the build
    // already took its ingredients, so the sale takes the finished unit.
    case 'recipe':
      return carriesOwnStock ? -1 : 0
    // A subtract-pack refer has no pile of its own — its target moves instead,
    // resolved by productComposition.ts at finalise. A normal-method one does
    // have a pile, and the caller says so.
    case 'refer':
      return carriesOwnStock ? -1 : 0
    case 'service':
    case 'buyout':
      return 0
    // Stored value has no pile. Without this case the default below would
    // silently deduct stock every time a card sold.
    case 'gift_card':
      return 0
    default:
      // An unknown type must not silently skip stock. Treat it as normal, which
      // is the safe assumption for anything stocked.
      return -1
  }
}

/** Whether a product type can be sold at all. Every one can, today. */
export function canSellNow(_productType: ProductTypeId): { ok: true } | { ok: false; reason: string } {
  // Every product type sells now. What used to be refused here — recipe, refer
  // and serial — is refused per PRODUCT instead, at finalise: a recipe with no
  // ingredients, or a serial line with no unit chosen, names the specific
  // problem rather than the whole type. Kept as a function because the
  // finalise path calls it and a future type may well need a blanket refusal.
  return { ok: true }
}

/**
 * A movement that must not happen — currently only a parent product.
 *
 * Its own class so a caller can tell "you asked for something impossible" from
 * a connection failure, and show the message rather than a generic apology.
 */
export class StockMovementError extends Error {}

export type MovementInput = {
  productId: number
  movementType: MovementType
  /** Signed. Negative takes stock out. Always a delta, never a new total. */
  qtyChange: number
  /**
   * Which pile moved. Omitted means the main location, which is what every
   * sale wants and what every path did before locations existed.
   */
  locationId?: number | null
  unitCostExcl?: number
  source?: string
  sourceDocId?: number | null
  sourceLineId?: number | null
  terminalId?: number | null
  shiftId?: number | null
  note?: string | null
  /**
   * Lot directives for a batch-tracked product (148) — receipt identity, an
   * exact lot, a return's original line, a receipt void. Absent means the
   * hook decides: FEFO out, newest-lot or the untracked bucket in.
   */
  batch?: BatchDirective
}

/**
 * Records a movement and applies it to BOTH stock figures, atomically.
 *
 * Takes the caller's OPEN transaction: a movement without its stock update
 * leaves the invariant broken, and a stock update without its movement leaves a
 * figure nobody can explain. They are never separate.
 *
 * ── WHAT THIS WRITES, AND WHY IT IS THREE STATEMENTS ───────────────────────
 *
 *   products.stock_on_hand            += qty   the site total
 *   product_location_stock            += qty   the pile that actually moved
 *   stock_movements                    row     what happened, and where
 *
 * Both stock rows move together or neither does, which is what keeps all three
 * invariants true at once:
 *
 *   (A) Σ qty_change                        = products.stock_on_hand
 *   (B) Σ qty_change per (product,location) = product_location_stock.stock_on_hand
 *   (C) Σ piles per product                 = products.stock_on_hand
 *
 * Every UPDATE reads and writes in one statement (`stock_on_hand + ?`), so two
 * concurrent tills selling the same product cannot lose one of the decrements —
 * the same reasoning as the numbering sequence.
 *
 * The pile is an UPSERT, not an UPDATE: the first receipt into a brand-new
 * location has no row yet, and an UPDATE would silently affect zero rows and
 * break (C) with nothing to show for it.
 *
 * ── A PRODUCT WITH VARIANTS CANNOT MOVE ────────────────────────────────────
 *
 * This function is the single gate every stock change in the application passes
 * through, which makes it the right place — and the only necessary place — to
 * enforce that a variant PARENT never accrues stock.
 *
 * A parent is a grouping row: the shopper sees one tile, the stockroom counts
 * the children. It is excluded from reconcileStock(), so any quantity that
 * reached it would be invisible to the report whose whole job is to prove the
 * figures add up. Refusing here means a bug in any picker, import or till path
 * fails loudly at the boundary instead of silently breaking invariant (A).
 *
 * See productVariants.ts for the rest of the rules and 070_product_variants.sql
 * for why the parent/child split is not enforceable by the schema alone.
 */
export async function recordMovement(
  tx: PoolConnection,
  actor: { userId: number; userName: string },
  input: MovementInput,
): Promise<number> {
  const qty = round(input.qtyChange, 3)

  // The parent gate. Read inside the caller's transaction so it cannot be
  // raced by a product becoming a parent halfway through a sale.
  if (await isParentTx(tx, input.productId)) {
    throw new StockMovementError(
      'This product has variants, so stock is held on the variants rather than on it. ' +
        'Choose a specific variant.',
    )
  }

  // Resolved inside the caller's transaction so a movement cannot straddle a
  // change of which location is main.
  const locationId = input.locationId ?? (await mainLocationIdTx(tx))

  // Apply first, then read back the resulting figure, so qty_after is what the
  // database actually holds rather than what we assumed it would.
  await tx.execute('UPDATE products SET stock_on_hand = stock_on_hand + ? WHERE id = ?', [
    qty.toFixed(3),
    input.productId,
  ] as never)

  await tx.execute(
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
          VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE stock_on_hand = stock_on_hand + VALUES(stock_on_hand)`,
    [input.productId, locationId, qty.toFixed(3)] as never,
  )

  // qty_after is the SITE TOTAL after this movement, not the pile.
  //
  // It is what stockAsAt() replays to answer "what did we own on the 3rd", and
  // that question has always been about the business rather than one room.
  // Reading the pile here instead would silently change the meaning of a
  // column with history already in it, and every existing row is a site total.
  //
  // The per-location position at a past date is the running Σ qty_change for
  // that (product, location) — invariant (B) — and needs no second column.
  const [rows] = await tx.execute('SELECT stock_on_hand, product_type FROM products WHERE id = ?', [
    input.productId,
  ] as never)
  const qtyAfter = toNum((rows as Row[])[0]?.stock_on_hand)
  const productType = String((rows as Row[])[0]?.product_type ?? 'normal')

  const [res] = await tx.execute(
    `INSERT INTO stock_movements
       (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl,
        source, source_doc_id, source_line_id, terminal_id, shift_id, user_id, user_name, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.productId,
      locationId,
      input.movementType,
      qty.toFixed(3),
      qtyAfter.toFixed(3),
      (input.unitCostExcl ?? 0).toFixed(4),
      input.source ?? 'sale',
      input.sourceDocId ?? null,
      input.sourceLineId ?? null,
      input.terminalId ?? null,
      input.shiftId ?? null,
      actor.userId,
      actor.userName.slice(0, 120),
      input.note?.slice(0, 190) ?? null,
    ] as never,
  )
  const movementId = (res as { insertId: number }).insertId

  /*
   * The batch hook (148), for batch-tracked products only. This gate is the
   * one place every stock change passes through, which is exactly what makes
   * the lot invariants hold for every caller by construction — including
   * ones the serial per-caller hooks never covered. The hook writes ONLY
   * product_batches and batch_movements; the three figures above stay this
   * function's alone.
   */
  if (productType === 'batch') {
    const { applyBatchMovementTx } = await import('./batches')
    await applyBatchMovementTx(tx, actor, {
      productId: input.productId,
      locationId,
      movementType: input.movementType,
      qtyChange: qty,
      unitCostExcl: input.unitCostExcl ?? 0,
      movementId,
      source: input.source ?? 'sale',
      sourceDocId: input.sourceDocId ?? null,
      sourceLineId: input.sourceLineId ?? null,
      batch: input.batch,
    })
  }

  return movementId
}

/** One product's movement history, newest first. */
export async function listMovements(
  siteId: number,
  productId: number,
  limit = 200,
): Promise<StockMovement[]> {
  const capped = Math.min(Math.max(limit, 1), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, product_id, movement_type, qty_change, qty_after, unit_cost_excl,
            source, source_doc_id, terminal_id, user_name, note, created_at
       FROM stock_movements
      WHERE product_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ${capped}`,
    [productId],
  )
  return rows.map(mapMovement)
}

export type StockDrift = {
  productId: number
  code: string
  description: string
  stored: number
  computed: number
  drift: number
  /**
   * Which pile drifted, or null when the SITE TOTAL is what disagrees.
   *
   * A null row means invariant (C) broke: the piles are individually
   * consistent with their movements but do not add up to products.stock_on_hand.
   * A named row means (B) broke in that one location.
   */
  locationId: number | null
  locationCode: string | null
}

/**
 * Products whose stored stock disagrees with their movements — at either level.
 *
 * `> 0.0005` is not a tolerance — it is "not equal" expressed inside the
 * column's own 3-decimal precision. Both sides are DECIMAL and no float is
 * involved, so any row returned is a bug in a posting path.
 *
 * Reports rather than repairs, for the same reason reconcileBalances does:
 * silently correcting a drift hides whatever caused it.
 *
 * ── WHY TWO QUERIES AND NOT THREE ──────────────────────────────────────────
 *
 * Invariant (A) — Σ qty_change = products.stock_on_hand — is exactly (B) and
 * (C) together, so checking those two proves all three. Checking (A)
 * separately would report the same broken product a second time with no extra
 * information about where it went wrong.
 *
 * The per-location half runs FIRST because it is the more specific answer: it
 * names the room. The total half then catches the case where every pile is
 * individually right but they do not sum — which is the signature of a write
 * that touched products.stock_on_hand without going through recordMovement().
 */
export async function reconcileStock(siteId: number): Promise<StockDrift[]> {
  // (B) each pile against the movements recorded in it.
  const perLocation = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description,
            l.id   AS location_id,
            l.code AS location_code,
            pls.stock_on_hand                          AS stored,
            COALESCE(m.total, 0)                       AS computed,
            pls.stock_on_hand - COALESCE(m.total, 0)   AS drift
       FROM product_location_stock pls
       JOIN products        p ON p.id = pls.product_id
       JOIN stock_locations l ON l.id = pls.location_id
       LEFT JOIN (
             SELECT product_id, location_id, SUM(qty_change) AS total
               FROM stock_movements GROUP BY product_id, location_id
            ) m ON m.product_id = pls.product_id AND m.location_id = pls.location_id
      WHERE ABS(pls.stock_on_hand - COALESCE(m.total, 0)) > 0.0005
      ORDER BY ABS(pls.stock_on_hand - COALESCE(m.total, 0)) DESC`,
  )

  // (C) the site total against the sum of its piles.
  const perProduct = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description,
            p.stock_on_hand                          AS stored,
            COALESCE(l.total, 0)                     AS computed,
            p.stock_on_hand - COALESCE(l.total, 0)   AS drift
       FROM products p
       LEFT JOIN (
             SELECT product_id, SUM(stock_on_hand) AS total
               FROM product_location_stock GROUP BY product_id
            ) l ON l.product_id = p.id
      WHERE ABS(p.stock_on_hand - COALESCE(l.total, 0)) > 0.0005
        -- A variant parent holds no stock by design: recordMovement refuses it
        -- and its children carry the quantity. Including it here would report
        -- an eternal zero-versus-zero row for every group in the file, and a
        -- report that always shows rows is one nobody reads.
        AND p.has_variants = 0
      ORDER BY ABS(p.stock_on_hand - COALESCE(l.total, 0)) DESC`,
  )

  const mapDrift = (r: Row): StockDrift => ({
    productId: Number(r.id),
    code: String(r.code),
    description: String(r.description),
    stored: toNum(r.stored),
    computed: toNum(r.computed),
    drift: toNum(r.drift),
    locationId: r.location_id === undefined || r.location_id === null ? null : Number(r.location_id),
    locationCode: (r.location_code as string | null) ?? null,
  })

  return [...perLocation.map(mapDrift), ...perProduct.map(mapDrift)]
}

/**
 * Writes an opening movement for every product that has stock but no history.
 *
 * Without this, Σ qty_change ≠ stock_on_hand from day one and the
 * reconciliation report — the thing that proves the module works — is useless
 * noise. Run once at go-live, immediately after the sales migration.
 *
 * Idempotent: a product that already has any movement is skipped, so running it
 * twice cannot double an opening balance.
 *
 * ── IT MUST PLACE THE STOCK, NOT ONLY RECORD IT ────────────────────────────
 *
 * The movement row alone satisfies invariant (A) and leaves (C) broken: the
 * product would claim a site total with no pile anywhere holding it. So the
 * main pile is written in the same transaction, from the same figure.
 *
 * The pile is SET, not incremented, unlike recordMovement(): this describes
 * stock that is already counted in products.stock_on_hand rather than stock
 * arriving. Adding to it would double whatever the backfill in
 * 025_stock_locations.sql already put there.
 */
export async function seedOpeningStock(
  siteId: number,
  actor: { userId: number; userName: string },
): Promise<{ seeded: number; skipped: number }> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.stock_on_hand, p.average_cost
       FROM products p
       LEFT JOIN stock_movements m ON m.product_id = p.id
      WHERE m.id IS NULL
      GROUP BY p.id, p.stock_on_hand, p.average_cost`,
  )

  let seeded = 0
  let skipped = 0
  const locationId = await mainLocationId(siteId)

  for (const row of rows) {
    const onHand = toNum(row.stock_on_hand)
    if (onHand === 0) {
      // Nothing on hand and no history: the sum already agrees at zero, so an
      // opening row of zero would be noise.
      skipped++
      continue
    }

    await siteTransaction(siteId, async (tx) => {
      // The pile the movement below says this stock is in. Written first so a
      // failure here cannot leave a movement pointing at nothing.
      await tx.execute(
        `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
              VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
        [Number(row.id), locationId, onHand.toFixed(3)] as never,
      )

      // Written directly rather than via recordMovement: the stock is already
      // there, so this records what it WAS without moving it again.
      await tx.execute(
        `INSERT INTO stock_movements
           (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl,
            source, user_id, user_name, note)
         VALUES (?, ?, 'opening', ?, ?, ?, 'opening', ?, ?, 'Opening balance at go-live')`,
        [
          Number(row.id),
          locationId,
          onHand.toFixed(3),
          onHand.toFixed(3),
          toNum(row.average_cost).toFixed(4),
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
    })
    seeded++
  }

  return { seeded, skipped }
}

/** Stock as it stood at a past moment, from the last movement on or before it. */
export async function stockAsAt(
  siteId: number,
  productId: number,
  asAt: Date,
): Promise<number | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT qty_after FROM stock_movements
      WHERE product_id = ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [productId, asAt],
  )
  return row ? toNum(row.qty_after) : null
}

/**
 * Quantity spoken for, so "available to sell" can subtract it.
 *
 * TWO sources, and both are promises to a named customer:
 *
 *   • open sales orders  — ordered, not yet delivered
 *   • open lay-bys       — put aside, not yet paid off
 *
 * A lay-by reservation is the harder of the two to get wrong cheaply: failing
 * to deliver a paid-up lay-by costs the shop DOUBLE what was paid under
 * section 62, and a stock shortage is explicitly not an excuse.
 *
 * Neither writes a stock movement, so `Σ qty_change = stock_on_hand` still
 * holds. A reservation has moved nothing — it has only made a claim.
 */
export async function reservedQty(siteId: number, productId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       COALESCE((
         SELECT SUM(l.qty - l.qty_delivered)
           FROM sales_document_lines l
           JOIN sales_documents d      ON d.id = l.document_id
           JOIN sales_order_details o  ON o.document_id = d.id
          WHERE l.product_id = ?
            AND d.doc_type = 'sales_order'
            AND d.status IN ('draft','saved','issued')
            AND o.fulfilment_status IN ('open','part_delivered')
            AND o.reserves_stock = 1
       ), 0)
       +
       COALESCE((
         SELECT SUM(ll.qty)
           FROM layby_lines ll
           JOIN laybys lb ON lb.id = ll.layby_id
          WHERE ll.product_id = ? AND lb.status = 'open'
       ), 0)
       +
       /* Parts on an accepted job quote (220). Kept in step with the same branch
          in reservedQtyFor below — two functions answering one question must not
          be able to disagree, and a claim counted by one and not the other is
          exactly the drift nobody would think to look for. */
       COALESCE((
         SELECT SUM(jr.qty)
           FROM job_stock_reservations jr
          WHERE jr.product_id = ?
       ), 0) AS reserved`,
    [productId, productId, productId],
  )
  // Online holds are added separately and tolerantly — see the note in
  // reservedQtyFor for why they are not in the query above.
  const held = await heldQtyFor(siteId, [productId])
  return toNum(row?.reserved) + (held.get(productId) ?? 0)
}

/**
 * Reserved quantities for many products at once.
 *
 * The till asks about every line on the screen, and one query per line turns a
 * ten-line basket into ten round trips. Products with nothing reserved are
 * simply absent from the map — the caller reads a missing key as zero.
 */
export async function reservedQtyFor(
  siteId: number,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()

  // UNION ALL then group, rather than two subqueries per row: this runs once
  // for the whole basket, and a product reserved by both an order and a
  // lay-by must have the two summed rather than one shadowing the other.
  const placeholders = ids.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT product_id, SUM(reserved) AS reserved FROM (
       SELECT l.product_id, SUM(l.qty - l.qty_delivered) AS reserved
         FROM sales_document_lines l
         JOIN sales_documents d      ON d.id = l.document_id
         JOIN sales_order_details o  ON o.document_id = d.id
        WHERE l.product_id IN (${placeholders})
          AND d.doc_type = 'sales_order'
          AND d.status IN ('draft','saved','issued')
          AND o.fulfilment_status IN ('open','part_delivered')
          AND o.reserves_stock = 1
        GROUP BY l.product_id
       UNION ALL
       SELECT ll.product_id, SUM(ll.qty) AS reserved
         FROM layby_lines ll
         JOIN laybys lb ON lb.id = ll.layby_id
        WHERE ll.product_id IN (${placeholders})
          AND lb.status = 'open'
        GROUP BY ll.product_id
       UNION ALL
       /*
        * Parts on an accepted job quote (220).
        *
        * The one STORED claim among the three derived ones, and the reason is in
        * jobReservations' header: a job line means four different things across
        * its life, so its claim is an event rather than a property of the row.
        *
        * It still belongs in this UNION rather than beside it, because the
        * question is the same — how much of this product is promised to somebody
        * — and a caller should not have to know which claims are stored.
        *
        * No status filter is needed: setStatus deletes every claim the moment a
        * job stops being open, and issuing or invoicing releases by exactly what
        * moved. A row here IS a live claim, which is what the unique key and
        * reconcileJobReservations exist to keep true.
        */
       SELECT jr.product_id, SUM(jr.qty) AS reserved
         FROM job_stock_reservations jr
        WHERE jr.product_id IN (${placeholders})
        GROUP BY jr.product_id
     ) AS claims
     GROUP BY product_id`,
    [...ids, ...ids, ...ids],
  )

  const reserved = new Map(rows.map((r) => [Number(r.product_id), toNum(r.reserved)]))

  /*
   * ── Online holds, added SEPARATELY and tolerantly ───────────────────────
   *
   * A third claim of the same kind as the two above — an online order awaiting
   * acceptance has promised goods to a named shopper without moving anything
   * (076). It is not folded into the UNION because this function is on the
   * till's hot path, and a store that has not run 076 yet has no such table:
   * one missing relation would turn every availability read into an error and
   * stop the shop selling, which is far worse than the feature being absent.
   *
   * heldQtyFor swallows that case and yields an empty map, so an unmigrated
   * store simply behaves as it did before holds existed.
   */
  const held = await heldQtyFor(siteId, ids)
  for (const [productId, qty] of held) {
    reserved.set(productId, (reserved.get(productId) ?? 0) + qty)
  }

  return reserved
}

export type Availability = {
  productId: number
  /** The pile in the MAIN location — what the counter can actually hand over. */
  onHand: number
  /** Everything the business owns, everywhere. Shown so the two can be compared. */
  onHandAllLocations: number
  reserved: number
  /** What can still be promised to someone new. Goes negative when oversold. */
  available: number
}

/**
 * What is actually sellable: in the MAIN location, less what is promised.
 *
 * The distinction matters at the counter. Ten on the shelf with eight reserved
 * for a customer collecting tomorrow means two are available — selling the
 * eight is not a stock error, it is a broken promise, and nothing in
 * `stock_on_hand` alone can tell you that.
 *
 * ── WHY MAIN AND NOT THE SITE TOTAL ────────────────────────────────────────
 *
 * Stock in a back warehouse is owned but not sellable at this counter until
 * someone carries it here. Reading the site total would have the till promise
 * goods that are in another building, which is the exact failure the reserved
 * figure exists to prevent — just with a lorry in the way instead of a
 * customer.
 *
 * Both figures are returned so a screen can say "2 here, 480 in the warehouse"
 * rather than appearing to have lost the stock.
 *
 * `available` is allowed to go negative. Clamping it at zero would hide an
 * over-commitment, which is precisely the thing worth seeing.
 *
 * Reservations stay SITE-WIDE: an order line does not name a location, so
 * subtracting the whole promise from the main pile is the conservative reading
 * and never over-promises.
 */
export async function availableToSell(
  siteId: number,
  productIds: readonly number[],
): Promise<Map<number, Availability>> {
  const ids = [...new Set(productIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()

  const placeholders = ids.map(() => '?').join(',')

  // LEFT JOIN, not an inner one: a product with no pile in main yet is not
  // missing from the till, it has none there — which is a 0, not an absence.
  const [rows, reserved] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT p.id,
              p.stock_on_hand                 AS total_on_hand,
              COALESCE(pls.stock_on_hand, 0)  AS main_on_hand
         FROM products p
         LEFT JOIN stock_locations l
                ON l.is_main = 1
         LEFT JOIN product_location_stock pls
                ON pls.product_id = p.id AND pls.location_id = l.id
        WHERE p.id IN (${placeholders})`,
      ids,
    ),
    reservedQtyFor(siteId, ids),
  ])

  return new Map(
    rows.map((r) => {
      const productId = Number(r.id)
      const onHand = toNum(r.main_on_hand)
      const claimed = reserved.get(productId) ?? 0
      return [
        productId,
        {
          productId,
          onHand,
          onHandAllLocations: toNum(r.total_on_hand),
          reserved: claimed,
          available: round(onHand - claimed, 3),
        },
      ]
    }),
  )
}
