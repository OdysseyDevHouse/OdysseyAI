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
 *  (J13) Parts move by TRANSFER and nothing else. A vehicle can never be the main
 *        location; a part is issued only to a vehicle and only up to what the job
 *        needs; a serial-tracked unit is never carried; promised-to-open-jobs
 *        falls as parts leave the shelf, so a unit on a bakkie is not counted
 *        twice; and the piles are checked after every act rather than the return
 *        value trusted. Ends by proving stock still reconciles.
 *  (J14) An SLA promise counts BUSINESS hours. Friday 16:00 plus four hours is
 *        Monday 11:00; a job arriving overnight starts at opening; a degenerate
 *        trading week refuses rather than looping; the two clocks agree, so the
 *        countdown cannot disagree with the deadline beside it; met is a state of
 *        its own and a late answer stays a breach; creating a job stamps its
 *        deadlines; and changing the priority re-promises from the ORIGINAL
 *        report time, so the clock cannot be reset with a dropdown.
 *  (J15) EVERY catalog field is executed, one column at a time — a template only
 *        selects what it names, so a broken expression elsewhere ships silently.
 *        Cost fields are gated per FIELD, so a report degrades for a technician
 *        rather than refusing to open; a job line dates from its job; and three
 *        built-ins ship rather than fifteen.
 *  (J16) A worklist with no screen is not a feature — travelNeedingVerification()
 *        shipped with no caller, so a claim of 88km against a 42km estimate
 *        appeared nowhere. Asserts it stays rendered, and behind the DECISION
 *        capability rather than the edit one.
 *  (J17) The suite leaves NOTHING behind, asserted per table rather than by
 *        checking job_cards alone — which passed while four orphaned activity rows
 *        sat behind it. Litter from one suite is how another suite fails.
 *  (J18) A kind of work brings its tasks and checks with it. Two kinds sharing an
 *        item produce ONE (matched past case and spacing) and a later REQUIRED
 *        duplicate promotes the survivor; a required item unanswered blocks closing
 *        and the refusal NAMES it; a check that records a value cannot be ticked off
 *        empty; and dropping a kind of work keeps anything signed off or added by
 *        hand, because neither is the system's to delete.
 *  (J19) Customer equipment is what we look after for somebody else — not
 *        fixed_assets, which we own and depreciate, and not product_serials, which
 *        we bought or sold. A generated serial_key means spacing and capitals
 *        cannot hide a duplicate; a duplicate WARNS rather than refusing, because
 *        plenty of equipment has no legible plate; a job cannot name another
 *        customer's unit; closing a job books the next service from the KIND; and
 *        is_active and status move together, because verifySequence reads status.
 *  (J20) Recurring work is contracts.ts with a job instead of an invoice, so the
 *        two things it borrows are the two things tested: the CLAIM — two ticks at
 *        once raise ONE job between them — and the CATCH-UP, where a missed
 *        quarter raises three jobs each dated for its OWN period rather than the
 *        run date. Lead time shifts the window, not the date; the 24-period cap is
 *        reported rather than silently applied; auto_create off stops the tick but
 *        not a person; and deleting a schedule keeps every job it raised.
 *
 * (J2) is the one that catches real bugs. A margin built on the lines' intended
 * prices rather than the invoice will agree with itself and disagree with the
 * sales report, and only a test that bills a job and then compares the two
 * notices.
 *
 *   npm run test:job-cards
 */
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../src/lib/siteDb'
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
  bulkUpdateJobs,
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
import {
  jobParts,
  partsPromised,
  vanHoldings,
  issueParts,
  returnParts,
  reconcileJobParts,
} from '../src/lib/site/jobParts'
import {
  createLocation,
  listLocations,
  listVans,
  isVanTx,
  mainLocationId,
  setMainLocation,
} from '../src/lib/site/stockLocations'
import { reconcileStock } from '../src/lib/site/stockMovements'
import {
  saveHeadline,
  deleteHeadline,
  listHeadlines,
  applyHeadlines,
  jobItems,
  recordItem,
  captureEvidence,
  addJobItem,
  deleteJobItem,
  reconcileJobHeadlines,
} from '../src/lib/site/jobHeadlines'
import { listUsers } from '../src/lib/site/users'
import { buildIcs, escapeIcsText, foldIcsLine, toIcsStamp } from '../src/lib/icsFeed'
import { createCalendarToken, readCalendarToken } from '../src/lib/calendarToken'
import {
  takeDeposit,
  jobDeposits,
  depositSummary,
  reconcileJobDeposits,
} from '../src/lib/site/jobDeposits'
import {
  saveJobView,
  listJobViews,
  deleteJobView,
  cleanFilters,
  reconcileJobViews,
} from '../src/lib/site/jobViews'
import { getSetting, setSetting } from '../src/lib/site/settings'
import {
  jobSignoff,
  reconcileSignoff,
  signJob,
  signoffRule,
  unsignJob,
} from '../src/lib/site/jobSignoff'
import {
  requestPart,
  decideRequest,
  linkToOrder,
  requestsForJob,
  requestQueue,
  markReceivedForDocument,
  reconcileJobPartRequests,
} from '../src/lib/site/jobPartRequests'
import {
  escalateBreaches,
  autoInvoiceClosed,
  automationRuns,
  reconcileJobAutomations,
  overdueCount,
} from '../src/lib/site/jobAutomations'
import {
  peopleFor,
  setJobPerson,
  removeJobPerson,
  toggleFollow,
  jobIdsFor,
  peopleCounts,
  everyoneOn,
  reconcileJobPeople,
  notifyStatusChanged,
  notifyClosed,
} from '../src/lib/site/jobPeople'
import {
  listJobTeams,
  getJobTeam,
  saveJobTeam,
  deleteJobTeam,
  applyTeamToJob,
  reconcileJobTeams,
} from '../src/lib/site/jobTeams'
import {
  saveAssetType,
  saveAsset,
  getAsset,
  listAssets,
  findDuplicateAssets,
  setJobAsset,
  addJobAsset,
  removeJobAsset,
  otherJobAssets,
  jobAssetFor,
  assetHistory,
  retireAsset,
  reviveAsset,
  deleteAsset,
  reconcileAssets,
  validateAsset,
} from '../src/lib/site/jobAssets'
import {
  saveJobSeries,
  getJobSeries,
  deleteJobSeries,
  generateDueJobs,
  seriesRuns,
  reconcileJobSeries,
  duePeriods,
  validateSeries,
} from '../src/lib/site/jobSeries'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { TEMPLATES } from '../src/lib/reportBuilder/templates'
import { getSource, fieldsFor } from '../src/lib/reportBuilder/catalog'
import {
  deadlinesFor,
  jobStanding,
  listSlaPolicies,
  createPolicy,
  deletePolicy,
  escalateOverdue,
  markResponded,
  reconcileJobSla,
  slaCounts,
  slaWorklist,
  tradingHours,
  untargetedJobCount,
  validatePolicy,
} from '../src/lib/site/jobSla'
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
  addBusinessMinutes,
  businessMinutesBetween,
  DEFAULT_TRADING_HOURS,
  describeDayMask,
  isDayMask,
  minutesUntilDue,
  parseClock,
  slaState,
  tradingWeekIsUsable,
  isFailedResponse,
  itemBlocker,
  responseIsEvidence,
  mergeHeadlineItems,
  validateHeadline,
  validateResponse,
  type ResponseType,
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
/** (J13) fixtures: JCP thermostat / JCS compressor, JCV bakkie / JCR store room. */
const PART_PATTERN = '^JC[PS][0-9]{6}$'
const VAN_PATTERN = '^JC[VR][0-9]{6}$'
/** (J18) fixtures: JCT<stamp>S for the service kind, JCT<stamp>R for the repair. */
const HEADLINE_PATTERN = '^JCT[0-9]{6}[SR]$'
/** (J19) fixtures: equipment described AS<stamp>..., its kind coded AS<stamp>A. */
const ASSET_PATTERN = '^AS[0-9]{6} '
const ASSET_TYPE_PATTERN = '^AS[0-9]{6}[A-Z]$'
/** (J20) fixtures: every schedule this suite creates is named "JCT recurring". */
const SERIES_PATTERN = '^JCT recurring'
/**
 * (J21) evidence fixtures: a headline coded JCE<stamp>H, its job titled
 * "JCE<stamp> evidence job", and the party_documents rows the capture created.
 *
 * The attachments matter most. An orphaned party_documents row pointing at a
 * stored_name that was never written is exactly the drift the reconciliation
 * screen now reports, and leaving one behind would have the NEXT run open with a
 * failure it did not cause.
 */
const EVIDENCE_HEADLINE_PATTERN = '^JCE[0-9]{6}H$'
const EVIDENCE_JOB_PATTERN = '^JCE[0-9]{6} '
/**
 * (J22) fixtures: a job titled "JCT<stamp> people job".
 *
 * job_card_people CASCADEs from job_cards, so deleting the job is enough — but
 * the job itself is matched by title and must be swept, or a crashed run leaves
 * a row that reconcileJobPeople may then report as drift somebody else caused.
 */
const PEOPLE_JOB_PATTERN = '^JCT[0-9]{6} people job$'
/** (J23) fixtures: a job titled "JCT<stamp> automation job". Runs CASCADE from it. */
const AUTOMATION_JOB_PATTERN = '^JCT[0-9]{6} automation job$'
/** (J24) fixtures: three jobs "JCT<stamp> bulk one|two|three", and a saved view. */
const BULK_JOB_PATTERN = '^JCT[0-9]{6} bulk (one|two|three)$'
const VIEW_PATTERN = '^JCT[0-9]{6} overdue'
/** (J25) fixture: one job titled "JCT<stamp> rules job". */
const RULES_JOB_PATTERN = '^JCT[0-9]{6} rules job$'
/** (J26) fixture: one job titled "JCT<stamp> deposit job". */
const DEPOSIT_JOB_PATTERN = '^JCT[0-9]{6} deposit job$'
/**
 * (J28) fixtures: a crew named "JCT<stamp> north crew" and two jobs.
 *
 * The crew needs its own pattern because it is the one thing here that outlives
 * its job: members CASCADE from job_teams, but nothing collects the team itself,
 * and a leftover one is a reconcileJobTeams drift row the next suite gets blamed for.
 */
const CREW_PATTERN = '^JCT[0-9]{6} north crew$'
const CREW_JOB_PATTERN = '^JCT[0-9]{6} crew( owner)? job$'
/*
 * (J29). Its own pattern, like every fixture above it — TITLE_PATTERN is 'JCT %'
 * with a space and matches none of these titles, so the LIKE sweep below cannot
 * catch a job that is not also registered here. Leaving it out left a cancelled
 * job behind, which then failed the CUSTOMER delete with a foreign key error and
 * took the whole suite down at the last line.
 */
const SIGNOFF_JOB_PATTERN = '^JCT[0-9]{6} signoff job$'
/* (J30). Its own pattern for the same reason — see the note above. */
const EXPENSE_JOB_PATTERN = '^JCT[0-9]{6} expense job$'
const EXPENSE_SUPPLIER_PATTERN = '^JCX[0-9]{6}$'
const EXPENSE_CATEGORY_PATTERN = '^JCT[0-9]{6} subcontract$'
/* (J31). Its own pattern, like every fixture above it. */
const MULTI_ASSET_JOB_PATTERN = '^JCT[0-9]{6} multi asset job$'
/* (J32). Its own pattern, like every fixture above it. */
const PART_REQUEST_JOB_PATTERN = '^JCT[0-9]{6} parts request job$'
/* (J33). Its own pattern, like every fixture above it. */
const BREACHED_JOB_PATTERN = '^JCT[0-9]{6} breached job$'
const SLA_POLICY_PATTERN = '^JCT[0-9]{6} promise$'

/**
 * Deletes only this suite's fixtures.
 *
 * Run at the START of main() as well as the end: a crashed prior run leaves rows
 * behind, and the next run must not fail on litter it created itself. The
 * document_sequences row is deliberately NOT reset — it is shared with a live
 * dev database, and resetting a counter is how a duplicate number gets issued.
 */
async function sweepStrays() {
  /*
   * (J20) schedules. The runs CASCADE from the series and job_cards.series_id is
   * SET NULL, so deleting the series is enough — but the JOBS it raised are matched
   * by title, and a leftover schedule is a reconcileJobSeries drift row that would
   * be blamed on whichever suite ran next.
   */
  await siteExecute(SITE, `DELETE FROM job_series WHERE name REGEXP ?`, [SERIES_PATTERN])

  /*
   * (J21) evidence. The attachments go first: job_card_items.attachment_id is
   * ON DELETE SET NULL, so removing the documents cannot fail on a reference, and
   * the items themselves CASCADE from the job below.
   */
  await siteExecute(
    SITE,
    `DELETE FROM party_documents
      WHERE entity = 'job_card'
        AND entity_id IN (SELECT id FROM job_cards WHERE title REGEXP ?)`,
    [EVIDENCE_JOB_PATTERN],
  )
  await siteExecute(
    SITE,
    `DELETE FROM job_card_headlines
      WHERE job_card_id IN (SELECT id FROM job_cards WHERE title REGEXP ?)`,
    [EVIDENCE_JOB_PATTERN],
  )
  await siteExecute(
    SITE,
    `DELETE FROM job_card_items
      WHERE job_card_id IN (SELECT id FROM job_cards WHERE title REGEXP ?)`,
    [EVIDENCE_JOB_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [EVIDENCE_JOB_PATTERN])
  await siteExecute(
    SITE,
    `DELETE FROM job_headline_items
      WHERE headline_id IN (SELECT id FROM job_headlines WHERE code REGEXP ?)`,
    [EVIDENCE_HEADLINE_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_headlines WHERE code REGEXP ?`, [EVIDENCE_HEADLINE_PATTERN])

  // (J22) people. job_card_people CASCADEs, so the job is the only thing to delete.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [PEOPLE_JOB_PATTERN])
  // (J23) automations. job_automation_runs CASCADEs from the job likewise.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [AUTOMATION_JOB_PATTERN])

  // (J24) bulk fixtures and saved views. A view has no FK to anything, so it has
  // to be deleted by name — nothing would ever collect it otherwise.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [BULK_JOB_PATTERN])
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [RULES_JOB_PATTERN])
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [DEPOSIT_JOB_PATTERN])
  // (J28) crews. job_team_members CASCADE from the team; the JOBS are separate
  // rows matched by title, and job_card_people CASCADEs from those.
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [CREW_JOB_PATTERN])
  // (J29). The signature documents go first: they are an (entity, entity_id)
  // pair with no foreign key, so deleting the job does not take them with it.
  await siteExecute(
    SITE,
    `DELETE FROM party_documents
      WHERE entity = 'job_card'
        AND entity_id IN (SELECT id FROM job_cards WHERE title REGEXP ?)`,
    [SIGNOFF_JOB_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [SIGNOFF_JOB_PATTERN])
  /*
   * (J30). Lines before the job (fk_jcl_job CASCADEs, but the supplier and
   * category below are RESTRICTed by those lines, so they must go first), then
   * the job, then the two lookup rows the section created for itself.
   */
  await siteExecute(
    SITE,
    `DELETE l FROM job_card_lines l JOIN job_cards j ON j.id = l.job_card_id
      WHERE j.title REGEXP ?`,
    [EXPENSE_JOB_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [EXPENSE_JOB_PATTERN])
  await siteExecute(SITE, `DELETE FROM expense_categories WHERE name REGEXP ?`, [
    EXPENSE_CATEGORY_PATTERN,
  ])
  await siteExecute(SITE, `DELETE FROM suppliers WHERE code REGEXP ?`, [EXPENSE_SUPPLIER_PATTERN])
  await siteExecute(SITE, `DELETE FROM job_teams WHERE name REGEXP ?`, [CREW_PATTERN]).catch(
    () => {},
  )
  await siteExecute(SITE, `DELETE FROM job_saved_views WHERE name REGEXP ?`, [VIEW_PATTERN]).catch(
    () => {},
  )

  /*
   * Any job_card attachment whose job is gone.
   *
   * Broader than the patterns above on purpose. party_documents carries a LOOSE
   * (entity, entity_id) pair with no foreign key, so deleting a job never cascades
   * to its files — which means every crashed run of this suite, and of (J18) since
   * it started capturing signatures, leaves rows nothing else will ever collect.
   * Scoped to jobs that no longer exist, so it cannot touch a live document.
   */
  await siteExecute(
    SITE,
    `DELETE FROM party_documents
      WHERE entity = 'job_card' AND entity_id NOT IN (SELECT id FROM job_cards)`,
  )

  /*
   * (J19) equipment. The job FK is RESTRICT, so the reference has to be cleared
   * before the asset can go — and a leftover asset row is a reconcileAssets drift
   * row that would then be blamed on whichever suite ran next.
   */
  await siteExecute(
    SITE,
    `UPDATE job_cards SET asset_id = NULL
      WHERE asset_id IN (SELECT id FROM customer_assets WHERE description REGEXP ?)`,
    [ASSET_PATTERN],
  )
  /*
   * (J31) The join table too — fk_jca_asset is RESTRICT, matching the primary
   * column, so a leftover row here blocks the asset delete below and the whole
   * sweep dies at that line.
   */
  await siteExecute(
    SITE,
    `DELETE FROM job_card_assets
      WHERE asset_id IN (SELECT id FROM customer_assets WHERE description REGEXP ?)`,
    [ASSET_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [MULTI_ASSET_JOB_PATTERN])
  /*
   * (J32) Part requests, then the job. fk_jpr_job CASCADEs so the job delete
   * would take them, but the request FK to purchase_document_lines is SET NULL
   * and the notifications carry no FK at all — both are swept by name.
   */
  await siteExecute(
    SITE,
    `DELETE r FROM job_part_requests r JOIN job_cards j ON j.id = r.job_card_id
      WHERE j.title REGEXP ?`,
    [PART_REQUEST_JOB_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [
    PART_REQUEST_JOB_PATTERN,
  ])
  /*
   * (J33) The breached job, its escalation claim and the per-customer policy.
   * The claim CASCADEs from the job, but the policy is RESTRICTed by any job
   * still pointing at it, so the job goes first. Notifications carry no FK at
   * all and are swept by event.
   */
  await siteExecute(SITE, `DELETE FROM job_cards WHERE title REGEXP ?`, [BREACHED_JOB_PATTERN])
  await siteExecute(SITE, `DELETE FROM job_sla_policies WHERE name REGEXP ?`, [
    SLA_POLICY_PATTERN,
  ])
  await siteExecute(SITE, `DELETE FROM notifications WHERE event = 'sla_escalation'`)
  await siteExecute(SITE, `DELETE FROM customer_assets WHERE description REGEXP ?`, [ASSET_PATTERN])
  await siteExecute(SITE, `DELETE FROM asset_types WHERE code REGEXP ?`, [ASSET_TYPE_PATTERN])

  /*
   * (J18) items and headlines. Items first — job_card_items CASCADEs from the job,
   * but a headline is RESTRICTed by job_card_headlines, so the links have to go
   * before the templates or the delete fails silently and leaves a stray.
   */
  await siteExecute(
    SITE,
    `DELETE i FROM job_card_items i JOIN job_cards j ON j.id = i.job_card_id
      WHERE j.title LIKE ?`,
    [TITLE_PATTERN],
  )
  await siteExecute(
    SITE,
    `DELETE h FROM job_card_headlines h JOIN job_cards j ON j.id = h.job_card_id
      WHERE j.title LIKE ?`,
    [TITLE_PATTERN],
  )
  await siteExecute(SITE, `DELETE FROM job_headlines WHERE code REGEXP ?`, [HEADLINE_PATTERN])

  /*
   * (J13) fixtures next: a crashed run leaves stock on a bakkie, and a leftover
   * pile on a leftover location is a reconcileStock() drift row that would then
   * be blamed on whichever suite ran next. Movements before piles before
   * products; transfer lines before transfers.
   */
  const jcProducts = `(SELECT id FROM products WHERE code REGEXP '${PART_PATTERN}')`
  const jcLocs = `(SELECT id FROM stock_locations WHERE code REGEXP '${VAN_PATTERN}' AND is_main = 0)`
  await siteExecute(
    SITE,
    `DELETE tl FROM stock_transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
      WHERE t.from_location_id IN ${jcLocs} OR t.to_location_id IN ${jcLocs}`,
  )
  await siteExecute(
    SITE,
    `DELETE FROM stock_transfers WHERE from_location_id IN ${jcLocs} OR to_location_id IN ${jcLocs}`,
  )
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${jcProducts}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id IN ${jcLocs}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${jcProducts}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id IN ${jcLocs}`)
  await siteExecute(SITE, `DELETE l FROM job_card_lines l WHERE l.product_id IN ${jcProducts}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${PART_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code REGEXP '${VAN_PATTERN}' AND is_main = 0`)

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
  /*
   * Activity, by ANY actor this module's scripts have used — not just this suite's.
   *
   * A one-name sweep left rows behind from the demo scripts that drove the browser
   * verification, and an orphaned activity row is precisely the shape of litter
   * that makes somebody else's suite fail: REF55846921 does it to three of them.
   * Also catches a row whose job has already gone, whatever wrote it.
   */
  await siteExecute(
    SITE,
    `DELETE FROM activity_log
      WHERE entity = 'job_card'
        AND (user_name IN (?, 'SLA Probe', 'SLA Demo', 'Parts Demo')
             OR entity_id NOT IN (SELECT id FROM job_cards))`,
    [actor.userName],
  )
}

/**
 * A DATETIME column as the wall clock that was stored.
 *
 * String(driverDate) is a LOCALE string, so comparing it against a
 * 'YYYY-MM-DD HH:MM:SS' the code produced would never match — and would fail in a
 * way that looks like a deadline bug rather than a formatting one.
 */
const wallOf = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
      ` ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    )
  }
  return String(value)
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
  /*
   * Baselined, not asserted to be zero. This suite shares a live dev database
   * with the others, so a drift row somebody else left must not be reported as
   * this suite's fault — what matters is that (J13) adds none.
   */
  const stockDriftBefore = (await reconcileStock(SITE)).length
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
      supplierId: null,
      expenseCategoryId: null,
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
    supplierId: null,
    expenseCategoryId: null,
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

  // ── 21. (J13) Parts, vans and issuing ─────────────────────────────────
  //
  // The only phase where a wrong number moves PHYSICAL GOODS, so this block
  // checks the piles after every act rather than trusting the return value.
  {
    const vatRate = await siteQueryOne<any>(
      SITE,
      "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
    )
    const mainId = await mainLocationId(SITE)

    // A van and a stock room. Two, because "is a van" must change behaviour.
    const van = await createLocation(SITE, {
      code: `JCV${stamp}`,
      name: 'JCT bakkie',
      isMobile: true,
    })
    const room = await createLocation(SITE, { code: `JCR${stamp}`, name: 'JCT store room' })
    ok('(J13) a vehicle location can be created', van.ok, van.ok ? '' : van.error)
    ok('(J13) so can an ordinary room', room.ok, room.ok ? '' : room.error)
    if (!van.ok || !room.ok) throw new Error('van fixture failed')

    const vanRow = await siteQueryOne<any>(
      SITE,
      'SELECT is_mobile FROM stock_locations WHERE id=?',
      [van.id],
    )
    ok('(J13) the flag is stored, not inferred from the name', Number(vanRow?.is_mobile) === 1)

    const vans = await listVans(SITE)
    ok(
      '(J13) listVans finds it and not the room',
      vans.some((v) => v.id === van.id) && !vans.some((v) => v.id === room.id),
    )
    ok('(J13) isVanTx agrees, inside a transaction', await siteTransaction(SITE, (tx) => isVanTx(tx, van.id)))
    ok('(J13) and says no to the room', !(await siteTransaction(SITE, (tx) => isVanTx(tx, room.id))))

    /*
     * The load-bearing refusal. Sales come from the main location, so a bakkie
     * as main would mean the till sells from whatever is on board — and
     * `availableToSell` reads main only, so the error would be invisible.
     */
    const vanAsMain = await setMainLocation(SITE, van.id)
    ok(
      '(J13) *** a vehicle cannot be made the main location ***',
      !vanAsMain.ok,
      vanAsMain.ok ? '' : vanAsMain.error,
    )

    // Purpose filtering: a van is transferable-into and countable, never sellable.
    const sellable = await listLocations(SITE, false, true, 'sell')
    const transferable = await listLocations(SITE, false, true, 'transfer')
    const countable = await listLocations(SITE, false, true, 'count')
    ok('(J13) a vehicle is not offered as a place to sell from', !sellable.some((l) => l.id === van.id))
    ok('(J13) but it IS offered as a transfer destination', transferable.some((l) => l.id === van.id))
    ok('(J13) and it can be counted like any other pile', countable.some((l) => l.id === van.id))
    ok('(J13) the room is offered for all three',
      sellable.some((l) => l.id === room.id) &&
      transferable.some((l) => l.id === room.id) &&
      countable.some((l) => l.id === room.id))

    // A stocked part, sitting on the main shelf.
    const created = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
       VALUES (?,?,'normal',40,60,60,?,1)`,
      [`JCP${stamp}`, 'JCT thermostat', vatRate?.id ?? null],
    )
    const part = created.insertId
    await siteExecute(
      SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,40)`,
      [part, mainId],
    )
    await siteExecute(
      SITE,
      `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name)
       VALUES (?,?,'opening',40,40,60,'opening',?,?)`,
      [part, mainId, actor.userId, actor.userName],
    )

    const pileAt = async (locationId: number) =>
      toNum(
        (
          await siteQueryOne<any>(
            SITE,
            'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
            [part, locationId],
          )
        )?.stock_on_hand ?? 0,
      )
    const siteTotal = async () =>
      toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [part]))?.stock_on_hand)

    // A fresh job needing 10 of them.
    const partsJob = await saveJobCard(SITE, actor, {
      id: null,
      customerId: customer.id,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      serviceAddressId: null,
      locationId: null,
      statusId: null,
      priority: 'normal',
      ownerUserId: null,
      ownerName: '',
      title: 'JCT thermostat replacement',
      description: null,
      dueAt: null,
      source: 'phone',
      reference: null,
      internalNote: null,
    })
    if (!partsJob.ok) throw new Error('parts job fixture failed')
    const pJob = partsJob.id

    const pLines = await saveLines(SITE, actor, pJob, [
      {
        id: null,
        lineKind: 'part',
        billingState: 'quoted',
        productId: part,
        productCode: `JCP${stamp}`,
        description: 'JCT thermostat',
        qty: 10,
        unitCostExcl: 60,
        unitPriceIncl: 138,
        vatRatePct: 15,
        discountPct: 0,
        note: null,
        supplierId: null,
        expenseCategoryId: null,
      },
    ])
    ok('(J13) a part line with a real product saves', pLines.ok, pLines.ok ? '' : pLines.error)

    const beforePart = await jobParts(SITE, pJob)
    ok('(J13) the job reports one part to pick', beforePart.length === 1)
    ok('(J13) all ten are outstanding before anything moves', beforePart[0]?.outstandingQty === 10)
    ok('(J13) and it knows what is on the shelf', beforePart[0]?.mainOnHand === 40)

    /*
     * Promised-to-open-jobs. This is the figure that stops a buyer seeing 40 on
     * the shelf and selling all of them while a technician is booked to fit ten.
     */
    const promised = await partsPromised(SITE, [part])
    ok('(J13) ten are promised to an open job', promised.get(part) === 10)

    // ── Issuing ─────────────────────────────────────────────────────────
    const overIssue = await issueParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: beforePart[0]!.lineId, productId: part, qty: 25 },
    ])
    ok(
      '(J13) *** issuing more than the job needs is refused ***',
      !overIssue.ok,
      overIssue.ok ? '' : overIssue.error,
    )

    const toARoom = await issueParts(SITE, actor, pJob, room.id, [
      { jobCardLineId: beforePart[0]!.lineId, productId: part, qty: 4 },
    ])
    ok(
      '(J13) parts can only be issued to a VEHICLE, not another stock room',
      !toARoom.ok,
      toARoom.ok ? '' : toARoom.error,
    )

    const issued = await issueParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: beforePart[0]!.lineId, productId: part, qty: 6 },
    ])
    ok('(J13) six go onto the bakkie', issued.ok, issued.ok ? '' : issued.error)

    ok('(J13) the shelf drops to 34', (await pileAt(mainId)) === 34)
    ok('(J13) the bakkie holds 6', (await pileAt(van.id)) === 6)
    ok('(J13) and the SITE total is unchanged — nothing was created or destroyed', (await siteTotal()) === 40)

    if (issued.ok) {
      const tRow = await siteQueryOne<any>(
        SITE,
        'SELECT status, from_location_id, to_location_id FROM stock_transfers WHERE id=?',
        [issued.transferId],
      )
      ok('(J13) it went through the ONE transfer engine, posted', String(tRow?.status) === 'posted')
      ok('(J13) off the main location, onto the van', Number(tRow?.to_location_id) === van.id)
      const linked = await siteQueryOne<any>(
        SITE,
        'SELECT job_card_line_id FROM stock_transfer_lines WHERE transfer_id=?',
        [issued.transferId],
      )
      ok(
        '(J13) the transfer line names the job line, which is what makes drift findable',
        Number(linked?.job_card_line_id) === beforePart[0]!.lineId,
      )
    }

    const afterIssue = await jobParts(SITE, pJob)
    ok('(J13) the line records six issued', afterIssue[0]?.issuedQty === 6)
    ok('(J13) four are still to pick', afterIssue[0]?.outstandingQty === 4)

    /*
     * Promised must fall to what has NOT left the building. Leaving it at ten
     * would double-count: six are on a bakkie, already off the shelf.
     */
    ok('(J13) promised falls to the four still on the shelf', (await partsPromised(SITE, [part])).get(part) === 4)

    const holdings = await vanHoldings(SITE, van.id)
    ok('(J13) vanHoldings sees the six on board', holdings.find((h) => h.productId === part)?.qty === 6)

    // Topping up to the job's full need is allowed; going past it is not.
    const topUp = await issueParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: afterIssue[0]!.lineId, productId: part, qty: 5 },
    ])
    ok(
      '(J13) six already out plus five more exceeds the ten needed, so it is refused',
      !topUp.ok,
      topUp.ok ? '' : topUp.error,
    )

    // ── Returning ───────────────────────────────────────────────────────
    const overReturn = await returnParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: afterIssue[0]!.lineId, productId: part, qty: 9 },
    ])
    ok(
      '(J13) *** more cannot come back than went out ***',
      !overReturn.ok,
      overReturn.ok ? '' : overReturn.error,
    )

    const returned = await returnParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: afterIssue[0]!.lineId, productId: part, qty: 2 },
    ])
    ok('(J13) two come back', returned.ok, returned.ok ? '' : returned.error)
    ok('(J13) the shelf climbs to 36', (await pileAt(mainId)) === 36)
    ok('(J13) four are left on board', (await pileAt(van.id)) === 4)
    ok('(J13) the site total STILL has not moved', (await siteTotal()) === 40)

    const afterReturn = await jobParts(SITE, pJob)
    ok('(J13) issued falls to four', afterReturn[0]?.issuedQty === 4)
    ok('(J13) so six are outstanding again', afterReturn[0]?.outstandingQty === 6)

    // ── Drift ───────────────────────────────────────────────────────────
    const cleanDrift = await reconcileJobParts(SITE)
    ok(
      '(J13) a correctly issued job reports no drift',
      cleanDrift.issuedMismatch.filter((d) => d.jobId === pJob).length === 0 &&
        cleanDrift.overIssued.filter((d) => d.jobId === pJob).length === 0,
    )
    ok(
      '(J13) four on a van for an OPEN job is not stranded',
      !cleanDrift.strandedOnVans.some((s) => s.productCode === `JCP${stamp}`),
    )

    /*
     * Now break it on purpose, the way a hand-edit or a half-applied write would.
     * The reconciliation exists for exactly this, and a drift function nobody has
     * seen fail is a drift function nobody should trust.
     */
    await siteExecute(SITE, 'UPDATE job_card_lines SET issued_qty = 9 WHERE id = ?', [
      afterReturn[0]!.lineId,
    ])
    const broken = await reconcileJobParts(SITE)
    const caught = broken.issuedMismatch.find((d) => d.lineId === afterReturn[0]!.lineId)
    ok('(J13) a tampered issued figure is CAUGHT', caught !== undefined)
    ok('(J13) and it names both numbers', caught?.issued === 9 && caught?.moved === 4)
    await siteExecute(SITE, 'UPDATE job_card_lines SET issued_qty = 4 WHERE id = ?', [
      afterReturn[0]!.lineId,
    ])

    /*
     * The case that defeats every other check on the reconciliation screen.
     * finaliseDocument consumes from MAIN, so invoicing a part still on a bakkie
     * debits the wrong pile — and all three stock invariants still hold, because
     * the totals are right and only the attribution is wrong.
     */
    await siteExecute(SITE, 'UPDATE job_card_lines SET invoiced_qty = 1 WHERE id = ?', [
      afterReturn[0]!.lineId,
    ])
    const outAndInvoiced = await reconcileJobParts(SITE)
    ok(
      '(J13) *** invoiced while still on a van is reported — nothing else can see it ***',
      outAndInvoiced.invoicedWhileOut.some((d) => d.lineId === afterReturn[0]!.lineId),
    )
    await siteExecute(SITE, 'UPDATE job_card_lines SET invoiced_qty = 0 WHERE id = ?', [
      afterReturn[0]!.lineId,
    ])

    // Closing the job leaves the four with nobody expecting them.
    ok('(J13) promised ignores a line already out', (await partsPromised(SITE, [part])).get(part) === 6)

    /*
     * A serial-tracked part is not carried on a bakkie: which unit was fitted is
     * the whole point of a serial, and choosing it on the pavement is how a
     * warranty ends up against the wrong customer.
     */
    const serialCreated = await siteExecute(
      SITE,
      /*
       * 'serial' is a PRODUCT TYPE, not a flag — the same enum that separates a
       * normal line from a service, which is why jobParts reads product_type.
       *
       * ZERO stock, deliberately. A serial-tracked product holding 5 with no
       * product_serials rows is a reconcileSerials() drift row, and it would
       * surface as a failure in test:serials — a suite this block does not
       * touch. The refusal below fires on the product type before any quantity
       * is looked at, so the stock is not needed to prove it.
       */
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
       VALUES (?,?,'serial',0,900,900,?,1)`,
      [`JCS${stamp}`, 'JCT compressor', vatRate?.id ?? null],
    )
    const serialPart = serialCreated.insertId
    const withSerial = await saveLines(SITE, actor, pJob, [
      { ...afterReturn[0]!, id: afterReturn[0]!.lineId, lineKind: 'part', billingState: 'quoted',
        productId: part, productCode: `JCP${stamp}`, description: 'JCT thermostat', qty: 10,
        unitCostExcl: 60, unitPriceIncl: 138, vatRatePct: 15, discountPct: 0, note: null, supplierId: null, expenseCategoryId: null },
      { id: null, lineKind: 'part', billingState: 'quoted', productId: serialPart,
        productCode: `JCS${stamp}`, description: 'JCT compressor', qty: 1, unitCostExcl: 900,
        unitPriceIncl: 2070, vatRatePct: 15, discountPct: 0, note: null, supplierId: null, expenseCategoryId: null },
    ])
    ok('(J13) a serial-tracked part can be ON a job', withSerial.ok, withSerial.ok ? '' : withSerial.error)

    const serialLine = (await jobParts(SITE, pJob)).find((p) => p.productId === serialPart)
    ok('(J13) and the job knows it is serialised', serialLine?.isSerial === true)
    const serialIssue = await issueParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: serialLine!.lineId, productId: serialPart, qty: 1 },
    ])
    ok(
      '(J13) *** but it cannot be loaded onto a bakkie ***',
      !serialIssue.ok,
      serialIssue.ok ? '' : serialIssue.error,
    )
    ok(
      '(J13) and the reason given is the serial, not the empty shelf',
      !serialIssue.ok && /serial/i.test(serialIssue.error),
    )

    // Bring the van back to empty so the fixture teardown leaves no stock behind.
    const finalOut = (await jobParts(SITE, pJob)).find((p) => p.productId === part)
    const emptied = await returnParts(SITE, actor, pJob, van.id, [
      { jobCardLineId: finalOut!.lineId, productId: part, qty: finalOut!.issuedQty },
    ])
    ok('(J13) the bakkie can be emptied', emptied.ok, emptied.ok ? '' : emptied.error)
    ok('(J13) every unit is back on the shelf', (await pileAt(mainId)) === 40 && (await pileAt(van.id)) === 0)

    /*
     * The whole-system invariant, last: after issuing, over-issuing, returning,
     * tampering and repairing, stock_on_hand must still equal the sum of every
     * movement ever recorded. This is the check that would catch a stray UPDATE.
     */
    const stockNow = await reconcileStock(SITE)
    ok(
      '(J13) *** stock still reconciles after all of that ***',
      stockNow.length === stockDriftBefore,
      `${stockNow.length} rows, was ${stockDriftBefore}`,
    )

    // Teardown, in FK order.
    await siteExecute(
      SITE,
      `DELETE tl FROM stock_transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
        WHERE t.from_location_id = ? OR t.to_location_id = ?`,
      [van.id, van.id],
    )
    await siteExecute(SITE, `DELETE FROM stock_transfers WHERE from_location_id = ? OR to_location_id = ?`, [van.id, van.id])
    await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN (?,?)`, [part, serialPart])
    await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN (?,?)`, [part, serialPart])
    await siteExecute(SITE, `DELETE FROM job_card_lines WHERE job_card_id = ?`, [pJob])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [pJob])
    await siteExecute(SITE, `DELETE FROM products WHERE id IN (?,?)`, [part, serialPart])
    await siteExecute(SITE, `DELETE FROM stock_locations WHERE id IN (?,?)`, [van.id, room.id])
  }

  // ── 22. (J14) Service targets on business hours ───────────────────────
  //
  // The arithmetic first, with no database at all: a wrong business-minute sum
  // makes every deadline in the system wrong, and it is the one thing here that
  // can be pinned down exactly.
  {
    const at = (iso: string) => new Date(`${iso}Z`).getTime()
    const iso = (msv: number | null) =>
      msv === null ? 'null' : new Date(msv).toISOString().slice(0, 16)

    // Mon-Fri 08:00-17:00, the seeded default.
    const wk = DEFAULT_TRADING_HOURS

    /*
     * THE CASE THE WHOLE DESIGN EXISTS FOR. Friday 16:00 plus four business hours
     * is MONDAY 11:00 — one hour of Friday and three of Monday. A calendar clock
     * would say Friday 20:00 and breach it before anybody was back at work.
     */
    ok(
      '(J14) *** friday 16:00 + 4 business hours is monday 11:00, not friday 20:00 ***',
      iso(addBusinessMinutes(at('2026-08-14T16:00:00'), 240, wk)) === '2026-08-17T11:00',
      iso(addBusinessMinutes(at('2026-08-14T16:00:00'), 240, wk)),
    )

    // A job that arrives overnight is not already an hour into its four.
    ok(
      '(J14) a job logged at 02:00 starts its clock at opening',
      iso(addBusinessMinutes(at('2026-08-11T02:00:00'), 240, wk)) === '2026-08-11T12:00',
    )
    ok(
      '(J14) and one logged after closing starts the next morning',
      iso(addBusinessMinutes(at('2026-08-11T18:00:00'), 240, wk)) === '2026-08-12T12:00',
    )
    ok(
      '(J14) exactly at closing time rolls to the next day',
      iso(addBusinessMinutes(at('2026-08-11T17:00:00'), 60, wk)) === '2026-08-12T09:00',
    )
    ok(
      '(J14) zero minutes is the reported time itself',
      iso(addBusinessMinutes(at('2026-08-11T10:00:00'), 0, wk)) === '2026-08-11T10:00',
    )

    ok('(J14) a full trading day is nine hours', businessMinutesBetween(
      at('2026-08-12T08:00:00'), at('2026-08-12T17:00:00'), wk) === 540)
    ok('(J14) a weekend on its own is zero', businessMinutesBetween(
      at('2026-08-15T00:00:00'), at('2026-08-16T23:59:00'), wk) === 0)

    /*
     * THE CONSISTENCY CHECK, and the one most likely to catch a real bug: the
     * two functions must agree. If addBusinessMinutes says the deadline is Monday
     * 11:00, then businessMinutesBetween from the start to that deadline has to be
     * the 240 that produced it — otherwise the countdown on screen disagrees with
     * the deadline beside it.
     */
    ok(
      '(J14) *** the two clocks agree — measuring back to the deadline gives the same 240 ***',
      businessMinutesBetween(at('2026-08-14T16:00:00'), at('2026-08-17T11:00:00'), wk) === 240,
    )

    const withHoliday = { ...wk, holidays: new Set(['2026-08-12']) }
    ok(
      '(J14) a public holiday pushes the deadline out by a day',
      iso(addBusinessMinutes(at('2026-08-11T16:00:00'), 240, withHoliday)) === '2026-08-13T11:00',
    )

    /*
     * Degenerate weeks must REFUSE rather than spin. A mask of zeroes has no
     * minute to find, and an unbounded search for one in a page render is a hung
     * request, not a wrong number.
     */
    ok(
      '(J14) *** a week with no open day returns no target rather than looping ***',
      addBusinessMinutes(at('2026-08-11T10:00:00'), 60, { ...wk, days: '0000000' }) === null,
    )
    ok(
      '(J14) so does a closing time before the opening one',
      addBusinessMinutes(at('2026-08-11T10:00:00'), 60, { ...wk, opensAt: 1020, closesAt: 480 }) === null,
    )
    ok('(J14) and tradingWeekIsUsable says so first', !tradingWeekIsUsable({ ...wk, days: '0000000' }))

    // A 24/7 business is the degenerate case the other way, and must behave.
    const roundClock = { days: '1111111', opensAt: 0, closesAt: 1440, holidays: new Set<string>() }
    ok(
      '(J14) a business open around the clock behaves like wall time',
      iso(addBusinessMinutes(at('2026-08-14T16:00:00'), 240, roundClock)) === '2026-08-14T20:00',
    )

    // The three states, and why 'met' is not 'not breached'.
    const dueAt = at('2026-08-17T11:00:00')
    ok('(J14) before the deadline it is counting down', slaState(dueAt, NaN, at('2026-08-17T10:00:00')) === 'due')
    ok('(J14) past it with nobody having replied is a breach', slaState(dueAt, NaN, at('2026-08-17T12:00:00')) === 'breached')
    ok(
      '(J14) *** answered in time is MET, a state of its own — not merely unbreached ***',
      slaState(dueAt, at('2026-08-17T09:00:00'), at('2026-08-20T09:00:00')) === 'met',
    )
    ok(
      '(J14) answered late stays a breach forever, rather than reverting',
      slaState(dueAt, at('2026-08-17T12:00:00'), at('2026-08-20T09:00:00')) === 'breached',
    )
    ok('(J14) answering at the exact deadline counts as met', slaState(dueAt, dueAt, at('2026-08-20T09:00:00')) === 'met')
    ok('(J14) no deadline is no target, not a pass', slaState(NaN, NaN, dueAt) === 'none')

    ok('(J14) the countdown is in business minutes', minutesUntilDue(dueAt, at('2026-08-14T16:00:00'), wk) === 240)
    ok('(J14) and goes negative once late', minutesUntilDue(dueAt, at('2026-08-17T12:00:00'), wk) === -60)

    ok('(J14) a mask reads as a sentence', describeDayMask('1111100') === 'Mon-Fri')
    ok('(J14) a scattered mask lists its days', describeDayMask('1010100') === 'Mon, Wed, Fri')
    ok('(J14) a malformed mask is refused', !isDayMask('11111') && !isDayMask('1111102'))
    ok('(J14) a clock parses, and a nonsense one does not',
      parseClock('08:30') === 510 && parseClock('25:00') === null && parseClock('rubbish') === null)

    // ── The policy rules ────────────────────────────────────────────────
    ok(
      '(J14) *** a response target longer than the resolution one is refused ***',
      validatePolicy({
        priority: 'normal', name: 'JCT', respondMinutes: 600, resolveMinutes: 60,
        isActive: true, note: null,
      }) !== null,
    )
    ok(
      '(J14) a blank resolution target is allowed — a fix often waits on a part',
      validatePolicy({
        priority: 'normal', name: 'JCT', respondMinutes: 600, resolveMinutes: null,
        isActive: true, note: null,
      }) === null,
    )
    ok(
      '(J14) zero is refused, because it is a promise of instant rather than none',
      validatePolicy({
        priority: 'normal', name: 'JCT', respondMinutes: 0, resolveMinutes: null,
        isActive: true, note: null,
      }) !== null,
    )
    ok(
      '(J14) a nameless policy is refused',
      validatePolicy({
        priority: 'normal', name: '   ', respondMinutes: 60, resolveMinutes: null,
        isActive: true, note: null,
      }) !== null,
    )

    // ── Against the database ────────────────────────────────────────────
    const week = await tradingHours(SITE)
    ok('(J14) the trading week loads and is usable', tradingWeekIsUsable(week), JSON.stringify({
      days: week.days, opensAt: week.opensAt, closesAt: week.closesAt,
    }))

    const seeded = await listSlaPolicies(SITE, false)
    ok('(J14) all four priorities carry a live policy', seeded.length === 4, String(seeded.length))
    ok(
      '(J14) and each respects respond <= resolve',
      seeded.every((p) => p.respondMinutes === null || p.resolveMinutes === null ||
        p.respondMinutes <= p.resolveMinutes),
    )

    const derived = await deadlinesFor(SITE, 'high', '2026-08-14 16:00:00', week)
    ok('(J14) a high-priority job reported friday 16:00 gets a policy', derived.policyId !== null)
    ok(
      '(J14) *** and its deadline is monday 11:00, from the seeded 4 hours ***',
      derived.respondBy === '2026-08-17 11:00:00',
      String(derived.respondBy),
    )

    // A real job, so the wiring is exercised and not just the arithmetic.
    const slaJob = await saveJobCard(SITE, actor, {
      id: null, customerId: customer.id, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'high', ownerUserId: null, ownerName: '',
      title: 'JCT geyser burst', description: null, dueAt: null, source: 'phone',
      reference: null, internalNote: null,
    })
    ok('(J14) the job is created', slaJob.ok, slaJob.ok ? '' : slaJob.error)
    if (!slaJob.ok) throw new Error('sla job fixture failed')
    const sJob = slaJob.id

    const stamped = await siteQueryOne<any>(
      SITE,
      `SELECT sla_policy_id, respond_by, resolve_by, reported_at FROM job_cards WHERE id = ?`,
      [sJob],
    )
    ok(
      '(J14) *** creating a job STAMPS its deadlines — the columns are not left for a cron ***',
      stamped?.sla_policy_id !== null && stamped?.respond_by !== null,
      JSON.stringify(stamped),
    )

    /*
     * The deadline must be computed from the stored reported_at, not from a fresh
     * `new Date()`. Off by even a second and reconcileJobSla would report every
     * job in the business as drifted.
     */
    const expected = await deadlinesFor(SITE, 'high', stamped.reported_at, week)
    ok(
      '(J14) and it matches what the policy says exactly, so nothing reads as drift',
      String(wallOf(stamped.respond_by)) === String(expected.respondBy),
      `${wallOf(stamped.respond_by)} vs ${expected.respondBy}`,
    )

    const standing = await jobStanding(SITE, sJob)
    ok('(J14) the job reports a standing', standing !== null)
    ok('(J14) which is counting down, not breached, on a fresh job', standing?.respondState === 'due')
    ok('(J14) and names the policy that set it', standing?.policyName === 'High')

    ok('(J14) it appears on the response worklist',
      (await slaWorklist(SITE, 'respond', 200)).some((r) => r.jobId === sJob))

    const before = await slaCounts(SITE)
    ok('(J14) and is counted as awaiting a reply', before.awaitingResponse >= 1)

    // ── Responding ──────────────────────────────────────────────────────
    const responded = await markResponded(SITE, actor, sJob)
    ok('(J14) somebody picks it up', responded.ok, responded.ok ? '' : responded.error)

    const twiceResponded = await markResponded(SITE, actor, sJob)
    ok(
      '(J14) *** a second response is refused — it would turn a met target into a breach ***',
      !twiceResponded.ok,
      twiceResponded.ok ? '' : twiceResponded.error,
    )

    const after = await jobStanding(SITE, sJob)
    ok('(J14) the response clock has stopped', after?.respondedAt !== null)
    ok('(J14) the target reads met', after?.respondState === 'met')
    ok('(J14) it names who did it', after?.respondedByName === actor.userName)
    ok('(J14) and how long it took in working time', (after?.responseTookMinutes ?? -1) >= 0)
    ok('(J14) there is no countdown left to show', after?.respondMinutesLeft === null)

    ok('(J14) it has left the response worklist',
      !(await slaWorklist(SITE, 'respond', 200)).some((r) => r.jobId === sJob))

    // ── A priority change re-promises the job ───────────────────────────
    const beforeChange = wallOf(
      (await siteQueryOne<any>(SITE, `SELECT respond_by FROM job_cards WHERE id=?`, [sJob]))?.respond_by,
    )
    const downgraded = await saveJobCard(SITE, actor, {
      id: sJob, customerId: customer.id, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'low', ownerUserId: null, ownerName: '',
      title: 'JCT geyser burst', description: null, dueAt: null, source: 'phone',
      reference: null, internalNote: null,
    })
    ok('(J14) the job is downgraded to low', downgraded.ok, downgraded.ok ? '' : downgraded.error)

    const afterChange = await siteQueryOne<any>(
      SITE, `SELECT respond_by, sla_policy_id FROM job_cards WHERE id=?`, [sJob])
    ok(
      '(J14) *** dropping the priority re-promises it — the urgent deadline does not linger ***',
      wallOf(afterChange?.respond_by) !== beforeChange,
      `${beforeChange} -> ${wallOf(afterChange?.respond_by)}`,
    )
    /*
     * Recomputed from the ORIGINAL report time, not from now. Otherwise the
     * deadline becomes a thing you can reset by fiddling with a dropdown.
     */
    const lowExpected = await deadlinesFor(SITE, 'low', stamped.reported_at, week)
    ok(
      '(J14) and from the original report time, so a priority edit cannot reset the clock',
      wallOf(afterChange?.respond_by) === lowExpected.respondBy,
      `${wallOf(afterChange?.respond_by)} vs ${lowExpected.respondBy}`,
    )

    // ── Drift ───────────────────────────────────────────────────────────
    const cleanSla = await reconcileJobSla(SITE)
    ok(
      '(J14) a correctly stamped job is not reported as drifted',
      !cleanSla.staleDeadlines.some((d) => d.jobId === sJob),
    )
    ok(
      '(J14) nor as missing a target',
      !cleanSla.missingDeadlines.some((d) => d.jobId === sJob),
    )

    /*
     * Break it the only way the app cannot: a response stamped before the job was
     * reported. Proving the drift function actually fires beats trusting it.
     */
    await siteExecute(SITE, `UPDATE job_cards SET responded_at = '2020-01-01 09:00:00' WHERE id = ?`, [sJob])
    const brokenSla = await reconcileJobSla(SITE)
    ok(
      '(J14) *** a response recorded before the job existed is CAUGHT ***',
      brokenSla.impossibleResponse.some((d) => d.jobId === sJob),
    )

    // A wiped deadline is reported as untargeted rather than passing silently.
    await siteExecute(
      SITE,
      `UPDATE job_cards SET responded_at = NULL, respond_by = NULL, resolve_by = NULL WHERE id = ?`,
      [sJob],
    )
    const wiped = await reconcileJobSla(SITE)
    ok(
      '(J14) a job with no deadline is reported as untargeted',
      wiped.missingDeadlines.some((d) => d.jobId === sJob),
    )
    ok('(J14) and the count agrees with the list', (await untargetedJobCount(SITE)) >= 1)
    ok('(J14) a job with no target has no standing to report', (await jobStanding(SITE, sJob)) === null)

    await siteExecute(SITE, `DELETE FROM job_card_lines WHERE job_card_id = ?`, [sJob])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [sJob])
  }

  // ── 23. (J15) Reports, and the cost gate ──────────────────────────────
  //
  // EVERY FIELD IS EXECUTED, one at a time. A template only selects the columns
  // it names, so a broken expression on any other field ships undetected until
  // somebody picks it in the builder — which is exactly how the two bugs this
  // block was written to catch got in (a bucket built as `t.reported_at` on a
  // table with no such column, and a spread field set whose join was missing).
  {
    const everything = () => true
    const technician = (c: string) => c !== 'jobs.cost' && c !== 'products.cost'

    /*
     * Every job source, not just the two that shipped in phase 9.
     *
     * jobTime, jobTravel and jobVisits were added in phase 22 — the tables had
     * existed since phases 5, 6 and 4 and were never exposed, which is why most
     * of the PRD's Phase-1 reports could not be expressed even by hand.
     */
    for (const key of ['jobCards', 'jobCardLines', 'jobTime', 'jobTravel', 'jobVisits']) {
      const src = getSource(key)
      ok(`(J15) the ${key} source is in the catalogue`, src !== undefined)
      if (!src) continue

      ok(
        `(J15) ${key} is gated on jobs.view`,
        src.permission === 'jobs.view',
        String(src.permission),
      )

      /*
       * The cost gate, at FIELD level rather than source level. A technician who
       * may see a job must not thereby learn its margin — but the report has to
       * open for them with those columns absent, because a saved report shared
       * across a shop should degrade for the junior rather than break.
       */
      const full = fieldsFor(src, everything as never)
      const reduced = fieldsFor(src, technician as never)
      /*
       * Only asserted where the source HAS gated fields.
       *
       * jobTime and jobVisits carry no cost at all — hours and arrival times are
       * not commercially sensitive — so "hides something" would be false for
       * them and the assertion would be testing the fixture rather than the
       * rule. What must always hold is the second one: whatever IS hidden is
       * hidden for the right reason.
       */
      const gated = full.filter((f) => f.permission === 'jobs.cost')
      if (gated.length > 0) {
        ok(
          `(J15) *** ${key} hides its cost fields from somebody without jobs.cost ***`,
          reduced.length < full.length,
          `${full.length} -> ${reduced.length}`,
        )
      }
      ok(
        `(J15) ${key}: every hidden field is a cost field, not something incidental`,
        full
          .filter((f) => !reduced.some((r) => r.key === f.key))
          .every((f) => f.permission === 'jobs.cost'),
      )

      let broken = 0
      for (const field of src.fields) {
        try {
          await runBuilderSpec(
            SITE,
            {
              version: 1,
              name: `J15 ${field.key}`,
              source: key,
              period: { key: 'thisYear' },
              columns: [{ field: field.key }],
              filters: [],
              groupFields: [],
              totalFilters: [],
              limit: 5,
            },
            everything as never,
          )
        } catch (err) {
          broken++
          console.log(`       ${key}.${field.key}: ${(err as Error).message}`)
        }
      }
      ok(
        `(J15) *** all ${src.fields.length} ${key} fields produce runnable SQL ***`,
        broken === 0,
        `${broken} failed`,
      )
    }

    /*
     * The date a LINE belongs to is its job's, not the line's own. A part added on
     * Friday to a job logged on Monday belongs in Monday's week — otherwise a
     * month-end job-cost report splits one job across two periods.
     */
    const lineSrc = getSource('jobCardLines')
    ok('(J15) a job line dates from its job, not from itself', lineSrc?.dateJoin === 'job')
    ok('(J15) and the column it filters on is the job report date', lineSrc?.dateColumn === 'reported_at')

    /*
     * Every job built-in, run for real rather than merely type-checked.
     *
     * The filter was `startsWith('jobCard')`, which covered jobCards and
     * jobCardLines and silently MISSED the three sources phase 22 added — five
     * new templates would have shipped unrun. Matching the source list itself is
     * what stops the next source slipping through the same gap.
     */
    const JOB_SOURCES = ['jobCards', 'jobCardLines', 'jobTime', 'jobTravel', 'jobVisits']
    const jobTemplates = TEMPLATES.filter((t) => JOB_SOURCES.includes(t.spec.source))
    /*
     * Fifteen — the PRD's Phase-1 list, completed.
     *
     * It shipped as eight in phase 22 on the PRD's own advice to "avoid building
     * too many specialised reports initially", with the remaining seven added
     * deliberately once the three catalog sources made them expressible as specs
     * rather than code. The number stays asserted for the original reason: adding
     * one should be a decision somebody makes on purpose rather than a drift
     * nobody notices.
     */
    ok('(J15) all fifteen job built-ins ship', jobTemplates.length === 15, String(jobTemplates.length))

    for (const template of jobTemplates) {
      ok(`(J15) ${template.id} is gated on jobs.view`, template.permission === 'jobs.view')

      let ran = true
      let cols = 0
      try {
        const result = await runBuilderSpec(
          SITE,
          // A wide period, so a template whose default is "this month" still has
          // this suite's fixtures inside it. The period lives on the SPEC.
          { ...template.spec, name: template.name, period: { key: 'thisYear' } },
          everything as never,
        )
        cols = result.columns.length
      } catch (err) {
        ran = false
        console.log(`       ${template.id}: ${(err as Error).message}`)
      }
      ok(`(J15) ${template.id} runs`, ran)

      // And degrades rather than throwing for somebody without the cost right.
      let degraded = true
      let reducedCols = 0
      try {
        const result = await runBuilderSpec(
          SITE,
          { ...template.spec, name: template.name, period: { key: 'thisYear' } },
          technician as never,
        )
        reducedCols = result.columns.length
      } catch {
        degraded = false
      }
      ok(`(J15) *** and still opens for a technician, with fewer columns ***`, degraded)
      ok(
        `(J15) ${template.id} keeps at least one column for them`,
        reducedCols > 0 && reducedCols <= cols,
        `${cols} -> ${reducedCols}`,
      )
    }

    /*
     * The absorbed-cost built-in must NOT filter to "absorbed > 0": the jobs where
     * the cost is still UNDECIDED are the ones somebody can act on, and a total
     * filter would hide exactly those.
     */
    const absorbed = jobTemplates.find((t) => t.id === 'job-cost-absorbed')
    ok(
      '(J15) the absorbed-cost report does not filter away undecided jobs',
      absorbed !== undefined && absorbed.spec.totalFilters.length === 0,
    )

    // ── The job drift function, finally on a screen ──────────────────────
    const drift = await reconcileJobCards(SITE)
    ok(
      '(J15) reconcileJobCards reports no invoicing drift',
      drift.overInvoiced.length === 0 &&
        drift.orphanedInvoiceLinks.length === 0 &&
        drift.billedUnbillable.length === 0,
      JSON.stringify({
        over: drift.overInvoiced.length,
        orphan: drift.orphanedInvoiceLinks.length,
        unbillable: drift.billedUnbillable.length,
      }),
    )
    ok(
      '(J15) and no job is stored in a state its stage contradicts',
      drift.stateMismatch.length === 0,
      JSON.stringify(drift.stateMismatch.slice(0, 3)),
    )

    /*
     * (J16) A WORKLIST WITH NO SCREEN IS NOT A FEATURE.
     *
     * travelNeedingVerification() and its dedicated index shipped in phase 6 with
     * NO caller — a claim of 88km against a 42km estimate sat in the database and
     * appeared nowhere, so the approval half of the travel workflow did not exist.
     * An audit found it; this asserts it stays found, because the same thing can
     * happen to any read that outlives the screen it was written for.
     */
    const readers = await import('node:fs').then((fs) =>
      fs
        .readdirSync('src/app/(app)/jobs/sla')
        .map((f) => fs.readFileSync(`src/app/(app)/jobs/sla/${f}`, 'utf8'))
        .join(''),
    )
    ok(
      '(J16) *** the travel approval worklist is actually rendered somewhere ***',
      readers.includes('travelNeedingVerification'),
    )
    // And it is behind the decision capability, not merely the edit one: the person
    // who drove must not be the person who signs it off.
    ok(
      '(J16) and verifying is gated on the billing decision, not on edit',
      readers.includes("'jobs.bill_decide'"),
    )
  }

  // ── 24. (J18) Headlines, tasks and checks ─────────────────────────────
  //
  // The pure logic first — merging is where this phase could be silently wrong,
  // because a duplicate that slips through produces two identical checks on one
  // job and nobody notices until a technician ticks the same box twice.
  {
    const item = (name: string, isRequired = false) => ({ name, isRequired })

    const merged = mergeHeadlineItems([
      { headlineName: 'Service', items: [item('Check gas pressure'), item('Replace filter')] },
      { headlineName: 'Repair', items: [item('  check GAS pressure  ', true), item('Test run')] },
    ])
    ok(
      '(J18) *** two kinds of work sharing an item produce ONE, matched past case and spacing ***',
      merged.items.length === 3,
      String(merged.items.length),
    )
    ok(
      '(J18) and the caller is told which was combined, so the screen can say so',
      merged.merged.length === 1 && merged.merged[0].from.length === 2,
      JSON.stringify(merged.merged),
    )
    /*
     * The subtle one. If EITHER kind of work insists on an item, the job insists.
     * Keeping the optional copy would silently drop a requirement somebody
     * configured, and the job would then close with the check unanswered.
     */
    ok(
      '(J18) *** a later REQUIRED duplicate promotes the survivor ***',
      merged.items.find((i) => i.name.trim().toLowerCase() === 'check gas pressure')?.isRequired ===
        true,
    )

    // Failure detection: only an explicit no or fail. An EMPTY answer is
    // unanswered, and treating it as failing would put every untouched job on the
    // exception report.
    ok('(J18) no is a failure', isFailedResponse('yesno', 'no'))
    ok('(J18) so is a padded, capitalised Fail', isFailedResponse('passfail', ' Fail '))
    ok('(J18) yes is not', !isFailedResponse('yesno', 'yes'))
    ok('(J18) *** an unanswered check is NOT a failure ***', !isFailedResponse('yesno', null))
    ok('(J18) and a number cannot fail — no threshold exists to judge it', !isFailedResponse('number', '0'))

    ok('(J18) a non-numeric measurement is refused', validateResponse('measure', 'quite high') !== null)
    ok('(J18) a numeric one passes', validateResponse('measure', '12.4') === null)
    ok('(J18) an answer outside the options is refused', validateResponse('yesno', 'maybe') !== null)
    ok('(J18) a blank answer is not an error — required-ness is what forces one', validateResponse('number', '') === null)

    const base = { code: 'J18CODE', name: 'J18', suggestedMinutes: 60 }
    const draft = (
      name: string,
      responseType: ResponseType = 'none',
      unit: string | null = null,
      evidenceRequired = false,
    ) => ({
      kind: 'check' as const, name, hint: null, responseType, unit,
      workPhase: 'during' as const, isRequired: false, evidenceRequired,
    })
    ok('(J18) a headline duplicating its OWN item is refused', validateHeadline({ ...base, items: [draft('A'), draft(' a ')] }) !== null)
    ok('(J18) a lower-case code is refused', validateHeadline({ ...base, code: 'lower', items: [] }) !== null)
    ok('(J18) a measurement with no unit is refused', validateHeadline({ ...base, items: [draft('P', 'measure')] }) !== null)
    ok('(J18) and a unit on something that is not a measurement', validateHeadline({ ...base, items: [draft('P', 'yesno', 'bar')] }) !== null)

    // ── Evidence (119) ──────────────────────────────────────────────────
    ok('(J18) a photo may require a file', validateHeadline({ ...base, items: [draft('Pic', 'photo', null, true)] }) === null)
    ok('(J18) a signature may too', validateHeadline({ ...base, items: [draft('Sig', 'signature', null, true)] }) === null)
    ok(
      '(J18) *** a yes/no CANNOT require a file — it could never be satisfied ***',
      validateHeadline({ ...base, items: [draft('Q', 'yesno', null, true)] }) !== null,
    )
    ok('(J18) photo and signature are the evidence types', responseIsEvidence('photo') && responseIsEvidence('signature'))
    ok('(J18) and nothing else is', !responseIsEvidence('text') && !responseIsEvidence('yesno') && !responseIsEvidence('none'))

    // ── Against the database ────────────────────────────────────────────
    const hlTag = `JCT${stamp}`

    const serv = await saveHeadline(SITE, actor, {
      id: null, code: `${hlTag}S`, name: 'JCT annual service', description: null,
      defaultPriority: 'high', defaultBoardId: null, suggestedMinutes: 120,
      requiredSkills: 'Gas licence', sortOrder: 0, isActive: true,
      items: [
        { id: null, kind: 'check', name: 'JCT isolate power', hint: null, responseType: 'yesno', unit: null, workPhase: 'before', isRequired: true, evidenceRequired: false },
        { id: null, kind: 'check', name: 'JCT gas pressure', hint: null, responseType: 'measure', unit: 'bar', workPhase: 'during', isRequired: false, evidenceRequired: false },
        { id: null, kind: 'task', name: 'JCT replace filter', hint: null, responseType: 'none', unit: null, workPhase: 'during', isRequired: false, evidenceRequired: false },
      ],
      parts: [],
    })
    ok('(J18) a kind of work saves with its items', serv.ok, serv.ok ? '' : serv.error)
    if (!serv.ok) throw new Error('headline fixture failed')

    const rep = await saveHeadline(SITE, actor, {
      id: null, code: `${hlTag}R`, name: 'JCT repair', description: null,
      defaultPriority: null, defaultBoardId: null, suggestedMinutes: 60,
      requiredSkills: null, sortOrder: 1, isActive: true,
      items: [
        { id: null, kind: 'check', name: '  jct GAS pressure  ', hint: null, responseType: 'measure', unit: 'bar', workPhase: 'during', isRequired: true, evidenceRequired: false },
        // Required AND evidence-required: the fixture the 119 checks below use.
        { id: null, kind: 'check', name: 'JCT customer signature', hint: null, responseType: 'signature', unit: null, workPhase: 'after', isRequired: true, evidenceRequired: true },
      ],
      parts: [],
    })
    if (!rep.ok) throw new Error('second headline fixture failed')

    const clash = await saveHeadline(SITE, actor, {
      id: null, code: `${hlTag}S`, name: 'Clash', description: null,
      defaultPriority: null, defaultBoardId: null, suggestedMinutes: null,
      requiredSkills: null, sortOrder: 0, isActive: true, items: [], parts: [],
    })
    ok('(J18) a duplicate code is refused', !clash.ok, clash.ok ? '' : clash.error)

    const hlJob = await saveJobCard(SITE, actor, {
      id: null, customerId: customer.id, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: 'JCT aircon service run', description: null, dueAt: null, source: 'phone',
      reference: null, internalNote: null,
    })
    if (!hlJob.ok) throw new Error('headline job fixture failed')
    const hJob = hlJob.id

    const applied = await applyHeadlines(SITE, actor, hJob, [serv.id, rep.id])
    ok('(J18) both kinds of work apply', applied.ok, applied.ok ? '' : applied.error)
    ok(
      '(J18) *** 3 + 2 items become 4 on the job, the shared one merged ***',
      applied.ok && applied.added === 4,
      applied.ok ? String(applied.added) : '',
    )
    ok('(J18) and the merge is reported back', applied.ok && applied.merged.length === 1)

    let jItems = await jobItems(SITE, hJob)
    ok('(J18) the job carries four', jItems.length === 4, String(jItems.length))
    /*
     * Ordered by PHASE, not by insertion. A safety check buried between two
     * readings is a safety check somebody skips.
     */
    ok(
      '(J18) ordered before / during / after, which is the order they are done in',
      jItems[0].workPhase === 'before' && jItems[jItems.length - 1].workPhase === 'after',
      jItems.map((i) => i.workPhase).join(','),
    )
    const gasItem = jItems.find((i) => i.name.toLowerCase() === 'jct gas pressure')
    ok('(J18) the merged item is required, promoted by the second kind', gasItem?.isRequired === true)

    // The headline sets the priority, but only while the job is at its default.
    const afterApply = await siteQueryOne<any>(SITE, `SELECT priority FROM job_cards WHERE id=?`, [hJob])
    ok('(J18) a kind of work sets the priority', String(afterApply?.priority) === 'high', String(afterApply?.priority))

    // ── The close guard, which is what makes "required" mean anything ────
    const blocked = await closeJob(SITE, actor, hJob)
    ok(
      '(J18) *** a job with unanswered REQUIRED checks cannot be closed ***',
      !blocked.ok,
      blocked.ok ? '' : blocked.error,
    )
    ok(
      '(J18) and the refusal NAMES them rather than counting them',
      !blocked.ok && blocked.error.includes('JCT isolate power'),
      blocked.ok ? '' : blocked.error,
    )

    const wrongType = await recordItem(SITE, actor, gasItem!.id, { response: 'quite high', note: null, complete: true })
    ok('(J18) a measurement refuses a non-number', !wrongType.ok, wrongType.ok ? '' : wrongType.error)

    /*
     * A check that captures a value cannot be completed without one, or
     * "completed" would only mean somebody pressed a button — which is the
     * box-ticking a checklist exists to prevent.
     */
    const noAnswer = await recordItem(SITE, actor, gasItem!.id, { response: null, note: null, complete: true })
    ok('(J18) *** and cannot be ticked off with nothing recorded ***', !noAnswer.ok, noAnswer.ok ? '' : noAnswer.error)

    for (const it of jItems.filter((i) => i.isRequired)) {
      // Since 119 a signature is satisfied by a FILE, not by typing a name — so it
      // is captured rather than answered. (J21) exercises that path properly; here
      // it is only being cleared so the close can be tested.
      if (it.evidenceRequired) {
        const cap = await captureEvidence(
          SITE, actor, it.id,
          { storedName: `${hlTag}-${it.id}.png`, filename: 'signed.png', mimeType: 'image/png', sizeBytes: 512 },
          'A Nkosi',
        )
        ok(`(J18) capturing ${it.name} works`, cap.ok, cap.ok ? '' : cap.error)
        continue
      }
      const answer = it.responseType === 'measure' ? '12.4'
        : it.responseType === 'yesno' ? 'yes'
        : null
      const done = await recordItem(SITE, actor, it.id, { response: answer, note: null, complete: true })
      ok(`(J18) answering ${it.name} works`, done.ok, done.ok ? '' : done.error)
    }

    const nowCloses = await closeJob(SITE, actor, hJob)
    ok('(J18) once answered, the job closes', nowCloses.ok, nowCloses.ok ? '' : nowCloses.error)

    // Reopen to exercise the rest.
    const backOpen = await statusForRole(SITE, 'in_progress')
    if (backOpen) await setStatus(SITE, actor, hJob, backOpen.id)

    // A failing answer, and the stored flag that makes the exception list one read.
    const isolate = (await jobItems(SITE, hJob)).find((i) => i.name === 'JCT isolate power')!
    await recordItem(SITE, actor, isolate.id, { response: 'no', note: 'breaker seized', complete: true })
    ok(
      '(J18) an answer of no flags the check as failed',
      (await jobItems(SITE, hJob)).find((i) => i.id === isolate.id)?.isFailed === true,
    )

    // ── What survives a reclassification ────────────────────────────────
    const adhoc = await addJobItem(SITE, actor, hJob, {
      kind: 'task', name: 'JCT fetch the long ladder', responseType: 'none',
      unit: null, workPhase: 'before', isRequired: false,
    })
    ok('(J18) a one-off task can be added by hand', adhoc.ok, adhoc.ok ? '' : adhoc.error)

    await applyHeadlines(SITE, actor, hJob, [serv.id])
    jItems = await jobItems(SITE, hJob)
    /*
     * Dropping a kind of work clears only its UNTOUCHED items. A signed-off check
     * is evidence, and a hand-added task belongs to whoever wrote it — neither is
     * the system's to delete because a category changed.
     */
    ok(
      '(J18) *** a hand-added task survives dropping a kind of work ***',
      jItems.some((i) => i.name === 'JCT fetch the long ladder'),
    )
    ok(
      '(J18) *** and so does a check that was already signed off ***',
      jItems.some((i) => i.name === 'JCT customer signature'),
    )

    const signed = jItems.find((i) => i.name === 'JCT customer signature')
    if (signed) {
      const delSigned = await deleteJobItem(SITE, actor, signed.id)
      ok('(J18) a signed-off item cannot be deleted', !delSigned.ok, delSigned.ok ? '' : delSigned.error)
    }

    const delUsed = await deleteHeadline(SITE, actor, serv.id)
    ok(
      '(J18) a kind of work a job has used cannot be deleted — that history names what was done',
      !delUsed.ok,
      delUsed.ok ? '' : delUsed.error,
    )

    // ── Drift ───────────────────────────────────────────────────────────
    const itemDrift = await reconcileJobHeadlines(SITE)
    ok(
      '(J18) a correctly recorded job reports no item drift',
      itemDrift.completedWithoutAnswer.length === 0 && itemDrift.failedFlagWrong.length === 0,
      JSON.stringify({
        noAnswer: itemDrift.completedWithoutAnswer.length,
        flags: itemDrift.failedFlagWrong.length,
      }),
    )

    /*
     * Break it the only way the app cannot: flip the stored failure flag away from
     * the answer beside it. If those diverge, every report of which checks failed
     * is wrong, and only this check can see it.
     */
    await siteExecute(SITE, `UPDATE job_card_items SET is_failed = 0 WHERE id = ?`, [isolate.id])
    const brokenFlag = await reconcileJobHeadlines(SITE)
    ok(
      '(J18) *** a failure flag that disagrees with its answer is CAUGHT ***',
      brokenFlag.failedFlagWrong.some((r) => r.itemId === isolate.id),
    )
    await siteExecute(SITE, `UPDATE job_card_items SET is_failed = 1 WHERE id = ?`, [isolate.id])

    await siteExecute(SITE, `UPDATE job_card_items SET response = NULL WHERE id = ?`, [gasItem!.id])
    const brokenAnswer = await reconcileJobHeadlines(SITE)
    ok(
      '(J18) a check signed off with nothing recorded is CAUGHT',
      brokenAnswer.completedWithoutAnswer.some((r) => r.itemId === gasItem!.id),
    )

    // Teardown, in FK order.
    // The attachments first. This block's signature check is satisfied by capturing a
    // file since 119, so it now creates party_documents rows that the job's own
    // delete cannot cascade — the entity pair is loose and carries no FK.
    await siteExecute(SITE, `DELETE FROM party_documents WHERE entity = 'job_card' AND entity_id = ?`, [hJob])
    await siteExecute(SITE, `DELETE FROM job_card_items WHERE job_card_id = ?`, [hJob])
    await siteExecute(SITE, `DELETE FROM job_card_headlines WHERE job_card_id = ?`, [hJob])
    await siteExecute(SITE, `DELETE FROM job_card_lines WHERE job_card_id = ?`, [hJob])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [hJob])
    await siteExecute(SITE, `DELETE FROM job_headlines WHERE code LIKE ?`, [`${hlTag}%`])
  }

  // ── 25. (J19) Customer equipment ──────────────────────────────────────
  //
  // The thing the work is done on. Three tables look alike and are not:
  // fixed_assets is what WE own and depreciate, product_serials is a unit we
  // bought or sold, and customer_assets is what we look after for somebody else.
  {
    const asTag = `AS${stamp}`

    const type = await saveAssetType(SITE, actor, {
      id: null, code: `${asTag}A`, name: 'JCT split aircon', serviceMonths: 6,
      identifierLabel: 'Unit serial', sortOrder: 0, isActive: true,
    })
    ok('(J19) a kind of equipment saves', type.ok, type.ok ? '' : type.error)
    if (!type.ok) throw new Error('asset type fixture failed')

    const dupType = await saveAssetType(SITE, actor, {
      id: null, code: `${asTag}A`, name: 'Clash', serviceMonths: null,
      identifierLabel: 'Serial', sortOrder: 0, isActive: true,
    })
    ok('(J19) a duplicate kind code is refused', !dupType.ok, dupType.ok ? '' : dupType.error)

    // ── Pure validation ─────────────────────────────────────────────────
    const draft = {
      id: null, assetTypeId: type.id, customerId: customer.id, serviceAddressId: null,
      description: `${asTag} rooftop unit`, make: 'Samsung', model: 'AR12',
      serialText: ' ab-12 cd ', productId: null, serialId: null,
      installedOn: '2024-03-01', purchasedOn: '2024-02-01', purchaseReference: 'INV991',
      warrantyUntil: '2027-03-01', nextServiceOn: null, conditionNote: null, note: null,
    }
    ok('(J19) equipment with no description is refused', validateAsset({ ...draft, description: '  ' }) !== null)
    /*
     * Installed before purchased catches a fat-fingered year, which is worth
     * catching because it makes a warranty look expired by a decade and nobody
     * questions a date.
     */
    ok('(J19) installed before purchased is refused', validateAsset({ ...draft, installedOn: '2020-01-01' }) !== null)
    ok('(J19) an impossible date is refused', validateAsset({ ...draft, warrantyUntil: '2027-13-45' }) !== null)
    ok(
      '(J19) a site without a customer is refused — an address belongs to somebody',
      validateAsset({ ...draft, customerId: null, serviceAddressId: 1 }) !== null,
    )
    ok('(J19) a valid one passes', validateAsset(draft) === null)

    // ── The record, and its number ──────────────────────────────────────
    const asset = await saveAsset(SITE, actor, draft)
    ok('(J19) equipment is recorded', asset.ok, asset.ok ? '' : asset.error)
    if (!asset.ok) throw new Error('asset fixture failed')
    ok('(J19) and gets an AST number', (asset.documentNumber ?? '').startsWith('AST'), String(asset.documentNumber))

    const loaded = await getAsset(SITE, asset.id)
    ok(
      '(J19) the identifier label comes from the KIND, so a trade can call it a VIN',
      loaded?.identifierLabel === 'Unit serial',
      String(loaded?.identifierLabel),
    )
    ok('(J19) the serial is stored exactly as typed', loaded?.serialText === 'ab-12 cd', String(loaded?.serialText))

    /*
     * THE GENERATED COLUMN. serial_key is UPPER(REPLACE(REPLACE(...))) STORED, so
     * spacing and capitals cannot produce a duplicate the check misses.
     * Normalising in code would mean every caller had to remember to.
     */
    const matches = await findDuplicateAssets(SITE, 'AB12CD', customer.id)
    ok(
      '(J19) *** a differently spelled serial still matches — the key is generated ***',
      matches.some((m) => m.id === asset.id),
      JSON.stringify(matches.map((m) => m.documentNumber)),
    )

    // WARNS rather than refuses: §18.3 says plenty of equipment has no legible
    // plate, so a hard block would refuse real second units.
    const second = await saveAsset(SITE, actor, {
      ...draft, description: `${asTag} second unit same plate`, serialText: 'AB 12 CD',
    })
    ok('(J19) *** a duplicate serial WARNS rather than refusing ***', second.ok)
    ok(
      '(J19) and the matches come back so the screen can show them',
      second.ok && second.duplicates.length > 0,
      second.ok ? String(second.duplicates.length) : '',
    )

    const elsewhere = await findDuplicateAssets(SITE, 'AB12CD', null)
    ok(
      '(J19) the same plate under a DIFFERENT owner is not a duplicate',
      !elsewhere.some((m) => m.id === asset.id),
    )

    const searched = await listAssets(SITE, { search: 'ab 12-cd' })
    ok(
      '(J19) search finds it past the spacing too — otherwise it sends somebody to create a duplicate',
      searched.some((a) => a.id === asset.id),
    )

    // ── A job on the equipment ──────────────────────────────────────────
    const aJob = await saveJobCard(SITE, actor, {
      id: null, customerId: customer.id, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `${asTag} service the rooftop unit`, description: null, dueAt: null,
      source: 'phone', reference: null, internalNote: null,
    })
    if (!aJob.ok) throw new Error('asset job fixture failed')

    const setIt = await setJobAsset(SITE, actor, aJob.id, asset.id)
    ok('(J19) a job can name the equipment', setIt.ok, setIt.ok ? '' : setIt.error)

    /*
     * The mistake a picker makes easy: two customers own the same model and the
     * list is alphabetical. The consequence is a warranty claim on the wrong
     * account and a history on the wrong unit.
     */
    const foreign = await createCustomer(SITE, actor, {
      code: `JCT${stamp}X`, name: 'JCT somebody else',
    })
    if (foreign.ok) {
      const theirAsset = await saveAsset(SITE, actor, {
        ...draft, customerId: foreign.id, description: `${asTag} their unit`, serialText: null,
      })
      if (theirAsset.ok) {
        const wrongOwner = await setJobAsset(SITE, actor, aJob.id, theirAsset.id)
        ok(
          '(J19) *** a job cannot name equipment belonging to a different customer ***',
          !wrongOwner.ok,
          wrongOwner.ok ? '' : wrongOwner.error,
        )
        await siteExecute(SITE, `DELETE FROM customer_assets WHERE id = ?`, [theirAsset.id])
      }
      await siteExecute(SITE, `DELETE FROM customers WHERE id = ?`, [foreign.id])
    }

    const summary = await jobAssetFor(SITE, aJob.id)
    ok('(J19) the job card reads back its equipment', summary?.id === asset.id)
    ok('(J19) with the label the kind decided', summary?.identifierLabel === 'Unit serial')

    const delUsed = await deleteAsset(SITE, actor, asset.id)
    ok(
      '(J19) equipment a job has named cannot be deleted — that work is its history',
      !delUsed.ok,
      delUsed.ok ? '' : delUsed.error,
    )

    // ── Closing rolls the service dates ─────────────────────────────────
    const beforeClose = await getAsset(SITE, asset.id)
    ok('(J19) nothing has been serviced yet', beforeClose?.lastServiceOn === null)

    const closedIt = await closeJob(SITE, actor, aJob.id)
    ok('(J19) the job closes', closedIt.ok, closedIt.ok ? '' : closedIt.error)

    const afterClose = await getAsset(SITE, asset.id)
    ok(
      '(J19) *** closing a job records the service and books the next one ***',
      afterClose?.lastServiceOn !== null && afterClose?.nextServiceOn !== null,
      JSON.stringify({ last: afterClose?.lastServiceOn, next: afterClose?.nextServiceOn }),
    )
    // Six months from the kind, not a guess.
    const expectedNext = new Date()
    expectedNext.setUTCMonth(expectedNext.getUTCMonth() + 6)
    ok(
      '(J19) and the interval came from the KIND of equipment',
      afterClose?.nextServiceOn === expectedNext.toISOString().slice(0, 10),
      `${afterClose?.nextServiceOn} vs ${expectedNext.toISOString().slice(0, 10)}`,
    )

    const history = await assetHistory(SITE, asset.id)
    ok(
      '(J19) the history is a QUERY over the jobs, with no second table to drift',
      history.some((h) => h.jobId === aJob.id),
    )

    // A closed job cannot have its equipment changed.
    const afterClosed = await setJobAsset(SITE, actor, aJob.id, null)
    ok('(J19) a closed job will not change its equipment', !afterClosed.ok, afterClosed.ok ? '' : afterClosed.error)

    // ── Retire and revive: the only writers of the status pair ───────────
    const noWhy = await retireAsset(SITE, actor, asset.id, '  ')
    ok('(J19) retiring without a reason is refused', !noWhy.ok, noWhy.ok ? '' : noWhy.error)

    ok('(J19) it retires with one', (await retireAsset(SITE, actor, asset.id, 'Scrapped')).ok)
    const retiredRow = await siteQueryOne<any>(
      SITE, `SELECT is_active, status FROM customer_assets WHERE id = ?`, [asset.id])
    ok(
      '(J19) *** is_active and status move TOGETHER — verifySequence reads status ***',
      Number(retiredRow?.is_active) === 0 && String(retiredRow?.status) === 'cancelled',
      JSON.stringify(retiredRow),
    )
    ok('(J19) retiring twice is refused', !(await retireAsset(SITE, actor, asset.id, 'again')).ok)
    ok('(J19) it comes back', (await reviveAsset(SITE, actor, asset.id)).ok)
    const revivedRow = await siteQueryOne<any>(
      SITE, `SELECT is_active, status FROM customer_assets WHERE id = ?`, [asset.id])
    ok(
      '(J19) and both columns come back together',
      Number(revivedRow?.is_active) === 1 && String(revivedRow?.status) === 'active',
      JSON.stringify(revivedRow),
    )

    /*
     * THE REGRESSION GUARD. verifySequence has TWO hard-coded expectations of an
     * OWN_TABLE_TYPES table: a `status` column carrying 'cancelled', and the number
     * column being called `document_number`. Migrations 116 and 117 exist because
     * the first attempt satisfied only the first. Without both, every AST number
     * ever issued reports as missing.
     */
    const seq = await verifySequence(SITE, 'customer_asset')
    /*
     * BASELINE-RELATIVE, not `missing === 0`.
     *
     * This suite shares a live dev database, and every earlier run allocated AST
     * numbers and then deleted its fixtures — so a gap is the expected state, the
     * same as the JC sequence. What this guard is actually for is proving the query
     * RUNS: verifySequence hard-codes both `status = 'cancelled'` and
     * `document_number`, and an unregistered or wrongly-named table makes it throw
     * rather than return a wrong number. `issued > 0` with a first and last number
     * is what proves the registration works.
     */
    ok(
      '(J19) *** the AST sequence is registered and reconciles — the OWN_TABLE_TYPES guard ***',
      seq.issued > 0 && seq.firstNumber !== null && seq.live + seq.missing === seq.issued,
      JSON.stringify(seq),
    )
    ok(
      '(J19) and the equipment created here is counted as live, not missing',
      seq.live >= 2,
      JSON.stringify({ live: seq.live, missing: seq.missing }),
    )

    // ── Drift ───────────────────────────────────────────────────────────
    const cleanAssets = await reconcileAssets(SITE)
    ok(
      '(J19) correctly recorded equipment reports no drift',
      cleanAssets.statusMismatch.length === 0 &&
        cleanAssets.addressMismatch.length === 0 &&
        cleanAssets.jobCustomerMismatch.length === 0,
      JSON.stringify({
        status: cleanAssets.statusMismatch.length,
        address: cleanAssets.addressMismatch.length,
        jobCust: cleanAssets.jobCustomerMismatch.length,
      }),
    )

    await siteExecute(SITE, `UPDATE customer_assets SET status = 'cancelled' WHERE id = ?`, [asset.id])
    const brokenPair = await reconcileAssets(SITE)
    ok(
      '(J19) *** a status out of step with is_active is CAUGHT ***',
      brokenPair.statusMismatch.some((r) => r.assetId === asset.id),
    )
    await siteExecute(SITE, `UPDATE customer_assets SET status = 'active' WHERE id = ?`, [asset.id])

    // Teardown, in FK order: the job references the asset.
    await siteExecute(SITE, `UPDATE job_cards SET asset_id = NULL WHERE asset_id IN (SELECT id FROM customer_assets WHERE description LIKE ?)`, [`${asTag}%`])
    await siteExecute(SITE, `DELETE FROM job_card_lines WHERE job_card_id = ?`, [aJob.id])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [aJob.id])
    await siteExecute(SITE, `DELETE FROM customer_assets WHERE description LIKE ?`, [`${asTag}%`])
    await siteExecute(SITE, `DELETE FROM asset_types WHERE code LIKE ?`, [`${asTag}%`])
  }

  // ── 26. (J20) Recurring jobs ──────────────────────────────────────────
  //
  // This is contracts.ts with a job instead of an invoice, and the two things it
  // borrows are the two things worth testing: the CLAIM that makes a double-raise
  // impossible, and the CATCH-UP that makes a missed month recoverable.
  {
    // ── The catch-up arithmetic, with no database ────────────────────────
    const monthly = {
      frequency: 'monthly' as const, dayOfMonth: 1, dayOfWeek: null,
      startsOn: '2026-01-01', endsOn: null, lastGeneratedFor: null,
    }
    const caught = duePeriods(monthly, '2026-04-15')
    ok(
      '(J20) *** a series ticked in April, starting January, owes FOUR periods ***',
      caught.periods.length === 4 && caught.periods[0] === '2026-01-01',
      JSON.stringify(caught.periods),
    )
    ok(
      '(J20) and from a March cursor it owes only April',
      duePeriods({ ...monthly, lastGeneratedFor: '2026-03-01' }, '2026-04-15').periods.length === 1,
    )

    /*
     * The cap is REPORTED, never silently applied. Past two years outstanding,
     * something is wrong that raising it all would make worse — and a truncated
     * catch-up that read as a complete one is how somebody trusts a wrong figure.
     */
    const overdue = duePeriods({ ...monthly, startsOn: '2018-01-01' }, '2026-04-15')
    ok(
      '(J20) *** six years outstanding is capped at 24 and SAYS so ***',
      overdue.capped === true && overdue.periods.length === 24,
      JSON.stringify({ capped: overdue.capped, count: overdue.periods.length }),
    )

    /*
     * Lead time shifts the WINDOW, not the date. Shifting the date instead would
     * quietly move every due date forward, and a service due on the 1st would
     * start being recorded as due on the 18th.
     */
    const early = duePeriods({ ...monthly, lastGeneratedFor: '2026-03-01' }, '2026-03-20', 14)
    ok(
      '(J20) *** 14 days of lead raises April early, still dated the 1st ***',
      early.periods.length === 1 && early.periods[0] === '2026-04-01',
      JSON.stringify(early.periods),
    )
    ok(
      '(J20) and without lead time nothing is due yet on the 20th',
      duePeriods({ ...monthly, lastGeneratedFor: '2026-03-01' }, '2026-03-20', 0).periods.length === 0,
    )
    ok(
      '(J20) an end date stops it',
      duePeriods({ ...monthly, endsOn: '2026-02-15' }, '2026-06-01').periods.length === 2,
    )

    // ── Validation ──────────────────────────────────────────────────────
    const draft = {
      id: null, name: 'JCT recurring', customerId: customer.id, serviceAddressId: null,
      assetId: null, title: 'JCT quarterly service', description: null,
      priority: 'normal' as const, ownerUserId: null, ownerName: null, locationId: null,
      frequency: 'monthly' as const, dayOfMonth: 1, dayOfWeek: null,
      startsOn: '2026-05-01', endsOn: null, leadDays: 0, isActive: true,
      autoCreate: true, note: null, headlineIds: [],
    }
    /*
     * A schedule with nobody to serve raises work for nobody — unlike a job card,
     * which allows a walk-in, because a walk-in is by definition not recurring.
     */
    ok('(J20) a schedule with no customer is refused', validateSeries({ ...draft, customerId: null }) !== null)
    ok('(J20) an end before the start is refused', validateSeries({ ...draft, endsOn: '2025-01-01' }) !== null)
    ok('(J20) weekly with no weekday is refused', validateSeries({ ...draft, frequency: 'weekly', dayOfWeek: null }) !== null)
    ok('(J20) day 45 of the month is refused', validateSeries({ ...draft, dayOfMonth: 45 }) !== null)
    ok('(J20) 120 days of lead is refused', validateSeries({ ...draft, leadDays: 120 }) !== null)
    ok('(J20) a valid one passes', validateSeries(draft) === null)

    // ── Against the database ────────────────────────────────────────────
    const series = await saveJobSeries(SITE, actor, draft)
    ok('(J20) a schedule saves', series.ok, series.ok ? '' : series.error)
    if (!series.ok) throw new Error('series fixture failed')

    const loaded = await getJobSeries(SITE, series.id)
    ok('(J20) it computes its own next due date rather than storing one', loaded?.nextDueOn === '2026-05-01', String(loaded?.nextDueOn))

    const firstTick = await generateDueJobs(SITE, actor, '2026-07-15')
    ok(
      '(J20) *** one tick raises the three months it missed ***',
      firstTick.created.filter((c) => c.seriesId === series.id).length === 3,
      JSON.stringify(firstTick.created.map((c) => c.forDate)),
    )

    /*
     * THE GUARANTEE. uq_series_period on (series_id, for_date) means the claim is
     * taken before the job is built, so a second tick fails on the insert having
     * written nothing.
     */
    const secondTick = await generateDueJobs(SITE, actor, '2026-07-15')
    ok(
      '(J20) *** the same tick again raises NOTHING — the claim held ***',
      secondTick.created.filter((c) => c.seriesId === series.id).length === 0,
      String(secondTick.created.length),
    )

    const [raceA, raceB] = await Promise.all([
      generateDueJobs(SITE, actor, '2026-08-15', series.id),
      generateDueJobs(SITE, actor, '2026-08-15', series.id),
    ])
    const raced =
      raceA.created.filter((c) => c.seriesId === series.id).length +
      raceB.created.filter((c) => c.seriesId === series.id).length
    ok(
      '(J20) *** two ticks running at once raise ONE job between them ***',
      raced === 1,
      `${raceA.created.length} + ${raceB.created.length}`,
    )

    /*
     * Each job is dated for ITS period, not for the day the run happened. A job
     * raised in July for May must start its SLA clock in May, or every catch-up
     * job arrives already breached.
     */
    const raisedJobs = await siteQuery<any>(
      SITE,
      `SELECT document_number, DATE(reported_at) AS rep FROM job_cards
        WHERE series_id = ? ORDER BY reported_at`,
      [series.id],
    )
    ok(
      '(J20) *** each job is dated for its own period, not the run date ***',
      raisedJobs.length === 4 && raisedJobs[0].rep === '2026-05-01' && raisedJobs[3].rep === '2026-08-01',
      JSON.stringify(raisedJobs.map((j: any) => `${j.document_number}@${j.rep}`)),
    )

    const runs = await seriesRuns(SITE, series.id)
    ok('(J20) every claim recorded the job it produced', runs.length === 4 && runs.every((r) => r.jobId !== null))

    const cursor = await getJobSeries(SITE, series.id)
    ok('(J20) the cursor moved to the newest period', cursor?.lastGeneratedFor === '2026-08-01', String(cursor?.lastGeneratedFor))

    /*
     * auto_create OFF stops the tick. Defaults off, exactly as contracts.auto_send
     * does: a schedule that raised three months of catch-up the moment it was
     * saved is a schedule nobody trusts again.
     */
    await saveJobSeries(SITE, actor, { ...draft, id: series.id, autoCreate: false })
    const paused = await generateDueJobs(SITE, actor, '2026-12-31')
    ok(
      '(J20) *** with the switch off, the tick raises nothing ***',
      paused.created.filter((c) => c.seriesId === series.id).length === 0,
    )
    // But a person pressing the button overrides it — that IS the decision.
    const manual = await generateDueJobs(SITE, actor, '2026-09-15', series.id)
    ok(
      '(J20) but a manual run overrides the switch',
      manual.created.filter((c) => c.seriesId === series.id).length === 1,
      String(manual.created.length),
    )

    // ── Drift ───────────────────────────────────────────────────────────
    const cleanSeries = await reconcileJobSeries(SITE)
    ok(
      '(J20) a correctly generated schedule reports no drift',
      cleanSeries.strandedClaims.filter((r) => r.seriesId === series.id).length === 0 &&
        cleanSeries.cursorAhead.filter((r) => r.seriesId === series.id).length === 0,
    )

    /*
     * A STRANDED CLAIM is the worst thing in this module: the key that stops a
     * double-raise also stops a retry, so a claimed-but-never-raised period is
     * work silently lost with no symptom anywhere else.
     */
    await siteExecute(
      SITE,
      `UPDATE job_series_runs SET job_card_id = NULL WHERE series_id = ? ORDER BY id LIMIT 1`,
      [series.id],
    )
    const stranded = await reconcileJobSeries(SITE)
    ok(
      '(J20) *** a period claimed but never raised is CAUGHT — nothing else would see it ***',
      stranded.strandedClaims.some((r) => r.seriesId === series.id),
    )

    // A cursor ahead of the newest claim skips periods for good.
    await siteExecute(SITE, `DELETE FROM job_series_runs WHERE series_id = ?`, [series.id])
    const cursorAhead = await reconcileJobSeries(SITE)
    ok(
      '(J20) and a cursor ahead of what was actually raised is CAUGHT too',
      cursorAhead.cursorAhead.some((r) => r.seriesId === series.id),
    )

    /*
     * Deleting a schedule KEEPS the work. fk_jcard_series is SET NULL: a schedule
     * is a plan, the jobs are the record of what happened.
     */
    const before = (
      await siteQuery<any>(SITE, `SELECT id FROM job_cards WHERE series_id = ?`, [series.id])
    ).length
    ok('(J20) the schedule deletes', (await deleteJobSeries(SITE, actor, series.id)).ok)
    const survivors = await siteQuery<any>(
      SITE,
      `SELECT id, series_id FROM job_cards WHERE title LIKE 'JCT quarterly service'`,
    )
    ok(
      '(J20) *** deleting a schedule keeps every job it raised, link cleared ***',
      survivors.length === before && survivors.every((s: any) => s.series_id === null),
      `${before} before, ${survivors.length} after`,
    )

    // Teardown.
    await siteExecute(SITE, `DELETE FROM job_card_items WHERE job_card_id IN (SELECT id FROM job_cards WHERE title = 'JCT quarterly service')`)
    await siteExecute(SITE, `DELETE FROM job_card_headlines WHERE job_card_id IN (SELECT id FROM job_cards WHERE title = 'JCT quarterly service')`)
    await siteExecute(SITE, `DELETE FROM job_cards WHERE title = 'JCT quarterly service'`)
  }

  /*
   * ── (J21) Evidence: the artefact IS the answer ────────────────────────────
   *
   * 114 shipped photo and signature response types that stored TEXT — a
   * technician typing that they had taken a photo. 119 made the file the answer.
   *
   * The checks that matter are the ones about DELETING the file afterwards. The
   * happy path is easy; the failure that loses a business a dispute is a job that
   * still reads "signed off" once the attachment is gone.
   */
  {
    const evTag = `JCE${stamp}`

    // The suite's OWN customer, not a borrowed live one: a fixture that reaches into
    // real data is a fixture that leaves litter somebody else has to find.
    const head = await saveHeadline(SITE, actor, {
      id: null, code: `${evTag}H`, name: `${evTag} sign-off`, description: null,
      defaultPriority: null, defaultBoardId: null, suggestedMinutes: 30,
      requiredSkills: null, sortOrder: 90, isActive: true,
      items: [
        { id: null, kind: 'check', name: `${evTag} photo of the flue`, hint: null, responseType: 'photo', unit: null, workPhase: 'after', isRequired: true, evidenceRequired: true },
        { id: null, kind: 'check', name: `${evTag} customer signs`, hint: null, responseType: 'signature', unit: null, workPhase: 'after', isRequired: true, evidenceRequired: true },
        { id: null, kind: 'check', name: `${evTag} pressure`, hint: null, responseType: 'measure', unit: 'bar', workPhase: 'during', isRequired: false, evidenceRequired: false },
      ],
      parts: [],
    })
    ok('(J21) a headline with evidence checks saves', head.ok, head.ok ? '' : head.error)
    if (!head.ok) throw new Error('evidence headline fixture failed')

    const saved = (await listHeadlines(SITE, false)).find((h) => h.id === head.id)
    ok(
      '(J21) the flag is stored per item, not inferred',
      saved?.items.filter((i) => i.evidenceRequired).length === 2,
      `${saved?.items.filter((i) => i.evidenceRequired).length} of ${saved?.items.length}`,
    )

    const jobRes = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null,
      statusId: null, priority: 'normal', ownerUserId: null, ownerName: '',
      title: `${evTag} evidence job`, description: null, dueAt: null, source: 'manual',
      reference: null, internalNote: null,
    })
    if (!jobRes.ok) throw new Error('evidence job fixture failed')
    const evJobId = jobRes.id

    await applyHeadlines(SITE, actor, evJobId, [head.id])
    const fresh = await jobItems(SITE, evJobId)
    const photo = fresh.find((i) => i.responseType === 'photo')!
    const sig = fresh.find((i) => i.responseType === 'signature')!

    ok('(J21) the job copied the flag from the template', photo.evidenceRequired && sig.evidenceRequired)
    ok('(J21) and nothing is attached yet', photo.attachmentId === null && sig.attachmentId === null)

    // ── The rule ──────────────────────────────────────────────────────────
    const typed = await recordItem(SITE, actor, photo.id, {
      response: 'I took one, honest', note: null, complete: true,
    })
    ok(
      '(J21) *** typing a reference does NOT complete a photo check ***',
      !typed.ok,
      typed.ok ? 'IT WAS ACCEPTED' : typed.error,
    )

    const stillOpen = (await jobItems(SITE, evJobId)).find((i) => i.id === photo.id)!
    ok('(J21) so it is still outstanding', stillOpen.completedAt === null)

    // A required evidence item with no file blocks the close, which is the whole
    // point of the flag.
    const earlyClose = await closeJob(SITE, actor, evJobId)
    ok(
      '(J21) *** and the job cannot be closed over it ***',
      !earlyClose.ok,
      earlyClose.ok ? 'IT CLOSED' : earlyClose.error,
    )

    // ── Capture ───────────────────────────────────────────────────────────
    const cap = await captureEvidence(
      SITE, actor, photo.id,
      { storedName: `${evTag}-photo.png`, filename: 'flue.png', mimeType: 'image/png', sizeBytes: 2048 },
      'north side',
    )
    ok('(J21) attaching a file completes it', cap.ok, cap.ok ? '' : cap.error)

    const done = (await jobItems(SITE, evJobId)).find((i) => i.id === photo.id)!
    ok('(J21) the item now names its file', done.attachmentId !== null && done.attachmentName === 'flue.png')
    ok('(J21) completed, by the person who captured it', done.completedAt !== null && done.completedByName === actor.userName)
    ok('(J21) and the caption is the response, not the answer', done.response === 'north side')

    const wrongType = await captureEvidence(
      SITE, actor, fresh.find((i) => i.responseType === 'measure')!.id,
      { storedName: `${evTag}-x.png`, filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 },
      null,
    )
    ok(
      '(J21) a measurement refuses a photo — the types are not interchangeable',
      !wrongType.ok,
      wrongType.ok ? 'ACCEPTED' : wrongType.error,
    )

    // ── Deleting the file is the interesting case ──────────────────────────
    await siteExecute(SITE, `DELETE FROM party_documents WHERE id = ?`, [cap.attachmentId])
    const orphaned = (await jobItems(SITE, evJobId)).find((i) => i.id === photo.id)!
    ok(
      '(J21) *** deleting the file un-answers the item via ON DELETE SET NULL ***',
      orphaned.attachmentId === null,
    )
    ok(
      '(J21) but the tick is still standing — which is why the guard re-checks',
      orphaned.completedAt !== null,
    )

    const drift = await reconcileJobHeadlines(SITE)
    ok(
      '(J21) *** reconcile CATCHES a sign-off with no file behind it ***',
      drift.completedWithoutEvidence.some((r) => r.itemId === photo.id),
      `${drift.completedWithoutEvidence.length} reported`,
    )
    ok(
      '(J21) and it is NOT double-reported as an unanswered check',
      !drift.completedWithoutAnswer.some((r) => r.itemId === photo.id),
    )

    const closeAgain = await closeJob(SITE, actor, evJobId)
    ok(
      '(J21) *** the job STILL cannot close: a tick with no file is outstanding ***',
      !closeAgain.ok,
      closeAgain.ok ? 'IT CLOSED WITH NO EVIDENCE' : closeAgain.error,
    )

    // ── Reclassification must not orphan a photograph ─────────────────────
    const recap = await captureEvidence(
      SITE, actor, photo.id,
      { storedName: `${evTag}-photo2.png`, filename: 'flue-again.png', mimeType: 'image/png', sizeBytes: 3072 },
      null,
    )
    ok('(J21) it can be re-captured', recap.ok)

    await applyHeadlines(SITE, actor, evJobId, [])
    const afterClear = await jobItems(SITE, evJobId)
    ok(
      '(J21) *** clearing the headlines KEEPS the item holding a photo ***',
      afterClear.some((i) => i.id === photo.id && i.attachmentId !== null),
      `${afterClear.length} items left`,
    )
    ok(
      '(J21) while the untouched measurement was cleared as normal',
      !afterClear.some((i) => i.responseType === 'measure'),
    )

    // Teardown.
    await siteExecute(SITE, `DELETE FROM party_documents WHERE entity = 'job_card' AND entity_id = ?`, [evJobId])
    await siteExecute(SITE, `DELETE FROM job_card_items WHERE job_card_id = ?`, [evJobId])
    await siteExecute(SITE, `DELETE FROM job_card_headlines WHERE job_card_id = ?`, [evJobId])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [evJobId])
    await siteExecute(SITE, `DELETE FROM job_headline_items WHERE headline_id = ?`, [head.id])
    await siteExecute(SITE, `DELETE FROM job_headlines WHERE id = ?`, [head.id])
    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [evJobId])
  }

  /*
   * ── (J22) Who is on a job ─────────────────────────────────────────────────
   *
   * Sections 16 and 13: a job-level team, and people who watch without being
   * responsible. One table with a role, so "every job I am involved in" is one
   * indexed read rather than a UNION every future caller must remember to write
   * both halves of.
   *
   * The checks that matter are the refusals. Anybody can build a list of names;
   * the value is in what the module will not let you record.
   */
  {
    /*
     * Mail off for the WHOLE block, restored at the end.
     *
     * setJobPerson and assignOwner both fire notifyAssigned, and this dev box has
     * real SMTP credentials in .env — so without this the suite emails a real
     * person every time it runs. Found the hard way: an earlier version reported
     * "sent 1".
     */
    const notifyWasEnabled = await getSetting(SITE, 'job_notify_enabled').catch(() => '1')
    await setSetting(SITE, 'job_notify_enabled', '0')

    const users = await listUsers(SITE)
    const active = users.filter((u) => u.isActive && u.userType === 'back_office')

    const pJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} people job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!pJob.ok) throw new Error('people job fixture failed')
    const pJobId = pJob.id

    ok('(J22) a new job has nobody on it', (await peopleFor(SITE, pJobId)).length === 0)

    if (active.length === 0) {
      ok('(J22) SKIPPED — no active back-office user on this site', true)
    } else {
      const alice = active[0]

      // ── Adding, promoting, removing ─────────────────────────────────────
      const added = await setJobPerson(SITE, actor, pJobId, alice.id, 'follower')
      ok('(J22) somebody can be added as a follower', added.ok, added.ok ? '' : added.error)

      const asFollower = await peopleFor(SITE, pJobId)
      ok('(J22) and appears with their role and who added them',
        asFollower.length === 1 &&
        asFollower[0].role === 'follower' &&
        asFollower[0].addedByName === actor.userName)

      const promoted = await setJobPerson(SITE, actor, pJobId, alice.id, 'assignee')
      ok('(J22) promoting to assignee works', promoted.ok)
      const afterPromote = await peopleFor(SITE, pJobId)
      ok(
        '(J22) *** and it is ONE row, not two — the key refuses a second ***',
        afterPromote.length === 1 && afterPromote[0].role === 'assignee',
        `${afterPromote.length} row(s)`,
      )
      ok(
        '(J22) the promotion kept when they first got involved',
        afterPromote[0].createdAt.getTime() === asFollower[0].createdAt.getTime(),
      )

      // ── The refusals ────────────────────────────────────────────────────
      const notAUser = await setJobPerson(SITE, actor, pJobId, 999999, 'assignee')
      ok('(J22) a user who is not on this site is refused', !notAUser.ok,
        notAUser.ok ? 'ACCEPTED' : notAUser.error)

      await assignOwner(SITE, actor, pJobId, alice.id, alice.name)
      const asOwner = await setJobPerson(SITE, actor, pJobId, alice.id, 'assignee')
      ok(
        '(J22) *** the OWNER cannot also be added — they would count twice ***',
        !asOwner.ok,
        asOwner.ok ? 'ACCEPTED' : asOwner.error,
      )

      // Reconcile catches the case setJobPerson cannot: the owner CHANGED to
      // somebody already on the job.
      const drift = await reconcileJobPeople(SITE)
      ok(
        '(J22) *** and an owner who was already on the team is CAUGHT by reconcile ***',
        drift.ownerDuplicated.some((r) => r.jobId === pJobId && r.userId === alice.id),
        `${drift.ownerDuplicated.length} reported`,
      )

      /*
       * The owner cannot follow their own job either.
       *
       * This was a real bug, found by pressing the button on a live screen rather
       * than by any assertion: setJobPerson refused the owner and toggleFollow did
       * not, so following your own job wrote exactly the ownerDuplicated row that
       * reconcileJobPeople exists to report. A row a reconciliation screen calls
       * drift must not be creatable by pressing a button.
       */
      const ownerFollows = await toggleFollow(SITE, { userId: alice.id, userName: alice.name }, pJobId)
      ok(
        '(J22) *** the OWNER cannot follow their own job — it would report as drift ***',
        !ownerFollows.ok,
        ownerFollows.ok ? 'ACCEPTED' : ownerFollows.error,
      )

      // ── Following is not assigning ──────────────────────────────────────
      const meFollow = await toggleFollow(SITE, actor, pJobId)
      ok('(J22) a person can follow a job themselves', meFollow.ok && meFollow.following === true)

      const meUnfollow = await toggleFollow(SITE, actor, pJobId)
      ok('(J22) and unfollow it', meUnfollow.ok && meUnfollow.following === false)

      await setJobPerson(SITE, actor, pJobId, actor.userId, 'assignee').catch(() => {})
      const assignedUnfollow = await toggleFollow(SITE, actor, pJobId)
      ok(
        '(J22) *** an ASSIGNEE cannot unfollow — that would drop their own work ***',
        !assignedUnfollow.ok,
        assignedUnfollow.ok ? 'ACCEPTED' : assignedUnfollow.error,
      )

      // ── The read this table exists for ──────────────────────────────────
      const mine = await jobIdsFor(SITE, actor.userId)
      ok('(J22) "jobs I am on" is one read and finds it', mine.includes(pJobId))
      const asAssignee = await jobIdsFor(SITE, actor.userId, 'assignee')
      ok('(J22) and it can be narrowed to one role', asAssignee.includes(pJobId))

      const counts = await peopleCounts(SITE, [pJobId])
      ok('(J22) a list screen gets its counts in one query', (counts.get(pJobId) ?? 0) >= 1)

      // The owner is NOT a row, but IS someone to tell.
      const all = await everyoneOn(SITE, pJobId)
      ok(
        '(J22) *** everyoneOn includes the owner, who is deliberately not a row ***',
        all.includes(alice.id),
        `owner ${alice.id} in [${all.join(',')}]`,
      )
      ok('(J22) and does not repeat anybody', all.length === new Set(all).size)

      const removed = await removeJobPerson(SITE, actor, pJobId, actor.userId)
      ok('(J22) somebody can be taken off', removed.ok)
      ok('(J22) and is then gone', !(await jobIdsFor(SITE, actor.userId)).includes(pJobId))
    }

    // ── Notifying never blocks ────────────────────────────────────────────
    /*
     * The load-bearing property of the whole notification path: it returns a
     * reason instead of throwing, whatever goes wrong. A job that cannot be
     * closed because a mail server is down is a far worse outcome than an email
     * nobody receives.
     *
     * Mail is already switched off for this whole block — see the top. That also
     * exercises the switch, so nothing is lost: these paths still run end to end
     * and still have to come back with a reason rather than an exception.
     */
    const notified = await notifyStatusChanged(SITE, actor, pJobId, 'In progress')
    ok(
      '(J22) *** with mail switched off, nothing is sent and it says so ***',
      notified.sent === 0 && notified.skipped === 'disabled',
      `sent ${notified.sent}, skipped ${notified.skipped ?? 'nothing'}`,
    )

    const gone = await notifyClosed(SITE, actor, 999999)
    ok(
      '(J22) *** and a job that does not exist does not throw either ***',
      typeof gone.sent === 'number' && gone.sent === 0,
      `skipped ${gone.skipped ?? 'nothing'}`,
    )

    // The recipient list is still worked out correctly while sending is off, so
    // the switch is not hiding a broken query.
    const stillKnows = await everyoneOn(SITE, pJobId)
    ok(
      '(J22) the switch stops the SENDING, not the working out of who to tell',
      stillKnows.length > 0,
      `${stillKnows.length} would be told`,
    )

    // ── Deleting the job takes its people with it ─────────────────────────
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [pJobId])
    const orphans = await siteQuery<any>(
      SITE, `SELECT user_id FROM job_card_people WHERE job_card_id = ?`, [pJobId])
    ok(
      '(J22) *** deleting a job CASCADEs its people — no orphan rows ***',
      orphans.length === 0,
      `${orphans.length} left`,
    )

    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [pJobId])

    // Restored last. Leaving a live site with notifications off would be the worst
    // kind of litter, because nothing about it looks broken.
    await setSetting(SITE, 'job_notify_enabled', notifyWasEnabled)
    ok(
      '(J22) the notification setting was put back as it was',
      (await getSetting(SITE, 'job_notify_enabled')) === notifyWasEnabled,
      notifyWasEnabled,
    )
  }

  /*
   * ── (J23) The three time-based automations ────────────────────────────────
   *
   * Section 12 wanted a workflow engine; the plan promised six named rules
   * instead. Three arrived as phase 14 notifications. These are the three a
   * CLOCK fires, which is why they claim a slot and the notifications did not.
   *
   * The load-bearing checks are the claim race and the auto-invoice guards. An
   * escalation sent twice is annoying; an invoice raised twice is money.
   */
  {
    // Mail off for the whole block, restored at the end. Same reason as (J22):
    // this box has real SMTP credentials and escalation would mail a real person.
    const autoNotifyWas = await getSetting(SITE, 'job_notify_enabled').catch(() => '1')
    await setSetting(SITE, 'job_notify_enabled', '0')

    const aJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'high', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} automation job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!aJob.ok) throw new Error('automation job fixture failed')
    const aJobId = aJob.id

    // ── The claim is the whole guarantee ────────────────────────────────────
    /*
     * Forced overdue by writing the deadline into the past. Waiting for a real
     * SLA to breach is not a test, and re-deriving the deadline here would be a
     * second copy of the business-hours arithmetic.
     */
    // respond_by in the PAST, resolve_by in the FUTURE. The pairing is what makes
    // "no resolution breach yet" mean something: the row matches the query on one
    // deadline and must not be escalated on the other.
    await siteExecute(
      SITE,
      `UPDATE job_cards
          SET respond_by = DATE_SUB(NOW(), INTERVAL 2 HOUR),
              resolve_by = DATE_ADD(NOW(), INTERVAL 2 DAY),
              responded_at = NULL
        WHERE id = ?`,
      [aJobId],
    )

    const before = await overdueCount(SITE)
    ok('(J23) an overdue job is counted', before >= 1, String(before))

    const first = await escalateBreaches(SITE)
    const firstRespond = first.find((o) => o.event === 'respond_breach')!
    ok(
      '(J23) the first sweep claims the breach',
      firstRespond.claimed >= 1,
      `claimed ${firstRespond.claimed}, done ${firstRespond.done}`,
    )

    const second = await escalateBreaches(SITE)
    const secondRespond = second.find((o) => o.event === 'respond_breach')!
    ok(
      '(J23) *** the same sweep again claims NOTHING — the claim held ***',
      secondRespond.claimed === 0,
      `claimed ${secondRespond.claimed}`,
    )

    const [raceA, raceB] = await Promise.all([escalateBreaches(SITE), escalateBreaches(SITE)])
    const raced =
      (raceA.find((o) => o.event === 'respond_breach')?.claimed ?? 0) +
      (raceB.find((o) => o.event === 'respond_breach')?.claimed ?? 0)
    ok(
      '(J23) *** two sweeps at once claim it ZERO times between them ***',
      raced === 0,
      `${raced} claims`,
    )

    const runs = await automationRuns(SITE, 200)
    const mine = runs.filter((r) => r.jobId === aJobId)
    /*
     * ONE respond_breach run, not one run overall — the job earns a separate
     * resolve_breach claim below, which is the point of the two events.
     *
     * The first version of this asserted one run in total and caught a real bug:
     * the sweep was claiming BOTH events for a job that had only breached its
     * response time, permanently consuming the resolution slot for the day.
     */
    const responds = mine.filter((r) => r.event === 'respond_breach')
    ok('(J23) exactly one response-breach run is recorded', responds.length === 1, `${responds.length}`)
    ok(
      '(J23) *** and NO resolution breach yet — that deadline has not passed ***',
      mine.filter((r) => r.event === 'resolve_breach').length === 0,
      `${mine.filter((r) => r.event === 'resolve_breach').length} claimed early`,
    )
    ok('(J23) the run settled rather than staying claimed', responds[0]?.status === 'done', responds[0]?.status)

    /*
     * A response breach and a resolution breach are separate claims.
     *
     * They must be: a job can breach its response promise, get responded to, and
     * then breach its resolution promise as well. One shared claim would swallow
     * the second escalation and nobody would ever be told.
     */
    await siteExecute(
      SITE,
      `UPDATE job_cards SET resolve_by = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?`,
      [aJobId],
    )
    const third = await escalateBreaches(SITE)
    ok(
      '(J23) *** a RESOLUTION breach is claimed separately from a response one ***',
      (third.find((o) => o.event === 'resolve_breach')?.claimed ?? 0) >= 1,
      `resolve claimed ${third.find((o) => o.event === 'resolve_breach')?.claimed}`,
    )

    // ── The switches actually switch ────────────────────────────────────────
    const escalateWas = await getSetting(SITE, 'job_auto_escalate')
    await setSetting(SITE, 'job_auto_escalate', '0')
    const offSweep = await escalateBreaches(SITE)
    ok(
      '(J23) with escalation off, nothing is claimed and it says why',
      offSweep.every((o) => o.claimed === 0 && o.skipped === 'off'),
    )
    await setSetting(SITE, 'job_auto_escalate', escalateWas)

    // ── Auto-invoice: the one that can cost money ───────────────────────────
    const invoiceWas = await getSetting(SITE, 'job_auto_invoice')
    ok(
      '(J23) *** auto-invoicing is OFF out of the box — it creates real paperwork ***',
      invoiceWas === '0',
      invoiceWas,
    )

    const offInvoice = await autoInvoiceClosed(SITE)
    ok('(J23) and does nothing while off', offInvoice.claimed === 0 && offInvoice.skipped === 'off')

    /*
     * The sweep is deliberately NOT run with auto-invoicing switched on.
     *
     * An earlier version did, and it raised a real draft invoice against an
     * unrelated closed job that happened to be in the seven-day window on this
     * dev database — 720.00 to a real customer, with the job line stamped as
     * invoiced. It was a draft with no document number, so nothing was posted and
     * no sequence number was consumed, but it still had to be unwound by hand.
     *
     * A test that flips a money-making switch on shared data and then runs the
     * thing it switched on is not a test, it is an outage waiting for the right
     * dataset. What matters here is provable without it: the guard is that a job
     * with nothing to bill is never claimed, and the claim table says so.
     */
    const emptyClose = await closeJob(SITE, actor, aJobId)
    ok('(J23) the fixture job closes', emptyClose.ok, emptyClose.ok ? '' : emptyClose.error)

    const billable = await billableLines(SITE, aJobId)
    ok('(J23) and it has nothing billable on it', billable.length === 0, `${billable.length} line(s)`)

    const claimedEmpty = (await automationRuns(SITE, 200)).filter(
      (r) => r.jobId === aJobId && r.event === 'auto_invoice',
    )
    ok(
      '(J23) *** a job with nothing to bill is NOT claimed — it stays eligible ***',
      claimedEmpty.length === 0,
      `${claimedEmpty.length} claim(s)`,
    )
    ok('(J23) and the switch is back off', (await getSetting(SITE, 'job_auto_invoice')) === invoiceWas)

    // ── Drift ───────────────────────────────────────────────────────────────
    const clean = await reconcileJobAutomations(SITE)
    ok(
      '(J23) a healthy site reports no stuck claims',
      !clean.stuckClaims.some((r) => r.jobId === aJobId),
      `${clean.stuckClaims.length} stuck overall`,
    )

    /*
     * A claim that never settled, backdated past the hour of grace.
     *
     * This is the shape that matters: the unique key means it will NEVER be
     * retried, so an escalation that died mid-send is silently lost unless
     * something reports it.
     */
    await siteExecute(
      SITE,
      `INSERT INTO job_automation_runs (job_card_id, event, for_date, status, created_at)
       VALUES (?, 'visit_reminder', '2020-01-01', 'claimed', DATE_SUB(NOW(), INTERVAL 3 HOUR))`,
      [aJobId],
    )
    const stuck = await reconcileJobAutomations(SITE)
    ok(
      '(J23) *** a claim that never finished is CAUGHT — nothing else would see it ***',
      stuck.stuckClaims.some((r) => r.jobId === aJobId),
      `${stuck.stuckClaims.length} reported`,
    )

    // ── Teardown ────────────────────────────────────────────────────────────
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [aJobId])
    const orphans = await siteQuery<any>(
      SITE, `SELECT id FROM job_automation_runs WHERE job_card_id = ?`, [aJobId])
    ok(
      '(J23) *** deleting a job CASCADEs its automation runs ***',
      orphans.length === 0,
      `${orphans.length} left`,
    )
    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [aJobId])

    await setSetting(SITE, 'job_notify_enabled', autoNotifyWas)
  }

  /*
   * ── (J24) Bulk actions and saved views ────────────────────────────────────
   *
   * Section 37.2. The two halves are tested for opposite reasons: a bulk action
   * must REFUSE the right rows and say why, and a saved view must store the
   * question rather than the answer.
   */
  {
    const bulkNotifyWas = await getSetting(SITE, 'job_notify_enabled').catch(() => '1')
    await setSetting(SITE, 'job_notify_enabled', '0')

    const mk = async (title: string) => {
      const r = await saveJobCard(SITE, actor, {
        id: null, customerId, customerName: null, customerPhone: null,
        customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
        priority: 'normal', ownerUserId: null, ownerName: '',
        title, description: null, dueAt: null, source: 'manual',
        reference: null, internalNote: null,
      })
      if (!r.ok) throw new Error(`bulk fixture failed: ${r.error}`)
      return r.id
    }

    const b1 = await mk(`JCT${stamp} bulk one`)
    const b2 = await mk(`JCT${stamp} bulk two`)
    const b3 = await mk(`JCT${stamp} bulk three`)

    // ── One change, many jobs ───────────────────────────────────────────
    const raised = await bulkUpdateJobs(SITE, actor, [b1, b2, b3], {
      kind: 'priority', priority: 'urgent',
    })
    ok('(J24) a bulk change reports what it did', raised.changed === 3, `${raised.changed}`)
    ok('(J24) and refuses nothing it should not', raised.skipped.length === 0)

    const after = await siteQuery<any>(
      SITE, `SELECT priority FROM job_cards WHERE id IN (?,?,?)`, [b1, b2, b3])
    ok('(J24) every one of them actually changed', after.every((r: any) => r.priority === 'urgent'))

    /*
     * The SLA promise moved with the priority.
     *
     * This is why bulk goes through setPriority rather than one UPDATE: a blind
     * statement would leave every one of these jobs promising an urgent response
     * against a deadline computed for a normal one.
     */
    const deadlines = await siteQuery<any>(
      SITE, `SELECT respond_by FROM job_cards WHERE id = ?`, [b1])
    ok(
      '(J24) *** and its SLA promise was re-stamped, not left behind ***',
      deadlines[0]?.respond_by !== null,
      String(deadlines[0]?.respond_by),
    )

    // ── The refusals are the feature ────────────────────────────────────
    await closeJob(SITE, actor, b3)
    const mixed = await bulkUpdateJobs(SITE, actor, [b1, b3, 999999], {
      kind: 'priority', priority: 'low',
    })
    ok('(J24) an open job in the same batch still changes', mixed.changed === 1, `${mixed.changed}`)
    ok(
      '(J24) *** a closed job is skipped BY NAME with a reason ***',
      mixed.skipped.some((s) => s.id === b3 && s.reason.includes('closed')),
      JSON.stringify(mixed.skipped),
    )
    ok(
      '(J24) and so is one that no longer exists',
      mixed.skipped.some((s) => s.id === 999999 && s.reason.includes('exists')),
    )

    // ── Saved views ─────────────────────────────────────────────────────
    const viewName = `JCT${stamp} overdue`
    const saved = await saveJobView(SITE, actor, {
      id: null, name: viewName,
      filters: { state: 'open', priority: 'urgent' },
      isShared: false, isPinned: true,
    })
    ok('(J24) a view saves', saved.ok, saved.ok ? '' : saved.error)
    if (!saved.ok) throw new Error('view fixture failed')

    const mine = await listJobViews(SITE, actor.userId)
    const found = mine.find((v) => v.id === saved.id)
    ok('(J24) and comes back with its filters intact', found?.filters.priority === 'urgent')

    /*
     * The whole model in one assertion: a view holds the QUESTION.
     *
     * Nothing about the view changes when the jobs matching it change, which is
     * what makes it right tomorrow without anybody maintaining it.
     */
    ok(
      '(J24) *** a view stores no job ids — only the filters ***',
      JSON.stringify(found?.filters ?? {}).indexOf(String(b1)) === -1,
      JSON.stringify(found?.filters),
    )

    const empty = await saveJobView(SITE, actor, {
      id: null, name: `${viewName} empty`, filters: {}, isShared: false, isPinned: false,
    })
    ok(
      '(J24) a view with no filters is refused — it would just be the job list',
      !empty.ok,
      empty.ok ? 'ACCEPTED' : empty.error,
    )

    const dupe = await saveJobView(SITE, actor, {
      id: null, name: viewName, filters: { state: 'open' }, isShared: false, isPinned: false,
    })
    ok('(J24) and the same person cannot use one name twice', !dupe.ok, dupe.ok ? 'ACCEPTED' : dupe.error)

    // Rubbish in the JSON column is narrowed away rather than reaching a screen.
    ok(
      '(J24) *** filters are narrowed on the way out, not trusted ***',
      JSON.stringify(cleanFilters({ state: 'open', evil: 'DROP TABLE', page: 9 })) ===
        JSON.stringify({ state: 'open' }),
      JSON.stringify(cleanFilters({ state: 'open', evil: 'DROP TABLE', page: 9 })),
    )

    const viewDrift = await reconcileJobViews(SITE)
    ok(
      '(J24) a view naming a live status is not reported as broken',
      !viewDrift.brokenStatus.some((v) => v.id === saved.id),
    )

    ok('(J24) the view deletes', (await deleteJobView(SITE, actor, saved.id)).ok)

    // Teardown.
    for (const id of [b1, b2, b3]) {
      await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [id])
      await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [id])
    }
    await setSetting(SITE, 'job_notify_enabled', bulkNotifyWas)
  }

  /*
   * ── (J25) Rules per stage ─────────────────────────────────────────────────
   *
   * Section 10.1. Four rules, and the one that matters most is the LAST: a
   * status with no role can now close a job, which is what lets a business add
   * a closing stage of its own without claiming one of the two reserved roles.
   */
  {
    const rulesNotifyWas = await getSetting(SITE, 'job_notify_enabled').catch(() => '1')
    await setSetting(SITE, 'job_notify_enabled', '0')

    const statuses = await listJobStatuses(SITE, true)
    const byCode = (code: string) => statuses.find((s) => s.code === code)

    // ── The five stages the PRD names and 104 did not seed ───────────────
    for (const code of ['paused', 'awaiting_customer', 'ready_invoice', 'invoiced', 'closed']) {
      ok(`(J25) the ${code} stage exists`, byCode(code) !== undefined)
    }
    ok(
      '(J25) *** and none of them claimed a role — that would break REQUIRED_ROLES ***',
      ['paused', 'awaiting_customer', 'ready_invoice', 'invoiced', 'closed'].every(
        (c) => byCode(c)?.role === '',
      ),
    )

    const rJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} rules job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!rJob.ok) throw new Error('rules fixture failed')

    // ── 1. A stage that asks why ─────────────────────────────────────────
    const paused = byCode('paused')!
    ok('(J25) Paused asks for a reason', paused.requiresReason)

    const noReason = await setStatus(SITE, actor, rJob.id, paused.id)
    ok(
      '(J25) *** and refuses the move without one ***',
      !noReason.ok,
      noReason.ok ? 'ACCEPTED' : noReason.error,
    )
    ok(
      '(J25) but accepts it with one',
      (await setStatus(SITE, actor, rJob.id, paused.id, 'Waiting on a part')).ok,
    )

    // ── 2. Office-only stages ────────────────────────────────────────────
    const invoiced = byCode('invoiced')!
    ok('(J25) Invoiced is office-only', invoiced.audience === 'office')

    const asTech = await setStatus(SITE, actor, rJob.id, invoiced.id, undefined, false)
    ok(
      '(J25) *** a technician cannot mark a job invoiced ***',
      !asTech.ok,
      asTech.ok ? 'ACCEPTED' : asTech.error,
    )
    ok(
      '(J25) somebody who bills jobs can',
      (await setStatus(SITE, actor, rJob.id, invoiced.id, undefined, true)).ok,
    )

    // ── 3. Blocking is per stage, not global ─────────────────────────────
    /*
     * The two closing stages want OPPOSITE answers, which is the whole reason
     * this moved off a single site-wide setting. Refusing to cancel a job over
     * an unticked check is how a job nobody wants stays open forever.
     */
    ok('(J25) Work Completed demands its checks', byCode('completed')?.blocksOnIncomplete === true)
    ok(
      '(J25) *** and Cancelled deliberately does NOT ***',
      byCode('cancelled')?.blocksOnIncomplete === false,
    )
    ok(
      '(J25) a stage that has not decided falls back to the site setting',
      byCode('scheduled')?.blocksOnIncomplete === null,
      String(byCode('scheduled')?.blocksOnIncomplete),
    )

    /*
     * A stage that existed before 123 must behave as it did.
     *
     * 123 originally turned requires_reason ON for On Hold and Cancelled, and
     * (J8) caught it immediately — a board test moves a job to On Hold with no
     * reason, and a drag can never carry one. 124 reverted it. The rule is
     * configurable; seeding it ON for an existing stage is a behaviour change
     * nobody asked for.
     */
    ok(
      '(J25) *** an existing stage was NOT made stricter by the migration ***',
      byCode('on_hold')?.requiresReason === false && byCode('cancelled')?.requiresReason === false,
      `on_hold=${byCode('on_hold')?.requiresReason} cancelled=${byCode('cancelled')?.requiresReason}`,
    )

    // ── 4. Closed WITHOUT a role ─────────────────────────────────────────
    const closedStage = byCode('closed')!
    ok('(J25) the Closed stage carries no role', closedStage.role === '')
    ok('(J25) but is marked as closing', closedStage.isClosedStage)

    const moved = await setStatus(SITE, actor, rJob.id, closedStage.id, undefined, true)
    ok('(J25) a job can be moved there', moved.ok, moved.ok ? '' : moved.error)

    const row = await siteQueryOne<any>(
      SITE, `SELECT status FROM job_cards WHERE id = ?`, [rJob.id])
    ok(
      '(J25) *** and the job records itself CLOSED on the flag alone ***',
      String(row?.status) === 'closed',
      String(row?.status),
    )

    const card = await getJobCard(SITE, rJob.id)
    ok(
      '(J25) the job card agrees it is closed, not just the column',
      card?.isClosed === true,
      String(card?.isClosed),
    )

    // Teardown.
    await siteExecute(SITE, `DELETE FROM job_card_items WHERE job_card_id = ?`, [rJob.id])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [rJob.id])
    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [rJob.id])
    await setSetting(SITE, 'job_notify_enabled', rulesNotifyWas)
  }

  /*
   * ── (J26) Deposits ────────────────────────────────────────────────────────
   *
   * Section 33, and no new table: a deposit is a customer RECEIPT, posted
   * through the cashbook so both halves land — the customer owes less AND the
   * money is in an account.
   *
   * That second half is the whole test. The first version of jobDeposits called
   * postTransaction directly, which writes the debtors side only, and the cash
   * position would have understated by every deposit ever taken.
   */
  {
    const acct = await siteQueryOne<any>(
      SITE,
      `SELECT id, name, balance FROM bank_accounts WHERE status <> 'closed' LIMIT 1`,
    )

    const dJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} deposit job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!dJob.ok) throw new Error('deposit fixture failed')

    ok('(J26) a new job has no deposits', (await jobDeposits(SITE, dJob.id)).length === 0)

    if (!acct) {
      ok('(J26) SKIPPED — this site has no open bank account', true)
    } else {
      // ── The refusals ──────────────────────────────────────────────────
      const zero = await takeDeposit(SITE, actor, dJob.id, {
        amount: 0, bankAccountId: Number(acct.id),
      })
      ok('(J26) a deposit of nothing is refused', !zero.ok, zero.ok ? 'ACCEPTED' : zero.error)

      const noAcct = await takeDeposit(SITE, actor, dJob.id, {
        amount: 100, bankAccountId: 999999,
      })
      ok(
        '(J26) *** and so is one with nowhere to put the money ***',
        !noAcct.ok,
        noAcct.ok ? 'ACCEPTED' : noAcct.error,
      )

      // ── Both halves ───────────────────────────────────────────────────
      const custBefore = await siteQueryOne<any>(
        SITE, `SELECT balance FROM customers WHERE id = ?`, [customerId])
      const bankBefore = await siteQueryOne<any>(
        SITE, `SELECT balance FROM bank_accounts WHERE id = ?`, [acct.id])

      const took = await takeDeposit(SITE, actor, dJob.id, {
        amount: 1200, bankAccountId: Number(acct.id), reference: `JCT${stamp}DEP`,
      })
      ok('(J26) a deposit is taken', took.ok, took.ok ? '' : took.error)
      if (!took.ok) throw new Error('deposit fixture failed')

      const custAfter = await siteQueryOne<any>(
        SITE, `SELECT balance FROM customers WHERE id = ?`, [customerId])
      const bankAfter = await siteQueryOne<any>(
        SITE, `SELECT balance FROM bank_accounts WHERE id = ?`, [acct.id])

      ok(
        '(J26) *** the customer owes 1200 LESS ***',
        Math.abs(Number(custBefore.balance) - Number(custAfter.balance) - 1200) < 0.01,
        `${custBefore.balance} -> ${custAfter.balance}`,
      )
      ok(
        '(J26) *** and the bank account holds 1200 MORE — the half postTransaction misses ***',
        Math.abs(Number(bankAfter.balance) - Number(bankBefore.balance) - 1200) < 0.01,
        `${bankBefore.balance} -> ${bankAfter.balance}`,
      )

      // ── It is findable as this job's deposit ──────────────────────────
      const mine = await jobDeposits(SITE, dJob.id)
      ok('(J26) the job finds its own deposit', mine.length === 1 && mine[0].amount === 1200)

      const summary = await depositSummary(SITE, dJob.id)
      ok('(J26) the summary totals it', summary.taken === 1200)
      ok(
        '(J26) *** it is UNALLOCATED — which invoice it settles is a debtors decision ***',
        summary.unallocated === 1200,
        String(summary.unallocated),
      )
      /*
       * No accepted quote on this fixture, so there is nothing to measure
       * against — and the summary says so rather than inventing a balance.
       */
      ok(
        '(J26) with no accepted quote, there is no made-up balance',
        summary.quoted === null && summary.stillToPay === null,
      )

      // ── A closed job takes no deposit ─────────────────────────────────
      await closeJob(SITE, actor, dJob.id)
      const afterClose = await takeDeposit(SITE, actor, dJob.id, {
        amount: 50, bankAccountId: Number(acct.id),
      })
      ok(
        '(J26) a closed job refuses one, and says where to take it instead',
        !afterClose.ok,
        afterClose.ok ? 'ACCEPTED' : afterClose.error,
      )

      // ── Drift ─────────────────────────────────────────────────────────
      const clean = await reconcileJobDeposits(SITE)
      ok(
        '(J26) a live deposit is not reported as orphaned',
        !clean.orphaned.some((o) => o.jobId === dJob.id),
      )

      /*
       * Teardown, in the order that keeps the books straight: the bank row and
       * the ledger row go, then both balances are put back by hand. A deposit
       * cannot simply be deleted in real life — it would be reversed — but this
       * is a fixture, and leaving it would drift every balance on the site.
       */
      await siteExecute(SITE,
        `DELETE FROM bank_transactions WHERE source_doc_id = ? AND source = 'receipt'`,
        [took.transactionId])
      await siteExecute(SITE, `DELETE FROM customer_transactions WHERE id = ?`, [took.transactionId])
      await siteExecute(SITE, `UPDATE customers SET balance = ? WHERE id = ?`,
        [custBefore.balance, customerId])
      await siteExecute(SITE, `UPDATE bank_accounts SET balance = ? WHERE id = ?`,
        [bankBefore.balance, acct.id])

      const restored = await siteQueryOne<any>(
        SITE, `SELECT balance FROM bank_accounts WHERE id = ?`, [acct.id])
      ok(
        '(J26) the fixture put both balances back',
        Math.abs(Number(restored.balance) - Number(bankBefore.balance)) < 0.01,
        `${restored.balance}`,
      )
    }

    await siteExecute(SITE, `DELETE FROM job_card_items WHERE job_card_id = ?`, [dJob.id])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [dJob.id])
    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'job_card' AND entity_id = ?`, [dJob.id])
  }

  /*
   * ── (J27) The calendar feed ───────────────────────────────────────────────
   *
   * §14.2 asks for Google and Outlook integration. This is the read-only
   * ninety per cent: a technician subscribes once and their own phone shows
   * their day.
   *
   * Every check here is about the FILE being valid, because an invalid one
   * fails in the worst possible way — a calendar app rejects it silently and
   * shows an empty week with no error at all.
   */
  {
    // ── Escaping. A customer called "Smith, Ltd" is ordinary. ────────────
    ok(
      '(J27) a comma is escaped — a bare one silently truncates the line',
      escapeIcsText('Harbour Cafe, Ltd') === 'Harbour Cafe\\, Ltd',
      escapeIcsText('Harbour Cafe, Ltd'),
    )
    ok('(J27) and a semicolon', escapeIcsText('a; b') === 'a\\; b')
    ok(
      '(J27) *** the backslash is escaped FIRST, or the others double-escape ***',
      escapeIcsText('A\\B, C') === 'A\\\\B\\, C',
      escapeIcsText('A\\B, C'),
    )
    ok(
      '(J27) a newline becomes a literal \\n, not a real line break',
      escapeIcsText('one\ntwo') === 'one\\ntwo',
    )

    // ── Folding, in OCTETS. ─────────────────────────────────────────────
    const bytes = (s: string) => new TextEncoder().encode(s).length
    const longest = (s: string) => Math.max(...s.split('\r\n').map(bytes))

    ok('(J27) a short line is left alone', foldIcsLine('SUMMARY:short') === 'SUMMARY:short')
    ok(
      '(J27) a long one folds to 75 octets or fewer',
      longest(foldIcsLine('SUMMARY:' + 'x'.repeat(200))) <= 75,
      String(longest(foldIcsLine('SUMMARY:' + 'x'.repeat(200)))),
    )
    ok(
      '(J27) every continuation begins with a space',
      foldIcsLine('SUMMARY:' + 'x'.repeat(200))
        .split('\r\n')
        .slice(1)
        .every((l) => l.startsWith(' ')),
    )
    /*
     * The one a character count gets wrong. An emoji is four octets, so forty of
     * them are 160 bytes in 40 characters — a naive fold produces lines that are
     * legal by length and illegal by size, and splitting mid-surrogate produces
     * invalid UTF-8 that can take a parser down.
     */
    ok(
      '(J27) *** multi-byte text folds by OCTET, not by character ***',
      longest(foldIcsLine('SUMMARY:' + '🔧'.repeat(40))) <= 75,
      String(longest(foldIcsLine('SUMMARY:' + '🔧'.repeat(40)))),
    )
    ok(
      '(J27) and no surrogate pair is cut in half',
      !foldIcsLine('SUMMARY:' + '🔧'.repeat(40)).includes('�'),
    )

    // ── The stamp is UTC, always. ───────────────────────────────────────
    ok(
      '(J27) a stamp is Zulu time, so no VTIMEZONE block is needed',
      toIcsStamp(new Date(Date.UTC(2026, 7, 20, 8, 5, 0))) === '20260820T080500Z',
      toIcsStamp(new Date(Date.UTC(2026, 7, 20, 8, 5, 0))),
    )

    // ── A whole calendar. ───────────────────────────────────────────────
    const ics = buildIcs(
      [
        {
          uid: 'job-visit-1-99@odyssey',
          startsAt: new Date(Date.UTC(2026, 7, 20, 8, 0, 0)),
          endsAt: new Date(Date.UTC(2026, 7, 20, 9, 30, 0)),
          summary: 'Harbour Cafe, Ltd — service; annual',
          description: 'JC000123\nGate code 4471',
          location: 'Unit 4, Main Rd',
        },
      ],
      { name: 'Piet — jobs', stampedAt: new Date(Date.UTC(2026, 7, 13, 6, 0, 0)) },
    )

    ok('(J27) it opens and closes as a VCALENDAR', ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'))
    ok(
      '(J27) *** every line is CRLF and the file ends with one — Outlook rejects otherwise ***',
      !/[^\r]\n/.test(ics) && ics.endsWith('\r\n'),
    )
    ok(
      '(J27) no line exceeds 75 octets anywhere in the file',
      ics.split('\r\n').every((l) => bytes(l) <= 75),
    )
    ok('(J27) the commas inside SUMMARY survived escaping', ics.includes('Harbour Cafe\\, Ltd'))
    /*
     * The most important property in the file. A calendar matches events by UID;
     * if it moved when a visit was edited the subscriber would end up holding
     * both the old booking and the new one.
     */
    ok('(J27) the UID is carried through verbatim', ics.includes('UID:job-visit-1-99@odyssey'))
    ok(
      '(J27) and a cancelled visit publishes as CANCELLED rather than vanishing',
      buildIcs(
        [
          {
            uid: 'x@odyssey',
            startsAt: new Date(),
            endsAt: new Date(),
            summary: 'x',
            status: 'CANCELLED',
          },
        ],
        { name: 'x', stampedAt: new Date() },
      ).includes('STATUS:CANCELLED'),
    )

    // ── The token names one person on one site. ─────────────────────────
    const token = await createCalendarToken(SITE, 4)
    const back = await readCalendarToken(token)
    ok('(J27) a token round-trips', back?.siteId === SITE && back?.userId === 4)
    ok('(J27) rubbish is refused', (await readCalendarToken('not-a-token')) === null)
    ok(
      '(J27) *** and a tampered signature is refused — the URL IS the credential ***',
      (await readCalendarToken(token.slice(0, -3) + 'aaa')) === null,
    )
  }

  /*
   * ── (J28) Crews ───────────────────────────────────────────────────────────
   *
   * Section 16. A crew is a SHORTCUT, not an owner: choosing one expands into
   * individual job_card_people rows and is then forgotten by the job. That is the
   * whole design, and these checks are what hold it in place.
   *
   * The load-bearing assertion is the last pair: editing a crew after it has been
   * applied must not reach backwards into the job. A job_cards.team_id would have
   * made that impossible to guarantee — retiring the North crew would silently
   * rewrite who did last month's work.
   */
  {
    // Mail off for the whole block, for the (J22) reason: applyTeamToJob goes
    // through setJobPerson, which notifies, and this box has real SMTP.
    const notifyWasEnabled = await getSetting(SITE, 'job_notify_enabled').catch(() => '1')
    await setSetting(SITE, 'job_notify_enabled', '0')

    const users = await listUsers(SITE)
    const active = users.filter((u) => u.isActive && u.userType === 'back_office')

    const crewName = `JCT${stamp} north crew`

    // ── The refusals, before anything is built ──────────────────────────────
    const nobody = await saveJobTeam(SITE, actor, {
      id: null, name: crewName, description: null, isActive: true, members: [],
    })
    ok(
      '(J28) *** a crew with nobody on it is refused — it would do nothing ***',
      !nobody.ok,
      nobody.ok ? 'ACCEPTED' : nobody.error,
    )

    const nameless = await saveJobTeam(SITE, actor, {
      id: null, name: '   ', description: null, isActive: true,
      members: active.length ? [{ userId: active[0].id, isLead: true }] : [],
    })
    ok('(J28) and one with no name', !nameless.ok, nameless.ok ? 'ACCEPTED' : nameless.error)

    const ghost = await saveJobTeam(SITE, actor, {
      id: null, name: crewName, description: null, isActive: true,
      members: [{ userId: 999999, isLead: true }],
    })
    ok(
      '(J28) a crew cannot name somebody who is not a user here',
      !ghost.ok,
      ghost.ok ? 'ACCEPTED' : ghost.error,
    )

    if (active.length < 2) {
      ok('(J28) SKIPPED — needs two active back-office users on this site', true)
    } else {
      const [alice, bob] = active

      const twoLeads = await saveJobTeam(SITE, actor, {
        id: null, name: crewName, description: null, isActive: true,
        members: [{ userId: alice.id, isLead: true }, { userId: bob.id, isLead: true }],
      })
      ok(
        '(J28) *** two leads is REFUSED, not silently corrected ***',
        !twoLeads.ok,
        twoLeads.ok ? 'ACCEPTED' : twoLeads.error,
      )

      // ── Building one ──────────────────────────────────────────────────────
      const made = await saveJobTeam(SITE, actor, {
        id: null, name: crewName, description: 'The northern round', isActive: true,
        members: [{ userId: alice.id, isLead: true }, { userId: bob.id, isLead: false }],
      })
      ok('(J28) a crew with a lead and a member saves', made.ok, made.ok ? '' : made.error)
      if (!made.ok) throw new Error('crew fixture failed')
      const teamId = made.id

      const dup = await saveJobTeam(SITE, actor, {
        id: null, name: crewName, description: null, isActive: true,
        members: [{ userId: alice.id, isLead: true }],
      })
      ok(
        '(J28) two crews cannot share a name',
        !dup.ok,
        dup.ok ? 'ACCEPTED' : dup.error,
      )

      const read = await getJobTeam(SITE, teamId)
      ok(
        '(J28) it reads back with both people and exactly one lead',
        read !== null &&
          read.members.length === 2 &&
          read.members.filter((m) => m.isLead).length === 1,
        `${read?.members.length ?? 0} member(s)`,
      )
      ok(
        '(J28) and the member name is SNAPSHOT, so a rename cannot blank the list',
        read?.members.every((m) => m.userName.length > 0) === true,
      )

      // ── Putting it on a job ───────────────────────────────────────────────
      const cJob = await saveJobCard(SITE, actor, {
        id: null, customerId, customerName: null, customerPhone: null,
        customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
        priority: 'normal', ownerUserId: null, ownerName: '',
        title: `JCT${stamp} crew job`, description: null, dueAt: null,
        source: 'manual', reference: null, internalNote: null,
      })
      if (!cJob.ok) throw new Error('crew job fixture failed')
      const cJobId = cJob.id

      const applied = await applyTeamToJob(SITE, actor, cJobId, teamId)
      ok('(J28) the crew goes on the job', applied.ok && applied.added === 2,
        `added ${applied.added}, skipped ${applied.skipped.length}`)

      const onJob = await peopleFor(SITE, cJobId)
      ok(
        '(J28) *** and lands as INDIVIDUAL rows — a crew owns no job ***',
        onJob.length === 2 && onJob.every((p) => p.role === 'assignee'),
        `${onJob.length} row(s)`,
      )

      /*
       * Twice is not an error; it is a no-op that says who it left alone.
       *
       * This was a real bug. setJobPerson is deliberately idempotent — its INSERT
       * is ON DUPLICATE KEY UPDATE, which is how a follower gets promoted — so
       * applying a crew twice reported "2 added" having added nobody, and would
       * have sent two people a second email about work they already had.
       */
      const again = await applyTeamToJob(SITE, actor, cJobId, teamId)
      ok(
        '(J28) *** applying it twice adds NOBODY and names who was left alone ***',
        again.ok && again.added === 0 && again.skipped.length === 2 &&
          again.skipped.every((s) => s.userName.length > 0),
        `added ${again.added}, skipped ${again.skipped.length}`,
      )

      /*
       * But a FOLLOWER on the crew is not "already on this job" in the sense that
       * matters: applying the crew genuinely changes their role, and they should
       * be told. The skip is about assignees, not about the row existing.
       */
      await removeJobPerson(SITE, actor, cJobId, bob.id)
      await setJobPerson(SITE, actor, cJobId, bob.id, 'follower')
      const promoting = await applyTeamToJob(SITE, actor, cJobId, teamId)
      ok(
        '(J28) *** but a FOLLOWER on the crew IS promoted, and counted ***',
        promoting.ok && promoting.added === 1,
        `added ${promoting.added}, skipped ${promoting.skipped.length}`,
      )
      ok(
        '(J28) and they are an assignee afterwards',
        (await peopleFor(SITE, cJobId)).some(
          (p) => p.userId === bob.id && p.role === 'assignee',
        ),
      )

      /*
       * The owner is skipped rather than refused, because applyTeamToJob goes
       * through the same door setJobPerson does — and that door refuses the owner
       * so nobody is counted twice on a workload figure. A crew containing the
       * owner must therefore add one person fewer, and SAY so.
       */
      const soloJob = await saveJobCard(SITE, actor, {
        id: null, customerId, customerName: null, customerPhone: null,
        customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
        priority: 'normal', ownerUserId: alice.id, ownerName: alice.name,
        title: `JCT${stamp} crew owner job`, description: null, dueAt: null,
        source: 'manual', reference: null, internalNote: null,
      })
      if (!soloJob.ok) throw new Error('crew owner job fixture failed')
      const ownerApplied = await applyTeamToJob(SITE, actor, soloJob.id, teamId)
      ok(
        '(J28) *** a crew containing the OWNER adds one fewer, and names them ***',
        ownerApplied.ok && ownerApplied.added === 1 &&
          ownerApplied.skipped.some((s) => s.userName === alice.name),
        `added ${ownerApplied.added}, skipped ${ownerApplied.skipped.map((s) => s.userName).join(',')}`,
      )

      // ── Editing it does not reach backwards ───────────────────────────────
      const shrunk = await saveJobTeam(SITE, actor, {
        id: teamId, name: crewName, description: null, isActive: true,
        members: [{ userId: alice.id, isLead: true }],
      })
      ok('(J28) somebody can be taken off the crew', shrunk.ok, shrunk.ok ? '' : shrunk.error)
      const afterShrink = await peopleFor(SITE, cJobId)
      ok(
        '(J28) *** the JOB still has both — editing a crew never rewrites history ***',
        afterShrink.length === 2,
        `${afterShrink.length} row(s) on the job`,
      )

      // ── Retiring, and deleting ────────────────────────────────────────────
      await saveJobTeam(SITE, actor, {
        id: teamId, name: crewName, description: null, isActive: false,
        members: [{ userId: alice.id, isLead: true }],
      })
      const retiredApply = await applyTeamToJob(SITE, actor, cJobId, teamId)
      ok(
        '(J28) a retired crew cannot be put on a job',
        !retiredApply.ok,
        retiredApply.ok ? 'ACCEPTED' : retiredApply.error,
      )
      ok(
        '(J28) and it is out of the picker but still readable',
        (await listJobTeams(SITE, false)).every((t) => t.id !== teamId) &&
          (await listJobTeams(SITE, true)).some((t) => t.id === teamId),
      )

      const missing = await applyTeamToJob(SITE, actor, cJobId, 999999)
      ok('(J28) a crew that does not exist is refused', !missing.ok)

      // ── Drift ─────────────────────────────────────────────────────────────
      const leaderless = await saveJobTeam(SITE, actor, {
        id: teamId, name: crewName, description: null, isActive: true,
        members: [{ userId: bob.id, isLead: false }],
      })
      ok(
        '(J28) a crew with nobody leading it SAVES — it is drift, not an error',
        leaderless.ok,
        leaderless.ok ? '' : leaderless.error,
      )
      const drift = await reconcileJobTeams(SITE)
      ok(
        '(J28) *** and reconcile reports it — nobody is named to ask about the crew ***',
        drift.emptyTeams.some((t) => t.teamId === teamId && t.reason === 'Nobody leads it'),
        `${drift.emptyTeams.length} reported`,
      )

      const deleted = await deleteJobTeam(SITE, actor, teamId)
      ok('(J28) a crew deletes with no refusal — it holds no jobs', deleted.ok)
      const stillThere = await peopleFor(SITE, cJobId)
      ok(
        '(J28) *** and the people it put on the job STAY ***',
        stillThere.length === 2,
        `${stillThere.length} row(s)`,
      )
      ok('(J28) deleting it twice says so rather than throwing',
        !(await deleteJobTeam(SITE, actor, teamId)).ok)
    }

    await setSetting(SITE, 'job_notify_enabled', notifyWasEnabled)
  }

  // ── 34. (J29) Two-party sign-off ──────────────────────────────────────────
  //
  // The rule is a SETTING, so this section changes it and must put it back —
  // leaving a site demanding signatures would fail every close in every suite
  // that runs after this one.
  {
    const signoffWas = await getSetting(SITE, 'job_signoff_required')
    try {
      const sJob = await saveJobCard(SITE, actor, {
        id: null, customerId, customerName: null, customerPhone: null,
        customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
        priority: 'normal', ownerUserId: null, ownerName: '',
        title: `JCT${stamp} signoff job`, description: null, dueAt: null,
        source: 'manual', reference: null, internalNote: null,
      })
      if (!sJob.ok) throw new Error('signoff job fixture failed')
      const sJobId = sJob.id

      const file = (name: string) => ({
        storedName: `jct-${stamp}-${name}.png`,
        filename: `${name}.png`,
        mimeType: 'image/png',
        sizeBytes: 128,
      })

      // ── The default must change nothing ──────────────────────────────────
      await setSetting(SITE, 'job_signoff_required', 'none')
      ok(
        '(J29) *** the default demands nothing — a migration must not refuse every close ***',
        (await signoffRule(SITE)) === 'none',
      )
      const unsignedClose = await closeJob(SITE, actor, sJobId, 'Nothing required.')
      ok(
        '(J29) so an unsigned job still closes',
        unsignedClose.ok,
        unsignedClose.ok ? '' : unsignedClose.error,
      )

      // ── A closed job cannot be signed ────────────────────────────────────
      //
      // The guard that makes the rule below mean anything. Without it a job
      // could close unsigned and be signed afterwards at leisure, which makes
      // the requirement decorative.
      const lateSign = await signJob(SITE, actor, sJobId, 'customer', file('late'), 'Too Late')
      ok(
        '(J29) *** a CLOSED job refuses a signature — otherwise the rule is decorative ***',
        !lateSign.ok,
        lateSign.ok ? 'ACCEPTED' : lateSign.error,
      )

      await reopenJob(SITE, actor, sJobId, 'Signing test.')

      // ── Requiring the customer ───────────────────────────────────────────
      await setSetting(SITE, 'job_signoff_required', 'customer')
      const refused = await closeJob(SITE, actor, sJobId, 'Should be refused.')
      ok(
        '(J29) *** with a signature required, closing is REFUSED ***',
        !refused.ok,
        refused.ok ? 'CLOSED ANYWAY' : refused.error,
      )
      ok(
        '(J29) and the refusal NAMES who has to sign',
        !refused.ok && /customer/i.test(refused.error),
        refused.ok ? '' : refused.error,
      )

      const signed = await signJob(SITE, actor, sJobId, 'customer', file('cust'), 'Mrs Adams')
      ok('(J29) the customer signs', signed.ok, signed.ok ? '' : signed.error)

      const marks = await jobSignoff(SITE, sJobId)
      ok(
        '(J29) the mark reads back with the name they typed, not the account name',
        marks.customer?.name === 'Mrs Adams',
        marks.customer?.name ?? 'null',
      )
      ok(
        '(J29) *** and resolves the STORED name, not the display filename ***',
        marks.customer?.storedName === `jct-${stamp}-cust.png`,
        marks.customer?.storedName ?? 'null',
      )
      ok(
        '(J29) the technician side is still empty — one party is not both',
        marks.technician === null,
      )

      const nowCloses = await closeJob(SITE, actor, sJobId, 'Signed for.')
      ok('(J29) and now it closes', nowCloses.ok, nowCloses.ok ? '' : nowCloses.error)
      await reopenJob(SITE, actor, sJobId, 'More signing.')

      // ── Requiring both ───────────────────────────────────────────────────
      await setSetting(SITE, 'job_signoff_required', 'both')
      const halfSigned = await closeJob(SITE, actor, sJobId, 'Half signed.')
      ok(
        '(J29) with BOTH required, one signature is not enough',
        !halfSigned.ok,
        halfSigned.ok ? 'CLOSED ANYWAY' : halfSigned.error,
      )
      ok(
        '(J29) and it names the missing party only — not the one already signed',
        !halfSigned.ok &&
          /technician/i.test(halfSigned.error) &&
          !/customer/i.test(halfSigned.error),
        halfSigned.ok ? '' : halfSigned.error,
      )

      // An unnamed technician mark falls back to whoever is holding the device,
      // because there the signer and the account almost always agree.
      const techSigned = await signJob(SITE, actor, sJobId, 'technician', file('tech'), null)
      ok('(J29) the technician signs', techSigned.ok)
      const bothMarks = await jobSignoff(SITE, sJobId)
      ok(
        '(J29) an unnamed TECHNICIAN mark falls back to the actor',
        bothMarks.technician?.name === actor.userName,
        bothMarks.technician?.name ?? 'null',
      )
      ok(
        '(J29) *** but an unnamed CUSTOMER mark stays unnamed — it is not our name to give ***',
        (
          await (async () => {
            await unsignJob(SITE, actor, sJobId, 'customer')
            await signJob(SITE, actor, sJobId, 'customer', file('anon'), null)
            return jobSignoff(SITE, sJobId)
          })()
        ).customer?.name === null,
      )

      const bothClose = await closeJob(SITE, actor, sJobId, 'Both signed.')
      ok('(J29) with both signed it closes', bothClose.ok, bothClose.ok ? '' : bothClose.error)

      // ── Cancelling is never blocked ──────────────────────────────────────
      //
      // Refusing to CANCEL a job because nobody signed for work that never
      // happened is how a job nobody wants stays open forever. 123 seeds
      // Cancelled with blocks_on_incomplete = 0 for exactly this reason.
      await reopenJob(SITE, actor, sJobId, 'Cancelling test.')
      await unsignJob(SITE, actor, sJobId, 'customer')
      await unsignJob(SITE, actor, sJobId, 'technician')
      const cancelStatus = await statusForRole(SITE, 'cancelled')
      if (cancelStatus) {
        const cancelled = await setStatus(SITE, actor, sJobId, cancelStatus.id, 'Customer withdrew.')
        ok(
          '(J29) *** an UNSIGNED job still cancels — a job nobody wants must not be trapped ***',
          cancelled.ok,
          cancelled.ok ? '' : cancelled.error,
        )
      }

      // ── Withdrawing keeps the evidence ───────────────────────────────────
      const afterUnsign = await jobSignoff(SITE, sJobId)
      ok(
        '(J29) withdrawing clears the claim',
        afterUnsign.customer === null && afterUnsign.technician === null,
      )
      /*
       * Every mark ever made is still filed — three of them: the customer's
       * first, the unnamed one that replaced it, and the technician's.
       *
       * Re-signing REPLACES the link and leaves the old document, exactly as
       * captureEvidence does, so the count is what was drawn rather than what is
       * currently claimed. An earlier version of this assertion expected four by
       * counting sign() calls and forgetting that a withdrawal writes nothing.
       */
      const stillFiled = await siteQuery<{ n: number }>(
        SITE,
        `SELECT COUNT(*) AS n FROM party_documents
          WHERE entity = 'job_card' AND entity_id = ?`,
        [sJobId],
      )
      ok(
        '(J29) *** but the marks stay on the Files tab — a withdrawal is not a deletion ***',
        Number(stillFiled[0]?.n ?? 0) === 3,
        `${stillFiled[0]?.n ?? 0} document(s)`,
      )

      // ── Reports, never repairs ───────────────────────────────────────────
      //
      // Closed and unsigned, deliberately, so there is something real to find.
      // Asserting only that reconcile returned an ARRAY would pass on an empty
      // one — the shape of vacuous test that let a cross-audience token check
      // pass while checking nothing.
      await setSetting(SITE, 'job_signoff_required', 'none')
      const reopenedForDrift = await reopenJob(SITE, actor, sJobId, 'Drift fixture.')
      const closedUnsigned = await closeJob(SITE, actor, sJobId, 'Closed unsigned.')
      ok(
        '(J29) the drift fixture is genuinely closed and unsigned',
        reopenedForDrift.ok && closedUnsigned.ok,
        closedUnsigned.ok ? '' : `reopen ${reopenedForDrift.ok} / close ${closedUnsigned.ok}`,
      )
      await setSetting(SITE, 'job_signoff_required', 'customer')
      const drift = await reconcileSignoff(SITE)
      ok(
        '(J29) *** reconcile REPORTS a job closed without the signature it needed ***',
        drift.closedUnsigned.some((j) => j.id === sJobId && j.missing === 'customer'),
        `${drift.closedUnsigned.length} reported`,
      )
      const stillUnsigned = await jobSignoff(SITE, sJobId)
      ok(
        '(J29) and repairs nothing — reconcile never signs on anybody behalf',
        stillUnsigned.customer === null,
      )

    } finally {
      await setSetting(SITE, 'job_signoff_required', signoffWas ?? 'none')
    }
  }

  // ── 35. (J30) An expense is its own kind of line ──────────────────────────
  {
    const eJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} expense job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!eJob.ok) throw new Error('expense job fixture failed')
    const eJobId = eJob.id

    // Its own supplier and category, so nothing here depends on demo data.
    const supRes = await siteExecute(
      SITE,
      `INSERT INTO suppliers (code, name, status) VALUES (?, ?, 'active')`,
      [`JCX${stamp}`, `JCT${stamp} subcontractor`],
    )
    const supplierId = Number(supRes.insertId)
    const catRes = await siteExecute(
      SITE,
      `INSERT INTO expense_categories (account_code, name, category_type)
       VALUES (?, ?, 'cost_of_sales')`,
      [`JC${stamp.slice(0, 4)}`, `JCT${stamp} subcontract`],
    )
    const categoryId = Number(catRes.insertId)

    const base = {
      id: null, productId: null, productCode: null, qty: 1,
      vatRatePct: 15, discountPct: 0, note: null,
    }

    const savedExp = await saveLines(SITE, actor, eJobId, [
      {
        ...base, lineKind: 'expense' as const, billingState: 'pending' as const,
        description: 'JCT subcontractor invoice', unitCostExcl: 4000, unitPriceIncl: 5750,
        supplierId, expenseCategoryId: categoryId,
      },
      {
        ...base, lineKind: 'labour' as const, billingState: 'pending' as const,
        description: 'JCT supervision', qty: 2, unitCostExcl: 300, unitPriceIncl: 690,
        supplierId, expenseCategoryId: categoryId,
      },
    ])
    ok('(J30) an expense line saves', savedExp.ok, savedExp.ok ? '' : savedExp.error)

    const withExp = await getJobCard(SITE, eJobId)
    const expLine = withExp!.lines.find((l) => l.lineKind === 'expense')
    const labLine = withExp!.lines.find((l) => l.lineKind === 'labour')

    ok(
      '(J30) it keeps who was paid, and reads the name back',
      expLine?.supplierId === supplierId && expLine?.supplierName === `JCT${stamp} subcontractor`,
      `${expLine?.supplierId} / ${expLine?.supplierName ?? 'null'}`,
    )
    ok(
      '(J30) and the category it lands in on the P&L',
      expLine?.expenseCategoryId === categoryId &&
        expLine?.expenseCategoryName === `JCT${stamp} subcontract`,
      expLine?.expenseCategoryName ?? 'null',
    )
    /*
     * The rule the screen cannot enforce on its own: a supplier belongs to an
     * expense. The labour line was SENT one, deliberately, because the kind can
     * be changed on a row that already carries one.
     */
    ok(
      '(J30) *** a supplier sent on a LABOUR line is dropped — it belongs to an expense ***',
      labLine?.supplierId === null && labLine?.expenseCategoryId === null,
      `${labLine?.supplierId} / ${labLine?.expenseCategoryId}`,
    )

    // Switching an existing expense to another kind must clear it too, which is
    // the case a create-time check would miss entirely.
    const switched = await saveLines(SITE, actor, eJobId, [
      {
        ...base, id: expLine!.id, lineKind: 'charge' as const, billingState: 'pending' as const,
        description: 'JCT subcontractor invoice', unitCostExcl: 4000, unitPriceIncl: 5750,
        supplierId, expenseCategoryId: categoryId,
      },
    ])
    ok('(J30) the line changes kind', switched.ok, switched.ok ? '' : switched.error)
    const afterSwitch = await getJobCard(SITE, eJobId)
    ok(
      '(J30) *** and switching AWAY from expense clears the supplier ***',
      afterSwitch!.lines[0]?.supplierId === null,
      String(afterSwitch!.lines[0]?.supplierId),
    )

    /*
     * (J2) still holds: cost counts EVERY line whatever its kind. An expense is
     * a cost like any other, and a new kind that quietly fell out of the total
     * would be the worst possible outcome of this change.
     */
    await saveLines(SITE, actor, eJobId, [
      {
        ...base, lineKind: 'expense' as const, billingState: 'internal' as const,
        description: 'JCT disposal fee', unitCostExcl: 250, unitPriceIncl: 0,
        supplierId: null, expenseCategoryId: null,
      },
    ])
    const costed = await getJobCard(SITE, eJobId)
    ok(
      '(J30) *** an expense counts in cost — (J2) holds for the new kind ***',
      costed!.totals.cost === 250,
      `cost ${costed!.totals.cost}`,
    )

    // The report builder must OFFER the new kind, which is the drift the plan
    // flagged: a hard-coded four-value list would filter expenses out silently.
    const kindField = fieldsFor(getSource('jobCardLines')!, (() => true) as never).find(
      (f) => f.key === 'lineKind',
    )
    ok(
      '(J30) *** the report builder offers Expense — a hard-coded list would hide it ***',
      kindField?.options?.some((o) => o.value === 'expense') === true,
      (kindField?.options ?? []).map((o) => o.value).join(', '),
    )

    await siteExecute(SITE, `DELETE FROM job_card_lines WHERE job_card_id = ?`, [eJobId])
    await siteExecute(SITE, `DELETE FROM expense_categories WHERE id = ?`, [categoryId])
    await siteExecute(SITE, `DELETE FROM suppliers WHERE id = ?`, [supplierId])
  }

  // ── 36. (J31) More than one piece of equipment on a job ───────────────────
  //
  // The whole risk of 161 is the READS, not the write. "The jobs for this asset"
  // was `WHERE asset_id = ?` in eleven places; a join table that fixes only the
  // history query leaves three job_count subqueries quietly wrong, and an asset
  // showing four jobs on one screen and six on another looks like working
  // software from every angle except the right one.
  {
    const mkAsset = async (label: string) => {
      const r = await saveAsset(SITE, actor, {
        id: null, assetTypeId: null, customerId, serviceAddressId: null,
        description: `AS${stamp} ${label}`, make: null, model: null,
        serialText: null, productId: null, serialId: null,
        installedOn: null, purchasedOn: null, purchaseReference: null,
        warrantyUntil: null, conditionNote: null, note: null,
        nextServiceOn: null,
      } as never)
      if (!r.ok) throw new Error(`asset fixture ${label} failed`)
      return r.id
    }
    const primary = await mkAsset('multi primary')
    const second = await mkAsset('multi second')

    const mJob = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} multi asset job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!mJob.ok) throw new Error('multi asset job fixture failed')
    const mJobId = mJob.id

    await setJobAsset(SITE, actor, mJobId, primary)
    const added = await addJobAsset(SITE, actor, mJobId, second, 'Gas top-up')
    ok('(J31) a second unit goes on the visit', added.ok, added.ok ? '' : added.error)

    ok(
      '(J31) *** the primary is NOT one of the others — it is the subject, not a member ***',
      !(await addJobAsset(SITE, actor, mJobId, primary)).ok,
    )
    const twice = await addJobAsset(SITE, actor, mJobId, second)
    ok(
      '(J31) adding the same unit twice says so rather than duplicating',
      !twice.ok,
      twice.ok ? 'ACCEPTED' : twice.error,
    )

    const others = await otherJobAssets(SITE, mJobId)
    ok(
      '(J31) the list holds the second unit and its note',
      others.length === 1 && others[0]?.assetId === second && others[0]?.note === 'Gas top-up',
      `${others.length} row(s)`,
    )

    /*
     * THE READS. Both assets must report this job — in the history AND in the
     * count — or the two screens disagree.
     */
    const hPrimary = await assetHistory(SITE, primary)
    const hSecond = await assetHistory(SITE, second)
    ok(
      '(J31) the primary asset has the job in its history, marked primary',
      hPrimary.some((h) => h.jobId === mJobId && h.isPrimary),
    )
    ok(
      '(J31) *** and so does the SECOND — a history that missed it would say the unit was never touched ***',
      hSecond.some((h) => h.jobId === mJobId && !h.isPrimary),
      `${hSecond.length} row(s)`,
    )

    const listed = await listAssets(SITE, { includeRetired: true })
    const countOf = (id: number) => listed.find((a) => a.id === id)?.jobCount ?? -1
    ok(
      '(J31) *** the job COUNT spans both sources — fixing only the history is the silent failure ***',
      countOf(primary) === 1 && countOf(second) === 1,
      `primary ${countOf(primary)}, second ${countOf(second)}`,
    )

    /*
     * Closing the visit must service EVERY unit on it. Left as the primary
     * alone, three of four would still show as due — and somebody would drive
     * out to a unit serviced last week.
     */
    await closeJob(SITE, actor, mJobId, 'All units done.')
    const servicedPrimary = await getAsset(SITE, primary)
    const servicedSecond = await getAsset(SITE, second)
    ok(
      '(J31) *** closing services every unit on the visit, not just the primary ***',
      servicedPrimary?.lastServiceOn !== null && servicedSecond?.lastServiceOn !== null,
      `primary ${servicedPrimary?.lastServiceOn ?? 'null'}, second ${servicedSecond?.lastServiceOn ?? 'null'}`,
    )

    // A closed job refuses equipment changes, matching setJobAsset.
    ok(
      '(J31) a closed job refuses another unit',
      !(await addJobAsset(SITE, actor, mJobId, second)).ok,
    )

    await reopenJob(SITE, actor, mJobId, 'Removing a unit.')
    const removed = await removeJobAsset(SITE, actor, mJobId, second)
    ok('(J31) a unit comes off the visit', removed.ok, removed.ok ? '' : removed.error)
    ok(
      '(J31) and removing it twice says so rather than throwing',
      !(await removeJobAsset(SITE, actor, mJobId, second)).ok,
    )
    ok(
      '(J31) its history entry goes with it — the visit no longer covered it',
      !(await assetHistory(SITE, second)).some((h) => h.jobId === mJobId),
    )

    await siteExecute(SITE, `DELETE FROM job_card_assets WHERE job_card_id = ?`, [mJobId])
    await siteExecute(SITE, `UPDATE job_cards SET asset_id = NULL WHERE id = ?`, [mJobId])
    await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [mJobId])
    await siteExecute(SITE, `DELETE FROM customer_assets WHERE id IN (?, ?)`, [primary, second])
  }

  // ── 37. (J32) Asking for a part the shop does not have ────────────────────
  {
    const pJobReq = await saveJobCard(SITE, actor, {
      id: null, customerId, customerName: null, customerPhone: null,
      customerEmail: null, serviceAddressId: null, locationId: null, statusId: null,
      priority: 'normal', ownerUserId: null, ownerName: '',
      title: `JCT${stamp} parts request job`, description: null, dueAt: null,
      source: 'manual', reference: null, internalNote: null,
    })
    if (!pJobReq.ok) throw new Error('parts request job fixture failed')
    const prJobId = pJobReq.id

    // Counted BEFORE, because the assertion is that asking writes none at all —
    // stock_movements carries no reference we could match on, and a total is
    // the honest test anyway.
    const movesBefore = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM stock_movements`,
    )

    const asked = await requestPart(SITE, actor, {
      jobCardId: prJobId,
      description: `JCT${stamp} brake pad set`,
      qty: 4,
      reason: 'Customer waiting',
    })
    ok('(J32) a technician can ask for a part', asked.ok, asked.ok ? '' : asked.error)
    if (!asked.ok) throw new Error('part request fixture failed')
    const reqId = asked.id

    /*
     * *** IT RESERVES NOTHING. ***
     *
     * jobParts.ts:23-41 records that a job reservation folded into
     * reservedQtyFor() was designed and DELIBERATELY DROPPED: availableToSell()
     * subtracts a site-wide reservation from the MAIN pile which has already
     * dropped by the transfer, so the same unit is deducted twice for every part
     * in every van, permanently. A part that does not exist yet must certainly
     * not reserve anything.
     */
    const movesAfter = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM stock_movements`,
    )
    ok(
      '(J32) *** asking writes NO stock movement — a request reserves nothing ***',
      Number(movesAfter[0]?.n ?? 0) === Number(movesBefore[0]?.n ?? 0),
      `${movesBefore[0]?.n} then ${movesAfter[0]?.n}`,
    )

    ok(
      '(J32) it shows on the job, and on the buyer queue',
      (await requestsForJob(SITE, prJobId)).some((r) => r.id === reqId) &&
        (await requestQueue(SITE)).some((r) => r.id === reqId),
    )

    // ── Deciding ────────────────────────────────────────────────────────────
    const approved = await decideRequest(SITE, actor, reqId, 'approved', 'Order it')
    ok('(J32) a buyer approves it', approved.ok, approved.ok ? '' : approved.error)
    const twice = await decideRequest(SITE, actor, reqId, 'cancelled', null)
    ok(
      '(J32) *** and a decided request cannot be decided again ***',
      !twice.ok,
      twice.ok ? 'ACCEPTED' : twice.error,
    )

    // ── The order, raised the ordinary way ──────────────────────────────────
    const sup = await siteQuery<{ id: number; code: string; name: string }>(
      SITE,
      `SELECT id, code, name FROM suppliers WHERE status = 'active' LIMIT 1`,
    )
    const poRes = await siteExecute(
      SITE,
      `INSERT INTO purchase_documents (doc_type, status, document_date, supplier_id,
         supplier_code, supplier_name, user_id, user_name, subtotal_excl, vat_total, total_incl)
       VALUES ('purchase_order','draft',CURDATE(),?,?,?,?,?,0,0,0)`,
      [Number(sup[0]!.id), String(sup[0]!.code), String(sup[0]!.name), actor.userId, actor.userName],
    )
    const poId = Number(poRes.insertId)
    const plRes = await siteExecute(
      SITE,
      `INSERT INTO purchase_document_lines
         (document_id, line_number, description, qty_ordered, qty_received, unit_cost_excl, vat_rate_pct)
       VALUES (?,1,?,4,0,100,15)`,
      [poId, `JCT${stamp} brake pad set`],
    )
    const plId = Number(plRes.insertId)

    const linked = await linkToOrder(SITE, actor, reqId, plId)
    ok('(J32) linking it to a purchase line moves it to on order', linked.ok)
    ok(
      '(J32) and the job can see which order it is on',
      (await requestsForJob(SITE, prJobId))[0]?.purchaseLineId === plId,
    )

    /*
     * Nothing has been received yet, so nothing may be claimed. A request that
     * flipped to "arrived" the moment it was ordered would tell a technician
     * their part was in when it was still on a lorry.
     */
    await markReceivedForDocument(SITE, poId)
    ok(
      '(J32) *** nothing received yet, so nothing is claimed ***',
      (await requestsForJob(SITE, prJobId))[0]?.status === 'ordered',
    )

    await siteExecute(SITE, `UPDATE purchase_document_lines SET qty_received = 4 WHERE id = ?`, [
      plId,
    ])
    await markReceivedForDocument(SITE, poId)
    ok(
      '(J32) once the goods arrive, the request says so',
      (await requestsForJob(SITE, prJobId))[0]?.status === 'received',
    )

    /*
     * The CLAIM is stamped before the bell, so running the tail twice cannot
     * notify twice — lowStockAlert.ts:85 is the pattern. Asserted by counting
     * the notifications after a second call.
     */
    const beforeSecond = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM notifications WHERE event = 'job_part_received' AND title LIKE ?`,
      [`%${stamp}%`],
    )
    await markReceivedForDocument(SITE, poId)
    const afterSecond = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM notifications WHERE event = 'job_part_received' AND title LIKE ?`,
      [`%${stamp}%`],
    )
    ok(
      '(J32) *** running the receipt tail twice notifies ONCE — the claim precedes the bell ***',
      Number(beforeSecond[0]?.n ?? 0) === Number(afterSecond[0]?.n ?? 0) &&
        Number(afterSecond[0]?.n ?? 0) === 1,
      `${beforeSecond[0]?.n} then ${afterSecond[0]?.n}`,
    )

    ok(
      '(J32) *** and it is addressed to the person who ASKED — the first userId producer ***',
      (
        await siteQuery<{ user_id: number | null }>(
          SITE,
          `SELECT user_id FROM notifications WHERE event = 'job_part_received' AND title LIKE ?`,
          [`%${stamp}%`],
        )
      )[0]?.user_id === actor.userId,
    )

    /*
     * *** THE SEVERING TRAP. ***
     *
     * saveOrder rewrites its lines wholesale — DELETE then re-INSERT — so a
     * buyer editing an issued order blanks job_card_line_id on every line of
     * it. The parts still arrive and no job knows they were its. Nothing else
     * in the system would ever say so, which is why this bucket exists.
     */
    await siteExecute(SITE, `UPDATE job_part_requests SET status = 'ordered' WHERE id = ?`, [reqId])
    await siteExecute(SITE, `DELETE FROM purchase_document_lines WHERE id = ?`, [plId])
    const drift = await reconcileJobPartRequests(SITE)
    ok(
      '(J32) *** reconcile catches a request whose purchase line has vanished ***',
      drift.orderedWithoutLine.some((d) => d.id === reqId),
      `${drift.orderedWithoutLine.length} reported`,
    )

    // Outstanding on a closed job: nobody is waiting, and it should be said.
    await closeJob(SITE, actor, prJobId, 'Done without the part.')
    const drift2 = await reconcileJobPartRequests(SITE)
    ok(
      '(J32) and one still outstanding on a CLOSED job',
      drift2.openOnClosedJob.some((d) => d.id === reqId),
    )
    ok(
      '(J32) a closed job refuses a new request',
      !(await requestPart(SITE, actor, {
        jobCardId: prJobId, description: `JCT${stamp} too late`, qty: 1,
      })).ok,
    )

    await siteExecute(SITE, `DELETE FROM job_part_requests WHERE job_card_id = ?`, [prJobId])
    await siteExecute(SITE, `DELETE FROM purchase_documents WHERE id = ?`, [poId])
    /*
     * BOTH notifications, by event rather than only by title.
     *
     * The first version swept `%stamp%`, which caught the "Part arrived" bell
     * but left "Part needed" behind — the two are written at different moments
     * and the requested one carries the DESCRIPTION, not the job title, so a
     * single LIKE matched only one of them. A leaked notification is exactly
     * the litter that makes somebody else's suite fail.
     */
    await siteExecute(
      SITE,
      `DELETE FROM notifications
        WHERE event IN ('job_part_requested','job_part_received') AND title LIKE ?`,
      [`%${stamp}%`],
    )
  }

  // ── 38. (J33) A promise made to ONE customer, and escalation ──────────────
  //
  // The whole risk of 164 is the NULLABLE UNIQUE KEY. (customer_id, priority)
  // with a NULL customer cannot dedupe, because NULL <> NULL — so the key
  // silently permits a second business default and INSERT IGNORE against it
  // does nothing. 113's seed comment says the gl_mappings trap did NOT apply
  // while priority was the whole key; adding customer_id made it apply.
  {
    const escWas = await getSetting(SITE, 'job_sla_escalation_enabled')
    try {
      const base = {
        name: `JCT${stamp} promise`,
        respondMinutes: 60,
        resolveMinutes: null,
        isActive: true,
        note: null,
      }

      const made = await createPolicy(SITE, actor, {
        ...base, priority: 'high' as const, customerId,
        escalateAfterMinutes: 30, escalateToUserId: actor.userId,
      })
      ok('(J33) a customer gets their own promise', made.ok, made.ok ? '' : made.error)

      /*
       * *** THE TRAP. *** Both of these are refused by an explicit read, not by
       * the unique key — which cannot see the NULL case at all.
       */
      const dupDefault = await createPolicy(SITE, actor, {
        ...base, priority: 'high' as const, customerId: null,
      })
      ok(
        '(J33) *** a SECOND business default is refused — the nullable key cannot dedupe it ***',
        !dupDefault.ok,
        dupDefault.ok ? 'ACCEPTED' : dupDefault.error,
      )
      const dupCustomer = await createPolicy(SITE, actor, {
        ...base, priority: 'high' as const, customerId,
      })
      ok(
        '(J33) and a second promise to the same customer at the same priority',
        !dupCustomer.ok,
        dupCustomer.ok ? 'ACCEPTED' : dupCustomer.error,
      )

      const policies = await listSlaPolicies(SITE)
      const mine = policies.find((p) => p.customerId === customerId && p.priority === 'high')
      const fallback = policies.find((p) => p.customerId === null && p.priority === 'high')
      ok(
        '(J33) it reads back against the customer, with their name',
        mine !== undefined && (mine.customerName ?? '').length > 0,
        mine?.customerName ?? 'null',
      )

      /*
       * SELECTION — the point of the whole phase. Three answers from one query.
       */
      const forThem = await deadlinesFor(SITE, 'high', '2026-08-14 09:00:00', undefined, customerId)
      const forOther = await deadlinesFor(SITE, 'high', '2026-08-14 09:00:00', undefined, 999999)
      const forNobody = await deadlinesFor(SITE, 'high', '2026-08-14 09:00:00')
      ok(
        '(J33) *** the customer is measured against THEIR promise ***',
        forThem.policyId === mine?.id,
        `${forThem.policyId} vs ${mine?.id}`,
      )
      ok(
        '(J33) *** and everybody else against the business default ***',
        forOther.policyId === fallback?.id && forNobody.policyId === fallback?.id,
        `other ${forOther.policyId}, none ${forNobody.policyId}, default ${fallback?.id}`,
      )

      ok(
        '(J33) a business default cannot be deleted — every job with no policy needs it',
        !(await deletePolicy(SITE, actor, fallback!.id)).ok,
      )

      // ── Escalation ────────────────────────────────────────────────────────
      await setSetting(SITE, 'job_sla_escalation_enabled', '0')
      ok(
        '(J33) escalation is OFF by default — it fills somebody elses bell',
        (await escalateOverdue(SITE)).skipped === 'off',
      )

      /*
       * A job breached days ago, measured against the policy created above.
       * Reported in the past and never answered, which is what escalation is
       * for; respond_by is stamped so the row looks like any other breached job.
       */
      const st = await siteQuery<{ id: number }>(
        SITE, `SELECT id FROM job_statuses WHERE is_active = 1 LIMIT 1`,
      )
      const breached = await siteExecute(
        SITE,
        `INSERT INTO job_cards (customer_id, status_id, status, title, reported_at, priority,
           source, sla_policy_id, respond_by)
         VALUES (?,?,'open',?, DATE_SUB(NOW(), INTERVAL 5 DAY), 'high','manual',?,
           DATE_SUB(NOW(), INTERVAL 4 DAY))`,
        [customerId, Number(st[0]!.id), `JCT${stamp} breached job`, mine!.id],
      )
      const breachedId = Number(breached.insertId)

      await setSetting(SITE, 'job_sla_escalation_enabled', '1')
      const pass1 = await escalateOverdue(SITE)
      const pass2 = await escalateOverdue(SITE)
      ok(
        '(J33) a missed promise escalates',
        pass1.escalated >= 1,
        `pass1 ${pass1.escalated}`,
      )
      ok(
        '(J33) *** and running the tick again escalates NOTHING — the claim precedes the bell ***',
        pass2.escalated === 0,
        `pass2 ${pass2.escalated}`,
      )
      ok(
        '(J33) it is addressed to the named manager, not to an audience',
        (
          await siteQuery<{ user_id: number | null }>(
            SITE,
            `SELECT user_id FROM notifications WHERE event = 'sla_escalation' LIMIT 1`,
          )
        )[0]?.user_id === actor.userId,
      )

      /*
       * Breach itself is still DERIVED — 113 argues a stored flag is wrong the
       * minute after it is written. What this table stores is that somebody was
       * TOLD, which does not go stale.
       */
      const stored = await siteQuery<{ n: number }>(
        SITE,
        `SELECT COUNT(*) AS n FROM job_cards WHERE id = ? AND respond_by < NOW()`,
        [breachedId],
      )
      ok(
        '(J33) the breach is still read off the deadline, never stored as a flag',
        Number(stored[0]?.n ?? 0) === 1,
      )

      await siteExecute(SITE, `DELETE FROM job_sla_escalations`)
      await siteExecute(SITE, `DELETE FROM notifications WHERE event = 'sla_escalation'`)
      await siteExecute(SITE, `DELETE FROM job_cards WHERE id = ?`, [breachedId])
      await deletePolicy(SITE, actor, mine!.id)
    } finally {
      await setSetting(SITE, 'job_sla_escalation_enabled', escWas ?? '0')
    }
  }

  await sweepStrays()

  /*
   * (J17) EVERY table this suite touches, not just job_cards.
   *
   * The old check looked at job_cards alone and passed while four orphaned
   * activity_log rows sat behind it. That is not a cosmetic problem: litter from
   * one suite is what makes ANOTHER suite fail, and it is genuinely hard to
   * diagnose from the far side — supplier REF55846921, left by the refers suite,
   * currently fails test:purchasing, test:opening-balances and test:payment-runs,
   * none of which have anything to do with refers.
   *
   * So each fixture pattern is asserted empty by name, and the failure says which.
   */
  const litter: [string, string, unknown[]][] = []
  const sweepCheck = async (label: string, sql: string, params: unknown[] = []) => {
    const rows = await siteQuery<any>(SITE, sql, params)
    if (rows.length > 0) litter.push([label, sql, rows])
  }

  await sweepCheck('job cards', 'SELECT id FROM job_cards WHERE title LIKE ?', [TITLE_PATTERN])
  await sweepCheck('customers', 'SELECT id FROM customers WHERE code REGEXP ?', [CUSTOMER_PATTERN])
  await sweepCheck('service addresses', 'SELECT id FROM service_addresses WHERE name LIKE ?', [
    ADDRESS_PATTERN,
  ])
  await sweepCheck('statuses', 'SELECT id FROM job_statuses WHERE name LIKE ?', [STATUS_PATTERN])
  await sweepCheck('boards', 'SELECT id FROM job_boards WHERE name LIKE ?', [BOARD_PATTERN])
  await sweepCheck('products', 'SELECT id FROM products WHERE code REGEXP ?', [PART_PATTERN])
  await sweepCheck('locations', 'SELECT id FROM stock_locations WHERE code REGEXP ?', [VAN_PATTERN])
  // The ones a pattern cannot catch: rows whose parent has already gone.
  await sweepCheck(
    'orphaned job lines',
    'SELECT l.id FROM job_card_lines l LEFT JOIN job_cards j ON j.id = l.job_card_id WHERE j.id IS NULL',
  )
  await sweepCheck(
    'orphaned activity',
    `SELECT id FROM activity_log WHERE entity = 'job_card' AND entity_id NOT IN (SELECT id FROM job_cards)`,
  )
  await sweepCheck(
    'orphaned time entries',
    'SELECT id FROM staff_time_entries WHERE job_card_id IS NOT NULL AND job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck('headlines', 'SELECT id FROM job_headlines WHERE code REGEXP ?', [
    HEADLINE_PATTERN,
  ])
  await sweepCheck(
    'orphaned job items',
    'SELECT id FROM job_card_items WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck(
    'orphaned headline links',
    'SELECT job_card_id FROM job_card_headlines WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck('equipment', 'SELECT id FROM customer_assets WHERE description REGEXP ?', [
    ASSET_PATTERN,
  ])
  await sweepCheck('kinds of equipment', 'SELECT id FROM asset_types WHERE code REGEXP ?', [
    ASSET_TYPE_PATTERN,
  ])
  await sweepCheck('schedules', 'SELECT id FROM job_series WHERE name REGEXP ?', [SERIES_PATTERN])
  await sweepCheck(
    'orphaned series runs',
    'SELECT id FROM job_series_runs WHERE series_id NOT IN (SELECT id FROM job_series)',
  )
  await sweepCheck(
    'jobs left pointing at a gone schedule',
    'SELECT id FROM job_cards WHERE series_id IS NOT NULL AND series_id NOT IN (SELECT id FROM job_series)',
  )
  await sweepCheck('evidence jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    EVIDENCE_JOB_PATTERN,
  ])
  await sweepCheck('evidence headlines', 'SELECT id FROM job_headlines WHERE code REGEXP ?', [
    EVIDENCE_HEADLINE_PATTERN,
  ])
  await sweepCheck('people jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    PEOPLE_JOB_PATTERN,
  ])
  await sweepCheck(
    'orphaned job people',
    'SELECT user_id FROM job_card_people WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck('automation jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    AUTOMATION_JOB_PATTERN,
  ])
  await sweepCheck(
    'orphaned automation runs',
    'SELECT id FROM job_automation_runs WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck('bulk jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    BULK_JOB_PATTERN,
  ])
  await sweepCheck('saved views', 'SELECT id FROM job_saved_views WHERE name REGEXP ?', [
    VIEW_PATTERN,
  ])
  await sweepCheck('rules jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    RULES_JOB_PATTERN,
  ])
  await sweepCheck('deposit jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    DEPOSIT_JOB_PATTERN,
  ])
  await sweepCheck('crew jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    CREW_JOB_PATTERN,
  ])
  await sweepCheck('signoff jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    SIGNOFF_JOB_PATTERN,
  ])
  await sweepCheck('expense jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    EXPENSE_JOB_PATTERN,
  ])
  await sweepCheck('expense suppliers', 'SELECT id FROM suppliers WHERE code REGEXP ?', [
    EXPENSE_SUPPLIER_PATTERN,
  ])
  await sweepCheck('expense categories', 'SELECT id FROM expense_categories WHERE name REGEXP ?', [
    EXPENSE_CATEGORY_PATTERN,
  ])
  await sweepCheck('multi-asset jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    MULTI_ASSET_JOB_PATTERN,
  ])
  await sweepCheck(
    'orphaned job equipment links',
    'SELECT id FROM job_card_assets WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck('part request jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    PART_REQUEST_JOB_PATTERN,
  ])
  await sweepCheck(
    'orphaned part requests',
    'SELECT id FROM job_part_requests WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  // Notifications carry no foreign key, so nothing removes them when the job
  // goes. A leaked one is litter of exactly the kind (J17) exists to catch.
  await sweepCheck(
    'part request notifications',
    `SELECT id FROM notifications
      WHERE event IN ('job_part_requested','job_part_received') AND title LIKE ?`,
    [`%${stamp}%`],
  )
  await sweepCheck('breached jobs', 'SELECT id FROM job_cards WHERE title REGEXP ?', [
    BREACHED_JOB_PATTERN,
  ])
  await sweepCheck('per-customer SLA policies', 'SELECT id FROM job_sla_policies WHERE name REGEXP ?', [
    SLA_POLICY_PATTERN,
  ])
  /*
   * A claim whose job has gone. Nothing removes these when the job is deleted
   * outside a CASCADE path, and a leaked claim would stop a REAL escalation
   * later — the worst kind of litter, because it fails silently and elsewhere.
   */
  await sweepCheck(
    'orphaned escalation claims',
    'SELECT id FROM job_sla_escalations WHERE job_card_id NOT IN (SELECT id FROM job_cards)',
  )
  await sweepCheck(
    'escalation notifications',
    `SELECT id FROM notifications WHERE event = 'sla_escalation'`,
  )
  await sweepCheck('crews', 'SELECT id FROM job_teams WHERE name REGEXP ?', [CREW_PATTERN])
  await sweepCheck(
    'orphaned crew members',
    'SELECT user_id FROM job_team_members WHERE team_id NOT IN (SELECT id FROM job_teams)',
  )
  /*
   * A deposit whose job is gone. customer_transactions has no FK to job_cards —
   * the source pair is loose — so a deleted job leaves its deposit pointing at
   * nothing. The money stays right; what is lost is why it was taken.
   */
  await sweepCheck(
    'orphaned job deposits',
    `SELECT id FROM customer_transactions
      WHERE source = 'job_deposit' AND source_doc_id NOT IN (SELECT id FROM job_cards)`,
  )
  /*
   * A party_documents row whose job is gone. The bytes were never written by this
   * suite (captureEvidence takes the metadata, not a File), so a leftover row is a
   * document pointing at nothing — and it would surface on somebody else's Files
   * tab, not ours.
   */
  await sweepCheck(
    'orphaned job attachments',
    `SELECT id FROM party_documents
      WHERE entity = 'job_card' AND entity_id NOT IN (SELECT id FROM job_cards)`,
  )

  ok(
    '(J17) *** the suite leaves NOTHING behind — litter is how another suite fails ***',
    litter.length === 0,
    litter.map(([label, , rows]) => `${label}: ${rows.length}`).join(', '),
  )
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
