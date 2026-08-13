'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, actorForOrThrow } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { searchCustomersForTill, type TillCustomer } from '@/lib/site/tillCustomers'
import { listServiceAddresses, type ServiceAddress } from '@/lib/site/serviceAddresses'
import {
  saveJobCard,
  setStatus,
  assignOwner,
  saveLines,
  reclassifyLine,
  closeJob,
  cancelJob,
  reopenJob,
  bulkUpdateJobs,
  type JobCardInput,
  type JobLineInput,
  type JobSaveResult,
  type JobActionResult,
  type JobBulkChange,
  type JobBulkResult,
} from '@/lib/site/jobCards'
import {
  saveJobView,
  deleteJobView,
  type ViewFilters,
  type ViewResult,
  type ViewActionResult,
} from '@/lib/site/jobViews'
import { invoiceJob, type InvoiceLineInput, type InvoiceJobResult } from '@/lib/site/jobInvoicing'
import {
  markResponded,
  savePolicy,
  type PolicyInput,
  type SlaActionResult,
} from '@/lib/site/jobSla'
import {
  saveHeadline,
  deleteHeadline,
  applyHeadlines,
  recordItem,
  captureEvidence,
  addJobItem,
  deleteJobItem,
  type HeadlineInput,
  type HeadlineResult,
  type ItemResult,
  type ApplyResult,
} from '@/lib/site/jobHeadlines'
import {
  saveAsset,
  retireAsset,
  reviveAsset,
  deleteAsset,
  saveAssetType,
  deleteAssetType,
  setJobAsset,
  listAssets,
  type AssetInput,
  type AssetTypeInput,
  type AssetResult,
  type AssetActionResult,
  type SaveAssetResult,
} from '@/lib/site/jobAssets'
import {
  saveJobSeries,
  deleteJobSeries,
  generateDueJobs,
  seriesRuns,
  type SeriesInput,
  type SeriesResult,
  type SeriesActionResult,
  type SeriesRun,
} from '@/lib/site/jobSeries'
import { setSetting } from '@/lib/site/settings'
import { storeUpload, deleteStoredFile } from '@/lib/uploads'
import {
  setJobPerson,
  removeJobPerson,
  toggleFollow,
  type JobRole,
  type PeopleResult,
} from '@/lib/site/jobPeople'
import {
  formatClock,
  isDayMask,
  parseClock,
  type ItemKind,
  type ResponseType,
  type WorkPhase,
} from '@/lib/jobStatusModel'
import {
  saveJobBoard,
  deleteJobBoard,
  type JobBoardLayout,
  type BoardSaveResult,
  type BoardActionResult,
} from '@/lib/site/jobBoards'
import {
  saveJobStatus,
  deleteJobStatus,
  reorderJobStatuses,
  type JobStatusInput,
  type StatusSaveResult,
} from '@/lib/site/jobStatuses'
import {
  quoteJob,
  acceptQuote,
  declineJobQuote,
  type AcceptMethod,
  type QuoteJobResult,
  type AcceptResult,
} from '@/lib/site/jobQuotes'
import {
  saveAppointment,
  setAppointmentStatus,
  deleteAppointment,
  type AppointmentInput,
  type AppointmentSaveResult,
  type AppointmentActionResult,
  type AppointmentStatus,
} from '@/lib/site/jobAppointments'
import { listUsers } from '@/lib/site/users'
import {
  startJobTimer,
  stopJobTimer,
  addJobTime,
  deleteJobTime,
  type TimerResult,
  type StopResult,
} from '@/lib/site/jobTime'
import {
  saveTravel,
  verifyTravel,
  deleteTravel,
  type TravelInput,
  type TravelSaveResult,
  type TravelActionResult,
} from '@/lib/site/jobTravel'
import {
  issueParts,
  returnParts,
  type IssueLineInput,
  type IssueResult,
} from '@/lib/site/jobParts'
import { listVans } from '@/lib/site/stockLocations'
import type { BillingState } from '@/lib/jobStatusModel'

/**
 * The job card's server actions.
 *
 * Thin by design: every one of these is a guard, a call into src/lib/site, and a
 * revalidate. Validation, SQL and the audit trail live in the data layer so the
 * test suite can prove them without a request, and so a second caller — the
 * board, a later mobile view — cannot get a different answer.
 *
 * ── WHY THE CAPABILITIES DIFFER PER ACTION ─────────────────────────────────
 *
 * The PRD is explicit that completing work, closing a job and invoicing it are
 * three distinct events that may need three different people: a technician
 * finishes, a supervisor signs off, the office bills. So they are three
 * capabilities, not one. `jobs.bill_decide` is separate again, because a
 * technician must be able to record what they used without ever choosing what
 * the customer is charged for it.
 */

function revalidateJobs(id?: number) {
  revalidatePath('/jobs')
  if (id) revalidateJobPath(id)
}

function revalidateJobPath(id: number) {
  revalidatePath(`/jobs/${id}`)
}

/**
 * Customer type-ahead for the job form.
 *
 * The till already has searchCustomersForTill and this reuses it — but NOT
 * sales/actions.ts' wrapper, which is gated on `sales.till`. Somebody logging a
 * job in a workshop office may well have no till permission at all, and reusing
 * that action would refuse them a customer picker on their own screen.
 *
 * actorForOrThrow because the return type has no room for a refusal: a
 * type-ahead returns a list, and an empty list would read as "no such customer"
 * rather than "you may not look".
 */
export async function searchJobCustomersAction(term: string): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('jobs.edit')
  return searchCustomersForTill(ctx.siteId, term)
}

/** The service addresses on file for a customer, for the job form's picker. */
export async function customerAddressesAction(customerId: number): Promise<ServiceAddress[]> {
  const ctx = await actorForOrThrow('jobs.edit')
  return listServiceAddresses(ctx.siteId, customerId)
}

export async function saveJobAction(input: JobCardInput): Promise<JobSaveResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveJobCard(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateJobs(result.id)
  return result
}

export async function setStatusAction(
  jobId: number,
  statusId: number,
  reason?: string,
): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  // jobs.invoice is the office test: the stages marked office-only are the
  // billing ones, and somebody who may raise the invoice may say a job is ready
  // for it.
  const result = await setStatus(
    ctx.siteId,
    ctx.actor,
    jobId,
    statusId,
    reason,
    can(ctx.capabilities, 'jobs.invoice'),
  )
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function assignOwnerAction(
  jobId: number,
  ownerUserId: number | null,
  ownerName: string,
): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await assignOwner(ctx.siteId, ctx.actor, jobId, ownerUserId, ownerName)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function saveLinesAction(
  jobId: number,
  lines: JobLineInput[],
): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveLines(ctx.siteId, ctx.actor, jobId, lines)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Decide who pays for a line.
 *
 * `jobs.bill_decide`, not `jobs.edit`. Turning a recorded cost into money
 * somebody does or does not pay is the commercial decision on a job card, and
 * the whole point of splitting it out is that the person who recorded the cost
 * need not be the person who makes it.
 */
export async function reclassifyLineAction(
  jobId: number,
  lineId: number,
  to: BillingState,
  reason: string | null,
): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.bill_decide')
  if ('ok' in ctx) return ctx

  const result = await reclassifyLine(ctx.siteId, ctx.actor, lineId, to, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function closeJobAction(jobId: number, reason?: string): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.close')
  if ('ok' in ctx) return ctx

  const result = await closeJob(ctx.siteId, ctx.actor, jobId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function cancelJobAction(jobId: number, reason: string): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.close')
  if ('ok' in ctx) return ctx

  const result = await cancelJob(ctx.siteId, ctx.actor, jobId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function reopenJobAction(jobId: number, reason: string): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.close')
  if ('ok' in ctx) return ctx

  const result = await reopenJob(ctx.siteId, ctx.actor, jobId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Bill the job.
 *
 * Raises a DRAFT invoice and revalidates the invoicing list too, because that is
 * where the draft now appears and where a person finalises it through the one
 * posting engine. Nothing here posts anything.
 */
export async function invoiceJobAction(
  jobId: number,
  selections: InvoiceLineInput[],
): Promise<InvoiceJobResult> {
  const ctx = await actorFor('jobs.invoice')
  if ('ok' in ctx) return ctx

  const result = await invoiceJob(ctx.siteId, ctx.actor, jobId, selections)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/sales/invoicing')
  return result
}

/**
 * Moving a card between columns on the board.
 *
 * Deliberately the SAME action the status dropdown calls, not a lighter one.
 * Dragging a card must trigger exactly the same validation, workflow and audit
 * rules as changing the field inside the job card — the PRD says so explicitly,
 * and it is what stops the board becoming a way around the refusal that a job
 * with undecided costs cannot be closed.
 *
 * So this is setStatusAction with a different revalidate, and nothing else.
 */
export async function moveCardAction(
  jobId: number,
  statusId: number,
  boardSlug: string,
): Promise<JobActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  /*
   * The drag gets the SAME rules as the dropdown — 37.2 says so explicitly, and
   * it is the whole reason moveCard goes through setStatus rather than writing
   * the column itself.
   *
   * A stage that needs a reason therefore cannot be reached by dragging, because
   * a drag carries no sentence. That refusal is correct rather than a gap: the
   * card bounces back with the reason named, and the user moves it from the job
   * where they can type one.
   */
  const result = await setStatus(
    ctx.siteId,
    ctx.actor,
    jobId,
    statusId,
    undefined,
    can(ctx.capabilities, 'jobs.invoice'),
  )
  if (!result.ok) return result
  revalidatePath(`/jobs/board/${boardSlug}`)
  revalidateJobs(jobId)
  return result
}

export async function saveBoardAction(input: {
  id: number | null
  name: string
  layout: JobBoardLayout
  isActive: boolean
  statusIds: number[]
}): Promise<BoardSaveResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveJobBoard(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/jobs/board')
  revalidatePath('/setup/job-workflow')
  return result
}

export async function deleteBoardAction(id: number): Promise<BoardActionResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteJobBoard(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/jobs/board')
  revalidatePath('/setup/job-workflow')
  return result
}

export async function saveStatusAction(input: JobStatusInput): Promise<StatusSaveResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveJobStatus(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

export async function deleteStatusAction(id: number): Promise<StatusSaveResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteJobStatus(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

/**
 * Raise a quote from the job's chargeable lines.
 *
 * `jobs.invoice` and not `jobs.edit`: a quote is a commercial offer that goes to
 * a customer, and the person recording what was used is not necessarily the
 * person allowed to put a price in front of them.
 */
export async function quoteJobAction(
  jobId: number,
  options: { validUntil?: string | null; notes?: string | null } = {},
): Promise<QuoteJobResult> {
  const ctx = await actorFor('jobs.invoice')
  if ('ok' in ctx) return ctx

  const result = await quoteJob(ctx.siteId, ctx.actor, jobId, options)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/sales/quotes')
  return result
}

/**
 * Record that the customer said yes.
 *
 * The same capability as quoting, because accepting on a customer's behalf is a
 * commercial act of the same weight — the PRD allows it explicitly, provided the
 * audit trail shows a member of staff vouched for it, which acceptQuote records.
 */
export async function acceptQuoteAction(
  jobId: number,
  quoteId: number,
  input: { method: AcceptMethod; acceptedBy: string; reference?: string | null },
): Promise<AcceptResult> {
  const ctx = await actorFor('jobs.invoice')
  if ('ok' in ctx) return ctx

  const result = await acceptQuote(ctx.siteId, ctx.actor, quoteId, input)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/sales/quotes')
  return result
}

export async function declineQuoteAction(
  jobId: number,
  quoteId: number,
  reason: string,
): Promise<AcceptResult> {
  const ctx = await actorFor('jobs.invoice')
  if ('ok' in ctx) return ctx

  const result = await declineJobQuote(ctx.siteId, ctx.actor, quoteId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/sales/quotes')
  return result
}

/**
 * Book or move a visit.
 *
 * `jobs.assign`, not `jobs.edit`: deciding who goes where and when is dispatch,
 * and the person recording what was used on a job is not necessarily the person
 * who allocates the day.
 *
 * Conflicts come back in the result rather than as a thrown error, so the dialog
 * can show them and offer the override — which is the PRD's own answer: an
 * authorised user may book over a clash provided the reason is captured.
 */
export async function saveAppointmentAction(
  input: AppointmentInput,
): Promise<AppointmentSaveResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await saveAppointment(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateJobs(input.jobCardId)
  revalidatePath('/jobs/schedule')
  return result
}

/**
 * Move a visit through its lifecycle.
 *
 * `jobs.edit` and not `jobs.assign`, deliberately: pressing On site is what a
 * technician does, and gating it behind dispatch permission would mean the one
 * person actually standing on the driveway cannot record that they arrived.
 */
export async function setVisitStatusAction(
  jobId: number,
  appointmentId: number,
  status: AppointmentStatus,
  reason?: string,
): Promise<AppointmentActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await setAppointmentStatus(ctx.siteId, ctx.actor, appointmentId, status, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/jobs/schedule')
  return result
}

export async function deleteAppointmentAction(
  jobId: number,
  appointmentId: number,
): Promise<AppointmentActionResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await deleteAppointment(ctx.siteId, ctx.actor, appointmentId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/jobs/schedule')
  return result
}

/**
 * The people a visit can be assigned to.
 *
 * Every active user, not a separate technician list. There is no `is_technician`
 * flag in this schema and inventing one would be a second place to keep a person
 * up to date — an office manager who occasionally attends a site is an ordinary
 * case, and a business that wants to narrow it has roles for that.
 */
export async function schedulableUsersAction(): Promise<{ id: number; name: string }[]> {
  const ctx = await actorForOrThrow('jobs.assign')
  const users = await listUsers(ctx.siteId)
  return users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))
}

/**
 * Start the clock on a job.
 *
 * `jobs.edit`, not `jobs.assign`: pressing start is what the technician standing
 * on the driveway does, and gating it behind dispatch permission would mean the
 * one person actually working cannot record that they are.
 *
 * The user is taken from the SESSION, never from the caller. A timer identifies
 * who worked, and letting a request name somebody else would put an hour on their
 * timesheet — and eventually in their pay.
 */
export async function startTimerAction(jobId: number): Promise<TimerResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await startJobTimer(
    ctx.siteId,
    ctx.actor,
    jobId,
    ctx.actor.userId,
    ctx.actor.userName,
  )
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function stopTimerAction(jobId: number, note?: string): Promise<StopResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await stopJobTimer(ctx.siteId, ctx.actor, jobId, ctx.actor.userId, note)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Book time somebody forgot to clock.
 *
 * `jobs.assign` rather than `jobs.edit`, and this one IS named: entering hours for
 * another person is a supervisor act, and it is the path a dispute would follow.
 * The activity log records who booked it as well as who it was for.
 */
export async function addTimeAction(
  jobId: number,
  input: { userId: number; userName: string; startedAt: string; minutes: number; note?: string | null },
): Promise<StopResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await addJobTime(ctx.siteId, ctx.actor, jobId, input)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function deleteTimeAction(
  jobId: number,
  entryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await deleteJobTime(ctx.siteId, ctx.actor, jobId, entryId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Record a trip.
 *
 * `jobs.edit`: recording what you drove is part of doing the work, and gating it
 * behind dispatch permission would mean the driver cannot say where they went.
 * Whether the claim is accepted is a separate act with its own capability below.
 */
export async function saveTravelAction(input: TravelInput): Promise<TravelSaveResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveTravel(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateJobs(input.jobCardId)
  return result
}

/**
 * Accept, or correct, what somebody claimed.
 *
 * `jobs.bill_decide`, not `jobs.edit` — and deliberately not `jobs.assign` either.
 * Verifying a distance decides what a customer is charged and what a technician is
 * credited with driving, which is the same weight of decision as classifying a cost.
 * The person who drove must not be the person who signs it off.
 */
export async function verifyTravelAction(
  jobId: number,
  travelId: number,
  verifiedKm: number,
  note?: string | null,
): Promise<TravelActionResult> {
  const ctx = await actorFor('jobs.bill_decide')
  if ('ok' in ctx) return ctx

  const result = await verifyTravel(ctx.siteId, ctx.actor, travelId, verifiedKm, note)
  if (!result.ok) return result
  revalidateJobs(jobId)
  // The approval worklist is the other place this trip is listed, and verifying is
  // exactly what takes it off there.
  revalidatePath('/jobs/sla')
  return result
}

export async function deleteTravelAction(
  jobId: number,
  travelId: number,
): Promise<TravelActionResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await deleteTravel(ctx.siteId, ctx.actor, jobId, travelId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Put parts on a van, or bring them back.
 *
 * `stock.transfer`, not a jobs capability — and that is the point. Issuing moves
 * real goods between piles, so it needs the permission that moving stock needs;
 * somebody who may edit a job card is not thereby allowed to load a bakkie.
 *
 * The work is done by issueParts(), which posts an ordinary stock transfer through
 * the existing engine. Nothing here writes a movement.
 */
export async function issuePartsAction(
  jobId: number,
  vanLocationId: number,
  lines: IssueLineInput[],
): Promise<IssueResult> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx

  const result = await issueParts(ctx.siteId, ctx.actor, jobId, vanLocationId, lines)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/transfers')
  return result
}

export async function returnPartsAction(
  jobId: number,
  vanLocationId: number,
  lines: IssueLineInput[],
): Promise<IssueResult> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx

  const result = await returnParts(ctx.siteId, ctx.actor, jobId, vanLocationId, lines)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/transfers')
  return result
}

/** The vans a part can be issued to. */
export async function vansAction(): Promise<{ id: number; code: string; name: string }[]> {
  const ctx = await actorForOrThrow('jobs.view')
  const vans = await listVans(ctx.siteId)
  return vans.map((v) => ({ id: v.id, code: v.code, name: v.name }))
}

/* ── Recurring work ───────────────────────────────────────────────────────── */

function revalidateSeries() {
  revalidatePath('/jobs/recurring')
  revalidatePath('/jobs')
}

/**
 * Setting up a schedule is `jobs.edit` — the same right that logs a job by hand.
 *
 * Deleting one is `jobs.setup`, though. Not because it destroys work — it does
 * not, the jobs survive with their link cleared — but because switching a
 * customer's maintenance schedule off is a commercial decision rather than a
 * day's dispatching.
 */
export async function saveSeriesAction(input: SeriesInput): Promise<SeriesResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveJobSeries(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateSeries()
  return result
}

export async function deleteSeriesAction(id: number): Promise<SeriesActionResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteJobSeries(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidateSeries()
  return result
}

/**
 * Raise whatever this schedule owes, now.
 *
 * The same generator the cron calls, against the same claim table — so it cannot
 * double-raise, and what it produces is exactly what the nightly run would have.
 * It overrides the auto switch because somebody pressing a button IS the decision
 * that switch guards.
 */
export async function raiseSeriesNowAction(
  seriesId: number,
): Promise<
  | { ok: true; created: { jobId: number; documentNumber: string | null; forDate: string }[]; skipped: { reason: string }[] }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await generateDueJobs(ctx.siteId, ctx.actor, undefined, seriesId)
  revalidateSeries()
  return {
    ok: true,
    created: result.created.map((c) => ({
      jobId: c.jobId,
      documentNumber: c.documentNumber,
      forDate: c.forDate,
    })),
    skipped: result.skipped.map((s) => ({ reason: s.reason })),
  }
}

/** What a schedule has raised. Fetched on demand — see RecurringClient. */
export async function seriesRunsAction(seriesId: number): Promise<SeriesRun[]> {
  const ctx = await actorForOrThrow('jobs.view')
  return seriesRuns(ctx.siteId, seriesId)
}

/* ── Customer equipment ───────────────────────────────────────────────────── */

function revalidateAssets(assetId?: number) {
  revalidatePath('/jobs/equipment')
  if (assetId) revalidatePath(`/jobs/equipment/${assetId}`)
}

/**
 * Recording equipment is `jobs.edit` — the same right that logs a job.
 *
 * Not `jobs.setup`: a technician who finds an undocumented unit on site should be
 * able to record it there and then, and making that an administrator's job means
 * it gets written on the back of a hand instead. The KINDS of equipment are setup,
 * because those are a business decision.
 */
export async function saveAssetAction(input: AssetInput): Promise<SaveAssetResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveAsset(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateAssets(result.id)
  return result
}

export async function retireAssetAction(
  id: number,
  reason: string,
): Promise<AssetActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await retireAsset(ctx.siteId, ctx.actor, id, reason)
  if (!result.ok) return result
  revalidateAssets(id)
  return result
}

export async function reviveAssetAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await reviveAsset(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidateAssets(id)
  return result
}

export async function deleteAssetAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteAsset(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidateAssets()
  return result
}

/** Kinds of equipment are a business decision, so this one is setup. */
export async function saveAssetTypeAction(input: AssetTypeInput): Promise<AssetResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveAssetType(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidateAssets()
  return result
}

export async function deleteAssetTypeAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteAssetType(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  return result
}

/**
 * Which piece of equipment a job is about.
 *
 * Its own action rather than a field on saveJobCard, because the job form does not
 * carry it: an asset is chosen on the job card once the customer is known, and
 * threading it through the create form would mean picking equipment before
 * choosing whose it is.
 */
export async function setJobAssetAction(
  jobId: number,
  assetId: number | null,
): Promise<AssetActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await setJobAsset(ctx.siteId, ctx.actor, jobId, assetId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  if (assetId) revalidateAssets(assetId)
  return result
}

/**
 * The equipment a job may name: this customer's, plus anything unclaimed.
 *
 * Unclaimed units are included because naming one on a job is often HOW it gets
 * claimed — a technician records a unit found in the workshop, then attaches it to
 * the job that brought it in. `setJobAsset` allows exactly that combination.
 *
 * Two queries rather than one, because listAssets filters to a single customer by
 * design and widening it to "or unclaimed" would put a job-specific rule inside a
 * general list function that four other callers use.
 */
export async function customerAssetsAction(customerId: number | null): Promise<
  { id: number; label: string }[]
> {
  const ctx = await actorForOrThrow('jobs.view')

  const [theirs, unclaimed] = await Promise.all([
    customerId === null
      ? Promise.resolve([])
      : listAssets(ctx.siteId, { customerId, limit: 200 }),
    listAssets(ctx.siteId, { unclaimedOnly: true, limit: 100 }),
  ])

  return [...theirs, ...unclaimed].map((a) => ({
    id: a.id,
    label:
      [a.description, a.serialText, a.serviceAddressName].filter(Boolean).join(' · ') +
      (a.customerId === null ? ' — unclaimed' : ''),
  }))
}

/* ── Headlines, tasks and checks ──────────────────────────────────────────── */

/**
 * Configuring what kinds of work exist is setup; recording a check is the work.
 *
 * So these two are `jobs.setup` and everything below is `jobs.edit`. A technician
 * must be able to tick off a task without being able to rewrite the template every
 * other technician follows.
 */
export async function saveHeadlineAction(input: HeadlineInput): Promise<HeadlineResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveHeadline(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

export async function deleteHeadlineAction(id: number): Promise<ItemResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteHeadline(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  return result
}

/** Which kinds of work a job is, which copies their tasks and checks onto it. */
export async function applyHeadlinesAction(
  jobId: number,
  headlineIds: number[],
): Promise<ApplyResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await applyHeadlines(ctx.siteId, ctx.actor, jobId, headlineIds)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function recordItemAction(
  jobId: number,
  itemId: number,
  input: { response: string | null; note: string | null; complete: boolean },
): Promise<ItemResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await recordItem(ctx.siteId, ctx.actor, itemId, input)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function addJobItemAction(
  jobId: number,
  input: {
    kind: ItemKind
    name: string
    responseType: ResponseType
    unit: string | null
    workPhase: WorkPhase
    isRequired: boolean
  },
): Promise<ItemResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await addJobItem(ctx.siteId, ctx.actor, jobId, input)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Attach a captured photo or signature to a check.
 *
 * Takes FormData because a File cannot cross a server-action boundary any other
 * way. The two cleanup paths are the point: storeUpload has already written
 * bytes to disk by the time captureEvidence runs, and its contract says the
 * caller unlinks them if the insert does not land. Both a returned refusal and a
 * thrown error leave the same orphan, so both are handled — the pattern
 * attachmentActions.ts established.
 */
export async function captureEvidenceAction(
  jobId: number,
  itemId: number,
  form: FormData,
): Promise<ItemResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const file = form.get('file')
  if (!(file instanceof File)) return { ok: false, error: 'No file was received.' }

  const caption = form.get('caption')
  const stored = await storeUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  try {
    const result = await captureEvidence(
      ctx.siteId,
      ctx.actor,
      itemId,
      stored.file,
      typeof caption === 'string' && caption.trim() ? caption.trim() : null,
    )
    if (!result.ok) {
      await deleteStoredFile(stored.file.storedName)
      return result
    }
  } catch (error) {
    await deleteStoredFile(stored.file.storedName)
    throw error
  }

  revalidateJobs(jobId)
  return { ok: true }
}

/* ── Bulk actions and saved views (37.2) ──────────────────────────────────── */

/**
 * One change, many jobs.
 *
 * Guarded on the capability the SINGLE version of each change needs, not on a
 * blanket one: changing a status in bulk requires exactly what changing it one
 * at a time requires. A single `jobs.bulk` capability would let somebody who may
 * not reassign work do it fifty times at once.
 */
export async function bulkUpdateJobsAction(
  ids: number[],
  change: JobBulkChange,
): Promise<JobBulkResult | { ok: false; error: string }> {
  const needed = change.kind === 'owner' ? 'jobs.assign' : 'jobs.edit'
  const ctx = await actorFor(needed)
  if ('ok' in ctx) return ctx

  const result = await bulkUpdateJobs(
    ctx.siteId,
    ctx.actor,
    ids,
    change,
    can(ctx.capabilities, 'jobs.invoice'),
  )
  revalidatePath('/jobs')
  revalidatePath('/jobs/board')
  ids.forEach((id) => revalidateJobs(id))
  return result
}

export async function saveJobViewAction(input: {
  id: number | null
  name: string
  filters: ViewFilters
  isShared: boolean
  isPinned: boolean
}): Promise<ViewResult> {
  // jobs.view, not jobs.setup: naming a filter set over work you can already see
  // is not a configuration act, and requiring setup would mean only an
  // administrator could keep a shortlist.
  const ctx = await actorFor('jobs.view')
  if ('ok' in ctx) return ctx

  const result = await saveJobView(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/jobs')
  return result
}

export async function deleteJobViewAction(id: number): Promise<ViewActionResult> {
  const ctx = await actorFor('jobs.view')
  if ('ok' in ctx) return ctx

  const result = await deleteJobView(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/jobs')
  return result
}

/* ── Who is on a job ───────────────────────────────────────────────────────── */

/**
 * Put somebody on a job, or change what they are.
 *
 * jobs.assign, not jobs.edit: deciding who does the work is a different
 * authority from doing it. Matches how assignOwnerAction is guarded.
 */
export async function setJobPersonAction(
  jobId: number,
  userId: number,
  role: JobRole,
): Promise<PeopleResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await setJobPerson(ctx.siteId, ctx.actor, jobId, userId, role)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function removeJobPersonAction(
  jobId: number,
  userId: number,
): Promise<PeopleResult> {
  const ctx = await actorFor('jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await removeJobPerson(ctx.siteId, ctx.actor, jobId, userId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Follow or unfollow a job yourself.
 *
 * Guarded on jobs.view, NOT jobs.assign. Choosing to watch something you can
 * already see needs no authority over it — requiring jobs.assign would mean only
 * the people who hand out work could subscribe to it, which is backwards.
 */
export async function toggleFollowAction(
  jobId: number,
): Promise<PeopleResult & { following?: boolean }> {
  const ctx = await actorFor('jobs.view')
  if ('ok' in ctx) return ctx

  const result = await toggleFollow(ctx.siteId, ctx.actor, jobId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function deleteJobItemAction(jobId: number, itemId: number): Promise<ItemResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteJobItem(ctx.siteId, ctx.actor, itemId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/* ── SLA ──────────────────────────────────────────────────────────────────── */

/**
 * Somebody has picked this job up.
 *
 * On `jobs.edit`, not `jobs.setup`: responding is the ordinary work of a
 * dispatcher, and requiring the setup capability would mean only an owner could
 * stop the response clock.
 */
export async function markRespondedAction(jobId: number): Promise<SlaActionResult> {
  const ctx = await actorFor('jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await markResponded(ctx.siteId, ctx.actor, jobId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/jobs/sla')
  return result
}

export async function savePolicyAction(
  id: number,
  input: PolicyInput,
): Promise<SlaActionResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await savePolicy(ctx.siteId, ctx.actor, id, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs/sla')
  return result
}

/**
 * The trading week the SLA clock runs on.
 *
 * Validated here rather than trusting the form, because these four values decide
 * every deadline in the system: a mask of zeroes or a closing time before opening
 * would make `addBusinessMinutes` unable to find any working minute, and every
 * new job would silently get no target at all.
 */
export async function saveTradingHoursAction(input: {
  days: string
  opensAt: string
  closesAt: string
  skipHolidays: boolean
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  if (!isDayMask(input.days)) {
    return { ok: false, error: 'Choose which days of the week the business is open.' }
  }
  if (!input.days.includes('1')) {
    return {
      ok: false,
      error: 'Pick at least one open day, or no job could ever have a response target.',
    }
  }

  const opens = parseClock(input.opensAt)
  const closes = parseClock(input.closesAt)
  if (opens === null) return { ok: false, error: 'That opening time is not a real time.' }
  if (closes === null) return { ok: false, error: 'That closing time is not a real time.' }
  if (closes <= opens) {
    return {
      ok: false,
      error: 'The closing time has to be after the opening one — an SLA clock needs hours to run in.',
    }
  }

  // All four or none: a half-saved week would compute deadlines nobody chose.
  for (const [key, value] of [
    ['job_sla_trading_days', input.days],
    ['job_sla_opens_at', formatClock(opens)],
    ['job_sla_closes_at', formatClock(closes)],
    ['job_sla_skip_holidays', input.skipHolidays ? '1' : '0'],
  ] as const) {
    const saved = await setSetting(ctx.siteId, key, value)
    if (!saved.ok) return saved
  }

  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs/sla')
  revalidatePath('/jobs')
  return { ok: true, message: 'Trading hours saved. New jobs will use them from now on.' }
}

/**
 * The eleven settings that decide how a job behaves.
 *
 * Accumulated across phases 11 to 15 with no screen at all, so every one of them
 * has been whatever the migration seeded. They save together because they read
 * together: a person setting up notifications wants to say what goes out AND
 * when in one act, and a half-saved group would leave the screen disagreeing
 * with itself.
 *
 * Validated here rather than trusted from the client for the usual reason — the
 * action is the boundary, and a number field is a text input to anybody with
 * curl.
 */
export async function saveJobSettingsAction(input: {
  itemsBlockClose: boolean
  headlineRequired: boolean
  signatureStatement: string
  notifyEnabled: boolean
  notifyAssignee: boolean
  notifyEvents: string[]
  autoEscalate: boolean
  autoVisitReminder: boolean
  autoVisitHours: number
  autoInvoice: boolean
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const statement = input.signatureStatement.trim()
  if (!statement) {
    return {
      ok: false,
      error: 'A signature needs wording above it — a mark with nothing stating what it means is not worth capturing.',
    }
  }
  if (statement.length > 400) {
    return { ok: false, error: 'That wording is too long for the pad. Keep it under 400 characters.' }
  }

  // The set is closed on purpose: a typo would create a fourth "moment" that
  // silently never fires, and nothing would say why.
  const allowed = new Set(['assigned', 'status', 'closed'])
  const events = input.notifyEvents.filter((e) => allowed.has(e))
  if (input.notifyEnabled && events.length === 0) {
    return {
      ok: false,
      error: 'Emails are on but nothing would send one. Pick at least one moment, or switch emails off.',
    }
  }

  const hours = Math.round(input.autoVisitHours)
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    return { ok: false, error: 'Remind between 1 and 168 hours before a visit.' }
  }

  // All eleven or none, on the trading-hours precedent: a half-saved group would
  // behave in a way nobody chose.
  for (const [key, value] of [
    ['job_items_block_close', input.itemsBlockClose ? '1' : '0'],
    ['job_headline_required', input.headlineRequired ? '1' : '0'],
    ['job_signature_statement', statement],
    ['job_notify_enabled', input.notifyEnabled ? '1' : '0'],
    ['job_notify_assignee', input.notifyAssignee ? '1' : '0'],
    ['job_notify_events', events.join(',')],
    ['job_auto_escalate', input.autoEscalate ? '1' : '0'],
    ['job_auto_visit_reminder', input.autoVisitReminder ? '1' : '0'],
    ['job_auto_visit_hours', String(hours)],
    ['job_auto_invoice', input.autoInvoice ? '1' : '0'],
  ] as const) {
    const saved = await setSetting(ctx.siteId, key, value)
    if (!saved.ok) return saved
  }

  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return { ok: true, message: 'Saved.' }
}

export async function reorderStatusesAction(ids: number[]): Promise<StatusSaveResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await reorderJobStatuses(ctx.siteId, ctx.actor, ids)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}
