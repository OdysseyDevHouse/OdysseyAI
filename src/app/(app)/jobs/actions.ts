'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule, actorForModuleOrThrow } from '@/lib/auth'
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
import { takeDeposit, type DepositResult } from '@/lib/site/jobDeposits'
import {
  saveJobTeam,
  deleteJobTeam,
  applyTeamToJob,
  type TeamResult,
  type TeamActionResult,
  type ApplyTeamResult,
} from '@/lib/site/jobTeams'
import { invoiceJob, type InvoiceLineInput, type InvoiceJobResult } from '@/lib/site/jobInvoicing'
import {
  markResponded,
  savePolicy,
  createPolicy,
  deletePolicy,
  type PolicyInput,
  type SlaActionResult,
} from '@/lib/site/jobSla'
import {
  saveHeadline,
  deleteHeadline,
  applyHeadlines,
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
  addJobAsset,
  removeJobAsset,
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
import {
  signJob,
  unsignJob,
  type SignoffParty,
  type SignoffResult,
} from '@/lib/site/jobSignoff'
import {
  requestPart,
  decideRequest,
  // Aliased: jobIntake already exports a RequestActionResult for INBOUND work
  // requests, which are a different thing entirely.
  type RequestResult as PartRequestResult,
  type RequestActionResult as PartRequestActionResult,
} from '@/lib/site/jobPartRequests'
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
  isStockWarnMode,
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
import {
  checkSerials,
  allocateSerials,
  type SerialCheck,
  type SerialResult,
} from '@/lib/site/jobSerials'
import {
  formsForJob,
  loadResponse,
  getVersion,
  saveResponse,
  type FormResult,
} from '@/lib/site/jobForms'
import type { FormField, FormAnswer } from '@/lib/jobFormModel'
import { listVans } from '@/lib/site/stockLocations'
import type { BillingState } from '@/lib/jobStatusModel'
import { setValues } from '@/lib/site/customFields'
import { markSeen } from '@/lib/site/jobFeedback'
import {
  acceptRequest,
  rejectRequest,
  reopenRequest,
  type AcceptResult as AcceptRequestResult,
  type RequestActionResult,
} from '@/lib/site/jobIntake'
import type { CustomFieldEntity } from '@/lib/customFieldModel'

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
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.edit')
  return searchCustomersForTill(ctx.siteId, term)
}

/** The service addresses on file for a customer, for the job form's picker. */
export async function customerAddressesAction(customerId: number): Promise<ServiceAddress[]> {
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.edit')
  return listServiceAddresses(ctx.siteId, customerId)
}

export async function saveJobAction(input: JobCardInput): Promise<JobSaveResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
  if ('ok' in ctx) return ctx

  const result = await assignOwner(ctx.siteId, ctx.actor, jobId, ownerUserId, ownerName)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/**
 * Save the lines on a job.
 *
 * `jobs.edit` opens the action — recording what was used is the technician's job
 * and always was. What changed with the §26.6 split is that the MONEY on those
 * lines is now three separate rights, resolved here and passed down.
 *
 * They are resolved at this boundary rather than inside saveLines because this
 * is where a session exists. saveLines defaults them all to false, so a call
 * site that forgets writes no money rather than granting it.
 */
export async function saveLinesAction(
  jobId: number,
  lines: JobLineInput[],
): Promise<JobActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveLines(ctx.siteId, ctx.actor, jobId, lines, {
    cost: can(ctx.capabilities, 'jobs.cost_edit'),
    price: can(ctx.capabilities, 'jobs.price_edit'),
    discount: can(ctx.capabilities, 'jobs.discount'),
  })
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
  const ctx = await actorForModule('job_cards', 'jobs.bill_decide')
  if ('ok' in ctx) return ctx

  const result = await reclassifyLine(ctx.siteId, ctx.actor, lineId, to, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function closeJobAction(jobId: number, reason?: string): Promise<JobActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.close')
  if ('ok' in ctx) return ctx

  const result = await closeJob(ctx.siteId, ctx.actor, jobId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function cancelJobAction(jobId: number, reason: string): Promise<JobActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.close')
  if ('ok' in ctx) return ctx

  const result = await cancelJob(ctx.siteId, ctx.actor, jobId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function reopenJobAction(jobId: number, reason: string): Promise<JobActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.close')
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
 *
 * TWO capabilities, since the §26.6 split. `jobs.invoice` is the right to bill
 * the job at all; `jobs.invoice_select` is the right to decide WHAT is billed,
 * which is a separate review step in PRD §26.4 — the person who chooses to leave
 * a R4,000 part in the job's cost rather than on the customer's invoice is
 * making a commercial decision, not raising paperwork.
 *
 * Both are checked here because `selections` arrives from the client. Without
 * the second check, the review step would be a screen somebody could skip by
 * posting a different payload.
 */
export async function invoiceJobAction(
  jobId: number,
  selections: InvoiceLineInput[],
): Promise<InvoiceJobResult> {
  const ctx = await actorForModule('job_cards', 'jobs.invoice')
  if ('ok' in ctx) return ctx

  if (!can(ctx.capabilities, 'jobs.invoice_select')) {
    return { ok: false, error: 'You may bill a job, but not choose which items go on the invoice.' }
  }

  const result = await invoiceJob(ctx.siteId, ctx.actor, jobId, selections)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/invoicing')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveJobBoard(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/jobs/board')
  revalidatePath('/setup/job-workflow')
  return result
}

export async function deleteBoardAction(id: number): Promise<BoardActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteJobBoard(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/jobs/board')
  revalidatePath('/setup/job-workflow')
  return result
}

export async function saveStatusAction(input: JobStatusInput): Promise<StatusSaveResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveJobStatus(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

export async function deleteStatusAction(id: number): Promise<StatusSaveResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
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
 * `jobs.quote_amend` and not `jobs.edit`: a quote is a commercial offer that goes
 * to a customer, and the person recording what was used is not necessarily the
 * person allowed to put a price in front of them.
 *
 * Separate from `jobs.invoice` since the §26.6 split, because the two acts have
 * different blast radius. Billing charges for work already agreed; re-quoting
 * supersedes the version the customer accepted and sends them back to Pending
 * Approval. A shop can now let the office bill without letting it renegotiate.
 */
export async function quoteJobAction(
  jobId: number,
  options: { validUntil?: string | null; notes?: string | null } = {},
): Promise<QuoteJobResult> {
  const ctx = await actorForModule('job_cards', 'jobs.quote_amend')
  if ('ok' in ctx) return ctx

  const result = await quoteJob(ctx.siteId, ctx.actor, jobId, options)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/invoicing/quotes')
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
  const ctx = await actorForModule('job_cards', 'jobs.quote_amend')
  if ('ok' in ctx) return ctx

  const result = await acceptQuote(ctx.siteId, ctx.actor, quoteId, input)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/invoicing/quotes')
  return result
}

export async function declineQuoteAction(
  jobId: number,
  quoteId: number,
  reason: string,
): Promise<AcceptResult> {
  const ctx = await actorForModule('job_cards', 'jobs.quote_amend')
  if ('ok' in ctx) return ctx

  const result = await declineJobQuote(ctx.siteId, ctx.actor, quoteId, reason)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/invoicing/quotes')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.bill_decide')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
/**
 * Check serial numbers somebody has typed, without committing to anything.
 *
 * `jobs.edit`, not `stock.transfer`: recording which unit is being fitted is the
 * technician's own work, and it moves no stock. This is a LOOKUP — it writes
 * nothing, so the screen may call it as somebody types.
 */
export async function checkSerialsAction(
  productId: number,
  lineId: number,
  entries: string[],
): Promise<SerialCheck[]> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return []
  return checkSerials(ctx.siteId, productId, lineId, entries)
}

/** Record which units are going on a line. Re-checks everything server-side. */
export async function allocateSerialsAction(
  jobId: number,
  lineId: number,
  entries: string[],
): Promise<SerialResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await allocateSerials(ctx.siteId, ctx.actor, lineId, entries)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

export async function issuePartsAction(
  jobId: number,
  vanLocationId: number,
  lines: IssueLineInput[],
  options: { acknowledged?: boolean } = {},
): Promise<IssueResult> {
  const ctx = await actorForModule('job_cards', 'stock.transfer')
  if ('ok' in ctx) return ctx

  const result = await issueParts(ctx.siteId, ctx.actor, jobId, vanLocationId, lines, options)
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
  const ctx = await actorForModule('job_cards', 'stock.transfer')
  if ('ok' in ctx) return ctx

  const result = await returnParts(ctx.siteId, ctx.actor, jobId, vanLocationId, lines)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidatePath('/transfers')
  return result
}

/** The vans a part can be issued to. */
export async function vansAction(): Promise<{ id: number; code: string; name: string }[]> {
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.view')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveJobSeries(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidateSeries()
  return result
}

export async function deleteSeriesAction(id: number): Promise<SeriesActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.view')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await retireAsset(ctx.siteId, ctx.actor, id, reason)
  if (!result.ok) return result
  revalidateAssets(id)
  return result
}

export async function reviveAssetAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await reviveAsset(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidateAssets(id)
  return result
}

export async function deleteAssetAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteAsset(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidateAssets()
  return result
}

/** Kinds of equipment are a business decision, so this one is setup. */
export async function saveAssetTypeAction(input: AssetTypeInput): Promise<AssetResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveAssetType(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidateAssets()
  return result
}

export async function deleteAssetTypeAction(id: number): Promise<AssetActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await setJobAsset(ctx.siteId, ctx.actor, jobId, assetId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  if (assetId) revalidateAssets(assetId)
  return result
}

/**
 * Add another unit to the visit (161, §18.4).
 *
 * `jobs.edit` — the same right setJobAssetAction needs, because it is the same
 * act: saying what the visit covered. Both revalidate the EQUIPMENT page too, so
 * the unit's own service history and job count are right the moment it is added.
 */
export async function addJobAssetAction(
  jobId: number,
  assetId: number,
  note: string | null,
): Promise<AssetActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await addJobAsset(ctx.siteId, ctx.actor, jobId, assetId, note)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidateAssets(assetId)
  return result
}

export async function removeJobAssetAction(
  jobId: number,
  assetId: number,
): Promise<AssetActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await removeJobAsset(ctx.siteId, ctx.actor, jobId, assetId)
  if (!result.ok) return result
  revalidateJobs(jobId)
  revalidateAssets(assetId)
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
  const ctx = await actorForModuleOrThrow('job_cards', 'jobs.view')

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

/* ── Headlines ────────────────────────────────────────────────────────────── */

/**
 * Configuring what kinds of work exist is setup; saying which kinds a job is, is
 * the work.
 *
 * So these two are `jobs.setup` and applyHeadlinesAction below is `jobs.edit`. A
 * technician must be able to say what a job turned out to be without being able
 * to rewrite the template every other technician follows.
 */
export async function saveHeadlineAction(input: HeadlineInput): Promise<HeadlineResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveHeadline(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

export async function deleteHeadlineAction(id: number): Promise<ItemResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteHeadline(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  return result
}

/**
 * Which kinds of work a job is.
 *
 * It used to copy each headline's checklist onto the job as well, which is why
 * the actions that recorded a check sat beside it here. 224 retired that — forms
 * ask the questions now, and they are answered through jobForms — so this simply
 * sets the links.
 */
export async function applyHeadlinesAction(
  jobId: number,
  headlineIds: number[],
): Promise<ApplyResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await applyHeadlines(ctx.siteId, ctx.actor, jobId, headlineIds)
  if (!result.ok) return result
  revalidateJobs(jobId)
  return result
}

/* ── Asking for a part the shop does not have (162, §28) ──────────────────── */

/**
 * `jobs.edit` — the right a technician recording what they used already has.
 *
 * Deliberately NOT `purchasing.edit`: asking is not buying. The whole point is
 * that somebody on site can raise the question without holding the right to
 * spend money, and a buyer answers it.
 */
export async function requestPartAction(
  jobId: number,
  input: { description: string; qty: number; reason: string | null; jobCardLineId?: number | null },
): Promise<PartRequestResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await requestPart(ctx.siteId, ctx.actor, {
    jobCardId: jobId,
    jobCardLineId: input.jobCardLineId ?? null,
    description: input.description,
    qty: input.qty,
    reason: input.reason,
  })
  if (result.ok) {
    revalidateJobs(jobId)
    revalidatePath('/jobs/part-requests')
  }
  return result
}

/**
 * Deciding is a BUYING act, so it needs `purchasing.edit` — the same right
 * raising the order needs. Somebody who may not spend must not be able to
 * approve spending.
 */
export async function decideRequestAction(
  id: number,
  decision: 'approved' | 'cancelled',
  note: string | null,
): Promise<PartRequestActionResult> {
  const ctx = await actorForModule('job_cards', 'purchasing.edit')
  if ('ok' in ctx) return ctx

  const result = await decideRequest(ctx.siteId, ctx.actor, id, decision, note)
  if (result.ok) {
    revalidatePath('/jobs/part-requests')
    revalidatePath('/jobs')
  }
  return result
}

/* ── Two-party sign-off (159) ─────────────────────────────────────────────── */

/**
 * File a signature against the job as the customer or as the technician.
 *
 * Guarded on `jobs.edit`, the same right captureEvidenceAction needs, because
 * this is the same act: a technician on site attaching evidence. A separate
 * capability would mean the person holding the tablet could tick a check but
 * not take the signature that finishes the job.
 *
 * The stored file is deleted on any failure, mirroring captureEvidenceAction —
 * an orphaned upload is a file on disk that nothing in the database knows about,
 * and uploads/ is backed up as if every byte in it is referenced.
 */
export async function signJobAction(
  jobId: number,
  party: SignoffParty,
  form: FormData,
): Promise<SignoffResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const file = form.get('file')
  if (!(file instanceof File)) return { ok: false, error: 'No signature was received.' }

  const nameField = form.get('name')
  const stored = await storeUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  try {
    const result = await signJob(
      ctx.siteId,
      ctx.actor,
      jobId,
      party,
      stored.file,
      typeof nameField === 'string' && nameField.trim() ? nameField.trim() : null,
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

/**
 * Withdraw a sign-off.
 *
 * The drawn file is deliberately left on the Files tab — see unsignJob. What is
 * withdrawn is the claim, not the evidence that a mark was made.
 */
export async function unsignJobAction(
  jobId: number,
  party: SignoffParty,
): Promise<SignoffResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await unsignJob(ctx.siteId, ctx.actor, jobId, party)
  if (result.ok) revalidateJobs(jobId)
  return result
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
  const ctx = await actorForModule('job_cards', needed)
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
  const ctx = await actorForModule('job_cards', 'jobs.view')
  if ('ok' in ctx) return ctx

  const result = await saveJobView(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/jobs')
  return result
}

export async function deleteJobViewAction(id: number): Promise<ViewActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.view')
  if ('ok' in ctx) return ctx

  const result = await deleteJobView(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/jobs')
  return result
}

/* ── Crews (§16) ──────────────────────────────────────────────────────────── */

/**
 * Create or edit a crew.
 *
 * jobs.setup, not jobs.assign: naming a crew is configuration — it changes what
 * everybody sees in the picker — while USING one is an assignment. The two are
 * separately granted for the same reason statuses and boards are.
 */
export async function saveJobTeamAction(input: {
  id: number | null
  name: string
  description: string | null
  isActive: boolean
  members: { userId: number; isLead: boolean }[]
}): Promise<TeamResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveJobTeam(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

export async function deleteJobTeamAction(id: number): Promise<TeamActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteJobTeam(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  return result
}

/**
 * Put a crew on a job.
 *
 * jobs.assign, because this IS assigning people — the fact that it happens
 * several at a time does not make it a different act.
 */
export async function applyTeamToJobAction(
  jobId: number,
  teamId: number,
): Promise<ApplyTeamResult & { ok: boolean; error?: string }> {
  const ctx = await actorForModule('job_cards', 'jobs.assign')
  if ('ok' in ctx) return { ...(ctx as { ok: false; error: string }), added: 0, skipped: [] }

  const result = await applyTeamToJob(ctx.siteId, ctx.actor, jobId, teamId)
  if (result.ok) revalidateJobs(jobId)
  return result
}

/* ── Deposits (§33) ───────────────────────────────────────────────────────── */

/**
 * Take a deposit against a job.
 *
 * TWO capabilities, and both are the point. `jobs.edit` says this person may
 * change this job; `cashbook.edit` says they may record money received — which
 * is what a deposit is, and which the cashbook screen requires for the identical
 * act. Guarding on `jobs.edit` alone would have let a dispatcher write into the
 * bank account through a door the cashbook keeps shut.
 */
export async function takeDepositAction(
  jobId: number,
  input: {
    amount: number
    bankAccountId: number
    docDate?: string
    reference?: string | null
    description?: string | null
  },
): Promise<DepositResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx
  if (!can(ctx.capabilities, 'cashbook.edit')) {
    return {
      ok: false,
      error: 'Taking a deposit records money received, which needs the cashbook permission.',
    }
  }

  const result = await takeDeposit(ctx.siteId, ctx.actor, jobId, input)
  if (!result.ok) return result

  revalidateJobs(jobId)
  // The money landed in an account and on a customer, so both of those screens
  // are now stale as well.
  revalidatePath('/cashbook')
  revalidatePath('/customers')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.assign')
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
  const ctx = await actorForModule('job_cards', 'jobs.view')
  if ('ok' in ctx) return ctx

  const result = await toggleFollow(ctx.siteId, ctx.actor, jobId)
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
  const ctx = await actorForModule('job_cards', 'jobs.edit')
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
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await savePolicy(ctx.siteId, ctx.actor, id, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs/sla')
  return result
}

/**
 * A promise made to ONE customer (164, §17.5).
 *
 * `jobs.setup`, the same right editing the business promises needs: deciding
 * what is promised is a configuration act whichever customer it is about.
 */
export async function createPolicyAction(input: PolicyInput): Promise<SlaActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await createPolicy(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs/sla')
  return result
}

export async function deletePolicyAction(id: number): Promise<SlaActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deletePolicy(ctx.siteId, ctx.actor, id)
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
  const ctx = await actorForModule('job_cards', 'jobs.setup')
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
  feedbackEnabled: boolean
  feedbackIntro: string
  intakeEnabled: boolean
  intakeBlurb: string
  intakeMaxPerPhone: number
  intakeShowHeadlines: boolean
  portalEnabled: boolean
  portalAllowComments: boolean
  portalAllowUploads: boolean
  portalAllowQuoteAccept: boolean
  stockWarnMode: string
  autoAwaitingParts: boolean
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
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

  // The intro is the first line of an email going to real customers, so an empty
  // one is refused rather than sent as a blank line above a bare link.
  const intro = input.feedbackIntro.trim()
  if (input.feedbackEnabled && !intro) {
    return { ok: false, error: 'The rating email needs an opening line.' }
  }

  /*
   * The cap is clamped rather than refused, on the reservations precedent.
   *
   * A nonsense value must not leave a PUBLIC form unprotected while somebody
   * works out why the save failed, so an unreadable number becomes the default
   * of three rather than zero.
   */
  const cap = Number.isFinite(Number(input.intakeMaxPerPhone))
    ? Math.max(0, Math.min(100, Math.trunc(Number(input.intakeMaxPerPhone))))
    : 3
  const intakeBlurb = input.intakeBlurb.trim()
  if (input.intakeEnabled && !intakeBlurb) {
    return { ok: false, error: 'The public form needs a line saying what it is for.' }
  }

  // All of them or none, on the trading-hours precedent: a half-saved group
  // would behave in a way nobody chose.
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
    ['job_feedback_enabled', input.feedbackEnabled ? '1' : '0'],
    // Saved even when switched off, so turning it back on keeps the wording
    // somebody wrote rather than resetting to the seeded sentence.
    ['job_feedback_intro', intro || 'Thank you for your business. How did we do?'],
    ['job_intake_enabled', input.intakeEnabled ? '1' : '0'],
    ['job_intake_blurb', intakeBlurb || 'Tell us what you need and we will come back to you.'],
    ['job_intake_max_per_phone', String(cap)],
    ['job_intake_show_headlines', input.intakeShowHeadlines ? '1' : '0'],
    ['portal_enabled', input.portalEnabled ? '1' : '0'],
    ['portal_allow_comments', input.portalAllowComments ? '1' : '0'],
    ['portal_allow_uploads', input.portalAllowUploads ? '1' : '0'],
    ['portal_allow_quote_accept', input.portalAllowQuoteAccept ? '1' : '0'],
    /*
     * Validated rather than clamped, unlike the cap above: an unrecognised warn
     * mode has no safe nearest value. Falling back to 'inform' is the right
     * answer for a READ (see stockWarnMode), because failing open there costs a
     * warning; storing it here would silently record something other than what
     * was chosen, and a shop that picked 'prevent' would find it had not stuck.
     */
    ['job_stock_warn_mode', isStockWarnMode(input.stockWarnMode) ? input.stockWarnMode : 'inform'],
    ['job_auto_awaiting_parts', input.autoAwaitingParts ? '1' : '0'],
  ] as const) {
    const saved = await setSetting(ctx.siteId, key, value)
    if (!saved.ok) return saved
  }

  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return { ok: true, message: 'Saved.' }
}

export async function reorderStatusesAction(ids: number[]): Promise<StatusSaveResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await reorderJobStatuses(ctx.siteId, ctx.actor, ids)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}

/**
 * The custom fields on a job.
 *
 * Guarded on jobs.edit rather than setup.edit, and the distinction matters: a
 * technician who may edit a job may FILL IN its extra fields, but defining what
 * those fields are is a setup decision they have no business making.
 */
export async function setCustomValuesAction(
  entity: CustomFieldEntity,
  entityId: number,
  values: { fieldId: number; value: string | null }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  // The entity is a parameter of the shared panel, so it arrives from the
  // client. Pinned to 'job' here — this action guards jobs.edit, and letting it
  // write a CUSTOMER field would be a permission bypass wearing a prop.
  if (entity !== 'job') return { ok: false, error: 'That is not a job field.' }

  const result = await setValues(ctx.siteId, ctx.actor, 'job', entityId, values)
  if (result.ok) revalidatePath(`/jobs/${entityId}`)
  return result
}

/**
 * The custom fields on a piece of equipment.
 *
 * A separate action from the job one rather than a shared one taking the entity,
 * because the capability differs per entity and a single action would have to
 * branch on a value the client supplied. Three short actions with three fixed
 * entities cannot be talked into writing the wrong set.
 */
export async function setAssetCustomValuesAction(
  entity: CustomFieldEntity,
  entityId: number,
  values: { fieldId: number; value: string | null }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }
  if (entity !== 'equipment') return { ok: false, error: 'That is not an equipment field.' }

  const result = await setValues(ctx.siteId, ctx.actor, 'equipment', entityId, values)
  if (result.ok) revalidatePath(`/jobs/equipment/${entityId}`)
  return result
}

/** Somebody in the business has read the customer's rating. */
export async function markFeedbackSeenAction(
  jobId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('job_cards', 'jobs.view')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  const result = await markSeen(ctx.siteId, ctx.actor, jobId)
  if (result.ok) revalidateJobPath(jobId)
  return result
}

/* ── Public job requests (§4.2) ────────────────────────────────────────────── */

/**
 * Turn a request into a job.
 *
 * jobs.edit, because that is what it does: it creates a job. Deliberately NOT a
 * new capability — somebody who may log a job by hand may log one somebody
 * phoned in, and the request queue is the same act with the typing already done.
 */
export async function acceptRequestAction(
  requestId: number,
  customerId: number,
  overrides: { title?: string; description?: string | null } = {},
): Promise<AcceptRequestResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  const result = await acceptRequest(ctx.siteId, ctx.actor, requestId, customerId, overrides)
  if (result.ok) {
    revalidatePath('/jobs/requests')
    revalidateJobs(result.jobId)
  }
  return result
}

export async function rejectRequestAction(
  requestId: number,
  status: 'rejected' | 'spam',
  reason: string | null,
): Promise<RequestActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  const result = await rejectRequest(ctx.siteId, ctx.actor, requestId, status, reason)
  if (result.ok) revalidatePath('/jobs/requests')
  return result
}

export async function reopenRequestAction(requestId: number): Promise<RequestActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  const result = await reopenRequest(ctx.siteId, ctx.actor, requestId)
  if (result.ok) revalidatePath('/jobs/requests')
  return result
}

/* ── Forms on a job (§24) ──────────────────────────────────────────────────── */

/**
 * Open one form: its shape, and whatever has been answered so far.
 *
 * `jobs.edit` rather than `jobs.setup` — filling a form in is the work, and
 * deciding what it asks is configuring the business. A technician who may
 * record what they did may open the form that records it.
 */
export async function loadJobFormAction(
  jobId: number,
  formId: number,
): Promise<{
  formId: number
  responseId: number | null
  fields: FormField[]
  answers: FormAnswer[]
} | null> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return null

  /*
   * Resolved through the JOB rather than taking a responseId from the client.
   * A response id is a number somebody could change, and it names a row that
   * carries answers about a customer — so the job is the boundary, and this
   * only ever returns a response belonging to the job being viewed.
   */
  const entry = (await formsForJob(ctx.siteId, jobId)).find((f) => f.formId === formId)
  if (!entry || entry.versionId === null) return null

  if (entry.responseId !== null) {
    const loaded = await loadResponse(ctx.siteId, entry.responseId)
    if (loaded && loaded.jobId === jobId) {
      return {
        formId,
        responseId: loaded.id,
        fields: loaded.fields,
        answers: loaded.answers,
      }
    }
  }

  // Nothing started yet: the live version's fields and no answers.
  const version = await getVersion(ctx.siteId, entry.versionId)
  return version ? { formId, responseId: null, fields: version.fields, answers: [] } : null
}

/** Save what is filled in, or submit it. See saveResponse for why one function. */
export async function saveFormAction(input: {
  jobId: number
  formId: number
  responseId: number | null
  answers: FormAnswer[]
  submit: boolean
}): Promise<FormResult> {
  const ctx = await actorForModule('job_cards', 'jobs.edit')
  if ('ok' in ctx) return ctx

  const result = await saveResponse(ctx.siteId, ctx.actor, input)
  if (result.ok) revalidateJobs(input.jobId)
  return result
}
