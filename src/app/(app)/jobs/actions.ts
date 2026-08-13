'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, actorForOrThrow } from '@/lib/auth'
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
  type JobCardInput,
  type JobLineInput,
  type JobSaveResult,
  type JobActionResult,
} from '@/lib/site/jobCards'
import { invoiceJob, type InvoiceLineInput, type InvoiceJobResult } from '@/lib/site/jobInvoicing'
import {
  markResponded,
  savePolicy,
  type PolicyInput,
  type SlaActionResult,
} from '@/lib/site/jobSla'
import { setSetting } from '@/lib/site/settings'
import { formatClock, isDayMask, parseClock } from '@/lib/jobStatusModel'
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

  const result = await setStatus(ctx.siteId, ctx.actor, jobId, statusId, reason)
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

  const result = await setStatus(ctx.siteId, ctx.actor, jobId, statusId)
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

export async function reorderStatusesAction(ids: number[]): Promise<StatusSaveResult> {
  const ctx = await actorFor('jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await reorderJobStatuses(ctx.siteId, ctx.actor, ids)
  if (!result.ok) return result
  revalidatePath('/setup/job-workflow')
  revalidatePath('/jobs')
  return result
}
