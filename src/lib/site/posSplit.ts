import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { documentTotals, lineTotals } from '../documentMath'
import { getDocument } from './salesDocuments'
import type { Actor } from './activityLog'

/**
 * Splitting a bill.
 *
 * ── THERE IS NO SUCH THING AS A SPLIT BILL ────────────────────────────────
 *
 * That is the whole design. A "split" is lines MOVING from one table's bill to another
 * table's bill — and since a table's bill is already an ordinary `saved` document
 * (posTables.ts), the result is two ordinary bills on two tables. No new table, no
 * `split_of` column, no parent/child, no third kind of unfinished sale.
 *
 * What that buys, and it is most of the value of this file being short:
 *
 *   · Each half is finalised by `finaliseDocument` like anything else, so specials, VAT,
 *     rounding, stock and the GL mirror all apply without being restated.
 *   · A split bill can be split again, with no special case — it is just a bill.
 *   · Nothing downstream has to learn what a split is. Reports, the day-end, the VAT
 *     return and `verifySequence` see two documents, which is what they are.
 *
 * The alternative — one document with a `seat` or `split_group` column on its lines —
 * was considered and rejected. Every screen that sums a document would have to learn to
 * group by it, and the first one that forgot would show one table's food on another's
 * bill. Two documents cannot make that mistake.
 *
 * ── THE ONE RULE THAT MATTERS ─────────────────────────────────────────────
 *
 * NO LINE MAY FALL OFF BOTH BILLS. Both halves are written in ONE transaction, so a
 * crash mid-split leaves the original bill untouched rather than half of it moved and
 * the rest gone. A waiter can re-do a split; nobody can reconstruct a line that was
 * never anywhere.
 *
 * That is also why this does not call `saveDraft` twice: two calls are two transactions,
 * and the window between them is exactly the failure this rule forbids. The line writes
 * are done here, against the same connection, from the same recomputed arithmetic
 * `documentMath` gives every other path.
 */

type Row = RowDataPacket & Record<string, unknown>

/** One line's worth of a split: which line, and how much of it moves. */
export type SplitMove = {
  /** `sales_document_lines.id` on the SOURCE bill. */
  lineId: number
  /**
   * How many units move. May be less than the line's qty — "one of the three beers goes
   * on Dave's bill" is the request this exists for — in which case the line ends up on
   * BOTH bills with the quantity divided between them.
   */
  qty: number
}

export type SplitInput = {
  /** The table whose bill is being split. */
  fromTableId: number
  /** Where the moved lines go. Must be a table with no open bill of its own. */
  toTableId: number
  moves: SplitMove[]
}

export type SplitResult =
  | { ok: true; fromDocumentId: number | null; toDocumentId: number }
  | { ok: false; error: string }

/**
 * Moves part of one table's bill onto another table.
 *
 * The destination must be FREE. Merging onto a table that already has a bill is a
 * different operation with a different failure mode — two parties' food on one bill,
 * with no way to tell afterwards which was which — and it is not offered here rather
 * than being offered and hedged.
 */
export async function splitTableBill(
  siteId: number,
  actor: Actor,
  input: SplitInput,
): Promise<SplitResult> {
  if (input.fromTableId === input.toTableId) {
    return { ok: false, error: 'Choose a different table to move the items to.' }
  }
  if (input.moves.length === 0) {
    return { ok: false, error: 'Choose what to move.' }
  }
  for (const move of input.moves) {
    if (!Number.isFinite(move.qty) || move.qty <= 0) {
      return { ok: false, error: 'A moved quantity must be more than nothing.' }
    }
  }

  return siteTransaction(siteId, async (tx) => {
    /*
     * Both tables locked, LOWEST ID FIRST.
     *
     * Ordered deliberately: two waiters splitting between the same pair of tables in
     * opposite directions would deadlock if each locked its own source first. Taking
     * them in a consistent order means one waits for the other instead.
     */
    const [first, second] =
      input.fromTableId < input.toTableId
        ? [input.fromTableId, input.toTableId]
        : [input.toTableId, input.fromTableId]

    const [lockRows] = await tx.query(
      `SELECT t.id, t.code, t.document_id,
              (SELECT d.status FROM sales_documents d WHERE d.id = t.document_id) AS doc_status
         FROM pos_tables t WHERE t.id IN (?, ?) ORDER BY t.id FOR UPDATE`,
      [first, second],
    )
    const locked = lockRows as Row[]
    const from = locked.find((r) => Number(r.id) === input.fromTableId)
    const to = locked.find((r) => Number(r.id) === input.toTableId)
    if (!from || !to) return { ok: false, error: 'That table no longer exists.' }

    const sourceDocId = from.document_id === null ? null : Number(from.document_id)
    if (sourceDocId === null || from.doc_status !== 'saved') {
      return { ok: false, error: 'That table has no open bill to split.' }
    }

    /* The destination must be free. A table whose bill was PAID keeps its pointer until
       something clears it, so the status is what decides — checking the column alone
       would refuse a table settled an hour ago. Same reasoning as seatTable. */
    const destDocId = to.document_id === null ? null : Number(to.document_id)
    if (destDocId !== null && to.doc_status === 'saved') {
      return {
        ok: false,
        error: `${String(to.code)} already has a bill. Move these to a free table.`,
      }
    }

    /* The source lines, read INSIDE the lock — anything read before it can have changed
       by the time the write lands, which is the whole reason this is a transaction. */
    const [lineRows] = await tx.query(
      `SELECT id, product_id, product_code, description, product_type, department_id,
              qty, unit_price_incl, discount_pct, vat_rate_pct, unit_cost_excl,
              sales_rep_id, sales_rep_user_id, special_id
         FROM sales_document_lines WHERE document_id = ? ORDER BY line_number`,
      [sourceDocId],
    )
    const lines = lineRows as Row[]
    if (lines.length === 0) return { ok: false, error: 'That bill has nothing on it.' }

    const byId = new Map(lines.map((l) => [Number(l.id), l]))
    for (const move of input.moves) {
      const line = byId.get(move.lineId)
      if (!line) return { ok: false, error: 'One of those items is no longer on the bill.' }
      /* More than is there. Half a cent of tolerance because a qty is DECIMAL(12,3) and
         a UI that computed 3 - 2.999 should not be refused for floating-point reasons. */
      if (move.qty > toNum(line.qty) + 0.0005) {
        return {
          ok: false,
          error: `There ${toNum(line.qty) === 1 ? 'is' : 'are'} only ${toNum(line.qty)} × ${String(line.description)} on the bill.`,
        }
      }
    }

    /* Two halves. A line moved in PART appears in both; moved in FULL, only in the
       destination. Built from the SAME source row either way, so a part-moved line
       cannot drift in price or cost between the two bills. */
    const movedBy = new Map(input.moves.map((m) => [m.lineId, m.qty]))
    const kept: Row[] = []
    const moved: Row[] = []
    for (const line of lines) {
      const moveQty = movedBy.get(Number(line.id)) ?? 0
      const total = toNum(line.qty)
      const keepQty = round(total - moveQty, 3)
      if (moveQty > 0) moved.push({ ...line, qty: moveQty })
      if (keepQty > 0.0005) kept.push({ ...line, qty: keepQty })
    }

    if (moved.length === 0) return { ok: false, error: 'Nothing would move.' }

    /*
     * The DESTINATION bill is created first, then the source rewritten.
     *
     * Order matters for what a crash leaves behind — and inside one transaction it
     * cannot leave anything behind, which is the point. Were these two transactions,
     * this order would leave a duplicated line rather than a lost one, and a duplicate
     * is recoverable where a loss is not. Stated because somebody will one day be
     * tempted to split this into two calls for readability.
     */
    const destination = await insertBill(tx, siteId, actor, sourceDocId, moved)
    if (!destination.ok) return destination

    await rewriteLines(tx, sourceDocId, kept)
    await restate(tx, sourceDocId, kept)

    /*
     * A bill with nothing left on it is not a bill.
     *
     * Moving EVERYTHING is a legitimate gesture — a party moved to a different table —
     * and it must free the one they left rather than leaving an empty bill somebody has
     * to work out how to close. The document is discarded rather than kept at zero,
     * because a zero-total saved sale is a thing every report has to learn to ignore.
     */
    if (kept.length === 0) {
      await tx.execute(`UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE id = ?`, [
        input.fromTableId,
      ] as never)
      await tx.execute(`UPDATE sales_documents SET status = 'cancelled' WHERE id = ?`, [
        sourceDocId,
      ] as never)
    }

    /* And the destination table now holds its bill. bill_asked_at cleared: a fresh bill
       has not been asked for, and inheriting the source's "waiting to pay" would show a
       party as ready before they had seen a total. */
    await tx.execute(
      `UPDATE pos_tables SET document_id = ?, bill_asked_at = NULL WHERE id = ?`,
      [destination.documentId, input.toTableId] as never,
    )

    return {
      ok: true,
      fromDocumentId: kept.length === 0 ? null : sourceDocId,
      toDocumentId: destination.documentId,
    }
  })
}

/**
 * Moves a WHOLE tab to another table.
 *
 * Not a split: the document keeps its identity — id, lines, customer, price
 * structure, covers — and only the table's pointer moves. Splitting everything
 * via `splitTableBill` would cancel the source document and mint a new one,
 * which is wrong for a party that simply moved: their bill's history should
 * read as one bill that changed tables, not a bill that died and a stranger
 * that appeared.
 *
 * Lives here rather than in posTables.ts because the both-tables-locked
 * pattern and the occupancy rules are already stated above, and two copies of
 * a deadlock-ordering argument is one copy too many.
 */
export async function transferTableBill(
  siteId: number,
  actor: Actor,
  input: { fromTableId: number; toTableId: number },
): Promise<{ ok: true; documentId: number } | { ok: false; error: string }> {
  if (input.fromTableId === input.toTableId) {
    return { ok: false, error: 'Choose a different table to move the bill to.' }
  }

  return siteTransaction(siteId, async (tx) => {
    // Both tables locked, LOWEST ID FIRST — same reasoning as the split above.
    const [first, second] =
      input.fromTableId < input.toTableId
        ? [input.fromTableId, input.toTableId]
        : [input.toTableId, input.fromTableId]

    const [lockRows] = await tx.query(
      `SELECT t.id, t.code, t.is_active, t.document_id,
              (SELECT d.status FROM sales_documents d WHERE d.id = t.document_id) AS doc_status
         FROM pos_tables t WHERE t.id IN (?, ?) ORDER BY t.id FOR UPDATE`,
      [first, second],
    )
    const locked = lockRows as Row[]
    const from = locked.find((r) => Number(r.id) === input.fromTableId)
    const to = locked.find((r) => Number(r.id) === input.toTableId)
    if (!from || !to) return { ok: false, error: 'That table no longer exists.' }
    if (Number(to.is_active) !== 1) {
      return { ok: false, error: `${String(to.code)} is closed off.` }
    }

    const sourceDocId = from.document_id === null ? null : Number(from.document_id)
    if (sourceDocId === null || from.doc_status !== 'saved') {
      return { ok: false, error: 'That table has no open bill to move.' }
    }

    /* Free by STATUS, not by pointer — a table settled an hour ago keeps its
       pointer until something clears it. Merging is not offered, exactly as
       with a split: two parties' food on one bill cannot be told apart later. */
    const destDocId = to.document_id === null ? null : Number(to.document_id)
    if (destDocId !== null && to.doc_status === 'saved') {
      return {
        ok: false,
        error: `${String(to.code)} already has a bill. Move it to a free table.`,
      }
    }

    /* bill_asked_at cleared on BOTH sides: the party that moved has not asked
       at the new table, and the table they left has nobody waiting to pay. */
    await tx.execute(
      `UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE id = ?`,
      [input.fromTableId] as never,
    )
    await tx.execute(
      `UPDATE pos_tables SET document_id = ?, bill_asked_at = NULL WHERE id = ?`,
      [sourceDocId, input.toTableId] as never,
    )

    // A tab that walks across the floor leaves a trail.
    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'transferred', ?, ?, ?)`,
      [
        sourceDocId,
        `${String(from.code)} → ${String(to.code)}`,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    return { ok: true as const, documentId: sourceDocId }
  })
}

/* ── Writing the two halves ──────────────────────────────────────────────── */

/**
 * Creates the destination bill, copying the source document's header.
 *
 * The header is COPIED rather than rebuilt from defaults: the customer, the price
 * structure and the terminal are properties of the sitting, not of the lines, and a
 * split half that lost its price structure would reprice at retail — turning a staff
 * discount into full price halfway through a meal.
 */
async function insertBill(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  siteId: number,
  actor: Actor,
  sourceDocId: number,
  lines: Row[],
): Promise<{ ok: true; documentId: number } | { ok: false; error: string }> {
  const [headRows] = await tx.query(
    `SELECT doc_type, document_date, customer_id, customer_name, customer_vat_no,
            terminal_id, terminal_code, price_structure_id
       FROM sales_documents WHERE id = ?`,
    [sourceDocId],
  )
  const head = (headRows as Row[])[0]
  if (!head) return { ok: false, error: 'That bill no longer exists.' }

  const computed = lines.map((l) => ({
    ...lineTotals({
      qty: toNum(l.qty),
      unitPriceIncl: toNum(l.unit_price_incl),
      discountPct: toNum(l.discount_pct),
      vatRatePct: toNum(l.vat_rate_pct),
    }),
    vatRatePct: toNum(l.vat_rate_pct),
  }))
  const totals = documentTotals(computed)

  const [res] = await tx.execute(
    `INSERT INTO sales_documents
       (doc_type, status, document_date, customer_id, customer_name, customer_vat_no,
        user_id, user_name, terminal_id, terminal_code, price_structure_id,
        subtotal_excl, vat_total, discount_total, total_incl)
     VALUES (?, 'saved', ?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(head.doc_type ?? 'invoice'),
      head.document_date,
      head.customer_id ?? null,
      head.customer_name ?? 'Walk-in',
      head.customer_vat_no ?? null,
      actor.userId,
      actor.userName.slice(0, 120),
      head.terminal_id ?? null,
      head.terminal_code ?? null,
      head.price_structure_id ?? null,
      totals.subtotalExcl.toFixed(4),
      totals.vatTotal.toFixed(4),
      totals.discountTotal.toFixed(4),
      totals.totalIncl.toFixed(4),
    ] as never,
  )
  const documentId = (res as { insertId: number }).insertId
  await rewriteLines(tx, documentId, lines)
  return { ok: true, documentId }
}

/** Replaces a document's lines wholesale, renumbered from 1. */
async function rewriteLines(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  documentId: number,
  lines: Row[],
): Promise<void> {
  await tx.execute(`DELETE FROM sales_document_lines WHERE document_id = ?`, [documentId] as never)
  let n = 0
  for (const line of lines) {
    n += 1
    const totals = lineTotals({
      qty: toNum(line.qty),
      unitPriceIncl: toNum(line.unit_price_incl),
      discountPct: toNum(line.discount_pct),
      vatRatePct: toNum(line.vat_rate_pct),
    })
    await tx.execute(
      `INSERT INTO sales_document_lines
         (document_id, line_number, product_id, product_code, description, product_type,
          department_id, sales_rep_id, sales_rep_user_id, special_id,
          qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
          line_total_incl, line_total_excl, line_vat, unit_cost_excl)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        documentId,
        n,
        line.product_id ?? null,
        line.product_code ?? null,
        String(line.description).slice(0, 190),
        line.product_type ?? 'normal',
        line.department_id ?? null,
        line.sales_rep_id ?? null,
        line.sales_rep_user_id ?? null,
        line.special_id ?? null,
        toNum(line.qty).toFixed(3),
        toNum(line.unit_price_incl).toFixed(4),
        toNum(line.discount_pct).toFixed(3),
        totals.discountIncl.toFixed(4),
        toNum(line.vat_rate_pct).toFixed(3),
        totals.lineTotalIncl.toFixed(4),
        totals.lineTotalExcl.toFixed(4),
        totals.lineVat.toFixed(4),
        toNum(line.unit_cost_excl).toFixed(4),
      ] as never,
    )
  }
}

/** Recomputes a document's stored totals from the lines now on it. */
async function restate(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  documentId: number,
  lines: Row[],
): Promise<void> {
  const computed = lines.map((l) => ({
    ...lineTotals({
      qty: toNum(l.qty),
      unitPriceIncl: toNum(l.unit_price_incl),
      discountPct: toNum(l.discount_pct),
      vatRatePct: toNum(l.vat_rate_pct),
    }),
    vatRatePct: toNum(l.vat_rate_pct),
  }))
  const totals = documentTotals(computed)
  await tx.execute(
    `UPDATE sales_documents
        SET subtotal_excl = ?, vat_total = ?, discount_total = ?, total_incl = ?
      WHERE id = ?`,
    [
      totals.subtotalExcl.toFixed(4),
      totals.vatTotal.toFixed(4),
      totals.discountTotal.toFixed(4),
      totals.totalIncl.toFixed(4),
      documentId,
    ] as never,
  )
}

/** The lines on a table's bill, for the split screen to divide. */
export async function billLinesForSplit(siteId: number, tableId: number) {
  const table = await siteQueryOne<Row>(
    siteId,
    `SELECT document_id FROM pos_tables WHERE id = ?`,
    [tableId],
  )
  const documentId = table?.document_id === null ? null : Number(table?.document_id)
  if (!documentId) return null

  const doc = await getDocument(siteId, documentId)
  if (!doc || doc.status !== 'saved') return null

  return {
    documentId,
    lines: doc.lines.map((l) => ({
      id: l.id,
      description: l.description,
      productCode: l.productCode,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: l.lineTotalIncl,
    })),
    totalIncl: doc.totalIncl,
  }
}
