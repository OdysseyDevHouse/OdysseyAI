import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { round, toNum } from '../decimals'

/**
 * Stock promised to a job that has not moved yet.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────
 *
 * RELEASE WHEN THE STOCK MOVES.
 *
 * 110_technician_vans.sql refused to build this table, and its reason is the
 * only thing that can go wrong here: `availableToSell` computes
 * `MAIN pile − site-wide reservation`. Once a part is issued to a van, the MAIN
 * pile has ALREADY dropped by the transfer. A reservation that survives that
 * moment therefore deducts the same unit a second time, for as long as the row
 * exists, for every part in every van — a permanent phantom shortage at the
 * till that no reconciliation of stock against movements could ever explain,
 * because nothing about the stock is wrong.
 *
 * ── WHERE THE RELEASE ACTUALLY RUNS, AND WHY IT VARIES ─────────────────────
 *
 * Two forms, because the callers are not the same shape:
 *
 *   `releaseLine` / `releaseJob` take a connection and run INSIDE the caller's
 *   transaction. Invoicing, closing and line edits all have one, so for them the
 *   claim and the thing that ends it commit together or not at all.
 *
 *   `releaseLineFor` does not, because `issueParts` does not have one. It writes
 *   its job state AFTER postTransfer has committed — a deliberate choice with
 *   its own reasoning at that call site — so the claim is released a moment
 *   after the stock moves rather than with it.
 *
 * That leaves a window, and pretending otherwise would be worse than naming it.
 * What makes it acceptable is that the failure is REPORTED rather than silent:
 * `reconcileJobReservations().overClaimed` finds any line holding a claim larger
 * than it still needs, which is exactly the shape a lost release takes. The
 * alternative — forking the transfer engine's transaction to carry job state —
 * is a much larger risk against a much smaller one.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is not a stock movement, and nothing here writes one. salesOrders.ts rule 2
 * holds: `stock_movements` records actual movement only, so Σ qty_change still
 * equals stock_on_hand. A reservation has moved nothing — it has made a claim on
 * what is there.
 *
 * ── WHY THE CLAIM IS STORED WHEN THE OTHER THREE ARE DERIVED ───────────────
 *
 * A sales order line, a lay-by line and an online hold ARE their own claims:
 * the row's existence is the reservation, so there is nothing to store. A job
 * line is different, because the same row means four different things across its
 * life — quoted-but-unaccepted claims nothing, accepted claims the stock, issued
 * has already taken it, invoiced has consumed it. Deriving that would put the
 * whole lifecycle into one subquery on the till's read path and make release a
 * condition rather than an event. Storing it makes reserve and release two
 * explicit acts a reconciliation can check.
 */

type Row = RowDataPacket & Record<string, unknown>

/** What a job is holding, for the job card and the drift report. */
export type JobReservation = {
  lineId: number
  jobId: number
  productId: number
  locationId: number
  qty: number
}

/**
 * Claim stock for every part line on an accepted quote.
 *
 * Runs inside the acceptance transaction: a quote that is accepted has promised
 * the customer these parts, and until they are issued the shop must not sell
 * them to somebody standing at the counter.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ──────────────────────────────────────────
 *
 * Only `part` lines with a real product. Labour, travel and expenses claim no
 * stock, and a line with a null product_id is a free-text charge with no pile to
 * claim against.
 *
 * Only the OUTSTANDING quantity — `qty − issued_qty`. A line already partly
 * issued has had that much taken off MAIN, so claiming the full quantity would
 * double-count from the very first write. In practice issued_qty is zero at
 * acceptance; it is written this way because relying on that would be an
 * assumption nothing enforces.
 *
 * Nothing is claimed for a line already invoiced: those units are consumed and
 * gone from the pile.
 */
export async function reserveForQuote(
  tx: PoolConnection,
  jobId: number,
  quoteId: number,
): Promise<number> {
  const [rows] = await tx.query<Row[]>(
    `SELECT l.id, l.product_id, GREATEST(0, l.qty - l.issued_qty - l.invoiced_qty) AS want
       FROM job_card_lines l
       JOIN sales_document_lines s ON s.job_card_line_id = l.id
      WHERE s.document_id = ?
        AND l.job_card_id = ?
        AND l.line_kind = 'part'
        AND l.product_id IS NOT NULL
      HAVING want > 0`,
    [quoteId, jobId] as never,
  )
  if (rows.length === 0) return 0

  /*
   * The main location, resolved INSIDE the transaction.
   *
   * Same reasoning as recordMovement's own fallback: reading it outside would
   * let the main location change between the read and the write, and a claim
   * against the wrong pile is invisible — availableToSell would subtract it from
   * a room that never promised anything.
   */
  const [mainRows] = await tx.query<Row[]>(
    `SELECT id FROM stock_locations WHERE is_main = 1 LIMIT 1`,
  )
  const locationId = mainRows[0] ? Number(mainRows[0].id) : null
  if (locationId === null) return 0

  let claimed = 0
  for (const r of rows) {
    /*
     * ON DUPLICATE KEY, against uq_jobres_line. Re-accepting a superseded quote
     * — or accepting a second version that covers the same line — must REPLACE
     * the claim, not add to it. Accumulating would hold stock for a line twice
     * and there would be nothing to release the surplus.
     */
    await tx.execute(
      `INSERT INTO job_stock_reservations (job_card_line_id, job_card_id, product_id, location_id, qty)
            VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE qty = VALUES(qty), location_id = VALUES(location_id)`,
      [Number(r.id), jobId, Number(r.product_id), locationId, toNum(r.want).toFixed(3)] as never,
    )
    claimed++
  }
  return claimed
}

/**
 * Give back the claim on one line, in whole or in part.
 *
 * `qty` null releases everything the line holds — the answer when a line is
 * invoiced, written off or removed. A number reduces the claim by that much,
 * which is what issuing part of a line does: three of ten go to the van, MAIN
 * drops by three, so exactly three must stop being claimed.
 *
 * Deleting at zero rather than leaving a row is deliberate. A zero-quantity
 * reservation is not a claim, and rows that mean nothing are how a table stops
 * being trustworthy — a count of reservations should be a count of claims.
 */
export async function releaseLine(
  tx: PoolConnection,
  lineId: number,
  qty: number | null = null,
): Promise<void> {
  if (qty === null) {
    await tx.execute(`DELETE FROM job_stock_reservations WHERE job_card_line_id = ?`, [
      lineId,
    ] as never)
    return
  }
  const amount = round(qty, 3)
  if (amount <= 0) return

  await tx.execute(
    `UPDATE job_stock_reservations
        SET qty = GREATEST(0, qty - ?)
      WHERE job_card_line_id = ?`,
    [amount.toFixed(3), lineId] as never,
  )
  // A claim reduced to nothing is not a claim. See above.
  await tx.execute(
    `DELETE FROM job_stock_reservations WHERE job_card_line_id = ? AND qty <= 0.0005`,
    [lineId] as never,
  )
}

/** Release every claim a job holds. Closing, cancelling, or deleting it. */
export async function releaseJob(tx: PoolConnection, jobId: number): Promise<void> {
  await tx.execute(`DELETE FROM job_stock_reservations WHERE job_card_id = ?`, [jobId] as never)
}

/**
 * The quote this job is currently working to, if any.
 *
 * `job_cards.accepted_quote_id` is nulled the moment a quote is superseded — see
 * quoteJob — so this returns the LIVE agreement rather than the most recent one.
 * That is what makes re-deriving a claim safe: a job whose quote was replaced
 * while a draft invoice sat unbilled reserves nothing until the new version is
 * accepted, instead of reinstating a promise the customer never made.
 */
export async function acceptedQuoteFor(
  tx: PoolConnection,
  jobId: number,
): Promise<number | null> {
  const [rows] = await tx.query<Row[]>(
    `SELECT accepted_quote_id FROM job_cards WHERE id = ?`,
    [jobId] as never,
  )
  const id = rows[0]?.accepted_quote_id
  return id === null || id === undefined ? null : Number(id)
}

/**
 * The same release, for a caller that has no transaction to join.
 *
 * `issueParts` is the one. It writes its job state after postTransfer has
 * committed, deliberately — see the comment at its call site — so it cannot pass
 * a connection, and forking the transfer engine's transaction to carry job state
 * would be a far larger risk than the narrow window this leaves.
 *
 * That window is REPORTED, which is what makes it acceptable:
 * reconcileJobReservations().overClaimed finds any line whose claim exceeds what
 * it still needs, which is precisely the shape of a lost release.
 *
 * Swallows its own errors for the same reason the rest of this path does: the
 * stock has already physically moved by the time this runs, and throwing here
 * would turn a reportable drift into a failed operation that has already
 * happened.
 */
export async function releaseLineFor(
  siteId: number,
  lineId: number,
  qty: number | null = null,
): Promise<void> {
  try {
    if (qty === null) {
      await siteExecute(siteId, `DELETE FROM job_stock_reservations WHERE job_card_line_id = ?`, [
        lineId,
      ])
      return
    }
    const amount = round(qty, 3)
    if (amount <= 0) return

    await siteExecute(
      siteId,
      `UPDATE job_stock_reservations
          SET qty = GREATEST(0, qty - ?)
        WHERE job_card_line_id = ?`,
      [amount.toFixed(3), lineId],
    )
    await siteExecute(
      siteId,
      `DELETE FROM job_stock_reservations WHERE job_card_line_id = ? AND qty <= 0.0005`,
      [lineId],
    )
  } catch {
    /* Reported by reconcileJobReservations rather than thrown. See above. */
  }
}

/** What one job is currently holding, for its own screen. */
export async function reservationsFor(siteId: number, jobId: number): Promise<JobReservation[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT job_card_line_id, job_card_id, product_id, location_id, qty
         FROM job_stock_reservations WHERE job_card_id = ?`,
      [jobId],
    )
    return rows.map((r) => ({
      lineId: Number(r.job_card_line_id),
      jobId: Number(r.job_card_id),
      productId: Number(r.product_id),
      locationId: Number(r.location_id),
      qty: toNum(r.qty),
    }))
  } catch {
    // Tolerant of a site without migration 220, exactly as peopleFor is of 120.
    return []
  }
}

/* ── Drift ────────────────────────────────────────────────────────────────── */

export type ReservationDrift = {
  /**
   * A claim larger than the line still needs.
   *
   * The signature of a release that did not happen: the line has been issued or
   * invoiced and the reservation was not reduced to match. Every unit of the
   * excess is a phantom shortage at the till.
   */
  overClaimed: {
    lineId: number
    jobId: number
    description: string
    reserved: number
    outstanding: number
  }[]
  /**
   * A claim held by a job that is closed.
   *
   * Nothing is going to be issued against it, so the stock is being held for
   * work that is finished. Reported rather than swept, because a closed job
   * still holding parts usually means the close path missed a release.
   */
  onClosedJobs: { lineId: number; jobId: number; jobNumber: string | null; description: string; qty: number }[]
}

/**
 * Reservations that no longer describe anything real. Reports, never repairs.
 *
 * This is the check that makes storing the claim safe. The derived reservations
 * cannot drift — they are recomputed from their own documents every time — so a
 * stored one has to earn the same trust by being checkable, and the failure it
 * is checking for is invisible everywhere else: a phantom claim does not break a
 * stock invariant, it just quietly makes the till refuse to sell something that
 * is sitting on the shelf.
 */
export async function reconcileJobReservations(siteId: number): Promise<ReservationDrift> {
  const [over, closed] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT r.job_card_line_id AS id, r.job_card_id, l.description, r.qty AS reserved,
              GREATEST(0, l.qty - l.issued_qty - l.invoiced_qty) AS outstanding
         FROM job_stock_reservations r
         JOIN job_card_lines l ON l.id = r.job_card_line_id
       HAVING reserved > outstanding + 0.001`,
    ).catch(() => []),
    siteQuery<Row>(
      siteId,
      `SELECT r.job_card_line_id AS id, r.job_card_id, j.document_number, l.description, r.qty
         FROM job_stock_reservations r
         JOIN job_card_lines l ON l.id = r.job_card_line_id
         JOIN job_cards j      ON j.id = r.job_card_id
        WHERE j.status <> 'open'`,
    ).catch(() => []),
  ])

  return {
    overClaimed: over.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      reserved: toNum(r.reserved),
      outstanding: toNum(r.outstanding),
    })),
    onClosedJobs: closed.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: r.document_number === null ? null : String(r.document_number),
      description: String(r.description),
      qty: toNum(r.qty),
    })),
  }
}
