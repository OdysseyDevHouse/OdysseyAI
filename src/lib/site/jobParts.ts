import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { round, toNum } from '../decimals'
import { postTransfer, todayIso } from './stockTransfers'
import { logActivity, type Actor } from './activityLog'
import { BILLABLE_STATES, isStockWarnMode, type StockWarnMode } from '../jobStatusModel'
import { getSetting } from './settings'
import { releaseLineFor } from './jobReservations'

/**
 * Parts on a job, and getting them onto a van.
 *
 * ── THIS MODULE WRITES NO STOCK ────────────────────────────────────────────
 *
 * Issuing a part is a `stock_transfers` document, posted by the existing
 * postTransfer(). That function already writes the balanced pair through
 * recordMovement(), already locks the FROM pile `FOR UPDATE` in product order so
 * two clerks issuing the same part cannot deadlock, already refuses a period lock,
 * and already reconciles. Nothing here duplicates any of it.
 *
 * So the rule the whole job module has kept holds here too: `recordMovement` is
 * the only legal writer of stock, and this file does not call it.
 *
 * ── TWO THINGS THIS FILE ONCE REFUSED, AND NOW DOES ────────────────────────
 *
 * Both were cut deliberately, and both are now built. The original arguments are
 * kept because they name what can still go wrong.
 *
 * RESERVATIONS (now 220, jobReservations.ts). The objection was that
 * `availableToSell()` reads the MAIN pile and subtracts a site-wide reservation,
 * so a claim surviving an issue deducts the same unit twice — permanently, for
 * every part in every van. That is still exactly true, which is why release
 * happens by the same quantity, immediately below the issued_qty increment that
 * mirrors it, and why reconcileJobReservations() exists to report the case where
 * it did not. The precondition the old note named — issued_qty existing and
 * being trusted — is what 110 built and what made the table safe to add.
 *
 * The double-count it also named is still undetectable and still reported rather
 * than fixed: a part on an accepted quote AND on a reserving sales order is one
 * physical unit claimed by two branches of the UNION, and no column links a
 * sales-order line to a job line. See `alsoOnOrder` below.
 *
 * CONSUMING OFF A VAN. The objection was that `salesPosting.ts` passed no
 * locationId, so a part fitted off a bakkie debited MAIN while every invariant
 * held — because each is about sums matching, and a wrongly-located movement
 * agrees with the pile it wrongly debited. It now resolves the pile per line
 * from `issued_qty`, and `invoicedOffWrongPile` below is the check that catches
 * it if that resolution is ever wrong, because only the job holds a second
 * independent record of where the goods went.
 *
 * `partsPromised()` remains what it was: the job-side answer, safe because a
 * wrong number there misleads one screen rather than changing what a shop can
 * sell.
 */

export type JobPartLine = {
  lineId: number
  productId: number | null
  productCode: string | null
  description: string
  /** What the job needs. */
  qty: number
  /** What has physically left the building for this line. */
  issuedQty: number
  invoicedQty: number
  billingState: string
  /** qty - issued. What still has to be picked. */
  outstandingQty: number
  /** Serial-tracked products are fitted from the workshop, not carried. */
  isSerial: boolean
  /** The pile in the main location, so a picker knows whether it can be met. */
  mainOnHand: number
}

export type VanHolding = {
  locationId: number
  locationCode: string
  locationName: string
  productId: number
  productCode: string
  description: string
  qty: number
}

export type IssueLineInput = {
  jobCardLineId: number
  productId: number
  qty: number
}

export type IssueResult =
  | { ok: true; transferId: number; documentNumber: string; lineCount: number }
  /**
   * `needsConfirmation` distinguishes "you may do this once you agree" from
   * "no". Only the `confirm` warn mode sets it, and the screen re-sends with
   * `acknowledged: true`. A plain refusal never carries it, so a caller that
   * ignores the flag simply gets the strict behaviour rather than a way through.
   */
  | { ok: false; error: string; needsConfirmation?: boolean }

export type PartsActionResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/**
 * The part lines on a job, with what is still to pick.
 *
 * Only `part` lines: labour and travel have no pile. A line with no product is a
 * free-text charge — a subcontractor invoice — and cannot be issued either.
 */
export async function jobParts(siteId: number, jobId: number): Promise<JobPartLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.product_id, l.product_code, l.description, l.qty, l.issued_qty,
            l.invoiced_qty, l.billing_state,
            p.product_type,
            COALESCE((SELECT pls.stock_on_hand
                        FROM product_location_stock pls
                        JOIN stock_locations loc ON loc.id = pls.location_id
                       WHERE pls.product_id = l.product_id AND loc.is_main = 1), 0) AS main_on_hand
       FROM job_card_lines l
       LEFT JOIN products p ON p.id = l.product_id
      WHERE l.job_card_id = ? AND l.line_kind = 'part'
      ORDER BY l.line_number, l.id`,
    [jobId],
  )

  return rows.map((row) => {
    const qty = toNum(row.qty)
    const issued = toNum(row.issued_qty)
    return {
      lineId: Number(row.id),
      productId: row.product_id === null ? null : Number(row.product_id),
      productCode: row.product_code === null ? null : String(row.product_code),
      description: String(row.description),
      qty,
      issuedQty: issued,
      invoicedQty: toNum(row.invoiced_qty),
      billingState: String(row.billing_state),
      outstandingQty: round(Math.max(0, qty - issued), 3),
      isSerial: String(row.product_type ?? '') === 'serial',
      mainOnHand: toNum(row.main_on_hand),
    }
  })
}

/**
 * Parts promised to open jobs.
 *
 * The safe half of what a reservation would have been: it answers "is this product
 * spoken for" on the JOB side, where a wrong number misleads one screen rather
 * than changing what the shop can sell.
 *
 * Only counts what has NOT yet been issued — a part on a van has already left the
 * pile, so counting it again is the double-count that got the reservation source
 * cut. `GREATEST` rather than a sum: a unit both issued and invoiced must be
 * subtracted once, and adding them would push the figure negative and quietly net
 * against another job's honest promise on the same product.
 */
export async function partsPromised(
  siteId: number,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.product_id, SUM(GREATEST(0, l.qty - GREATEST(l.issued_qty, l.invoiced_qty))) AS promised
       FROM job_card_lines l
       JOIN job_cards j ON j.id = l.job_card_id
      WHERE l.product_id IN (${ids.map(() => '?').join(',')})
        AND l.line_kind = 'part'
        AND j.status = 'open'
        AND l.billing_state IN (${BILLABLE_STATES.map(() => '?').join(',')})
      GROUP BY l.product_id`,
    [...ids, ...BILLABLE_STATES],
  ).catch(() => [])

  return new Map(
    rows
      .map((r) => [Number(r.product_id), toNum(r.promised)] as const)
      .filter(([, promised]) => promised > 0),
  )
}

/**
 * What this shop wants to happen when a part is short (§26.7).
 *
 * Falls back to 'inform' on anything unexpected — an unmigrated site, a value
 * somebody typed straight into the table, a setting read that failed. Failing
 * OPEN is right here and would be wrong almost anywhere else in this module:
 * the strict modes exist to protect stock accuracy, and defaulting to one
 * because a settings read hiccuped would refuse real work for no reason a
 * technician standing at a storeroom could ever diagnose.
 */
export async function stockWarnMode(siteId: number): Promise<StockWarnMode> {
  const raw = await getSetting(siteId, 'job_stock_warn_mode').catch(() => 'inform')
  return isStockWarnMode(raw) ? raw : 'inform'
}

/** What is sitting on each van, for the stocktake and the chase-up. */
export async function vanHoldings(siteId: number, locationId?: number): Promise<VanHolding[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT loc.id AS location_id, loc.code AS location_code, loc.name AS location_name,
            p.id AS product_id, p.code AS product_code, p.description, pls.stock_on_hand
       FROM product_location_stock pls
       JOIN stock_locations loc ON loc.id = pls.location_id
       JOIN products p          ON p.id = pls.product_id
      WHERE loc.is_mobile = 1 AND pls.stock_on_hand <> 0
        ${locationId ? 'AND loc.id = ?' : ''}
      ORDER BY loc.code, p.code`,
    locationId ? [locationId] : [],
  )
  return rows.map((row) => ({
    locationId: Number(row.location_id),
    locationCode: String(row.location_code),
    locationName: String(row.location_name),
    productId: Number(row.product_id),
    productCode: String(row.product_code),
    description: String(row.description),
    qty: toNum(row.stock_on_hand),
  }))
}

/**
 * Put parts on a van for a job.
 *
 * ── ONE TRANSFER, POSTED BY EXISTING CODE ──────────────────────────────────
 *
 * Every line goes on a single `stock_transfers` document, so the movement history
 * shows one act — a van being loaded — rather than six unrelated adjustments. The
 * transfer is posted by postTransfer(), which does all the work; this function
 * validates the job-shaped part and then stamps `issued_qty` and the line link.
 *
 * ── SERIALS ARE REFUSED, WITH A SENTENCE ───────────────────────────────────
 *
 * A serial-tracked unit CAN be transferred — postTransfer accepts one whose units
 * are named. What cannot yet be done safely is consuming it off a van:
 * `checkSellable` does not check location, and `markSold` NULLs the serial's
 * location, so invariant (S2) breaks in two places at once and reconcileSerials
 * reports drift in both the van and MAIN. That is precisely the state (S2) exists
 * to catch, and this module will not manufacture it through the front door.
 *
 * A refusal with a reason is a decision. A silently corrupted serial ledger is not.
 */
export async function issueParts(
  siteId: number,
  actor: Actor,
  jobId: number,
  vanLocationId: number,
  lines: readonly IssueLineInput[],
  /**
   * `acknowledged` is somebody agreeing to a shortage the `confirm` mode
   * stopped. It is meaningless in every other mode: `prevent` ignores it — an
   * acknowledgement is not permission — and `inform` never asked.
   */
  options: { acknowledged?: boolean } = {},
): Promise<IssueResult> {
  const wanted = lines.filter((l) => round(l.qty, 3) > 0)
  if (wanted.length === 0) return { ok: false, error: 'Choose at least one part to issue.' }

  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, document_number, location_id FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'That job is closed. Reopen it before issuing parts to it.' }
  }

  const van = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, name, is_mobile, is_active FROM stock_locations WHERE id = ?`,
    [vanLocationId],
  )
  if (!van) return { ok: false, error: 'That van no longer exists.' }
  if (Number(van.is_mobile) !== 1) {
    return {
      ok: false,
      error: `${String(van.name)} is a room, not a vehicle. Use a stock transfer to move goods between rooms.`,
    }
  }
  if (Number(van.is_active) !== 1) {
    return { ok: false, error: `${String(van.name)} is deactivated.` }
  }

  // The from-end: the job's own location, falling back to main.
  const fromRow = await siteQueryOne<Row>(
    siteId,
    `SELECT COALESCE(?, (SELECT id FROM stock_locations WHERE is_main = 1 LIMIT 1)) AS id`,
    [job.location_id],
  )
  const fromLocationId = Number(fromRow?.id)
  if (!Number.isFinite(fromLocationId) || fromLocationId <= 0) {
    return { ok: false, error: 'No main stock location is set, so there is nowhere to issue from.' }
  }
  if (fromLocationId === vanLocationId) {
    return { ok: false, error: 'That van is already the location this job draws from.' }
  }

  // Validate every line before writing anything, so a bad request cannot leave a
  // job half issued — the discipline postTransfer and deliverOrder both apply.
  const parts = await jobParts(siteId, jobId)
  const byLine = new Map(parts.map((p) => [p.lineId, p]))

  const planned: { part: JobPartLine; qty: number }[] = []
  for (const line of wanted) {
    const part = byLine.get(line.jobCardLineId)
    if (!part) return { ok: false, error: 'One of those lines is not a part on this job.' }
    if (part.productId === null) {
      return {
        ok: false,
        error: `${part.description} is a charge rather than a stocked part, so there is nothing to pick.`,
      }
    }
    if (part.isSerial) {
      return {
        ok: false,
        error: `${part.description} is serial-tracked. Serialised items are fitted from the workshop rather than carried on a van.`,
      }
    }
    const qty = round(line.qty, 3)
    if (qty > part.outstandingQty) {
      return {
        ok: false,
        error: `Only ${part.outstandingQty} of ${part.description} is still to issue.`,
      }
    }
    planned.push({ part, qty })
  }

  /*
   * ── What the shop wants to happen when the shelf cannot cover it (§26.7) ──
   *
   * Checked HERE, before postTransfer, for two reasons. Nothing has been written
   * yet, so a refusal leaves no half-issued job; and the message can name the
   * job's own line — "Only 2 of JCT thermostat on the shelf" — where
   * postTransfer can only speak about products and locations.
   *
   * postTransfer still has the last word on whether the stock is physically
   * there. This is the shop's POLICY about a shortage it can already see; that
   * is the invariant, and it stays where it is.
   *
   * `confirm` refuses once and is got past by re-sending with `acknowledged`.
   * `prevent` cannot be got past at all — which is the whole difference between
   * them, and why they are not one branch with a flag.
   */
  const shortfalls = planned
    .map(({ part, qty }) => ({ part, qty, short: round(qty - part.mainOnHand, 3) }))
    .filter((s) => s.short > 0)

  if (shortfalls.length > 0) {
    const mode = await stockWarnMode(siteId)
    const worst = shortfalls.slice().sort((a, b) => b.short - a.short)[0]!
    const detail =
      `${worst.part.description} is short by ${worst.short}` +
      (shortfalls.length > 1 ? ` and ${shortfalls.length - 1} other ${shortfalls.length === 2 ? 'part is' : 'parts are'} short too` : '')

    if (mode === 'prevent') {
      return {
        ok: false,
        error: `${detail}. This shop does not allow issuing more than the shelf holds.`,
      }
    }
    if (mode === 'confirm' && !options.acknowledged) {
      return {
        ok: false,
        needsConfirmation: true,
        error: `${detail}. Confirm to issue anyway.`,
      }
    }
    /*
     * 'inform' and 'order' both proceed. The offer to raise a part request is
     * the SCREEN's job — it already knows the outstanding quantities and has the
     * button — because an action that quietly created a purchase request as a
     * side effect of issuing stock would be doing something nobody asked for.
     */
  }

  const jobLabel = job.document_number ? String(job.document_number) : `#${jobId}`

  /*
   * postTransfer does the rest: the balanced pair through recordMovement, the
   * FOR UPDATE lock ordering, the period-lock check, the document number. If it
   * refuses — insufficient stock, a locked period — nothing here has been written.
   */
  const posted = await postTransfer(siteId, actor, {
    fromLocationId,
    toLocationId: vanLocationId,
    documentDate: todayIso(),
    reference: jobLabel,
    note: `Parts for job ${jobLabel}`,
    lines: planned.map(({ part, qty }) => ({
      productId: part.productId as number,
      productCode: part.productCode,
      // The job line's own description, so the transfer document reads as what it
      // is — a van being loaded for a named job — rather than a bare product list.
      description: part.description,
      qty,
    })),
  })
  if (!posted.ok) return posted

  /*
   * Stamp the job lines and the transfer lines AFTER the transfer has posted.
   *
   * Deliberately not inside postTransfer's transaction: that would mean either
   * forking it or passing a callback, and the failure mode of doing it afterwards
   * is benign and detectable. If this half fails the stock has genuinely moved and
   * reconcileJobParts() reports the line whose movements do not match its
   * issued_qty — which is exactly what that function is for.
   */
  for (const { part, qty } of planned) {
    await siteExecute(
      siteId,
      `UPDATE job_card_lines SET issued_qty = issued_qty + ? WHERE id = ?`,
      [qty.toFixed(3), part.lineId],
    )
    /*
     * ── Release the claim, by exactly what moved (220) ───────────────────
     *
     * The rule jobReservations is built around: the MAIN pile has just dropped
     * by this transfer, so a claim that survives it deducts the same unit twice
     * from availableToSell — permanently, and invisibly, because nothing about
     * the stock is wrong. That double deduction is the reason 110 refused to
     * build the table at all.
     *
     * Written here, immediately after the issued_qty increment it mirrors,
     * rather than inside postTransfer's transaction. That is the same trade the
     * increment above already makes, and the same argument holds: forking the
     * transfer engine's transaction to carry job state would be a far larger
     * risk than a narrow window that is REPORTED. If this write is lost, the
     * line's claim exceeds what it still needs, and
     * reconcileJobReservations().overClaimed names it.
     *
     * Note this is the SECOND statement, not the first: releasing before the
     * increment would leave a window where the stock has moved, the claim is
     * gone, and issued_qty does not yet say so — briefly overstating what is
     * available. Understating is the safer way to be wrong.
     */
    await releaseLineFor(siteId, part.lineId, qty)
    await siteExecute(
      siteId,
      `UPDATE stock_transfer_lines SET job_card_line_id = ?
        WHERE transfer_id = ? AND product_id = ? AND job_card_line_id IS NULL
        LIMIT 1`,
      [part.lineId, posted.id, part.productId],
    )
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'parts_issued',
    detail: `${planned.length} ${planned.length === 1 ? 'part' : 'parts'} issued to ${String(van.name)} on transfer ${posted.documentNumber}`,
  })

  return {
    ok: true,
    transferId: posted.id,
    documentNumber: posted.documentNumber,
    lineCount: planned.length,
  }
}

/**
 * Bring parts back off a van.
 *
 * Two cases, and they are the same movement: stock that was not used going back to
 * the shelf, and stock that WAS fitted going back so the invoice can consume it
 * from MAIN — see the header on why that step is manual.
 *
 * `issued_qty` comes down by what returned, so the outstanding figure and the
 * worklist stay true.
 */
export async function returnParts(
  siteId: number,
  actor: Actor,
  jobId: number,
  vanLocationId: number,
  lines: readonly IssueLineInput[],
): Promise<IssueResult> {
  const wanted = lines.filter((l) => round(l.qty, 3) > 0)
  if (wanted.length === 0) return { ok: false, error: 'Choose at least one part to bring back.' }

  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, document_number, location_id FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }

  const parts = await jobParts(siteId, jobId)
  const byLine = new Map(parts.map((p) => [p.lineId, p]))

  const planned: { part: JobPartLine; qty: number }[] = []
  for (const line of wanted) {
    const part = byLine.get(line.jobCardLineId)
    if (!part) return { ok: false, error: 'One of those lines is not a part on this job.' }
    const qty = round(line.qty, 3)
    if (qty > part.issuedQty) {
      return {
        ok: false,
        error: `Only ${part.issuedQty} of ${part.description} is out on a van.`,
      }
    }
    planned.push({ part, qty })
  }

  /*
   * ── What the van PHYSICALLY holds, which issued_qty does not answer ───────
   *
   * The check above asks the job's own figure. Since a part fitted off a van is
   * billed off that van (see salesPosting), the two can legitimately differ:
   * a line issued four and invoiced two has `issued_qty` of four — invoicing
   * does not decrement it, because that column tracks what left the shelf for
   * the technician — while the bakkie holds two.
   *
   * Asking for four back then passes the job-side check and is refused by
   * postTransfer with "JCP123 has only 2 in JCT bakkie — cannot move 4". Correct,
   * and from the wrong layer: the message names a product code and a location
   * where the person is looking at a job line, and it arrives after the caller
   * believed the request was valid.
   *
   * So the pile is checked here too, and the refusal names the line. postTransfer
   * keeps the last word — this is a better message, never a substitute for the
   * invariant.
   */
  const onVan = await siteQuery<Row>(
    siteId,
    `SELECT product_id, stock_on_hand
       FROM product_location_stock
      WHERE location_id = ? AND product_id IN (${planned.map(() => '?').join(',')})`,
    [vanLocationId, ...planned.map((p) => p.part.productId)],
  ).catch(() => [])

  const heldBy = new Map(onVan.map((r) => [Number(r.product_id), toNum(r.stock_on_hand)]))
  for (const { part, qty } of planned) {
    const held = heldBy.get(part.productId as number) ?? 0
    if (qty > held) {
      return {
        ok: false,
        error:
          `${part.description}: only ${held} of the ${part.issuedQty} issued ${held === 1 ? 'is' : 'are'} still on the van` +
          (part.invoicedQty > 0 ? ` — ${part.invoicedQty} ${part.invoicedQty === 1 ? 'was' : 'were'} fitted and invoiced.` : '.'),
      }
    }
  }

  const toRow = await siteQueryOne<Row>(
    siteId,
    `SELECT COALESCE(?, (SELECT id FROM stock_locations WHERE is_main = 1 LIMIT 1)) AS id`,
    [job.location_id],
  )
  const toLocationId = Number(toRow?.id)
  const jobLabel = job.document_number ? String(job.document_number) : `#${jobId}`

  const posted = await postTransfer(siteId, actor, {
    fromLocationId: vanLocationId,
    toLocationId,
    documentDate: todayIso(),
    reference: jobLabel,
    note: `Parts back from a van for job ${jobLabel}`,
    lines: planned.map(({ part, qty }) => ({
      productId: part.productId as number,
      productCode: part.productCode,
      description: part.description,
      qty,
    })),
  })
  if (!posted.ok) return posted

  for (const { part, qty } of planned) {
    await siteExecute(
      siteId,
      `UPDATE job_card_lines SET issued_qty = GREATEST(0, issued_qty - ?) WHERE id = ?`,
      [qty.toFixed(3), part.lineId],
    )
    await siteExecute(
      siteId,
      `UPDATE stock_transfer_lines SET job_card_line_id = ?
        WHERE transfer_id = ? AND product_id = ? AND job_card_line_id IS NULL
        LIMIT 1`,
      [part.lineId, posted.id, part.productId],
    )
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'parts_returned',
    detail: `${planned.length} ${planned.length === 1 ? 'part' : 'parts'} brought back on transfer ${posted.documentNumber}`,
  })

  return {
    ok: true,
    transferId: posted.id,
    documentNumber: posted.documentNumber,
    lineCount: planned.length,
  }
}

export type PartsDrift = {
  /** issued_qty does not match the transfers that claim to have moved it. */
  issuedMismatch: { lineId: number; jobId: number; description: string; issued: number; moved: number }[]
  /** A line claiming more issued than the job needs. Arithmetic that cannot be right. */
  overIssued: { lineId: number; jobId: number; description: string; qty: number; issued: number }[]
  /**
   * Invoiced while still out on a van.
   *
   * The consumed-from-the-wrong-pile case, and the reason returning is a manual
   * step. The invoice debited MAIN; the goods are on a bakkie. Every invariant
   * still holds, so reconcileStock() cannot see this — only the job link can.
   */
  invoicedWhileOut: { lineId: number; jobId: number; jobNumber: string | null; description: string; issued: number }[]
  /** Van piles for products no open job references. Stock living on a bakkie. */
  strandedOnVans: { locationName: string; productCode: string; description: string; qty: number }[]
  /**
   * The double-count nothing can fix: a job part also on a reserving sales order
   * for the same customer. Reported rather than pretended away.
   */
  alsoOnOrder: { lineId: number; jobId: number; description: string; orderNumber: string | null }[]
  /**
   * A part invoiced off one pile and issued from another.
   *
   * ── WHY THIS CANNOT BE reconcileStock()'S JOB ───────────────────────────
   *
   * Both stock invariants compare a STORED figure against THE MOVEMENTS
   * THEMSELVES: (B) is each pile versus the movements recorded in it, (C) is the
   * product total versus the sum of its piles. A movement that names the wrong
   * location is therefore perfectly self-consistent — the pile it debited agrees
   * with it, and the sum still matches. The ledger is coherent and wrong, and no
   * amount of reconciling it against itself can tell.
   *
   * The only thing that knows better is the JOB, which recorded where the part
   * actually went when it was issued. This compares those two independent facts:
   * where the goods were, and where the invoice took them from.
   *
   * It is the safety net for threading a location through the sale path. Before
   * that change the answer was always MAIN and this reported every van-fitted
   * part; after it, a row here means the threading is wrong for that line, which
   * is exactly the failure that would otherwise be silent forever.
   */
  invoicedOffWrongPile: {
    lineId: number
    jobId: number
    jobNumber: string | null
    description: string
    issuedFrom: string
    debited: string
    qty: number
  }[]
}

/**
 * Drift between the shelf, the van and the job. Reports, never repairs.
 *
 * This is the phase where a quantity can be wrong in four places, and the only
 * phase in the programme where a wrong number moves PHYSICAL GOODS. Every other
 * module in this codebase earns its trust with a reconciliation function; this one
 * needs it most.
 */
export async function reconcileJobParts(siteId: number): Promise<PartsDrift> {
  const [mismatch, over, invoicedOut, stranded, onOrder, wrongPile] = await Promise.all([
    /*
     * issued_qty against the transfers that carry the line link. Signed: a line
     * issued 5 and returned 2 has moved 3, and both transfers name it.
     */
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description, l.issued_qty,
              COALESCE((
                SELECT SUM(CASE WHEN loc.is_mobile = 1 THEN tl.qty ELSE -tl.qty END)
                  FROM stock_transfer_lines tl
                  JOIN stock_transfers t   ON t.id = tl.transfer_id
                  JOIN stock_locations loc ON loc.id = t.to_location_id
                 WHERE tl.job_card_line_id = l.id AND t.status = 'posted'
              ), 0) AS moved
         FROM job_card_lines l
        WHERE l.issued_qty <> 0
       HAVING ABS(l.issued_qty - moved) > 0.001`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, description, qty, issued_qty
         FROM job_card_lines WHERE issued_qty > qty + 0.001`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description, l.issued_qty, j.document_number
         FROM job_card_lines l
         JOIN job_cards j ON j.id = l.job_card_id
        WHERE l.invoiced_qty > 0 AND l.issued_qty > 0`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT loc.name AS location_name, p.code AS product_code, p.description, pls.stock_on_hand
         FROM product_location_stock pls
         JOIN stock_locations loc ON loc.id = pls.location_id
         JOIN products p          ON p.id = pls.product_id
        WHERE loc.is_mobile = 1 AND pls.stock_on_hand <> 0
          AND NOT EXISTS (
            SELECT 1 FROM job_card_lines l
              JOIN job_cards j ON j.id = l.job_card_id
             WHERE l.product_id = pls.product_id AND j.status = 'open' AND l.issued_qty > 0
          )`,
    ),
    /*
     * One physical unit promised by two documents. There is no column linking a
     * sales-order line to a job line, so this cannot be deduplicated — only
     * reported, which is the honest answer.
     */
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description, d.document_number
         FROM job_card_lines l
         JOIN job_cards j            ON j.id = l.job_card_id
         JOIN sales_document_lines sl ON sl.product_id = l.product_id
         JOIN sales_documents d       ON d.id = sl.document_id
         JOIN sales_order_details o   ON o.document_id = d.id
        WHERE j.status = 'open'
          AND l.line_kind = 'part'
          AND l.billing_state IN ('quoted','variation','additional')
          AND d.doc_type = 'sales_order'
          AND d.customer_id = j.customer_id
          AND d.status IN ('draft','saved','issued')
          AND o.fulfilment_status IN ('open','part_delivered')
          AND o.reserves_stock = 1
        GROUP BY l.id, l.job_card_id, l.description, d.document_number`,
    ).catch(() => []),
    /*
     * ── Invoiced off a different pile than it was issued from ─────────────
     *
     * Two independent records of where one part was, compared:
     *
     *   the JOB says     — the last transfer carrying this line put it on VAN2
     *   the INVOICE says — the sale movement debited MAIN
     *
     * Neither stock invariant can notice the disagreement, because both are
     * about a ledger agreeing with itself. Only the job link is outside it.
     *
     * `issued_qty > 0` is what decides the goods are still out — the same rule
     * salesPosting uses to pick the pile, and deliberately so: a check that
     * asked a different question from the writer would either miss real drift
     * or invent it. The subquery then takes the latest MOBILE destination,
     * ignoring the return leg, so a partial return still names the van the
     * remainder sits on rather than the room two of them came back to.
     *
     * A line with nothing still issued is correctly billed off the shelf and
     * produces no row, which keeps this quiet on sites that never use a van.
     */
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description, j.document_number,
              issued_loc.name AS issued_from,
              COALESCE(debit_loc.name, 'Main') AS debited,
              l.invoiced_qty AS qty
         FROM job_card_lines l
         JOIN job_cards j ON j.id = l.job_card_id
         /* Where the job last put the goods. */
         JOIN stock_locations issued_loc ON issued_loc.id = (
              SELECT t.to_location_id
                FROM stock_transfer_lines tl
                JOIN stock_transfers t    ON t.id = tl.transfer_id
                JOIN stock_locations loc2 ON loc2.id = t.to_location_id
               WHERE tl.job_card_line_id = l.id
                 AND t.status = 'posted'
                 AND loc2.is_mobile = 1
               ORDER BY t.id DESC LIMIT 1
         )
         /* Where the invoice took them from. */
         JOIN sales_document_lines sl ON sl.job_card_line_id = l.id
         JOIN stock_movements m       ON m.source_line_id = sl.id
                                     AND m.movement_type IN ('sale','sale_return')
         LEFT JOIN stock_locations debit_loc ON debit_loc.id = m.location_id
        WHERE l.invoiced_qty > 0
          AND l.issued_qty > 0
          AND issued_loc.is_mobile = 1
          AND m.location_id <> issued_loc.id
        GROUP BY l.id, l.job_card_id, l.description, j.document_number,
                 issued_loc.name, debit_loc.name, l.invoiced_qty`,
    ).catch(() => []),
  ])

  return {
    issuedMismatch: mismatch.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      issued: toNum(r.issued_qty),
      moved: toNum(r.moved),
    })),
    overIssued: over.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      qty: toNum(r.qty),
      issued: toNum(r.issued_qty),
    })),
    invoicedWhileOut: invoicedOut.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: r.document_number === null ? null : String(r.document_number),
      description: String(r.description),
      issued: toNum(r.issued_qty),
    })),
    strandedOnVans: stranded.map((r) => ({
      locationName: String(r.location_name),
      productCode: String(r.product_code),
      description: String(r.description),
      qty: toNum(r.stock_on_hand),
    })),
    alsoOnOrder: onOrder.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      orderNumber: r.document_number === null ? null : String(r.document_number),
    })),
    invoicedOffWrongPile: wrongPile.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: r.document_number === null ? null : String(r.document_number),
      description: String(r.description),
      issuedFrom: String(r.issued_from),
      debited: String(r.debited),
      qty: toNum(r.qty),
    })),
  }
}
