import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { weightedAverageCost } from '../documentMath'
import { recordMovement } from './stockMovements'
import { nextDocumentNumber } from './sequences'
import { guardPosting } from './periodLocks'
import { allocateBlockTest, validateBlockTest, type BlockTestOutput } from '../blockTestMath'
import type { Actor } from './activityLog'

/**
 * Posting a block test — the carcass out, the cuts in, in one transaction.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * Not a manufacturing order. `manufacturing_orders` carries a single
 * product_id: many components in, ONE finished good out. A block test is the
 * exact inverse — one carcass in, twenty cuts out, each at a different value —
 * and that inversion is the entire feature. Every vendor in this market bends a
 * production order into it, which is why none of them report per-cut margin.
 *
 * ── THE MOVEMENT PAIR ────────────────────────────────────────────────────
 *
 * `block_test_out` consumes the carcass, `block_test_in` receives each cut,
 * all through `recordMovement()` so the stock invariants hold by construction
 * and the batch hook (148) sees every one. Its own movement types rather than
 * 'adjustment', for the reason unpacking and manufacturing each took theirs: a
 * manager asking why the hindquarter count dropped must see it was broken
 * down, not adjusted away.
 *
 * ── COST TRAVELS WITH THE MEAT ───────────────────────────────────────────
 *
 * `recordMovement` records a cost but never BLENDS one, so like
 * `referBreakdown` and `purchasePosting` this module is a deliberate writer of
 * `products.average_cost`. A cut that appeared at cost zero would poison the GP
 * on every sale of it, and nothing downstream would ever correct it.
 *
 * The blend weighs against the position read BEFORE the movement — that is the
 * position the average has to move from, and reading it after would blend the
 * new stock against itself.
 */

type Row = RowDataPacket & Record<string, unknown>

export type BlockTestLineInput = {
  productId: number | null
  productCode?: string | null
  description: string
  qty: number
  costFactor: number
  excludeFromApportionment?: boolean
  isLoss?: boolean
  note?: string | null
}

export type BlockTestInput = {
  documentDate: string
  locationId?: number | null
  species?: string
  classCode?: string | null
  fatCode?: string | null
  carcassNo?: string | null
  inputProductId: number
  inputProductCode?: string | null
  inputDescription?: string | null
  inputQty: number
  /** Omitted, the product's own average cost is used — which is the usual case. */
  inputUnitCostExcl?: number | null
  inputBatchId?: number | null
  normalise?: boolean
  varianceAccountId?: number | null
  reference?: string | null
  note?: string | null
  lines: BlockTestLineInput[]
}

export type PostResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * Posts a block test.
 *
 * Refuses before anything is written, like every other posting path here: a
 * document half-applied to stock is worse than one refused, because the second
 * can be retyped and the first has to be unpicked by hand.
 */
export async function postBlockTest(
  siteId: number,
  actor: Actor,
  input: BlockTestInput,
): Promise<PostResult> {
  const normalise = input.normalise !== false

  const lockRefusal = await guardPosting(siteId, input.documentDate, 'stock')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  const parent = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, description, average_cost, product_type FROM products WHERE id = ? AND is_archived = 0',
    [input.inputProductId],
  )
  if (!parent) return { ok: false, error: 'That carcass product no longer exists.' }

  /*
   * The input's cost per kilo, from the product unless the caller says
   * otherwise. Read here rather than inside the transaction because a block
   * test is typed over minutes and the figure shown while typing must be the
   * figure that posts — see the live panel in blockTestMath.
   */
  const inputUnitCost =
    input.inputUnitCostExcl != null && input.inputUnitCostExcl >= 0
      ? round(input.inputUnitCostExcl, 4)
      : round(toNum(parent.average_cost), 4)

  const outputs: BlockTestOutput[] = input.lines.map((l) => ({
    qty: l.qty,
    costFactor: l.costFactor,
    excludeFromApportionment: l.excludeFromApportionment,
    isLoss: l.isLoss,
  }))

  const invalid = validateBlockTest({
    inputQty: input.inputQty,
    inputUnitCostExcl: inputUnitCost,
    outputs,
    normalise,
  })
  if (invalid) return { ok: false, error: invalid }

  /*
   * A cut that is not a loss has to name a product, or there is nothing to
   * receive the stock into. Checked here rather than in the pure validator,
   * which knows about arithmetic and not about the product file.
   */
  for (const [i, line] of input.lines.entries()) {
    if (!line.isLoss && !line.productId) {
      return { ok: false, error: `Line ${i + 1}: choose a product, or mark it as waste.` }
    }
  }

  const allocation = allocateBlockTest({
    inputQty: input.inputQty,
    inputUnitCostExcl: inputUnitCost,
    outputs,
    normalise,
  })

  /*
   * Not normalising leaves a residual, and it has to GO somewhere nameable.
   * Refusing here rather than posting it nowhere: the whole reason the flag
   * exists is a shop wanting yield loss visible in the P&L, and a variance
   * with no account is the silent loss the flag was meant to prevent.
   */
  if (!normalise && allocation.varianceCost > 0.005 && !input.varianceAccountId) {
    return {
      ok: false,
      error:
        'This test does not recover the full carcass cost. Choose a yield-variance account, or normalise so the cuts absorb it.',
    }
  }

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      const documentNumber = await nextDocumentNumber(tx, 'block_test')

      const [res] = await tx.execute(
        `INSERT INTO block_tests
           (document_number, document_date, status, location_id, species, class_code, fat_code,
            carcass_no, input_product_id, input_product_code, input_description, input_qty,
            input_unit_cost_excl, input_batch_id, apportionment, normalise, variance_account_id,
            input_cost, output_cost, variance_cost, yield_pct, reference, note,
            user_id, user_name, posted_at)
         VALUES (?,?,'posted',?,?,?,?,?,?,?,?,?,?,?,'factor',?,?,?,?,?,?,?,?,?,?,NOW())`,
        [
          documentNumber,
          input.documentDate,
          input.locationId ?? null,
          (input.species ?? 'beef').slice(0, 20),
          input.classCode ?? null,
          input.fatCode ?? null,
          input.carcassNo ?? null,
          input.inputProductId,
          (input.inputProductCode ?? String(parent.code ?? '')).slice(0, 40),
          (input.inputDescription ?? String(parent.description ?? '')).slice(0, 190),
          round(input.inputQty, 3).toFixed(3),
          inputUnitCost.toFixed(4),
          input.inputBatchId ?? null,
          normalise ? 1 : 0,
          input.varianceAccountId ?? null,
          allocation.inputCost.toFixed(4),
          allocation.outputCost.toFixed(4),
          allocation.varianceCost.toFixed(4),
          allocation.yieldPct.toFixed(3),
          input.reference ?? null,
          input.note ?? null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const id = (res as { insertId: number }).insertId

      /*
       * ── THE CARCASS GOES OUT FIRST ─────────────────────────────────────
       *
       * Before the cuts come in, deliberately. A shop breaking down the last
       * hindquarter would otherwise briefly hold both the carcass and
       * everything cut from it, and any concurrent read — a till checking
       * availability, a reorder run — would see stock that does not exist.
       */
      await recordMovement(tx, actor, {
        productId: input.inputProductId,
        locationId: input.locationId ?? null,
        movementType: 'block_test_out',
        qtyChange: -round(input.inputQty, 3),
        unitCostExcl: inputUnitCost,
        source: 'block_test',
        sourceDocId: id,
        note: `Broken down on ${documentNumber}`.slice(0, 190),
        // The carcass IS a lot: consume the exact one, never FEFO. A block
        // test names its input, so guessing would be a worse answer than the
        // one already in hand (236, and the lot rules in 234).
        batch: input.inputBatchId ? { batchId: input.inputBatchId } : undefined,
      })

      for (const [i, line] of input.lines.entries()) {
        const share = allocation.lines[i]!

        const [lineRes] = await tx.execute(
          `INSERT INTO block_test_lines
             (block_test_id, line_number, product_id, product_code, description, qty,
              cost_factor, exclude_from_apportionment, is_loss,
              allocated_cost_excl, unit_cost_excl, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            i + 1,
            line.productId ?? null,
            (line.productCode ?? '').slice(0, 40),
            line.description.slice(0, 190),
            round(line.qty, 3).toFixed(3),
            round(line.costFactor, 4).toFixed(4),
            line.excludeFromApportionment ? 1 : 0,
            line.isLoss ? 1 : 0,
            share.allocatedCostExcl.toFixed(4),
            share.unitCostExcl.toFixed(4),
            line.note ?? null,
          ] as never,
        )

        /*
         * Bone in the bin is not stock. It consumed input weight — which is
         * what makes the yield honest — and becomes no movement and no row on
         * any shelf.
         */
        if (line.isLoss || !line.productId || line.qty <= 0) continue

        // Read BEFORE the movement: this is the position the average has to
        // move from, and reading it after would blend the new stock against
        // itself.
        const before = await siteQueryOne<Row>(
          siteId,
          'SELECT stock_on_hand, average_cost FROM products WHERE id = ?',
          [line.productId],
        )

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: input.locationId ?? null,
          movementType: 'block_test_in',
          qtyChange: round(line.qty, 3),
          unitCostExcl: share.unitCostExcl,
          source: 'block_test',
          sourceDocId: id,
          sourceLineId: (lineRes as { insertId: number }).insertId,
          note: `From ${documentNumber}`.slice(0, 190),
        })

        /*
         * Blend, exactly as a receipt does. `recordMovement` records a cost
         * but never blends one, so this module joins purchasePosting,
         * manufacturing and referBreakdown as a deliberate writer of
         * average_cost. A cut arriving at cost zero would poison the GP on
         * every sale of it, for ever.
         */
        const blended = weightedAverageCost({
          existingQty: toNum(before?.stock_on_hand),
          existingCostExcl: toNum(before?.average_cost),
          receivedQty: round(line.qty, 3),
          receivedCostExcl: share.unitCostExcl,
        })
        await tx.execute('UPDATE products SET average_cost = ?, last_cost = ? WHERE id = ?', [
          blended.toFixed(4),
          share.unitCostExcl.toFixed(4),
          line.productId,
        ] as never)
      }

      return { id, documentNumber }
    })

    return { ok: true, ...posted }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The block test could not be posted.' }
  }
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

export type BlockTestSummary = {
  id: number
  documentNumber: string | null
  documentDate: string
  status: string
  species: string
  carcassNo: string | null
  inputDescription: string
  inputQty: number
  inputCost: number
  outputCost: number
  varianceCost: number
  yieldPct: number
  userName: string
}

export async function listBlockTests(
  siteId: number,
  options: { species?: string; limit?: number } = {},
): Promise<BlockTestSummary[]> {
  const where: string[] = ["status <> 'cancelled'"]
  const params: unknown[] = []
  if (options.species) {
    where.push('species = ?')
    params.push(options.species)
  }
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, document_date, status, species, carcass_no, input_description,
            input_qty, input_cost, output_cost, variance_cost, yield_pct, user_name
       FROM block_tests
      WHERE ${where.join(' AND ')}
      ORDER BY document_date DESC, id DESC
      LIMIT ${Math.min(500, Math.max(1, options.limit ?? 100))}`,
    params,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date).slice(0, 10),
    status: String(r.status),
    species: String(r.species ?? ''),
    carcassNo: (r.carcass_no as string | null) ?? null,
    inputDescription: String(r.input_description ?? ''),
    inputQty: toNum(r.input_qty),
    inputCost: toNum(r.input_cost),
    outputCost: toNum(r.output_cost),
    varianceCost: toNum(r.variance_cost),
    yieldPct: toNum(r.yield_pct),
    userName: String(r.user_name ?? ''),
  }))
}

/**
 * One block test with its cuts — what went in, what came out, what each cost.
 */
export async function getBlockTest(
  siteId: number,
  id: number,
): Promise<{
  test: BlockTestSummary & { note: string | null; normalise: boolean }
  lines: {
    lineNumber: number
    productId: number | null
    productCode: string
    description: string
    qty: number
    costFactor: number
    isLoss: boolean
    allocatedCostExcl: number
    unitCostExcl: number
  }[]
} | null> {
  const head = await siteQueryOne<Row>(siteId, 'SELECT * FROM block_tests WHERE id = ?', [id])
  if (!head) return null

  const lines = await siteQuery<Row>(
    siteId,
    'SELECT * FROM block_test_lines WHERE block_test_id = ? ORDER BY line_number',
    [id],
  )

  return {
    test: {
      id: Number(head.id),
      documentNumber: (head.document_number as string | null) ?? null,
      documentDate: String(head.document_date).slice(0, 10),
      status: String(head.status),
      species: String(head.species ?? ''),
      carcassNo: (head.carcass_no as string | null) ?? null,
      inputDescription: String(head.input_description ?? ''),
      inputQty: toNum(head.input_qty),
      inputCost: toNum(head.input_cost),
      outputCost: toNum(head.output_cost),
      varianceCost: toNum(head.variance_cost),
      yieldPct: toNum(head.yield_pct),
      userName: String(head.user_name ?? ''),
      note: (head.note as string | null) ?? null,
      normalise: Number(head.normalise) === 1,
    },
    lines: lines.map((l) => ({
      lineNumber: Number(l.line_number),
      productId: l.product_id === null ? null : Number(l.product_id),
      productCode: String(l.product_code ?? ''),
      description: String(l.description ?? ''),
      qty: toNum(l.qty),
      costFactor: toNum(l.cost_factor),
      isLoss: Number(l.is_loss) === 1,
      allocatedCostExcl: toNum(l.allocated_cost_excl),
      unitCostExcl: toNum(l.unit_cost_excl),
    })),
  }
}
