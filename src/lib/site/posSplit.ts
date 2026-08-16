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
 * ── THE DESTINATION MAY ALREADY HAVE A BILL ───────────────────────────────
 *
 * "Two people at table 12 are paying together with the four at 14" is an ordinary
 * request, and refusing it sends the waiter to move the lines by hand — retyping an
 * order, which is the one way a line really does get lost. So a split onto an OCCUPIED
 * table appends to the bill already there.
 *
 * The cost is real and worth naming: once appended, nothing records that those lines
 * arrived from somewhere else, so a merge cannot be un-done by a second split unless the
 * waiter remembers what came across. That is a worse outcome than the retyping it
 * replaces only if merges are common and mistaken, which they are not — and a line moved
 * onto the wrong bill is still visible, still priced, and still movable again.
 *
 * Identical lines FUSE on arrival — same product, same unit price, same note — so two
 * beers landing on a bill that has one read as "3 × Castle" rather than three rows. A
 * line the kitchen was told to cook differently keeps its own row: it is not the same
 * thing to the kitchen or to the customer.
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
 * Splitting one open sale onto another, identified by DOCUMENT rather than by table.
 *
 * ── WHY THIS EXISTS BESIDE splitTableBill ─────────────────────────────────
 *
 * A hospitality floor is not only tables. The till's open-sales list mixes bills seated
 * on a `pos_tables` row with free-text tabs — "Tiaan", "Walk-in", a takeaway — and those
 * have no table row at all. `splitTableBill` addresses its destination as a table id, so
 * every one of those tabs was invisible to the split screen: a waiter looking at four
 * open bills was offered only the one that happened to be on the floor plan.
 *
 * Keying the destination on the document fixes that, because a document is the one thing
 * EVERY open sale has. Where the destination also happens to sit on a table, the table's
 * pointer is left exactly as it was — appending to a bill does not move it.
 *
 * `toDocumentId: null` means "start a new sale", which is how a split reaches a bill that
 * does not exist yet without inventing a table to hang it on.
 */
export type SplitToDocumentInput = {
  /** The bill being split. */
  fromDocumentId: number
  /** The bill the lines join, or null to raise a new one. */
  toDocumentId: number | null
  /** What the new bill is called, when one is being raised. */
  newSaleName?: string | null
  moves: SplitMove[]
}

/**
 * Moves part of one table's bill onto another table.
 *
 * The destination may be free or already occupied. A free one gets a new bill copied
 * from the source's header; an occupied one has the lines appended to the bill it
 * already holds, fusing into identical lines where they match. See the module note.
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

    /* Whether the destination is FREE or already holds a bill decides which of the two
       writes below happens. A table whose bill was PAID keeps its pointer until something
       clears it, so the status is what decides — reading the column alone would treat a
       table settled an hour ago as occupied. Same reasoning as seatTable. */
    const destPointer = to.document_id === null ? null : Number(to.document_id)
    const destDocId = destPointer !== null && to.doc_status === 'saved' ? destPointer : null

    /* The source lines, read INSIDE the lock — anything read before it can have changed
       by the time the write lands, which is the whole reason this is a transaction. */
    const [lineRows] = await tx.query(
      /* line_note, kitchen_sent_qty and ordered_at travel with the line. They were
         missing here, and the omission was silent data loss: splitting a table
         dropped "allergy: nuts" off the moved line, reset what the kitchen had
         been told, and restarted the line's age. The instruction rows are
         carried separately — see rewriteLines. */
      `SELECT id, product_id, product_code, description, product_type, department_id,
              qty, unit_price_incl, discount_pct, vat_rate_pct, unit_cost_excl,
              sales_rep_id, sales_rep_user_id, special_id,
              line_note, kitchen_sent_qty, ordered_at
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
      /*
       * What the kitchen has been told has to be divided too, or the split
       * manufactures a ticket. Three beers all sent, one moved: if both halves
       * kept the full sent figure of 3, the delta on each is negative and
       * nothing prints — fine. But if both halves kept ZERO, the next Send
       * prints all three again and the bar pours three more.
       *
       * Divided so the two halves still sum to what was actually sent, and the
       * KEPT side is served first: a line the kitchen has already made stays
       * "made" on the bill it started on, and only the surplus follows the
       * move. Clamped into each half's own quantity, since sent can never
       * exceed what is there.
       */
      const sent = toNum(line.kitchen_sent_qty)
      const keptSent = round(Math.min(keepQty, sent), 3)
      const movedSent = round(Math.min(moveQty, Math.max(0, sent - keptSent)), 3)
      if (moveQty > 0) moved.push({ ...line, qty: moveQty, kitchen_sent_qty: movedSent })
      if (keepQty > 0.0005) kept.push({ ...line, qty: keepQty, kitchen_sent_qty: keptSent })
    }

    if (moved.length === 0) return { ok: false, error: 'Nothing would move.' }

    /*
     * The DESTINATION is written first — created, or appended to — then the source
     * rewritten.
     *
     * Order matters for what a crash leaves behind — and inside one transaction it
     * cannot leave anything behind, which is the point. Were these two transactions,
     * this order would leave a duplicated line rather than a lost one, and a duplicate
     * is recoverable where a loss is not. Stated because somebody will one day be
     * tempted to split this into two calls for readability.
     */
    const destination =
      destDocId === null
        ? await insertBill(tx, siteId, actor, sourceDocId, moved)
        : await appendToBill(tx, destDocId, moved)
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

    /*
     * And the destination table now holds its bill.
     *
     * bill_asked_at is cleared only when the bill is NEW: a fresh bill has not been asked
     * for, and inheriting the source's "waiting to pay" would show a party as ready before
     * they had seen a total. Appending leaves it alone — a table that asked for the bill
     * and then had food moved onto it is still waiting for one, and clearing the flag
     * would drop them off the floor's amber list while they sat there with their hand up.
     */
    await tx.execute(
      destDocId === null
        ? `UPDATE pos_tables SET document_id = ?, bill_asked_at = NULL WHERE id = ?`
        : `UPDATE pos_tables SET document_id = ? WHERE id = ?`,
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
 * Splits one open sale onto another open sale, or onto a brand new one.
 *
 * The same halving `splitTableBill` does — see the module note for how a part-moved line
 * ends up on both bills, and how the kitchen's sent quantities are divided — but with
 * the destination named by document. That is what lets a free-text tab be a destination:
 * it has no `pos_tables` row for the table-based call to address.
 *
 * ── WHAT HAPPENS TO THE TABLES ────────────────────────────────────────────
 *
 * Nothing, deliberately. Appending lines to a bill does not move it: a tab that was on
 * no table stays on none, and one seated at table 4 stays at table 4. The only table
 * write here is the one that frees a table whose bill has been emptied out entirely,
 * because a table pointing at a cancelled document reads as occupied forever.
 */
export async function splitBillOntoDocument(
  siteId: number,
  actor: Actor,
  input: SplitToDocumentInput,
): Promise<SplitResult> {
  if (input.toDocumentId !== null && input.fromDocumentId === input.toDocumentId) {
    return { ok: false, error: 'Choose a different sale to move the items to.' }
  }
  if (input.moves.length === 0) return { ok: false, error: 'Choose what to move.' }
  for (const move of input.moves) {
    if (!Number.isFinite(move.qty) || move.qty <= 0) {
      return { ok: false, error: 'A moved quantity must be more than nothing.' }
    }
  }

  return siteTransaction(siteId, async (tx) => {
    /*
     * Both documents locked, LOWEST ID FIRST — the same deadlock ordering the
     * table-based split uses, for the same reason: two waiters splitting between the
     * same pair of bills in opposite directions would otherwise each hold what the
     * other needs.
     */
    const ids =
      input.toDocumentId === null
        ? [input.fromDocumentId]
        : [input.fromDocumentId, input.toDocumentId].sort((a, b) => a - b)
    const [lockRows] = await tx.query(
      `SELECT id, status FROM sales_documents WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
      ids,
    )
    const locked = lockRows as Row[]

    const source = locked.find((r) => Number(r.id) === input.fromDocumentId)
    if (!source) return { ok: false, error: 'That sale no longer exists.' }
    /* `draft` is accepted alongside `saved` because the till CLAIMS a bill while a
       waiter has it open (171), and splitting from the screen you are sitting in is the
       whole point of this call. What stays refused is a posted document. */
    if (source.status !== 'saved' && source.status !== 'draft') {
      return { ok: false, error: 'That bill has already been settled.' }
    }
    if (input.toDocumentId !== null) {
      const dest = locked.find((r) => Number(r.id) === input.toDocumentId)
      if (!dest) return { ok: false, error: 'That sale no longer exists.' }
      if (dest.status !== 'saved' && dest.status !== 'draft') {
        return { ok: false, error: 'That bill has already been settled.' }
      }
    }

    const [lineRows] = await tx.query(
      `SELECT id, product_id, product_code, description, product_type, department_id,
              qty, unit_price_incl, discount_pct, vat_rate_pct, unit_cost_excl,
              sales_rep_id, sales_rep_user_id, special_id,
              line_note, kitchen_sent_qty, ordered_at
         FROM sales_document_lines WHERE document_id = ? ORDER BY line_number`,
      [input.fromDocumentId],
    )
    const lines = lineRows as Row[]
    if (lines.length === 0) return { ok: false, error: 'That bill has nothing on it.' }

    const byId = new Map(lines.map((l) => [Number(l.id), l]))
    for (const move of input.moves) {
      const line = byId.get(move.lineId)
      if (!line) return { ok: false, error: 'One of those items is no longer on the bill.' }
      if (move.qty > toNum(line.qty) + 0.0005) {
        return {
          ok: false,
          error: `There ${toNum(line.qty) === 1 ? 'is' : 'are'} only ${toNum(line.qty)} × ${String(line.description)} on the bill.`,
        }
      }
    }

    /* Divided exactly as the table split divides — including the kitchen's sent
       quantities, which must still sum to what was actually sent or the next Send
       reprints a ticket the kitchen has already made. */
    const movedBy = new Map(input.moves.map((m) => [m.lineId, m.qty]))
    const kept: Row[] = []
    const moved: Row[] = []
    for (const line of lines) {
      const moveQty = movedBy.get(Number(line.id)) ?? 0
      const keepQty = round(toNum(line.qty) - moveQty, 3)
      const sent = toNum(line.kitchen_sent_qty)
      const keptSent = round(Math.min(keepQty, sent), 3)
      const movedSent = round(Math.min(moveQty, Math.max(0, sent - keptSent)), 3)
      if (moveQty > 0) moved.push({ ...line, qty: moveQty, kitchen_sent_qty: movedSent })
      if (keepQty > 0.0005) kept.push({ ...line, qty: keepQty, kitchen_sent_qty: keptSent })
    }
    if (moved.length === 0) return { ok: false, error: 'Nothing would move.' }

    // Destination first, then the source rewritten — same ordering argument as above.
    const destination =
      input.toDocumentId === null
        ? await insertBill(tx, siteId, actor, input.fromDocumentId, moved, input.newSaleName)
        : await appendToBill(tx, input.toDocumentId, moved)
    if (!destination.ok) return destination

    await rewriteLines(tx, input.fromDocumentId, kept)
    await restate(tx, input.fromDocumentId, kept)

    /* Everything moved. The source bill is discarded rather than kept at zero, and any
       table holding it is freed — a table pointing at a cancelled document would read as
       occupied with no way to clear it. */
    if (kept.length === 0) {
      await tx.execute(
        `UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE document_id = ?`,
        [input.fromDocumentId] as never,
      )
      await tx.execute(`UPDATE sales_documents SET status = 'cancelled' WHERE id = ?`, [
        input.fromDocumentId,
      ] as never)
    }

    return {
      ok: true,
      fromDocumentId: kept.length === 0 ? null : input.fromDocumentId,
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
  /**
   * What to call the new bill, when the waiter has said.
   *
   * Only the DOCUMENT-destination split passes one: splitting onto a free table names
   * the bill after the table, which the caller already knows. Splitting onto "a new
   * sale" has no such name, so the waiter supplies one and it lands here — otherwise
   * every new half would inherit the source's name and a floor of "Walk-in" tabs would
   * be indistinguishable from each other.
   */
  newName?: string | null,
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
      newName?.trim() || head.customer_name || 'Walk-in',
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

/**
 * Appends moved lines to a bill that is already open, fusing identical ones.
 *
 * ── READ INSIDE THE LOCK, WRITTEN WHOLE ────────────────────────────────────
 *
 * The destination's lines are read here rather than passed in, because the caller read
 * the floor before taking the lock and a round ordered in between would be silently
 * overwritten by a stale copy. The row lock on `pos_tables` (taken above) is what makes
 * this read safe: another till appending to the same table waits for it.
 *
 * ── WHAT COUNTS AS THE SAME LINE ───────────────────────────────────────────
 *
 * Same product, same unit price, same discount, same note. All four, because each one
 * is a way two rows can look alike and mean different things:
 *
 *   · a different price is a different deal — a happy-hour beer is not a full-price one
 *   · a different discount likewise, and fusing them would silently reprice one
 *   · a different note is a different plate to the kitchen ("no onion" is not "onion")
 *
 * A fused line keeps the DESTINATION's line_note and instructions and adds the incoming
 * quantity; its `kitchen_sent_qty` sums, so what the kitchen has already been told
 * survives the merge and the next Send does not re-fire food that is already cooking.
 *
 * `ordered_at` keeps the EARLIER of the two, so a starter ordered forty minutes ago that
 * fuses with one ordered just now still reads as forty minutes old on the kitchen screen.
 * Taking the later one would make an old order look new, which is the direction that
 * loses somebody's food.
 */
async function appendToBill(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  documentId: number,
  incoming: Row[],
): Promise<{ ok: true; documentId: number } | { ok: false; error: string }> {
  const [headRows] = await tx.query(
    `SELECT status FROM sales_documents WHERE id = ? FOR UPDATE`,
    [documentId],
  )
  const head = (headRows as Row[])[0]
  if (!head) return { ok: false, error: 'That bill no longer exists.' }
  /* Settled between the floor being read and this landing. Refused rather than appended
     to: a finalised invoice is on the books and somebody has been handed it. */
  if (head.status !== 'saved') return { ok: false, error: 'That bill has already been settled.' }

  const [existingRows] = await tx.query(
    `SELECT id, product_id, product_code, description, product_type, department_id,
            qty, unit_price_incl, discount_pct, vat_rate_pct, unit_cost_excl,
            sales_rep_id, sales_rep_user_id, special_id,
            line_note, kitchen_sent_qty, ordered_at
       FROM sales_document_lines WHERE document_id = ? ORDER BY line_number`,
    [documentId],
  )
  const merged = [...(existingRows as Row[])]

  /* Which lines on EITHER side carry chosen options. Asked once, as a set, rather than
     per line: the fuse test below runs over both lists and a query inside it would be a
     round trip per pair. */
  const candidateIds = [...merged, ...incoming]
    .map((l) => Number(l.id))
    .filter((id) => Number.isFinite(id))
  const withInstructions = new Set<number>()
  if (candidateIds.length > 0) {
    const [flagRows] = await tx.query(
      `SELECT DISTINCT line_id FROM sales_document_line_instructions
        WHERE line_id IN (${candidateIds.map(() => '?').join(',')})`,
      candidateIds,
    )
    for (const row of flagRows as Row[]) withInstructions.add(Number(row.line_id))
  }
  const hasInstructions = (line: Row) => withInstructions.has(Number(line.id))

  for (const line of incoming) {
    const at = merged.findIndex(
      (e) =>
        /* By product_code, not product_id: a non-stock line ("Corkage") has no id, and
           two of those would fuse into each other on a null match. */
        String(e.product_code ?? '') === String(line.product_code ?? '') &&
        String(e.description ?? '') === String(line.description ?? '') &&
        toNum(e.unit_price_incl) === toNum(line.unit_price_incl) &&
        toNum(e.discount_pct) === toNum(line.discount_pct) &&
        String(e.line_note ?? '') === String(line.line_note ?? '') &&
        /* A line carrying chosen options never fuses. Its identity is the answers hanging
           off it, which this comparison cannot see — and rewriteLines re-inserts them
           against the surviving line's id, so a fuse would drop the incoming line's own
           modifiers. Kept separate instead: two rows is right when they differ, and
           harmless when they do not. */
        !hasInstructions(e) &&
        !hasInstructions(line),
    )
    if (at < 0) {
      merged.push(line)
      continue
    }
    const target = merged[at]
    merged[at] = {
      ...target,
      qty: round(toNum(target.qty) + toNum(line.qty), 3),
      kitchen_sent_qty: round(
        toNum(target.kitchen_sent_qty) + toNum(line.kitchen_sent_qty),
        3,
      ),
      ordered_at: earlier(target.ordered_at, line.ordered_at),
    } as Row
  }

  await rewriteLines(tx, documentId, merged)
  await restate(tx, documentId, merged)
  return { ok: true, documentId }
}

/** The earlier of two nullable timestamps — a null means "no claim", so the other wins. */
function earlier(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined) return b ?? null
  if (b === null || b === undefined) return a
  return new Date(String(a)) <= new Date(String(b)) ? a : b
}

/**
 * Replaces a document's lines wholesale, renumbered from 1.
 *
 * ── WHAT TRAVELS WITH A LINE, AND WHY IT ALL HAS TO ───────────────────────
 *
 * Everything that describes the ORDER, not just what it costs. This wrote only
 * the priced columns for a long time, and each omission was silent:
 *
 *   · `line_note` — "allergy: nuts" vanished off a moved line. A safety fact,
 *     lost by a gesture that has nothing to do with allergies.
 *   · the instruction rows — a burger arrived at the new table with its
 *     modifiers stripped, repricing nothing (the money is folded into
 *     unit_price_incl) but telling the kitchen the wrong plate.
 *   · `kitchen_sent_qty` — reset to zero, so the next Send re-fired food the
 *     kitchen had already made.
 *   · `ordered_at` (167) — the line's age restarted, so a starter ordered forty
 *     minutes ago read as new the moment a table was split.
 *
 * The instruction rows have to be re-inserted rather than left alone: they hang
 * off `line_id` with ON DELETE CASCADE, so the DELETE below takes them with it.
 * They are read BEFORE that delete, keyed by the OLD line id, and written back
 * against the new one.
 */
async function rewriteLines(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  documentId: number,
  lines: Row[],
): Promise<void> {
  /* Read the answers before the delete cascades them away. Keyed by the source
     line id, which is on the row objects even when a line is being moved to a
     different document — that is what lets a split carry them across. */
  const sourceIds = lines.map((l) => Number(l.id)).filter((id) => Number.isFinite(id))
  const answers = new Map<number, Row[]>()
  if (sourceIds.length > 0) {
    const [answerRows] = await tx.query(
      `SELECT line_id, sort_order, group_id, group_name, option_id, option_name,
              qty, price_adjust_incl, product_id, stock_qty_per,
              prints_on_kitchen, prints_on_receipt
         FROM sales_document_line_instructions
        WHERE line_id IN (${sourceIds.map(() => '?').join(',')})
        ORDER BY line_id, sort_order`,
      sourceIds,
    )
    for (const row of answerRows as Row[]) {
      const key = Number(row.line_id)
      const list = answers.get(key)
      if (list) list.push(row)
      else answers.set(key, [row])
    }
  }

  await tx.execute(`DELETE FROM sales_document_lines WHERE document_id = ?`, [documentId] as never)
  let n = 0
  for (const line of lines) {
    n += 1
    const qty = toNum(line.qty)
    const totals = lineTotals({
      qty,
      unitPriceIncl: toNum(line.unit_price_incl),
      discountPct: toNum(line.discount_pct),
      vatRatePct: toNum(line.vat_rate_pct),
    })
    const [res] = await tx.execute(
      `INSERT INTO sales_document_lines
         (document_id, line_number, product_id, product_code, description, product_type,
          department_id, sales_rep_id, sales_rep_user_id, special_id,
          qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
          line_total_incl, line_total_excl, line_vat, unit_cost_excl,
          line_note, kitchen_sent_qty, ordered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        qty.toFixed(3),
        toNum(line.unit_price_incl).toFixed(4),
        toNum(line.discount_pct).toFixed(3),
        totals.discountIncl.toFixed(4),
        toNum(line.vat_rate_pct).toFixed(3),
        totals.lineTotalIncl.toFixed(4),
        totals.lineTotalExcl.toFixed(4),
        totals.lineVat.toFixed(4),
        toNum(line.unit_cost_excl).toFixed(4),
        String(line.line_note ?? '').slice(0, 190),
        toNum(line.kitchen_sent_qty).toFixed(3),
        line.ordered_at ?? null,
      ] as never,
    )

    const chosen = answers.get(Number(line.id)) ?? []
    if (chosen.length === 0) continue
    const lineId = (res as { insertId: number }).insertId
    for (const [i, answer] of chosen.entries()) {
      const per = toNum(answer.qty)
      const adjust = toNum(answer.price_adjust_incl)
      await tx.execute(
        `INSERT INTO sales_document_line_instructions
           (line_id, document_id, sort_order, group_id, group_name, option_id, option_name,
            qty, price_adjust_incl, line_adjust_incl,
            product_id, stock_qty_per, prints_on_kitchen, prints_on_receipt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          lineId,
          documentId,
          i,
          answer.group_id ?? null,
          String(answer.group_name ?? '').slice(0, 120),
          answer.option_id ?? null,
          String(answer.option_name ?? '').slice(0, 120),
          per.toFixed(3),
          adjust.toFixed(4),
          /* Recomputed against THIS half's quantity, not copied. It is the
             option's contribution across the line, so a line split from 3 to 1
             must restate it or the two halves would each report the whole
             table's worth of bacon. */
          round(adjust * per * qty, 4).toFixed(4),
          answer.product_id ?? null,
          toNum(answer.stock_qty_per).toFixed(3),
          Number(answer.prints_on_kitchen) === 0 ? 0 : 1,
          Number(answer.prints_on_receipt) === 0 ? 0 : 1,
        ] as never,
      )
    }
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

/**
 * The lines on a table's bill, for the split screen to divide.
 *
 * Also what the screen shows under "Already on this bill" once a destination is chosen —
 * read at that moment rather than taken from the floor list, which carries a count and a
 * total but not the products, and is seconds old besides. A waiter deciding where a plate
 * goes is reading these rows to recognise the table.
 */
export async function billLinesForSplit(siteId: number, tableId: number) {
  const table = await siteQueryOne<Row>(
    siteId,
    `SELECT document_id FROM pos_tables WHERE id = ?`,
    [tableId],
  )
  const documentId = table?.document_id === null ? null : Number(table?.document_id)
  if (!documentId) return null
  return billLinesForSplitByDocument(siteId, documentId)
}

/**
 * The same read, addressed by DOCUMENT.
 *
 * Which is what the split screen needs now that a destination may be any open sale
 * rather than only a seated table — a free-text tab has no `pos_tables` row to look it
 * up by. `draft` is accepted alongside `saved` because the till claims a bill while a
 * waiter has it on screen (171), and the bill being split is by definition one of those.
 */
export async function billLinesForSplitByDocument(siteId: number, documentId: number) {
  const doc = await getDocument(siteId, documentId)
  if (!doc || (doc.status !== 'saved' && doc.status !== 'draft')) return null

  return {
    documentId,
    lines: doc.lines.map((l) => ({
      id: l.id,
      description: l.description,
      productCode: l.productCode,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: l.lineTotalIncl,
      note: l.note || null,
      /*
       * The answers the till asked for — "no onions", "medium rare".
       *
       * Carried onto the split screen because they are how a waiter TELLS TWO LINES
       * APART. A table of four ordering the same burger four different ways is four
       * lines reading "Beef Burger R120" with nothing else to distinguish them, and
       * picking which one moves to Dave's bill is then a guess. The split itself has
       * always carried them across (see rewriteLines); only the screen was blind.
       */
      instructions: l.instructions.map((i) => ({
        optionName: i.optionName,
        qty: i.qty,
      })),
    })),
    totalIncl: doc.totalIncl,
  }
}
