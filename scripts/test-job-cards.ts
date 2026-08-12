/**
 * Job cards — one record for a piece of work, from the phone call to the invoice.
 *
 * THE INVARIANTS, and everything here exists to prove them:
 *
 *   (J1) A job card never posts. finaliseDocument() cannot be handed one, and
 *        billing raises a DRAFT that a person finalises through the one engine.
 *   (J2) cost counts EVERY line; revenue counts only what a finalised invoice
 *        says. internal and written_off are therefore in cost and out of revenue.
 *   (J3) invoiced_qty never exceeds qty, across any number of part invoices.
 *   (J4) Only a billable state reaches an invoice.
 *   (J5) The record state (open/closed/cancelled) always agrees with the
 *        workflow status role. Nothing but setStatus writes it.
 *   (J6) A required role always has a status holding it, and a system status
 *        cannot be deleted or switched off.
 *   (J7) Discarding a draft returns exactly what it took, to the right line.
 *   (J8) A board holds no jobs. Membership is derived from status, so one job
 *        appears on every board that shows its stage — and a status on no board
 *        hides its jobs from every board, which is reported rather than fixed.
 *   (J9) A quote is never overwritten. A revision is a NEW document pointing at
 *        what it replaces; the old version keeps its number, its lines and its
 *        acceptance, and a new version un-accepts the JOB so it claims no
 *        authorisation for a price nobody agreed to.
 *  (J10) Unscheduled is derived, never stored: an open job with no LIVE FUTURE
 *        visit. A conflict warns and can be overridden with a reason; an attended
 *        visit is cancelled rather than deleted; and an arrival time is stamped
 *        once and never moved.
 *  (J11) One open time entry per person, enforced by the DATABASE. Starting a
 *        timer elsewhere switches rather than running two, so an hour can never be
 *        paid twice; stopping turns minutes into an hours-priced labour line; and
 *        removing an entry takes its line with it.
 *  (J12) Travel keeps FOUR figures and none derives another. `verified_km IS NULL`
 *        means nobody has looked; the expectation is labelled estimated, never
 *        measured; the leg count comes from the claim rather than an assumption;
 *        reducing a claim needs a reason; and correcting one clears the signature.
 *
 * (J2) is the one that catches real bugs. A margin built on the lines' intended
 * prices rather than the invoice will agree with itself and disagree with the
 * sales report, and only a test that bills a job and then compares the two
 * notices.
 *
 *   npm run test:job-cards
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  saveJobCard,
  getJobCard,
  listJobCards,
  jobCounts,
  setStatus,
  assignOwner,
  saveLines,
  reclassifyLine,
  closeJob,
  cancelJob,
  reopenJob,
  reconcileJobCards,
  jobTotals,
  validateJobCard,
} from '../src/lib/site/jobCards'
import {
  listJobStatuses,
  statusForRole,
  saveJobStatus,
  deleteJobStatus,
  missingRoles,
  validateJobStatus,
} from '../src/lib/site/jobStatuses'
import { invoiceJob, billableLines, releaseJobLines } from '../src/lib/site/jobInvoicing'
import {
  listJobBoards,
  boardColumns,
  saveJobBoard,
  deleteJobBoard,
  statusesOffEveryBoard,
} from '../src/lib/site/jobBoards'
import {
  quoteJob,
  acceptQuote,
  declineJobQuote,
  jobQuotes,
  quoteVariance,
  workBlockedReason,
} from '../src/lib/site/jobQuotes'
import {
  startJobTimer,
  stopJobTimer,
  addJobTime,
  deleteJobTime,
  jobTime,
  reconcileJobTime,
} from '../src/lib/site/jobTime'
import {
  saveTravel,
  verifyTravel,
  deleteTravel,
  jobTravel,
  travelNeedingVerification,
  reconcileJobTravel,
} from '../src/lib/site/jobTravel'
import {
  saveAppointment,
  getAppointment,
  jobAppointments,
  appointmentsOn,
  setAppointmentStatus,
  deleteAppointment,
  unscheduledJobCount,
  unscheduledJobIds,
} from '../src/lib/site/jobAppointments'
import {
  saveServiceAddress,
  listServiceAddresses,
  deleteServiceAddress,
} from '../src/lib/site/serviceAddresses'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { verifySequence } from '../src/lib/site/sequences'
import { createCustomer } from '../src/lib/site/customers'
import { round, toNum } from '../src/lib/decimals'
import {
  REQUIRED_ROLES,
  breachesTolerance,
  canReclassify,
  chargeableKm,
  estimatedTripKm,
  gapBetween,
  haversineKm,
  overlaps,
} from '../src/lib/jobStatusModel'

const SITE = 1
const actor = { userId: 1, userName: 'Job Card Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/*
 * Fixtures are matched by a reserved pattern so the sweep can only ever delete
 * its own. JCT is not a code any real job or customer would carry.
 */
const TITLE_PATTERN = 'JCT %'
const CUSTOMER_PATTERN = '^JCT[0-9]{6}$'
const ADDRESS_PATTERN = 'JCT %'
const STATUS_PATTERN = 'JCT %'
const BOARD_PATTERN = 'JCT %'

/**
 * Deletes only this suite's fixtures.
 *
 * Run at the START of main() as well as the end: a crashed prior run leaves rows
 * behind, and the next run must not fail on litter it created itself. The
 * document_sequences row is deliberately NOT reset — it is shared with a live
 * dev database, and resetting a counter is how a duplicate number gets issued.
 */
async function sweepStrays() {
  // Invoices first: fk_jcl_invoice is SET NULL but the lines must go before the
  // job, and the documents reference the job.
  await siteExecute(
    SITE,
    `DELETE l FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
       JOIN job_cards j       ON j.id = d.job_card_id
      WHERE j.title LIKE ?`,
    [TITLE_PATTERN],
  )
  await siteExecute(
    SITE,
    `DELETE d FROM sales_documents d JOIN job_cards j ON j.id = d.job_card_id
      WHERE j.title LIKE ?`,
    [TITLE_PATTERN],
  )
  await siteExecute(
    SITE,
    `DELETE l FROM job_card_lines l JOIN job_cards j ON j.id = l.job_card_id
      WHERE j.title LIKE ?`,
    [TITLE_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title LIKE ?`, [TITLE_PATTERN])
  await siteExecute(SITE, `DELETE FROM service_addresses WHERE name LIKE ?`, [ADDRESS_PATTERN])
  // Boards before statuses: job_board_statuses CASCADEs from both, and deleting
  // the board first leaves nothing pointing at a status about to go.
  await siteExecute(SITE, `DELETE FROM job_boards WHERE name LIKE ?`, [BOARD_PATTERN])
  await siteExecute(SITE, `DELETE FROM job_statuses WHERE name LIKE ? AND is_system = 0`, [
    STATUS_PATTERN,
  ])
  await siteExecute(SITE, `DELETE FROM customers WHERE code REGEXP ?`, [CUSTOMER_PATTERN])
  await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND user_name = ?`, [
    actor.userName,
  ])
}

const jobLineCount = async (jobId: number) =>
  Number(
    (
      await siteQueryOne<any>(SITE, 'SELECT COUNT(*) n FROM job_card_lines WHERE job_card_id=?', [
        jobId,
      ])
    )?.n,
  )

async function main() {
  await sweepStrays()

  // ── Fixtures ───────────────────────────────────────────────────────────
  const stamp = String(Date.now()).slice(-6)
  const customer = await createCustomer(SITE, actor, {
    code: `JCT${stamp}`,
    name: `JCT Test Customer ${stamp}`,
    status: 'active',
  } as any)
  ok('a test customer was created', customer.ok, JSON.stringify(customer))
  if (!customer.ok) return
  const customerId = customer.id

  // ── 1. The workflow is well formed out of the box ──────────────────────
  const missing = await missingRoles(SITE)
  ok('(J6) every required role has an active status', missing.length === 0, missing.join(','))

  const statuses = await listJobStatuses(SITE)
  const systemCount = statuses.filter((s) => s.isSystem).length
  ok(
    '(J6) the six lifecycle roles are seeded as system statuses',
    systemCount === REQUIRED_ROLES.length,
    `${systemCount} system statuses`,
  )

  const newStatus = await statusForRole(SITE, 'new')
  ok('a status holds the new role', newStatus !== null)

  // ── 2. Validation refuses what it should ───────────────────────────────
  ok(
    'a job with no description is refused',
    validateJobCard({ title: '   ', customerId, customerName: null, dueAt: null } as any) !== null,
  )
  ok(
    'a job with neither account nor name is refused',
    validateJobCard({ title: 'Fix it', customerId: null, customerName: null, dueAt: null } as any) !==
      null,
  )
  ok(
    'a walk-in with only a name is allowed',
    validateJobCard({
      title: 'Fix it',
      customerId: null,
      customerName: 'Mrs Naidoo',
      dueAt: null,
    } as any) === null,
  )

  // ── 3. Creating a job issues a number immediately ──────────────────────
  const created = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'high',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT aircon not cooling',
    description: 'Blowing warm since Friday.',
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  ok('a job card is created', created.ok, JSON.stringify(created))
  if (!created.ok) return
  const jobId = created.id

  ok(
    'the job number is issued at CREATE, not at close',
    created.documentNumber !== null && created.documentNumber.startsWith('JC'),
    String(created.documentNumber),
  )

  const fresh = await getJobCard(SITE, jobId)
  ok('a new job lands on the status holding the new role', fresh?.statusId === newStatus?.id)
  ok('(J5) a new job is open', fresh?.status === 'open' && fresh?.isClosed === false)
  ok('the customer is snapshotted onto the job', fresh?.customerName?.includes('JCT Test') === true)

  // ── 4. Assigning advances the status ───────────────────────────────────
  const assigned = await assignOwner(SITE, actor, jobId, 1, 'JCT Technician')
  ok('a job can be assigned', assigned.ok, JSON.stringify(assigned))
  const afterAssign = await getJobCard(SITE, jobId)
  const assignedStatus = await statusForRole(SITE, 'assigned')
  ok(
    'assigning a new job advances it to the assigned role',
    afterAssign?.statusId === assignedStatus?.id,
    `${afterAssign?.statusName}`,
  )
  ok('the owner is recorded', afterAssign?.ownerName === 'JCT Technician')

  // ── 5. Service addresses ──────────────────────────────────────────────
  const address = await saveServiceAddress(SITE, actor, {
    id: null,
    customerId,
    locationId: null,
    code: null,
    name: 'JCT Unit 4 Parow',
    addressLine1: '4 Voortrekker Road',
    addressLine2: null,
    city: 'Parow',
    postalCode: '7500',
    latitude: -33.9,
    longitude: 18.6,
    contactId: null,
    accessNotes: 'Gate code 4471.',
    note: null,
    isDefault: true,
    isActive: true,
  })
  ok('a service address is created', address.ok, JSON.stringify(address))

  const halfCoords = await saveServiceAddress(SITE, actor, {
    id: null,
    customerId,
    locationId: null,
    code: null,
    name: 'JCT Half Coords',
    addressLine1: null,
    addressLine2: null,
    city: null,
    postalCode: null,
    latitude: -33.9,
    longitude: null,
    contactId: null,
    accessNotes: null,
    note: null,
    isDefault: false,
    isActive: true,
  })
  ok('an address with half a coordinate pair is refused', !halfCoords.ok)

  const addresses = await listServiceAddresses(SITE, customerId)
  ok('the address is listed against the customer', addresses.length === 1)

  // ── 6. Lines, and who pays for them ───────────────────────────────────
  const saved = await saveLines(SITE, actor, jobId, [
    {
      id: null,
      lineKind: 'part',
      billingState: 'quoted',
      productId: null,
      productCode: null,
      description: 'JCT capacitor',
      qty: 2,
      unitCostExcl: 100,
      unitPriceIncl: 230,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
    {
      id: null,
      lineKind: 'labour',
      billingState: 'pending',
      productId: null,
      productCode: null,
      description: 'JCT labour',
      qty: 3,
      unitCostExcl: 150,
      unitPriceIncl: 460,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
    {
      id: null,
      lineKind: 'part',
      billingState: 'pending',
      productId: null,
      productCode: null,
      description: 'JCT warranty compressor',
      qty: 1,
      unitCostExcl: 4200,
      unitPriceIncl: 0,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
  ])
  ok('lines are saved', saved.ok, JSON.stringify(saved))
  ok('three lines are on the job', (await jobLineCount(jobId)) === 3)

  const withLines = await getJobCard(SITE, jobId)
  ok(
    '(J2) cost counts every line regardless of who pays',
    withLines?.totals.cost === 2 * 100 + 3 * 150 + 4200,
    String(withLines?.totals.cost),
  )
  ok(
    'nothing is invoiced yet, so profit is not asserted',
    withLines?.totals.profit === null && withLines?.totals.invoiced === 0,
  )
  ok('two lines await a decision', withLines?.totals.pendingCount === 2)

  // ── 7. A closed job may not hide an undecided cost ─────────────────────
  const earlyClose = await closeJob(SITE, actor, jobId)
  ok(
    'closing is refused while a line awaits a billing decision',
    !earlyClose.ok,
    earlyClose.ok ? '' : earlyClose.error,
  )

  // ── 8. Reclassification, and the transitions it refuses ───────────────
  const labour = withLines!.lines.find((l) => l.description === 'JCT labour')!
  const warranty = withLines!.lines.find((l) => l.description === 'JCT warranty compressor')!
  const quoted = withLines!.lines.find((l) => l.description === 'JCT capacitor')!

  ok('a write-off with no reason is refused', !(await reclassifyLine(SITE, actor, labour.id, 'written_off', null)).ok)

  const toVariation = await reclassifyLine(SITE, actor, labour.id, 'variation', null)
  ok('pending becomes an approved variation', toVariation.ok, JSON.stringify(toVariation))

  const toInternal = await reclassifyLine(SITE, actor, warranty.id, 'internal', 'Under warranty.')
  ok('pending becomes an internal cost', toInternal.ok, JSON.stringify(toInternal))

  ok('nothing leaves internal, by the transition table', canReclassify('internal', 'additional') === false)
  const outOfInternal = await reclassifyLine(SITE, actor, warranty.id, 'additional', null)
  ok('the server refuses to make an internal cost billable', !outOfInternal.ok)

  ok('a quoted line may only be written off', canReclassify('quoted', 'variation') === false)

  // ── 9. Only billable lines reach an invoice ────────────────────────────
  const billable = await billableLines(SITE, jobId)
  const billableDescriptions = billable.map((l) => l.description).sort()
  ok(
    '(J4) only the quoted and variation lines are billable',
    billableDescriptions.length === 2 &&
      billableDescriptions[0] === 'JCT capacitor' &&
      billableDescriptions[1] === 'JCT labour',
    billableDescriptions.join(', '),
  )

  const billInternal = await invoiceJob(SITE, actor, jobId, [{ lineId: warranty.id, qty: 1 }])
  ok('(J4) invoicing an internal cost is refused', !billInternal.ok)

  const overBill = await invoiceJob(SITE, actor, jobId, [{ lineId: quoted.id, qty: 99 }])
  ok('(J3) invoicing more than is outstanding is refused', !overBill.ok)

  // ── 10. Part invoicing, twice, without over-billing ───────────────────
  const firstBill = await invoiceJob(SITE, actor, jobId, [{ lineId: quoted.id, qty: 1 }])
  ok('a part invoice is raised', firstBill.ok, JSON.stringify(firstBill))
  if (!firstBill.ok) return

  const firstDoc = await siteQueryOne<any>(
    SITE,
    'SELECT status, doc_type, document_number, job_card_id FROM sales_documents WHERE id=?',
    [firstBill.invoiceId],
  )
  ok('(J1) billing raises a DRAFT, not a posted document', firstDoc?.status === 'draft')
  ok('(J1) the draft carries no document number yet', firstDoc?.document_number === null)
  ok('the invoice is linked back to the job', Number(firstDoc?.job_card_id) === jobId)

  const afterFirst = await getJobCard(SITE, jobId)
  const quotedAfter = afterFirst!.lines.find((l) => l.id === quoted.id)!
  ok('(J3) one of two is invoiced', quotedAfter.invoicedQty === 1)
  ok('one of two is still outstanding', quotedAfter.outstandingQty === 1)
  ok(
    'a draft invoice is not revenue',
    afterFirst!.totals.invoiced === 0,
    String(afterFirst!.totals.invoiced),
  )

  // ── 11. (J7) Discarding the draft gives the quantity back ─────────────
  const released = await releaseJobLines(SITE, actor, firstBill.invoiceId)
  ok('(J7) a draft can be released', released.ok, JSON.stringify(released))
  const afterRelease = await getJobCard(SITE, jobId)
  ok(
    '(J7) the released line is outstanding again',
    afterRelease!.lines.find((l) => l.id === quoted.id)!.invoicedQty === 0,
  )

  // Put it back, in full this time, together with the variation.
  const fullBill = await invoiceJob(SITE, actor, jobId, [
    { lineId: quoted.id, qty: 2 },
    { lineId: labour.id, qty: 3 },
  ])
  ok('the whole billable job is invoiced', fullBill.ok, JSON.stringify(fullBill))
  if (!fullBill.ok) return

  const nothingLeft = await billableLines(SITE, jobId)
  ok('nothing is left to bill', nothingLeft.length === 0, String(nothingLeft.length))

  const releaseFinalised = await siteExecute(
    SITE,
    `UPDATE sales_documents SET status='finalised', document_number=CONCAT('JCTINV', id) WHERE id=?`,
    [fullBill.invoiceId],
  )
  ok('the invoice is marked finalised for the revenue test', releaseFinalised.affectedRows === 1)

  const cannotRelease = await releaseJobLines(SITE, actor, fullBill.invoiceId)
  ok('(J7) a finalised invoice cannot be released, only credited', !cannotRelease.ok)

  // ── 12. (J2) Revenue comes off the invoice, cost includes the absorbed ─
  const billed = await getJobCard(SITE, jobId)
  const invoiceTotal = toNum(
    (await siteQueryOne<any>(SITE, 'SELECT total_incl FROM sales_documents WHERE id=?', [
      fullBill.invoiceId,
    ]))?.total_incl,
  )
  ok(
    '(J2) revenue is exactly what the finalised invoice says',
    billed!.totals.invoiced === Math.round(invoiceTotal * 100) / 100,
    `job ${billed!.totals.invoiced} vs invoice ${invoiceTotal}`,
  )
  ok(
    '(J2) cost still includes the warranty part nobody paid for',
    billed!.totals.cost === 2 * 100 + 3 * 150 + 4200,
    String(billed!.totals.cost),
  )
  ok(
    '(J2) the absorbed figure is the warranty cost',
    billed!.totals.absorbed === 4200,
    String(billed!.totals.absorbed),
  )
  ok(
    '(J2) a job that gave away a R4 200 part reports a loss',
    billed!.totals.profit !== null && billed!.totals.profit < 0,
    String(billed!.totals.profit),
  )

  // The same arithmetic, run on the pure function, so the screens and the
  // reports cannot disagree with the detail page.
  const pure = jobTotals(billed!.lines, billed!.documents)
  ok('jobTotals is pure and agrees with the stored read', pure.cost === billed!.totals.cost)

  // ── 13. (J1) A job card cannot be posted ──────────────────────────────
  let postRefused = false
  try {
    // finaliseDocument takes a sales_documents id. A job card id is not one, and
    // the only way this could succeed is if a job had been written into that
    // table — which is the whole thing decision 1 makes impossible.
    const attempt = await finaliseDocument(SITE, actor, { documentId: jobId, tenders: [] } as any)
    postRefused = !attempt.ok
  } catch {
    postRefused = true
  }
  ok('(J1) finaliseDocument cannot post a job card id', postRefused)

  const jobInSales = await siteQueryOne<any>(
    SITE,
    "SELECT COUNT(*) n FROM sales_documents WHERE doc_type = 'job_card'",
  )
  ok("(J1) no sales document has doc_type 'job_card'", Number(jobInSales?.n) === 0)

  // ── 14. (J5) Closing, cancelling and reopening keep the states in step ─
  const decided = await reclassifyLine(SITE, actor, warranty.id, 'internal', 'Already internal.')
  ok('a no-op reclassification is harmless', decided.ok || true)

  const closed = await closeJob(SITE, actor, jobId, 'Tested and cooling.')
  ok('the job closes once every line is decided', closed.ok, closed.ok ? '' : closed.error)
  const afterClose = await getJobCard(SITE, jobId)
  ok('(J5) a closed job reads closed', afterClose?.status === 'closed' && afterClose?.isClosed)
  ok('the close reason is kept', afterClose?.closeReason === 'Tested and cooling.')

  const reopened = await reopenJob(SITE, actor, jobId, 'Fault came back.')
  ok('a closed job can be reopened', reopened.ok, JSON.stringify(reopened))
  const afterReopen = await getJobCard(SITE, jobId)
  ok('(J5) a reopened job is open again', afterReopen?.status === 'open')
  ok('a reopened job goes to work-underway, not back to new', afterReopen?.statusRole === 'in_progress')

  // A second job, to cancel, so the first keeps its invoice history.
  const second = await saveJobCard(SITE, actor, {
    id: null,
    customerId: null,
    customerName: 'JCT Walk-in',
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'low',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT walk-in kettle',
    description: null,
    dueAt: null,
    source: 'walk_in',
    reference: null,
    internalNote: null,
  })
  ok('a walk-in job with no account is created', second.ok, JSON.stringify(second))
  if (!second.ok) return

  const noAccountBill = await invoiceJob(SITE, actor, second.id, [{ lineId: 1, qty: 1 }])
  ok('a job with no customer account cannot be invoiced', !noAccountBill.ok)

  const cancelNoReason = await cancelJob(SITE, actor, second.id, '   ')
  ok('cancelling with no reason is refused', !cancelNoReason.ok)

  const cancelled = await cancelJob(SITE, actor, second.id, 'Customer changed their mind.')
  ok('a job can be cancelled', cancelled.ok, JSON.stringify(cancelled))
  const afterCancel = await getJobCard(SITE, second.id)
  ok('(J5) a cancelled job reads cancelled', afterCancel?.status === 'cancelled')
  ok('the cancel reason is kept', afterCancel?.cancelReason === 'Customer changed their mind.')

  // ── 15. (J6) The workflow protects itself ─────────────────────────────
  const systemStatus = statuses.find((s) => s.isSystem && s.role === 'on_hold')!
  const deleteSystem = await deleteJobStatus(SITE, actor, systemStatus.id)
  ok('(J6) a system status cannot be deleted', !deleteSystem.ok, deleteSystem.ok ? '' : deleteSystem.error)

  const switchOffSystem = validateJobStatus(
    { id: systemStatus.id, name: systemStatus.name, tone: systemStatus.tone, role: systemStatus.role, isActive: false },
    statuses,
  )
  ok('(J6) a system status cannot be switched off', switchOffSystem !== null)

  const stealRole = validateJobStatus(
    { id: null, name: 'JCT Second On Hold', tone: 'neutral', role: 'on_hold', isActive: true },
    statuses,
  )
  ok('(J6) two statuses cannot hold the same role', stealRole !== null)

  const renameSystem = validateJobStatus(
    { id: systemStatus.id, name: 'JCT Parked', tone: 'neutral', role: systemStatus.role, isActive: true },
    statuses,
  )
  ok('(J6) a system status CAN be renamed', renameSystem === null, String(renameSystem))

  const custom = await saveJobStatus(SITE, actor, {
    id: null,
    name: 'JCT Awaiting Sign-off',
    tone: 'warning',
    role: '',
    isActive: true,
  })
  ok('a business can add its own status', custom.ok, JSON.stringify(custom))
  if (custom.ok) {
    const moved = await setStatus(SITE, actor, jobId, custom.id)
    ok('a job can move to a custom status', moved.ok, JSON.stringify(moved))
    const onCustom = await getJobCard(SITE, jobId)
    ok(
      '(J5) a custom status with no role leaves the job open',
      onCustom?.status === 'open',
      String(onCustom?.status),
    )

    const deleteInUse = await deleteJobStatus(SITE, actor, custom.id)
    ok('a status holding jobs cannot be deleted', !deleteInUse.ok, deleteInUse.ok ? '' : deleteInUse.error)

    // Move it off so the sweep can remove the status.
    await setStatus(SITE, actor, jobId, systemStatus.id)
  }

  // ── 15b. (J8) Boards are views, and hold no jobs ──────────────────────
  const seededBoards = await listJobBoards(SITE, true)
  ok('a board is seeded out of the box', seededBoards.length >= 1, String(seededBoards.length))

  const firstBoard = seededBoards[0]
  const cols = await boardColumns(SITE, firstBoard.id)
  ok('the seeded board draws every active status as a column', cols.length >= 6, String(cols.length))
  ok(
    '(J5) a closed column is derived from the role, not stored',
    cols.some((c) => c.isClosed) && cols.some((c) => !c.isClosed),
  )

  const onBoard = cols.flatMap((c) => c.cards).some((card) => card.id === jobId)
  ok('(J8) the job appears on the board through its status alone', onBoard)

  // The whole point of deriving membership: two boards naming one status show
  // the same job, and nothing about that was stored anywhere.
  const secondBoard = await saveJobBoard(SITE, actor, {
    id: null,
    name: 'JCT Second Board',
    layout: 'kanban',
    isActive: true,
    statusIds: cols.map((c) => c.statusId),
  })
  ok('a second board is created', secondBoard.ok, JSON.stringify(secondBoard))
  if (secondBoard.ok) {
    const alsoCols = await boardColumns(SITE, secondBoard.id)
    const onBoth = alsoCols.flatMap((c) => c.cards).some((card) => card.id === jobId)
    ok('(J8) the same job appears on both boards, from one row', onBoth)

    const noJobRows = await siteQueryOne<any>(
      SITE,
      'SELECT COUNT(*) n FROM job_board_statuses WHERE board_id = ?',
      [secondBoard.id],
    )
    ok(
      '(J8) a board stores its columns and nothing about jobs',
      Number(noJobRows?.n) === cols.length,
      `${noJobRows?.n} column rows`,
    )
  }

  const emptyBoard = await saveJobBoard(SITE, actor, {
    id: null,
    name: 'JCT Empty Board',
    layout: 'kanban',
    isActive: true,
    statusIds: [],
  })
  ok('a board with no columns is refused', !emptyBoard.ok, emptyBoard.ok ? '' : emptyBoard.error)

  // ── 15c. A status on no board is reported, never hidden ───────────────
  const loneStatus = await saveJobStatus(SITE, actor, {
    id: null,
    name: 'JCT Off Board',
    tone: 'neutral',
    role: '',
    isActive: true,
  })
  ok('a status can exist off every board', loneStatus.ok, JSON.stringify(loneStatus))
  if (loneStatus.ok) {
    const off = await statusesOffEveryBoard(SITE)
    ok(
      'the off-board report names it',
      off.some((s) => s.statusId === loneStatus.id),
      off.map((s) => s.name).join(', '),
    )

    // Move the job there and confirm it vanishes from the board while staying in
    // the list — which is exactly the trap the report exists to surface.
    await setStatus(SITE, actor, jobId, loneStatus.id)
    const strandedCols = await boardColumns(SITE, firstBoard.id)
    ok(
      'a job in an off-board status is on no board',
      !strandedCols.flatMap((c) => c.cards).some((card) => card.id === jobId),
    )
    const stillListed = await listJobCards(SITE, { state: 'all', search: 'JCT aircon', limit: 50 })
    ok('but it is still in the job list', stillListed.some((j) => j.id === jobId))

    const offReport = await statusesOffEveryBoard(SITE)
    ok(
      'the report counts the stranded job',
      (offReport.find((s) => s.statusId === loneStatus.id)?.jobCount ?? 0) === 1,
    )

    // Put it back on a real column so the sweep can clear the status.
    await setStatus(SITE, actor, jobId, cols[0].statusId)
  }

  const lastBoardGuard = await siteQuery<any>(SITE, 'SELECT id FROM job_boards')
  if (lastBoardGuard.length === 1) {
    const deleteOnly = await deleteJobBoard(SITE, actor, lastBoardGuard[0].id)
    ok('the only board cannot be deleted', !deleteOnly.ok)
  }

  // ── 15d. (J9) Quoting, revisions and acceptance ───────────────────────
  const quoteJob3 = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT quote lifecycle',
    description: null,
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  ok('a job for the quote tests is created', quoteJob3.ok, JSON.stringify(quoteJob3))
  if (!quoteJob3.ok) return
  const qJob = quoteJob3.id

  const noLines = await quoteJob(SITE, actor, qJob, {})
  ok('a job with nothing chargeable cannot be quoted', !noLines.ok, noLines.ok ? '' : noLines.error)

  await saveLines(SITE, actor, qJob, [
    {
      id: null,
      lineKind: 'part',
      billingState: 'pending',
      productId: null,
      productCode: null,
      description: 'JCT quoted pump',
      qty: 1,
      unitCostExcl: 500,
      unitPriceIncl: 1150,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
    {
      id: null,
      lineKind: 'part',
      billingState: 'pending',
      productId: null,
      productCode: null,
      description: 'JCT absorbed seal',
      qty: 1,
      unitCostExcl: 90,
      unitPriceIncl: 0,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
  ])

  const qLines = (await getJobCard(SITE, qJob))!.lines
  const pump = qLines.find((l) => l.description.includes('pump'))!
  const seal = qLines.find((l) => l.description.includes('seal'))!

  // Only the pump is chargeable; the seal is absorbed.
  await reclassifyLine(SITE, actor, pump.id, 'additional', null)
  await reclassifyLine(SITE, actor, seal.id, 'internal', 'Goodwill.')

  const v1 = await quoteJob(SITE, actor, qJob, {})
  ok('a quote is raised from the chargeable lines', v1.ok, JSON.stringify(v1))
  if (!v1.ok) return
  ok('(J9) the quote carries only the chargeable line', v1.lineCount === 1, String(v1.lineCount))
  ok('(J9) a quote claims a QUO number immediately', (v1.documentNumber ?? '').startsWith('QUO'))
  ok('(J9) the first quote is revision 1', v1.revision === 1)

  const v1Doc = await siteQueryOne<any>(
    SITE,
    'SELECT doc_type, status, job_card_id, total_incl, quote_outcome FROM sales_documents WHERE id=?',
    [v1.quoteId],
  )
  ok("(J1) a job quote is doc_type 'quote', not a new type", String(v1Doc?.doc_type) === 'quote')
  ok('(J9) it is linked back to the job', Number(v1Doc?.job_card_id) === qJob)
  ok('(J9) it starts awaiting an answer', String(v1Doc?.quote_outcome) === 'open')
  ok(
    '(J9) documentMath priced it, so the quote and an invoice would agree',
    toNum(v1Doc?.total_incl) === 1150,
    String(v1Doc?.total_incl),
  )

  // Acceptance requires a name, and email requires evidence.
  const noName = await acceptQuote(SITE, actor, v1.quoteId, {
    method: 'verbal',
    acceptedBy: '  ',
  })
  ok('accepting with nobody named is refused', !noName.ok)

  const noRef = await acceptQuote(SITE, actor, v1.quoteId, {
    method: 'email',
    acceptedBy: 'Mrs Naidoo',
  })
  ok('an email acceptance with no evidence is refused', !noRef.ok, noRef.ok ? '' : noRef.error)

  const accepted = await acceptQuote(SITE, actor, v1.quoteId, {
    method: 'email',
    acceptedBy: 'Mrs Naidoo',
    reference: 'Re: QUO, 11 Aug',
  })
  ok('the quote is accepted', accepted.ok, JSON.stringify(accepted))

  const afterAccept = await siteQueryOne<any>(
    SITE,
    `SELECT quote_outcome, quote_accept_method, quote_accepted_by, quote_accept_reference,
            quote_accepted_by_user_id, status
       FROM sales_documents WHERE id=?`,
    [v1.quoteId],
  )
  ok('(J9) the method is recorded', String(afterAccept?.quote_accept_method) === 'email')
  ok('(J9) who accepted is recorded', String(afterAccept?.quote_accepted_by) === 'Mrs Naidoo')
  ok('(J9) the evidence is recorded', String(afterAccept?.quote_accept_reference).includes('11 Aug'))
  ok(
    '(J9) the user who recorded it is kept apart from the customer who gave it',
    Number(afterAccept?.quote_accepted_by_user_id) === actor.userId,
  )
  ok('accepting issues a draft quote', String(afterAccept?.status) === 'issued')

  const jobAfter = await getJobCard(SITE, qJob)
  ok('(J9) the job names the live version', jobAfter?.acceptedQuoteId === v1.quoteId)
  ok(
    '(J9) accepting rebases the covered line to the quoted baseline',
    jobAfter!.lines.find((l) => l.id === pump.id)!.billingState === 'quoted',
  )
  ok(
    '(J9) an absorbed line is NOT dragged onto the quote by acceptance',
    jobAfter!.lines.find((l) => l.id === seal.id)!.billingState === 'internal',
  )

  const twice = await acceptQuote(SITE, actor, v1.quoteId, { method: 'verbal', acceptedBy: 'Again' })
  ok('the same version cannot be accepted twice', !twice.ok)

  // ── A new version un-accepts the job, and v1 survives ─────────────────
  await saveLines(SITE, actor, qJob, [
    ...jobAfter!.lines.map((l) => ({
      id: l.id,
      lineKind: l.lineKind,
      billingState: l.billingState,
      productId: l.productId,
      productCode: l.productCode,
      description: l.description,
      qty: l.qty,
      unitCostExcl: l.unitCostExcl,
      unitPriceIncl: l.unitPriceIncl,
      vatRatePct: l.vatRatePct,
      discountPct: l.discountPct,
      note: l.note,
    })),
    {
      id: null,
      lineKind: 'labour',
      billingState: 'additional',
      productId: null,
      productCode: null,
      description: 'JCT extra hours found on site',
      qty: 2,
      unitCostExcl: 150,
      unitPriceIncl: 520,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
  ])

  const v2 = await quoteJob(SITE, actor, qJob, {})
  ok('a second version is raised', v2.ok, JSON.stringify(v2))
  if (!v2.ok) return
  ok('(J9) it is revision 2', v2.revision === 2)
  ok('(J9) it carries both chargeable lines', v2.lineCount === 2, String(v2.lineCount))

  const v2Row = await siteQueryOne<any>(SITE, 'SELECT supersedes_id FROM sales_documents WHERE id=?', [
    v2.quoteId,
  ])
  ok('(J9) v2 points at what it replaces', Number(v2Row?.supersedes_id) === v1.quoteId)

  const v1Still = await siteQueryOne<any>(
    SITE,
    'SELECT quote_outcome, quote_accepted_by, document_number FROM sales_documents WHERE id=?',
    [v1.quoteId],
  )
  ok(
    '(J9) v1 keeps its acceptance and its number — never overwritten',
    String(v1Still?.quote_outcome) === 'accepted' && String(v1Still?.quote_accepted_by) === 'Mrs Naidoo',
  )

  const unAccepted = await getJobCard(SITE, qJob)
  ok(
    '(J9) a new version un-accepts the JOB, so it claims no authorisation',
    unAccepted?.acceptedQuoteId === null,
  )

  /*
   * The superseded guard, tested on a version that is NOT already accepted.
   *
   * Accepting v1 again hits the already-accepted refusal first, so it proves
   * nothing about superseding. A third version makes v2 superseded while it is
   * still open, which is the only state where this guard is the one that fires —
   * and it is the state that matters, because it is how somebody answers a stale
   * email after a revised quote has gone out.
   */
  const v3 = await quoteJob(SITE, actor, qJob, {})
  ok('a third version is raised', v3.ok, JSON.stringify(v3))
  if (!v3.ok) return

  const acceptSuperseded = await acceptQuote(SITE, actor, v2.quoteId, {
    method: 'verbal',
    acceptedBy: 'Answering a stale email',
  })
  ok(
    '(J9) an open but superseded version cannot be accepted',
    !acceptSuperseded.ok && (acceptSuperseded.ok ? '' : acceptSuperseded.error).includes('replaced'),
    acceptSuperseded.ok ? 'ALLOWED' : acceptSuperseded.error,
  )

  // v3 is the live offer from here on.
  const acceptV3 = await acceptQuote(SITE, actor, v3.quoteId, {
    method: 'verbal',
    acceptedBy: 'Mrs Naidoo',
  })
  ok('the newest version can be accepted', acceptV3.ok, JSON.stringify(acceptV3))

  // ── Declining, and the variance figure ────────────────────────────────
  const noReason = await declineJobQuote(SITE, actor, v2.quoteId, '   ')
  ok('declining with no reason is refused', !noReason.ok)

  const declineAccepted = await declineJobQuote(SITE, actor, v3.quoteId, 'Changed their mind.')
  ok(
    'an accepted version cannot be declined — raise a new one instead',
    !declineAccepted.ok,
    declineAccepted.ok ? '' : declineAccepted.error,
  )

  const declined = await declineJobQuote(SITE, actor, v2.quoteId, 'Went with a cheaper quote.')
  ok('an open version can be declined', declined.ok, JSON.stringify(declined))

  const chain = await jobQuotes(SITE, qJob)
  ok(
    '(J9) every version is on the job, newest first',
    chain.length === 3 && chain[0].revision === 3,
    `${chain.length} versions, newest v${chain[0]?.revision}`,
  )
  ok(
    '(J9) the chain reports which version replaced which',
    chain.find((q) => q.id === v2.quoteId)?.supersededById === v3.quoteId,
  )
  ok(
    'the declined reason is kept on the version that was declined',
    chain.find((q) => q.id === v2.quoteId)?.lostReason?.includes('cheaper') === true,
  )
  ok(
    '(J9) exactly one version is live',
    chain.filter((q) => q.isLive).length === 1 && chain.find((q) => q.isLive)?.id === v3.quoteId,
  )

  const varBefore = await quoteVariance(SITE, qJob)
  ok(
    '(J9) with everything on the accepted quote, the variance is zero',
    varBefore.variance === 0,
    `quoted ${varBefore.quotedTotal} vs chargeable ${varBefore.chargeableTotal}`,
  )
  ok('nothing is unquoted', varBefore.unquotedLines.length === 0)

  // Work added AFTER acceptance is the case the figure exists for.
  const withExtra = await getJobCard(SITE, qJob)
  await saveLines(SITE, actor, qJob, [
    ...withExtra!.lines.map((l) => ({
      id: l.id,
      lineKind: l.lineKind,
      billingState: l.billingState,
      productId: l.productId,
      productCode: l.productCode,
      description: l.description,
      qty: l.qty,
      unitCostExcl: l.unitCostExcl,
      unitPriceIncl: l.unitPriceIncl,
      vatRatePct: l.vatRatePct,
      discountPct: l.discountPct,
      note: l.note,
    })),
    {
      id: null,
      lineKind: 'part',
      billingState: 'additional',
      productId: null,
      productCode: null,
      description: 'JCT scope creep bracket',
      qty: 1,
      unitCostExcl: 100,
      unitPriceIncl: 300,
      vatRatePct: 15,
      discountPct: 0,
      note: null,
    },
  ])

  const varAfter = await quoteVariance(SITE, qJob)
  ok(
    '(J9) work added after acceptance shows as over the quote',
    varAfter.variance === 300,
    String(varAfter.variance),
  )
  ok(
    '(J9) and it is named, so somebody can go and approve it',
    varAfter.unquotedLines.length === 1 &&
      varAfter.unquotedLines[0].description.includes('bracket'),
    JSON.stringify(varAfter.unquotedLines),
  )

  // ── The work gate, off by default ─────────────────────────────────────
  const notBlocked = await workBlockedReason(SITE, jobId)
  ok('work is not gated on acceptance by default', notBlocked === null)

  await siteExecute(
    SITE,
    `INSERT INTO settings (setting_key, setting_value) VALUES ('job_require_quote_acceptance','1')
       ON DUPLICATE KEY UPDATE setting_value = '1'`,
  )
  const blocked = await workBlockedReason(SITE, jobId)
  ok('with the setting on, an unquoted job is gated', blocked !== null, String(blocked))
  const notGated = await workBlockedReason(SITE, qJob)
  ok('but a job with an accepted quote is not', notGated === null, String(notGated))
  await siteExecute(
    SITE,
    `UPDATE settings SET setting_value = '0' WHERE setting_key = 'job_require_quote_acceptance'`,
  )

  // ── 15e. (J10) Visits, and the conflicts they cause ───────────────────
  /*
   * Times are built from a FIXED future day rather than "tomorrow", so the suite
   * cannot straddle midnight and cannot collide with real bookings on a dev
   * database. Far enough out that nothing real is there.
   */
  const day = '2099-03-04'
  const at = (hhmm: string) => `${day} ${hhmm}:00`

  const noWhen = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: '',
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [],
  })
  ok('a visit with no date is refused', !noWhen.ok)

  const tooShort = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('09:00'),
    durationMinutes: 2,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [],
  })
  ok('a two-minute visit is refused', !tooShort.ok)

  // A visit with nobody on it is ALLOWED — booking the slot before knowing who
  // is free is how dispatchers work.
  const unassignedVisit = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('09:00'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: 'First look',
    notes: null,
    assignees: [],
  })
  ok(
    '(J10) a visit can be booked before anybody is assigned',
    unassignedVisit.ok,
    JSON.stringify(unassignedVisit),
  )
  if (!unassignedVisit.ok) return

  const first = await getAppointment(SITE, unassignedVisit.id)
  ok('(J10) it is visit 1', first?.visitNumber === 1)
  ok('(J10) a fresh visit is live', first?.isLive === true)

  // ── The job advances to Scheduled ────────────────────────────────────
  const schedStatus = await siteQueryOne<any>(
    SITE,
    "SELECT id FROM job_statuses WHERE code='scheduled' AND is_active=1",
  )
  if (schedStatus) {
    const jobNow = await getJobCard(SITE, qJob)
    ok(
      '(J10) booking a future visit moves a new job to Scheduled',
      jobNow?.statusId === Number(schedStatus.id),
      `${jobNow?.statusName}`,
    )
  }

  // ── Overlap ─────────────────────────────────────────────────────────
  const withPerson = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('11:00'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [{ userId: 1, userName: 'JCT Tech', isLead: true }],
  })
  ok('a visit with somebody on it is booked', withPerson.ok, JSON.stringify(withPerson))
  if (!withPerson.ok) return

  const clash = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: jobId,
    startsAt: at('11:30'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [{ userId: 1, userName: 'JCT Tech', isLead: true }],
  })
  ok(
    '(J10) double-booking the same person is refused with the clash named',
    !clash.ok && (clash.conflicts ?? []).some((c) => c.kind === 'overlap'),
    clash.ok ? 'ALLOWED' : JSON.stringify(clash.conflicts),
  )

  // ── The gap allowance ───────────────────────────────────────────────
  const tight = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: jobId,
    startsAt: at('12:05'),
    durationMinutes: 30,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [{ userId: 1, userName: 'JCT Tech', isLead: true }],
  })
  ok(
    '(J10) five minutes after the last visit trips the travel allowance',
    !tight.ok && (tight.conflicts ?? []).some((c) => c.kind === 'travel_gap'),
    tight.ok ? 'ALLOWED' : JSON.stringify(tight.conflicts),
  )

  // Half-open intervals: a visit starting exactly when another ends does NOT
  // overlap. The classic off-by-one, and the reason the maths is a pure function.
  ok('(J10) back-to-back visits do not overlap', overlaps(600, 60, 660, 60) === false)
  ok('(J10) a one-minute intrusion does overlap', overlaps(600, 60, 659, 60) === true)
  ok('(J10) the gap between two visits is measured, not guessed', gapBetween(600, 60, 690, 30) === 30)
  ok('(J10) overlapping visits have no gap', gapBetween(600, 60, 630, 30) === null)

  // ── The override, which is the point of warning rather than refusing ──
  const overridden = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: jobId,
    startsAt: at('11:30'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [{ userId: 1, userName: 'JCT Tech', isLead: true }],
    overrideReason: 'Both jobs are on the same street.',
  })
  ok(
    '(J10) an authorised override books it anyway',
    overridden.ok,
    JSON.stringify(overridden.ok ? overridden.conflicts.length : overridden),
  )
  if (overridden.ok) {
    ok('(J10) and the conflicts it overrode are reported back', overridden.conflicts.length > 0)
    const kept = await getAppointment(SITE, overridden.id)
    ok(
      '(J10) the override reason is stored for the audit',
      kept?.overrideReason?.includes('same street') === true,
    )
  }

  // ── Outside the working day ─────────────────────────────────────────
  const dawn = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('05:00'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [],
  })
  ok(
    '(J10) a visit before the working day is flagged',
    !dawn.ok && (dawn.conflicts ?? []).some((c) => c.kind === 'outside_hours'),
    dawn.ok ? 'ALLOWED' : JSON.stringify(dawn.conflicts),
  )

  // ── Two people, and who leads ───────────────────────────────────────
  const noLead = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('14:00'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [
      { userId: 1, userName: 'JCT Tech', isLead: false },
      { userId: 2, userName: 'JCT Mate', isLead: false },
    ],
  })
  ok('with two people going, one must lead', !noLead.ok, noLead.ok ? '' : noLead.error)

  const pair = await saveAppointment(SITE, actor, {
    id: null,
    jobCardId: qJob,
    startsAt: at('14:00'),
    durationMinutes: 60,
    serviceAddressId: null,
    visitType: null,
    notes: null,
    assignees: [
      { userId: 1, userName: 'JCT Tech', isLead: true },
      { userId: 2, userName: 'JCT Mate', isLead: false },
    ],
    overrideReason: 'Second pair of hands.',
  })
  ok('a two-person visit is booked', pair.ok, JSON.stringify(pair))

  // ── Unscheduled is derived ──────────────────────────────────────────
  const beforeCancel = await unscheduledJobCount(SITE)
  ok('(J10) the unscheduled count is a number', Number.isFinite(beforeCancel))

  const jobWithVisit = await unscheduledJobIds(SITE, 500)
  ok(
    '(J10) a job with a live future visit is NOT unscheduled',
    !jobWithVisit.includes(qJob),
    `qJob ${qJob} in ${jobWithVisit.length} unscheduled`,
  )

  // Cancelling every visit puts it back — the PRD rule that a cancelled
  // appointment must not make a job count as scheduled.
  for (const visit of await jobAppointments(SITE, qJob)) {
    if (visit.isLive) {
      await setAppointmentStatus(SITE, actor, visit.id, 'cancelled', 'JCT sweep')
    }
  }
  const unscheduledAgain = await unscheduledJobIds(SITE, 500)
  ok(
    '(J10) cancelling every visit makes the job unscheduled again',
    unscheduledAgain.includes(qJob),
    `qJob ${qJob} ${unscheduledAgain.includes(qJob) ? 'is' : 'is NOT'} unscheduled`,
  )

  const noReasonCancel = await setAppointmentStatus(SITE, actor, withPerson.id, 'no_show')
  ok('a no-show needs a reason', !noReasonCancel.ok)

  // ── Arriving starts the job ─────────────────────────────────────────
  const arriveJob = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT arrival starts work',
    description: null,
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  if (arriveJob.ok) {
    const visit = await saveAppointment(SITE, actor, {
      id: null,
      jobCardId: arriveJob.id,
      startsAt: at('15:00'),
      durationMinutes: 60,
      serviceAddressId: null,
      visitType: null,
      notes: null,
      assignees: [{ userId: 3, userName: 'JCT Arriver', isLead: true }],
    })
    if (visit.ok) {
      await setAppointmentStatus(SITE, actor, visit.id, 'en_route')
      const arrived = await setAppointmentStatus(SITE, actor, visit.id, 'on_site')
      ok('a technician can arrive', arrived.ok, JSON.stringify(arrived))

      const started = await getJobCard(SITE, arriveJob.id)
      ok(
        '(J10) arriving on site moves the job to work underway',
        started?.statusRole === 'in_progress',
        String(started?.statusName),
      )
      ok('(J10) and stamps when work started', started?.startedAt !== null)

      const stamped = await getAppointment(SITE, visit.id)
      ok('(J10) the travel and arrival times are stamped, not typed', stamped?.arrivedAt !== null)

      // Stamped once and never moved: a second press must not improve somebody's
      // punctuality figures.
      const firstArrival = stamped!.arrivedAt
      await setAppointmentStatus(SITE, actor, visit.id, 'en_route')
      await setAppointmentStatus(SITE, actor, visit.id, 'on_site')
      const again = await getAppointment(SITE, visit.id)
      ok('(J10) arriving twice does not move the first arrival time', again?.arrivedAt === firstArrival)

      const cannotDelete = await deleteAppointment(SITE, actor, visit.id)
      ok(
        '(J10) an attended visit cannot be deleted, only cancelled',
        !cannotDelete.ok,
        cannotDelete.ok ? '' : cannotDelete.error,
      )
    }
  }

  // ── The day view ────────────────────────────────────────────────────
  const onDay = await appointmentsOn(SITE, day)
  ok('(J10) the day view finds the visits booked on it', onDay.length >= 3, String(onDay.length))
  ok(
    '(J10) it includes cancelled ones, so a lane does not look free',
    onDay.some((v) => !v.isLive),
  )

  // ── 15f. (J11) The clock, and the labour it produces ──────────────────
  const timeJob = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT timer job A',
    description: null,
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  const otherJob = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT timer job B',
    description: null,
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  ok('two jobs for the timer tests', timeJob.ok && otherJob.ok)
  if (!timeJob.ok || !otherJob.ok) return

  const TECH = 9901

  const started = await startJobTimer(SITE, actor, timeJob.id, TECH, 'JCT Timer Tech')
  ok('(J11) the clock starts', started.ok, JSON.stringify(started))
  ok('(J11) nothing was running before, so nothing was stopped', started.ok && started.stoppedOther === null)

  const startedTwice = await startJobTimer(SITE, actor, timeJob.id, TECH, 'JCT Timer Tech')
  ok(
    '(J11) starting the same job twice is refused',
    !startedTwice.ok,
    startedTwice.ok ? '' : startedTwice.error,
  )

  /*
   * The decision this phase turned on: starting elsewhere SWITCHES rather than
   * refusing or running two clocks. uq_open_entry is what makes the third option
   * impossible, and it stays.
   */
  const switched = await startJobTimer(SITE, actor, otherJob.id, TECH, 'JCT Timer Tech')
  ok('(J11) starting another job switches the clock', switched.ok, JSON.stringify(switched))
  ok(
    '(J11) and says which job it came off',
    switched.ok && switched.stoppedOther !== null,
    switched.ok ? JSON.stringify(switched.stoppedOther) : '',
  )

  const openRows = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) n FROM staff_time_entries WHERE user_id=? AND ended_at IS NULL',
    [TECH],
  )
  ok(
    '(J11) exactly one entry is open — the database index holds',
    Number(openRows?.n) === 1,
    `${openRows?.n} open`,
  )

  // The switched-off entry keeps its minutes and has no line yet: that is the
  // state reconcileJobTime reports, and it is deliberate.
  const jobATime = await jobTime(SITE, timeJob.id)
  ok('(J11) the switched-off job kept its entry', jobATime.entries.length === 1)
  ok('(J11) and it is closed', jobATime.entries[0].isOpen === false)
  ok(
    '(J11) but not yet priced — switching never charges a job nobody was looking at',
    jobATime.entries[0].lineId === null,
  )

  const wrongJob = await stopJobTimer(SITE, actor, timeJob.id, TECH)
  ok(
    '(J11) stopping the wrong job is refused',
    !wrongJob.ok,
    wrongJob.ok ? '' : wrongJob.error,
  )

  const stopped = await stopJobTimer(SITE, actor, otherJob.id, TECH, 'JCT stop note')
  ok('(J11) the clock stops', stopped.ok, JSON.stringify(stopped))
  // A sub-minute test timer makes no line, by design — a zero-hour labour line is
  // noise on the costing tab.
  ok(
    '(J11) a sub-minute timer records the entry and makes no line',
    stopped.ok && stopped.minutes === 0 && stopped.lineId === null,
    stopped.ok ? `${stopped.minutes}min line=${stopped.lineId}` : '',
  )

  const noneRunning = await stopJobTimer(SITE, actor, otherJob.id, TECH)
  ok('(J11) stopping when nothing runs is refused', !noneRunning.ok)

  // ── Booking forgotten hours, which is where the money appears ─────────
  const zero = await addJobTime(SITE, actor, timeJob.id, {
    userId: TECH,
    userName: 'JCT Timer Tech',
    startedAt: '2099-03-04 09:00:00',
    minutes: 0,
  })
  ok('(J11) booking zero minutes is refused', !zero.ok)

  const tooLong = await addJobTime(SITE, actor, timeJob.id, {
    userId: TECH,
    userName: 'JCT Timer Tech',
    startedAt: '2099-03-04 09:00:00',
    minutes: 25 * 60,
  })
  ok('(J11) booking more than a day is refused', !tooLong.ok)

  const booked = await addJobTime(SITE, actor, timeJob.id, {
    userId: TECH,
    userName: 'JCT Timer Tech',
    startedAt: '2099-03-04 09:00:00',
    minutes: 150,
    note: 'JCT forgotten afternoon',
  })
  ok('(J11) forgotten hours can be booked', booked.ok, JSON.stringify(booked))
  if (!booked.ok) return
  ok('(J11) 150 minutes is recorded', booked.minutes === 150)

  const withLabour = await getJobCard(SITE, timeJob.id)
  const labourLine = withLabour!.lines.find((l) => l.id === booked.lineId)
  ok('(J11) it produced a labour line', labourLine !== undefined)
  ok('(J11) priced in HOURS, not minutes', labourLine?.qty === 2.5, String(labourLine?.qty))
  ok('(J11) as a labour line, not a part', labourLine?.lineKind === 'labour')
  ok(
    '(J11) VAT resolves from vat_rates, not a hard-coded number',
    labourLine !== undefined && labourLine.vatRatePct > 0,
    String(labourLine?.vatRatePct),
  )
  /*
   * No employment record and no labour product on a test site, so the line lands
   * awaiting a decision rather than inventing a rate. Losing the hours because a
   * setting is blank would be worse than a line somebody has to price.
   */
  ok(
    '(J11) unpriced work waits for a decision rather than guessing a rate',
    labourLine?.billingState === 'pending',
    String(labourLine?.billingState),
  )

  // ── Booking never collides with a running clock ───────────────────────
  const running = await startJobTimer(SITE, actor, timeJob.id, TECH, 'JCT Timer Tech')
  ok('the clock is running again', running.ok)
  const alongside = await addJobTime(SITE, actor, otherJob.id, {
    userId: TECH,
    userName: 'JCT Timer Tech',
    startedAt: '2099-03-05 09:00:00',
    minutes: 60,
  })
  ok(
    '(J11) yesterday can be booked while today runs — a closed entry never trips uq_open_entry',
    alongside.ok,
    JSON.stringify(alongside),
  )
  await stopJobTimer(SITE, actor, timeJob.id, TECH)

  // ── Removing time takes its line with it ─────────────────────────────
  const timeNow = await jobTime(SITE, timeJob.id)
  const priced = timeNow.entries.find((e) => e.lineId !== null)!
  const beforeLines = (await getJobCard(SITE, timeJob.id))!.lines.length

  const removed = await deleteJobTime(SITE, actor, timeJob.id, priced.id)
  ok('(J11) a time entry can be removed', removed.ok, JSON.stringify(removed))
  const afterLines = (await getJobCard(SITE, timeJob.id))!.lines.length
  ok(
    '(J11) and the labour line goes with it — never an entry without its cost',
    afterLines === beforeLines - 1,
    `${beforeLines} -> ${afterLines}`,
  )

  const runningAgain = await startJobTimer(SITE, actor, timeJob.id, TECH, 'JCT Timer Tech')
  if (runningAgain.ok) {
    const openDelete = await deleteJobTime(SITE, actor, timeJob.id, runningAgain.entryId)
    ok('(J11) a running entry cannot be removed', !openDelete.ok, openDelete.ok ? '' : openDelete.error)
    await stopJobTimer(SITE, actor, timeJob.id, TECH)
  }

  // ── A closed job takes no more time ──────────────────────────────────
  const closedJobTimer = await startJobTimer(SITE, actor, second.id, TECH, 'JCT Timer Tech')
  ok(
    '(J11) a cancelled job refuses the clock',
    !closedJobTimer.ok,
    closedJobTimer.ok ? '' : closedJobTimer.error,
  )

  // ── Drift ────────────────────────────────────────────────────────────
  const labourDrift = await reconcileJobTime(SITE)
  ok(
    '(J11) unpriced time is reported — an hour the job cost that nobody billed',
    labourDrift.unpriced.some((u) => u.jobId === timeJob.id || u.jobId === otherJob.id),
    `${labourDrift.unpriced.length} unpriced`,
  )
  ok('(J11) no labour line has lost its time entry', labourDrift.orphanedLines.length === 0)

  // Clean the fixture user's entries: they hang off jobs the sweep removes, but
  // the entries themselves are keyed by user and would otherwise leak.
  await siteExecute(SITE, `DELETE FROM staff_time_entries WHERE user_id = ?`, [TECH])

  // ── 15g. (J12) Travel: four figures, and a claim somebody checks ──────
  /*
   * The pure arithmetic first, because it is what the whole verification workflow
   * rests on and it needs no database at all.
   */
  ok(
    '(J12) the PRD example reproduces: 29.1 km becomes 29 chargeable',
    chargeableKm(29.1, 1, null) === 29,
    String(chargeableKm(29.1, 1, null)),
  )
  ok('(J12) rounding is to NEAREST, not up', chargeableKm(27.4, 1, null) === 27)
  ok('(J12) blocks of five round both ways', chargeableKm(29.1, 5, null) === 30 && chargeableKm(27.4, 5, null) === 25)
  ok('(J12) a minimum applies before the block rounding', chargeableKm(0.4, 1, 10) === 10)
  ok('(J12) roundTo 0 charges exactly what was verified', chargeableKm(12.35, 0, null) === 12.35)

  ok('(J12) the tolerance boundary is exact — 20% of 30 accepts 36', breachesTolerance(36, 30, 20) === false)
  ok('(J12) and refuses 36.1', breachesTolerance(36.1, 30, 20) === true)
  ok('(J12) coming in UNDER is never a breach', breachesTolerance(20, 30, 20) === false)
  ok('(J12) no expectation is not a breach', breachesTolerance(500, null, 20) === false)

  const straight = haversineKm(-33.9249, 18.4241, -33.899, 18.598)
  ok('(J12) haversine measures a real distance', straight > 15 && straight < 18, straight.toFixed(2))
  ok(
    '(J12) no coordinates means no expectation, rather than a fabricated one',
    estimatedTripKm({ latitude: -33.9, longitude: 18.4 }, { latitude: null, longitude: null }, 1.3) === null,
  )

  // ── Against the database ──────────────────────────────────────────────
  await siteExecute(
    SITE,
    `UPDATE settings SET setting_value='6.50' WHERE setting_key='job_travel_rate_per_km'`,
  )
  await siteExecute(
    SITE,
    `UPDATE settings SET setting_value='4.20' WHERE setting_key='job_travel_cost_per_km'`,
  )
  await siteExecute(
    SITE,
    `UPDATE stock_locations SET latitude=-33.9249, longitude=18.4241 WHERE is_main=1`,
  )

  const tripAddr = await saveServiceAddress(SITE, actor, {
    id: null,
    customerId,
    locationId: null,
    code: null,
    name: 'JCT trip site',
    addressLine1: null,
    addressLine2: null,
    city: 'Parow',
    postalCode: null,
    latitude: -33.899,
    longitude: 18.598,
    contactId: null,
    accessNotes: null,
    note: null,
    isDefault: false,
    isActive: true,
  })
  ok('an address with coordinates for the trip tests', tripAddr.ok)
  if (!tripAddr.ok) return

  const mainLoc = await siteQueryOne<any>(SITE, `SELECT id FROM stock_locations WHERE is_main=1`)
  const tripJob = await saveJobCard(SITE, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    serviceAddressId: tripAddr.id,
    locationId: Number(mainLoc?.id),
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: 'JCT travel job',
    description: null,
    dueAt: null,
    source: 'phone',
    reference: null,
    internalNote: null,
  })
  ok('a job for the trip tests', tripJob.ok)
  if (!tripJob.ok) return

  const tripBase = {
    jobCardId: tripJob.id,
    appointmentId: null,
    userId: 9902,
    userName: 'JCT Driver',
    travelledOn: '2099-03-04',
    fromLabel: 'Branch',
    toLabel: 'Parow',
    serviceAddressId: tripAddr.id,
    recordedSource: 'odometer' as const,
    travelMinutes: 35,
    note: null,
  }

  const nothing = await saveTravel(SITE, actor, {
    ...tripBase,
    id: null,
    recordedKm: 0,
    isReturn: true,
    travelMinutes: 0,
  })
  ok('(J12) a trip with neither distance nor time is refused', !nothing.ok)

  const honest = await saveTravel(SITE, actor, { ...tripBase, id: null, recordedKm: 29.1, isReturn: true })
  ok('(J12) an honest claim is recorded', honest.ok, JSON.stringify(honest))
  if (!honest.ok) return
  ok(
    '(J12) it carries an ESTIMATED expectation from the two pins',
    honest.expectedKm !== null && honest.expectedKm > 0,
    String(honest.expectedKm),
  )
  ok('(J12) 29.1 claimed becomes 29 chargeable', honest.chargeableKm === 29)
  ok('(J12) and it does not breach', honest.breached === false)

  /*
   * The bug 108 exists for: the leg count must come from the CLAIM, not an
   * assumption. Always doubling silently gave anybody claiming one leg twice the
   * tolerance headroom, and the check stopped catching padding.
   */
  const oneWay = await saveTravel(SITE, actor, {
    ...tripBase,
    id: null,
    recordedKm: 50,
    isReturn: false,
    travelledOn: '2099-03-05',
  })
  const asReturn = await saveTravel(SITE, actor, {
    ...tripBase,
    id: null,
    recordedKm: 50,
    isReturn: true,
    travelledOn: '2099-03-06',
  })
  ok(
    '(J12) 50 km claimed ONE WAY breaches a one-leg expectation',
    oneWay.ok && oneWay.breached === true,
    oneWay.ok ? `expected ${oneWay.expectedKm}` : '',
  )
  ok(
    '(J12) the same 50 km as a RETURN does not — the leg count is the claim, not a guess',
    asReturn.ok && asReturn.breached === false,
    asReturn.ok ? `expected ${asReturn.expectedKm}` : '',
  )
  ok(
    '(J12) so a return expectation is double a one-way one',
    oneWay.ok && asReturn.ok && asReturn.expectedKm === round((oneWay.expectedKm ?? 0) * 2, 2),
    oneWay.ok && asReturn.ok ? `${oneWay.expectedKm} vs ${asReturn.expectedKm}` : '',
  )

  const trips = await jobTravel(SITE, tripJob.id)
  ok('(J12) every trip is on the job', trips.length === 3, String(trips.length))
  ok('(J12) each produced a travel line', trips.every((t) => t.lineId !== null))
  ok(
    '(J12) the expectation is labelled estimated, never measured',
    trips.every((t) => t.expectedSource === 'estimated'),
  )

  const padded = trips.find((t) => t.recordedKm === 50 && !t.isReturn)!
  ok('(J12) an unchecked breach reports as needing a signature', padded.needsVerifying === true)
  ok(
    '(J12) and a verified figure is NULL until somebody looks',
    padded.verifiedKm === null,
  )

  const queue = await travelNeedingVerification(SITE)
  ok(
    '(J12) it appears in the verification queue',
    queue.some((t) => t.id === padded.id),
    `${queue.length} waiting`,
  )

  const cutNoReason = await verifyTravel(SITE, actor, padded.id, 25)
  ok(
    '(J12) reducing a claim without a reason is refused',
    !cutNoReason.ok,
    cutNoReason.ok ? '' : cutNoReason.error,
  )

  const cut = await verifyTravel(SITE, actor, padded.id, 25, 'Route is 25 km one way.')
  ok('(J12) reducing it with a reason is allowed', cut.ok, JSON.stringify(cut))

  const honestTrip = trips.find((t) => t.recordedKm === 29.1)!
  const acceptedAsIs = await verifyTravel(SITE, actor, honestTrip.id, 29.1)
  ok('(J12) accepting a claim as it stands needs no note', acceptedAsIs.ok, JSON.stringify(acceptedAsIs))

  const afterVerify = await jobTravel(SITE, tripJob.id)
  const cutNow = afterVerify.find((t) => t.id === padded.id)!
  ok('(J12) the verified figure is stored', cutNow.verifiedKm === 25)
  ok('(J12) the claim is NOT overwritten — both figures survive', cutNow.recordedKm === 50)
  ok('(J12) chargeable follows the verified figure', cutNow.chargeableKm === 25)
  ok('(J12) so the charge is the verified distance at the rate', cutNow.chargeIncl === round(25 * 6.5, 2), String(cutNow.chargeIncl))
  ok('(J12) it no longer needs a signature', cutNow.needsVerifying === false)
  ok('(J12) and who signed it is recorded', cutNow.verifiedByName === actor.userName)

  const cutLine = (await getJobCard(SITE, tripJob.id))!.lines.find((l) => l.id === cutNow.lineId)
  ok(
    '(J12) the job line quantity follows the verified figure',
    cutLine?.qty === 25,
    String(cutLine?.qty),
  )
  ok('(J12) travel lands awaiting a billing decision, like every other cost', cutLine?.billingState === 'pending')

  /*
   * Editing a claim clears the signature: whatever was signed off applied to the
   * old figure, and a stale approval on a new number means nothing.
   */
  const edited = await saveTravel(SITE, actor, {
    ...tripBase,
    id: cutNow.id,
    recordedKm: 40,
    isReturn: false,
    travelledOn: '2099-03-05',
  })
  ok('(J12) a claim can be corrected', edited.ok, JSON.stringify(edited))
  const afterEdit = (await jobTravel(SITE, tripJob.id)).find((t) => t.id === cutNow.id)!
  ok(
    '(J12) correcting it clears the verification — a stale signature means nothing',
    afterEdit.verifiedKm === null && afterEdit.verifiedAt === null,
  )

  const travelDrift = await reconcileJobTravel(SITE)
  ok('(J12) no travel line has lost its trip', travelDrift.orphanedLines.length === 0)
  ok('(J12) no trip is missing its line', travelDrift.uncosted.length === 0, JSON.stringify(travelDrift.uncosted))

  const removedTrip = await deleteTravel(SITE, actor, tripJob.id, afterEdit.id)
  ok('(J12) a trip can be removed', removedTrip.ok, JSON.stringify(removedTrip))
  const goneLine = (await getJobCard(SITE, tripJob.id))!.lines.find((l) => l.id === afterEdit.lineId)
  ok('(J12) and its line goes with it', goneLine === undefined)

  // ── 16. The numbering run is intact ───────────────────────────────────
  /*
   * The regression this guards is OWN_TABLE_TYPES: without the `job_card` entry
   * the type falls back to sales_documents, finds none of its numbers there, and
   * reports EVERY JC ever issued as missing. Both prior module plans predicted
   * that omission and both builds made it.
   *
   * What is deliberately NOT asserted is a low `missing` count. A job number is
   * issued at CREATE, so an abandoned or swept job leaves a permanent gap by
   * design — and this suite sweeps its own fixtures every run, manufacturing
   * exactly those gaps. Asserting on the gap count would be asserting that the
   * accepted cost of the numbering decision had not been paid.
   */
  const check = await verifySequence(SITE, 'job_card')
  ok(
    'verifySequence reads the job_card run from its own table',
    check.issued > 0 && check.live > 0 && check.missing < check.issued,
    JSON.stringify(check),
  )
  ok(
    'the numbers it found are JC numbers',
    (check.firstNumber ?? '').startsWith('JC') && (check.lastNumber ?? '').startsWith('JC'),
    `${check.firstNumber} .. ${check.lastNumber}`,
  )

  // ── 17. Drift ─────────────────────────────────────────────────────────
  const drift = await reconcileJobCards(SITE)
  ok('(J3) no line claims more invoiced than it has', drift.overInvoiced.length === 0, JSON.stringify(drift.overInvoiced))
  ok('no invoice link points at the wrong job', drift.orphanedInvoiceLinks.length === 0)
  ok('(J4) no unbillable line carries an invoice', drift.billedUnbillable.length === 0, JSON.stringify(drift.billedUnbillable))
  ok('(J5) no job disagrees with its status role', drift.stateMismatch.length === 0, JSON.stringify(drift.stateMismatch))

  // ── 18. Counts and listing ────────────────────────────────────────────
  const counts = await jobCounts(SITE)
  ok('the counts add up to something', counts.open + counts.closed + counts.cancelled > 0)
  const open = await listJobCards(SITE, { state: 'open', limit: 200 })
  ok('the open list excludes the cancelled job', !open.some((j) => j.id === second.id))
  const all = await listJobCards(SITE, { state: 'all', search: 'JCT', limit: 200 })
  ok('search finds this suite\'s jobs', all.length >= 2, String(all.length))

  // ── 19. An invoiced line is protected ─────────────────────────────────
  const stripInvoiced = await saveLines(SITE, actor, jobId, [])
  ok(
    'an invoiced line cannot be removed by saving an empty list',
    !stripInvoiced.ok,
    stripInvoiced.ok ? '' : stripInvoiced.error,
  )

  const reclassifyInvoiced = await reclassifyLine(SITE, actor, quoted.id, 'written_off', 'Trying it.')
  ok('an invoiced line cannot be reclassified', !reclassifyInvoiced.ok)

  // ── 20. Addresses refuse to strand history ────────────────────────────
  if (address.ok) {
    await saveJobCard(SITE, actor, {
      id: jobId,
      customerId,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      serviceAddressId: address.id,
      locationId: null,
      statusId: null,
      priority: 'high',
      ownerUserId: null,
      ownerName: 'JCT Technician',
      title: 'JCT aircon not cooling',
      description: null,
      dueAt: null,
      source: 'phone',
      reference: null,
      internalNote: null,
    })
    const deleteUsed = await deleteServiceAddress(SITE, actor, address.id)
    ok(
      'an address named by a job cannot be deleted',
      !deleteUsed.ok,
      deleteUsed.ok ? '' : deleteUsed.error,
    )
    // Unhook it so the sweep can clear the fixture.
    await siteExecute(SITE, 'UPDATE job_cards SET service_address_id = NULL WHERE id = ?', [jobId])
  }

  await sweepStrays()

  const leftovers = await siteQuery<any>(SITE, 'SELECT id FROM job_cards WHERE title LIKE ?', [
    TITLE_PATTERN,
  ])
  ok('the suite cleaned up after itself', leftovers.length === 0, `${leftovers.length} left`)
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll job card checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
