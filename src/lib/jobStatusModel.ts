/**
 * The job-status MODEL — shared by the server and the browser.
 *
 * Deliberately free of `server-only` and of any database import, because the
 * status setup screen and the job board are client components and need the same
 * roles, labels and open/closed rule the server uses. Importing them from
 * site/jobStatuses.ts would drag mysql2 into the browser bundle — which is
 * exactly what happened to quotesModel.ts before it was split out, and it broke
 * the build app-wide.
 *
 * The reading and writing half lives in site/jobStatuses.ts, which re-exports
 * this so a server caller still has one import.
 *
 * Same split, and the same reasoning, as orderStatusModel.ts / site/onlineStore.ts.
 */

/** A Badge tone, so a status stays legible in both themes. */
export type JobStatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

/**
 * What a status DOES, so code can find the right one without knowing what a
 * particular business calls it.
 *
 * A workshop that renames "In Progress" to "On the bench" must still be able to,
 * and `setStatus` must still find where a job goes when work starts. The name is
 * the business's; the role is the code's.
 *
 * '' is an ordinary step a business invented — Awaiting Parts, Quoted, Ready for
 * Collection. Most statuses in a mature pipeline are these.
 */
export type JobStatusRole =
  | ''
  | 'new'
  | 'assigned'
  | 'in_progress'
  | 'on_hold'
  | 'completed'
  | 'cancelled'

/**
 * The roles that must always exist somewhere.
 *
 * The PRD names New, Assigned, In Progress and On Hold as undeletable core
 * statuses. `completed` and `cancelled` are added because the lifecycle cannot
 * work without them: a job has to be able to finish, and `isClosed` below reads
 * exactly these two. Between them they are the six a business cannot delete its
 * way out of.
 *
 * Each role is held by at most one status at a time — the setup screen enforces
 * that, so "the status whose role is assigned" is always a single answer.
 */
export const REQUIRED_ROLES = [
  'new',
  'assigned',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
] as const

export type RequiredRole = (typeof REQUIRED_ROLES)[number]

/** What each role means, as the setup screen offers it. */
export const ROLE_LABEL: Record<Exclude<JobStatusRole, ''>, string> = {
  new: 'New jobs start here',
  assigned: 'Somebody has been made responsible',
  in_progress: 'Work is underway',
  on_hold: 'Paused, and waiting on something',
  completed: 'The work is done',
  cancelled: 'The job was called off',
}

/** How a refusal describes a role, mid-sentence. */
export function roleMeaning(role: JobStatusRole): string {
  switch (role) {
    case 'new':
      return 'a job has just come in'
    case 'assigned':
      return 'somebody has been made responsible'
    case 'in_progress':
      return 'work is underway'
    case 'on_hold':
      return 'the job is paused'
    case 'completed':
      return 'the work is done'
    case 'cancelled':
      return 'the job was called off'
    default:
      return ''
  }
}

/**
 * Open or Closed — DERIVED from the role, and never stored.
 *
 * The PRD asks for a high-level Open/Closed state alongside the detailed status,
 * and for a setting on each status that decides which. This function is that
 * setting, and it is deliberately not configurable.
 *
 * A stored `is_closed` column can disagree with the role it duplicates, and
 * there is no way to tell which one is lying. A per-status configurable flag is
 * worse: it lets somebody mark In Progress as closed and silently empty every
 * open-jobs figure, every dashboard tile and every ageing report in the app,
 * with no error and no symptom but wrong numbers.
 *
 * Closed means no more work and no more cost, and exactly two roles mean that.
 * This is the quoteState() argument — derived on read, because nobody triggers
 * it. Reaching a completed status IS closed-ness.
 */
export function isClosed(role: JobStatusRole): boolean {
  return role === 'completed' || role === 'cancelled'
}

/** The two words the interface shows for the derived state. */
export type JobState = 'open' | 'closed'

export function jobState(role: JobStatusRole): JobState {
  return isClosed(role) ? 'closed' : 'open'
}

export const JOB_STATE_LABEL: Record<JobState, string> = {
  open: 'Open',
  closed: 'Closed',
}

/**
 * Priority.
 *
 * An ENUM and not a table, unlike statuses. A priority has no workflow attached,
 * no notifications of its own and no per-business vocabulary worth protecting:
 * everybody calls the top one urgent. Ordered low to urgent so the database ENUM
 * sorts correctly on its own.
 */
export const JOB_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type JobPriority = (typeof JOB_PRIORITIES)[number]

export const PRIORITY_LABEL: Record<JobPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

/**
 * Tones chosen so the list reads at a glance without relying on colour alone —
 * the label is always rendered beside it, which the PRD requires explicitly.
 */
export const PRIORITY_TONE: Record<JobPriority, JobStatusTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
}

export function isJobPriority(value: string): value is JobPriority {
  return (JOB_PRIORITIES as readonly string[]).includes(value)
}

/**
 * Where a job came from, kept for reporting.
 *
 * `portal` and `public_form` are declared now and written by a later phase, so
 * the enum does not need widening when those arrive.
 */
export const JOB_SOURCES = [
  'manual',
  'phone',
  'email',
  'walk_in',
  'internal',
  'quote',
  'portal',
  'public_form',
] as const
export type JobSource = (typeof JOB_SOURCES)[number]

export const SOURCE_LABEL: Record<JobSource, string> = {
  manual: 'Created here',
  phone: 'Phone call',
  email: 'Email',
  walk_in: 'Walk-in',
  internal: 'Internal',
  quote: 'From a quote',
  portal: 'Customer portal',
  public_form: 'Public form',
}

export function isJobSource(value: string): value is JobSource {
  return (JOB_SOURCES as readonly string[]).includes(value)
}

/**
 * What kind of thing a cost line is.
 *
 *   part    something off the shelf, or bought in for the job
 *   labour  time, priced by the hour. qty is hours.
 *   travel  distance. qty is kilometres.
 *   charge  a fixed fee: callout, disposal, a subcontractor invoice
 */
export const LINE_KINDS = ['part', 'labour', 'travel', 'charge', 'expense'] as const
export type JobLineKind = (typeof LINE_KINDS)[number]

export const LINE_KIND_LABEL: Record<JobLineKind, string> = {
  part: 'Part',
  labour: 'Labour',
  travel: 'Travel',
  charge: 'Charge',
  expense: 'Expense',
}

/** The unit `qty` is counted in, which differs per kind. */
export const LINE_KIND_UNIT: Record<JobLineKind, string> = {
  part: '',
  labour: 'hours',
  travel: 'km',
  charge: '',
  // An expense is a sum of money, not a count of anything. qty stays 1 and the
  // figure lives in the price, the same way a charge works.
  expense: '',
}

/**
 * Which kinds name an outside party rather than something we did ourselves.
 *
 * Only `expense` today, and it is a set rather than a comparison so the next one
 * is a one-line change instead of a hunt for `=== 'expense'` scattered across
 * screens. A subcontractor invoice, a permit fee, a skip: money that left the
 * business to somebody specific.
 */
export const LINE_KINDS_WITH_SUPPLIER: ReadonlySet<JobLineKind> = new Set<JobLineKind>(['expense'])

export function isJobLineKind(value: string): value is JobLineKind {
  return (LINE_KINDS as readonly string[]).includes(value)
}

/**
 * Who pays for a line — the whole of the costing model.
 *
 *   quoted       on the accepted quote. The baseline.
 *   variation    extra work the customer approved. Billable, and not quoted.
 *   additional   extra work done and billable, with no separate approval sought.
 *   internal     our cost, never billable. Rework, goodwill, warranty.
 *   pending      the cost is real and nobody has decided who pays.
 *   written_off  was billable, and a decision was taken not to charge it.
 *
 * Note what is NOT here: `invoiced`. A line is a variation AND invoiced, so
 * folding the two would destroy the fact that made it billable — "what did we
 * charge as variations" becomes unanswerable the moment the invoice goes out.
 * Worse, a stored invoiced flag drifts: when an invoice is voided or credited,
 * salesReversal.ts does not know to unset it. So this enum answers SHOULD this
 * be charged, and `invoicedDocId` answers HAS it been.
 */
export const BILLING_STATES = [
  'quoted',
  'variation',
  'additional',
  'internal',
  'pending',
  'written_off',
] as const
export type BillingState = (typeof BILLING_STATES)[number]

export const BILLING_STATE_LABEL: Record<BillingState, string> = {
  quoted: 'Quoted',
  variation: 'Approved variation',
  additional: 'Additional',
  internal: 'Internal cost',
  pending: 'Awaiting a decision',
  written_off: 'Written off',
}

/** The one-line explanation the decision dialog shows beside each choice. */
export const BILLING_STATE_HINT: Record<BillingState, string> = {
  quoted: 'On the quote the customer accepted',
  variation: 'Extra work the customer agreed to pay for',
  additional: 'Extra work we are charging for without a separate approval',
  internal: 'Our cost — warranty, rework or goodwill. Never charged.',
  pending: 'The cost is recorded; who pays has not been decided',
  written_off: 'Was chargeable, and we chose not to charge it',
}

export const BILLING_STATE_TONE: Record<BillingState, JobStatusTone> = {
  quoted: 'brand',
  variation: 'brand',
  additional: 'brand',
  internal: 'neutral',
  pending: 'warning',
  written_off: 'danger',
}

export function isBillingState(value: string): value is BillingState {
  return (BILLING_STATES as readonly string[]).includes(value)
}

/**
 * The states that may reach an invoice.
 *
 * One list, exported, so the screen offers exactly what the server will accept
 * and the invoicing query filters on the same set. Three places asking the same
 * question three different ways is how a pending line ends up billed.
 */
export const BILLABLE_STATES: readonly BillingState[] = ['quoted', 'variation', 'additional']

export function isBillable(state: BillingState): boolean {
  return BILLABLE_STATES.includes(state)
}

/**
 * The legal moves out of a state.
 *
 * Directional and few. Nothing leaves `internal` — a warranty repair does not
 * become chargeable because somebody changed their mind about it, and if the
 * business genuinely wants to charge for it that is a new line with a reason,
 * not a quiet reclassification of an old one.
 *
 * Nothing leaves `quoted` except a write-off: the accepted quote is the
 * baseline every variance figure is measured against, so relabelling a quoted
 * line would move the goalposts after the fact.
 */
export const BILLING_TRANSITIONS: Record<BillingState, readonly BillingState[]> = {
  pending: ['variation', 'additional', 'internal', 'written_off'],
  quoted: ['written_off'],
  variation: ['written_off', 'internal'],
  additional: ['written_off', 'internal'],
  internal: [],
  written_off: [],
}

export function canReclassify(from: BillingState, to: BillingState): boolean {
  return BILLING_TRANSITIONS[from].includes(to)
}

/**
 * Whether a reclassification must carry a reason.
 *
 * A write-off always does — it is the thing an owner queries first, and
 * reconstructing why from an activity log months later is guesswork. Marking
 * something internal does too: "we absorbed this" is a decision worth a
 * sentence.
 */
export function reclassifyNeedsReason(to: BillingState): boolean {
  return to === 'written_off' || to === 'internal'
}

/**
 * Straight-line kilometres between two coordinate pairs.
 *
 * Haversine on a sphere of mean radius 6371 km. Accurate to a few metres over the
 * distances a service call covers, which is far better than the road factor
 * applied on top of it will ever be.
 *
 * Pure, so the form can preview the figure while somebody types coordinates and
 * the server can compute the real one — the same split hourlyCostOf() uses.
 */
export function haversineKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const R = 6371
  const rad = (deg: number) => (deg * Math.PI) / 180
  const dLat = rad(toLat - fromLat)
  const dLng = rad(toLng - fromLng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(fromLat)) * Math.cos(rad(toLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * What a trip should have been, from coordinates.
 *
 * Straight-line times a road factor, and the result is an ESTIMATE — good enough
 * to catch a 60km claim on a 12km trip, which is what it exists for, and not good
 * enough to argue over 2km. Callers label it `estimated` so the interface never
 * implies more precision than this has.
 *
 * Null when either end has no coordinates: no expectation is an honest answer, and
 * inventing one would give the tolerance check something false to measure against.
 */
export function estimatedTripKm(
  from: { latitude: number | null; longitude: number | null } | null,
  to: { latitude: number | null; longitude: number | null } | null,
  roadFactor: number,
): number | null {
  if (!from || !to) return null
  if (from.latitude === null || from.longitude === null) return null
  if (to.latitude === null || to.longitude === null) return null

  const straight = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude)
  const factor = Number.isFinite(roadFactor) && roadFactor > 0 ? roadFactor : 1
  return Math.round(straight * factor * 100) / 100
}

/**
 * The distance that actually goes on the invoice.
 *
 * ── TO NEAREST, NOT UP ─────────────────────────────────────────────────────
 *
 * Rounding up favours the business on every single trip, and the PRD's own worked
 * example settles it the other way: 29.1 km recorded becomes 29 km chargeable.
 *
 * That is the right call for a reason beyond matching the document. Travel is a
 * line item a customer can see, beside a distance they can check — and 29.1
 * recorded billed as 30 is an argument on every invoice. Nearest is the rule that
 * survives being read by the person paying for it.
 *
 * The MINIMUM is applied first, so a 400m call-out reaches the floor before the
 * block rounding rather than being rounded to nothing and then floored.
 *
 * `roundTo` of 0 or a non-number means charge exactly what was verified, to two
 * places.
 */
export function chargeableKm(km: number, roundTo: number, minimumKm: number | null): number {
  const floor = minimumKm !== null && Number.isFinite(minimumKm) ? Math.max(km, minimumKm) : km
  if (!Number.isFinite(roundTo) || roundTo <= 0) return Math.round(floor * 100) / 100
  return Math.round(floor / roundTo) * roundTo
}

/**
 * Is this claim far enough past the expectation to need a signature?
 *
 * Only ever ABOVE: a technician who found a shorter route has done nothing that
 * needs approving, and flagging it would train people to ignore the flag — the
 * failure mode that makes any tolerance check worthless.
 *
 * False when there is no expectation. Nothing to measure against is not a breach.
 */
export function breachesTolerance(
  recordedKm: number,
  expectedKm: number | null,
  tolerancePct: number,
): boolean {
  if (expectedKm === null || expectedKm <= 0) return false
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) return false
  return recordedKm > expectedKm * (1 + tolerancePct / 100)
}

/** How the technician said they measured it. */
export const RECORDED_SOURCES = ['manual', 'odometer', 'gps'] as const
export type RecordedSource = (typeof RECORDED_SOURCES)[number]

export const RECORDED_SOURCE_LABEL: Record<RecordedSource, string> = {
  manual: 'Typed in',
  odometer: 'Read off the odometer',
  gps: 'From the device',
}

/**
 * Where a trip expectation came from.
 *
 * `estimated` is what this app produces. `provider` is reserved for a real routing
 * service and nothing writes it yet — declared now so the column does not need
 * widening when one arrives.
 */
export type ExpectedSource = 'estimated' | 'provider' | 'manual'

export const EXPECTED_SOURCE_LABEL: Record<ExpectedSource, string> = {
  estimated: 'Estimated from the map pins',
  provider: 'Measured by a route service',
  manual: 'Entered by hand',
}

/**
 * Where a person physically is, for one visit.
 *
 * Fixed, unlike the job statuses, and the reason is worth stating: job statuses
 * are configurable because how many stages a business has and what it calls them
 * is genuinely local. These seven describe whether somebody has left yet, is
 * driving, has arrived, or did not turn up — which is not a matter of vocabulary.
 *
 * A configurable version would also break the rule this column exists for. The
 * PRD requires that a cancelled or completed appointment must NOT make a job
 * count as scheduled, and that cannot survive a business inventing a status the
 * code has never seen.
 */
export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'en_route',
  'on_site',
  'completed',
  'cancelled',
  'no_show',
] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Booked',
  confirmed: 'Confirmed',
  en_route: 'On the way',
  on_site: 'On site',
  completed: 'Visit done',
  cancelled: 'Cancelled',
  no_show: 'Nobody there',
}

export const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, JobStatusTone> = {
  scheduled: 'neutral',
  confirmed: 'brand',
  en_route: 'warning',
  on_site: 'warning',
  completed: 'success',
  cancelled: 'danger',
  no_show: 'danger',
}

/**
 * Whether this visit still counts as a booking.
 *
 * The three that do not are the three the PRD names: a completed visit has
 * happened, and a cancelled or no-show one never will. This is what makes a job
 * "unscheduled" answerable — see `isUnscheduled` below.
 */
export function isLiveAppointment(status: AppointmentStatus): boolean {
  return status !== 'completed' && status !== 'cancelled' && status !== 'no_show'
}

/** A visit that has not happened and is not going to. Needs a reason. */
export function appointmentNeedsReason(status: AppointmentStatus): boolean {
  return status === 'cancelled' || status === 'no_show'
}

/**
 * A stored DATETIME as milliseconds since the epoch.
 *
 * ── WHY THIS EXISTS RATHER THAN `new Date(x + 'Z')` AT EACH CALL SITE ───────
 *
 * A DATETIME reaches the browser in one of two shapes, depending on whether the
 * mapper stringified a driver Date or passed a raw column through:
 *
 *   '2099-03-04T11:00:00.000Z'   already ISO, already zoned
 *   '2099-03-04 11:00:00'        a bare wall clock
 *
 * The pool sets the connection timezone to 'Z', so both mean the same instant and
 * both must be read as UTC — using `getHours()` on a South African machine shifts
 * every time by two hours.
 *
 * But appending 'Z' to the first produces '...000ZZ', which parses to **NaN**.
 * Every comparison against NaN is false, so a check built on it does not throw —
 * it silently finds nothing. That is exactly how the appointment overlap check
 * came to report no conflicts while the query was returning the clashing row.
 *
 * One helper, so the seven places that read a stored time cannot each get it
 * subtly wrong.
 */
export function storedMillis(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return NaN
  if (value instanceof Date) return value.getTime()

  const text = String(value).trim()

  /*
   * A THIRD shape, and the one that actually bit: `String(driverDate)` in Node
   * yields a locale string —
   *
   *   'Wed Aug 12 2026 10:00:00 GMT+0200 (South Africa Standard Time)'
   *
   * — not ISO. It carries its own offset, so appending 'Z' makes it unparseable.
   * Anything that is not a bare `YYYY-MM-DD[ T]HH:MM` is already self-describing
   * and must be handed to Date untouched; only the bare wall clock needs the
   * marker, because only that one is ambiguous.
   */
  const bare = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)
  return new Date(bare ? `${text.replace(' ', 'T')}Z` : text).getTime()
}

/** The same value as a Date, for formatting. NaN-safe: returns null instead. */
export function storedDate(value: string | Date | null | undefined): Date | null {
  const ms = storedMillis(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * Do two bookings collide?
 *
 * Half-open intervals — `aStart < bEnd && bStart < aEnd` — so a visit ending at
 * 10:00 and one starting at 10:00 do NOT overlap. Using closed intervals here is
 * the classic off-by-one that makes every back-to-back booking report a clash,
 * and a scheduler that cries wolf on every legitimate pair gets ignored.
 *
 * Minutes since an epoch, not Date objects, so this is testable without a clock.
 */
export function overlaps(
  aStart: number,
  aMinutes: number,
  bStart: number,
  bMinutes: number,
): boolean {
  return aStart < bStart + bMinutes && bStart < aStart + aMinutes
}

/**
 * Minutes of daylight between two bookings, or null when they overlap.
 *
 * Negative is impossible by construction: if the second starts before the first
 * ends they overlap, and that is a different finding with a different message.
 */
export function gapBetween(
  aStart: number,
  aMinutes: number,
  bStart: number,
  bMinutes: number,
): number | null {
  if (overlaps(aStart, aMinutes, bStart, bMinutes)) return null
  return aStart < bStart ? bStart - (aStart + aMinutes) : aStart - (bStart + bMinutes)
}

/**
 * How we know the customer said yes.
 *
 * Here rather than beside the SQL because the acceptance dialog is a client
 * component, and importing these from site/jobQuotes.ts would drag siteDb — and
 * through it mysql2 — into the browser bundle. Same split, same reason, as the
 * validator below.
 *
 * The PRD asks what constitutes valid proof of acceptance and answers: customer
 * email, an approval link, or a permitted user accepting on their behalf. Those
 * are different strengths of evidence, and a dispute turns on which was used — so
 * the method is recorded, not just the fact.
 */
export const ACCEPT_METHODS = ['verbal', 'internal', 'in_person', 'email', 'link'] as const
export type AcceptMethod = (typeof ACCEPT_METHODS)[number]

/** Ordered weakest evidence first, so the list itself hints at which to prefer. */
export const ACCEPT_METHOD_LABEL: Record<AcceptMethod, string> = {
  verbal: 'Said yes on the phone',
  internal: 'Accepted on their behalf',
  in_person: 'Signed on site',
  email: 'Replied by email',
  link: 'Clicked the approval link',
}

/**
 * Whether this method needs something pointing at the evidence.
 *
 * Email and a signed acceptance both leave something findable, and the whole
 * value of recording the method is being able to go and find it. A phone call
 * leaves nothing but the user who took it, which is why they are named instead.
 */
export function methodNeedsReference(method: AcceptMethod): boolean {
  return method === 'email' || method === 'in_person'
}

export function isAcceptMethod(value: string): value is AcceptMethod {
  return (ACCEPT_METHODS as readonly string[]).includes(value)
}

/**
 * The fields a job needs before it can be saved.
 *
 * Declared here rather than beside the SQL so the FORM can run it too. The job
 * form is a client component, and importing this from site/jobCards.ts would drag
 * siteDb — and through it mysql2 — into the browser bundle. That is exactly what
 * happened to quotesModel.ts before it was split out, and it broke the build
 * app-wide.
 *
 * A structural type rather than JobCardInput, for the same reason: the input type
 * lives with the writer and this file must not import from it.
 */
export function validateJobCardFields(input: {
  title: string
  customerId: number | null
  customerName: string | null
  dueAt: string | null
}): string | null {
  const title = input.title.trim()
  if (!title) return 'A job needs a short description of the work.'
  if (title.length > 190) return 'That description is too long — put the detail in the notes.'

  /*
   * A customer ACCOUNT is optional — a walk-in with a broken kettle is a real
   * job, and forcing a debtor row for them turns the customer file into a
   * dumping ground. A NAME is not optional: with neither there is nothing to
   * call the job by and nobody to phone when it is ready.
   */
  if (!input.customerId && !input.customerName?.trim()) {
    return 'Choose a customer, or type a name for a walk-in.'
  }

  if (input.dueAt) {
    const due = new Date(input.dueAt.replace(' ', 'T'))
    if (Number.isNaN(due.getTime())) return 'That due date is not a real date.'
  }

  return null
}

/* ── SLA: TRADING HOURS AND THE TWO CLOCKS ────────────────────────────────
 *
 * An SLA says "respond within 4 hours". A job logged Friday at 16:00 by a shop
 * trading 08:00-17:00 is due MONDAY at 11:00, not Friday at 20:00: one hour of
 * Friday plus three of Monday.
 *
 * WHY BUSINESS HOURS AND NOT WALL CLOCK. A calendar clock makes every job logged
 * after Friday lunch a breach by Monday morning. The breach list then fills with
 * jobs nobody could have done anything about, and a worklist that cries wolf is a
 * worklist people stop opening — the same argument the appointment overlap check
 * makes about back-to-back bookings.
 *
 * The cost of the choice, stated plainly: the due time is no longer obvious from
 * the logged time. Somebody has to be able to see WHY Monday 11:00, which is why
 * the screen shows the target and the elapsed business minutes rather than only a
 * red badge.
 *
 * EVERYTHING HERE IS IN UTC MILLIS. Stored DATETIMEs are read with storedMillis()
 * and the pool runs at 'Z', so a "wall clock" here means the UTC field values of
 * that instant. Using getHours() would shift every SLA by two hours on a South
 * African machine and by a different amount in every other timezone — the exact
 * bug that made the schedule draw every block at the right edge.
 */

const MS_PER_MIN = 60_000
const MINS_PER_DAY = 1440

/**
 * When the business is open, as a week.
 *
 * `days` is a 7-character Mon..Sun mask, the shape `report_schedules.days_of_week`
 * and `specials.days_of_week` already use — one mask, one validator, and a reader
 * who has seen it once recognises it here.
 *
 * `opensAt`/`closesAt` are minutes from midnight rather than HH:MM strings: the
 * arithmetic below needs numbers, and converting at every comparison is how one
 * of them ends up forgotten.
 */
export type TradingHours = {
  /** Mon..Sun, '1' = open. '1111100' is weekdays. */
  days: string
  /** Minutes from midnight. 480 = 08:00. */
  opensAt: number
  /** Minutes from midnight. 1020 = 17:00. */
  closesAt: number
  /** Dates the business is shut regardless of the mask, as YYYY-MM-DD. */
  holidays: ReadonlySet<string>
}

export const DEFAULT_TRADING_HOURS: TradingHours = {
  days: '1111100',
  opensAt: 8 * 60,
  closesAt: 17 * 60,
  holidays: new Set(),
}

/** HH:MM to minutes from midnight. Returns null on anything malformed. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Minutes from midnight back to HH:MM, for display and for storing. */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % MINS_PER_DAY) + MINS_PER_DAY) % MINS_PER_DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * The UTC day-of-week as a Mon..Sun index, which is what the mask is indexed by.
 *
 * getUTCDay() is Sunday-first (0=Sun). Every mask in this codebase is Monday-
 * first, so this is the one place the two conventions meet.
 */
function maskIndex(at: Date): number {
  return (at.getUTCDay() + 6) % 7
}

/** YYYY-MM-DD of the UTC date. Deliberately not localDay() — see the header. */
export function utcDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** Is the business open on the day this instant falls in? */
export function isTradingDay(at: Date, hours: TradingHours): boolean {
  if (hours.holidays.has(utcDay(at))) return false
  return hours.days[maskIndex(at)] === '1'
}

/** Midnight UTC of the day this instant falls in, as millis. */
function startOfUtcDay(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * A guard on the trading week, used by every function below.
 *
 * A week with no open day, or a close time at or before the open time, would make
 * the loops below run forever looking for a minute that does not exist. Callers
 * get a null due date instead, which the screens already render as "no target" —
 * refusing to compute beats spinning.
 */
export function tradingWeekIsUsable(hours: TradingHours): boolean {
  if (hours.closesAt <= hours.opensAt) return false
  return hours.days.includes('1')
}

/**
 * Business minutes elapsed between two instants.
 *
 * Walks day by day and clips each to the trading window. A day loop rather than
 * a minute loop, so a six-month-old job costs ~180 iterations and not 260,000.
 */
export function businessMinutesBetween(
  fromMs: number,
  toMs: number,
  hours: TradingHours = DEFAULT_TRADING_HOURS,
): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0
  if (toMs <= fromMs) return 0
  if (!tradingWeekIsUsable(hours)) return 0

  let total = 0
  for (let day = startOfUtcDay(fromMs); day <= toMs; day += MINS_PER_DAY * MS_PER_MIN) {
    const at = new Date(day)
    if (!isTradingDay(at, hours)) continue

    const openMs = day + hours.opensAt * MS_PER_MIN
    const closeMs = day + hours.closesAt * MS_PER_MIN

    // The part of this day's window that also lies inside [from, to].
    const start = Math.max(openMs, fromMs)
    const end = Math.min(closeMs, toMs)
    if (end > start) total += (end - start) / MS_PER_MIN
  }
  return Math.round(total * 100) / 100
}

/**
 * Add business minutes to an instant, returning the deadline.
 *
 * A job logged outside the window starts its clock at the next opening — a job
 * logged at 02:00 is not already an hour into its four, and treating it as such
 * would breach jobs that arrived overnight before anybody could read them.
 */
export function addBusinessMinutes(
  fromMs: number,
  minutes: number,
  hours: TradingHours = DEFAULT_TRADING_HOURS,
): number | null {
  if (!Number.isFinite(fromMs)) return null
  if (!Number.isFinite(minutes) || minutes < 0) return null
  if (!tradingWeekIsUsable(hours)) return null

  let remaining = minutes
  let day = startOfUtcDay(fromMs)

  /*
   * 400 days, not `while (true)`. A trading week can be legal and still never
   * reach the target — a mask with one open day and a holiday list covering that
   * weekday for a year — and an unbounded loop in a page render is a hung
   * request. Returning null means "no target", which every reader already handles.
   */
  for (let guard = 0; guard < 400; guard++, day += MINS_PER_DAY * MS_PER_MIN) {
    const at = new Date(day)
    if (!isTradingDay(at, hours)) continue

    const openMs = day + hours.opensAt * MS_PER_MIN
    const closeMs = day + hours.closesAt * MS_PER_MIN

    // Where the clock starts today: the later of opening and the job's own start.
    const start = Math.max(openMs, fromMs)
    if (start >= closeMs) continue

    const availableMins = (closeMs - start) / MS_PER_MIN
    if (remaining <= availableMins) return start + remaining * MS_PER_MIN
    remaining -= availableMins
  }
  return null
}

/**
 * Where a job stands against a target.
 *
 * `met` is a THIRD state, not "not breached": a job responded to inside its
 * target is settled, and showing it in a worklist beside jobs still counting down
 * is how the list stops being actionable.
 */
export type SlaState = 'none' | 'met' | 'due' | 'breached'

export const SLA_STATE_LABEL: Record<SlaState, string> = {
  none: 'No target',
  met: 'Met',
  due: 'Counting down',
  breached: 'Breached',
}

export const SLA_STATE_TONE: Record<SlaState, JobStatusTone> = {
  none: 'neutral',
  met: 'success',
  due: 'brand',
  breached: 'danger',
}

/**
 * Derived on read, never stored.
 *
 * A stored breach flag is wrong the minute after it is written and needs a cron
 * to stay true; the same argument `isClosed()` makes about open/closed. The
 * `satisfiedAtMs` argument is when the thing the target measures actually
 * happened — first response, or closure — and NaN means it has not happened yet.
 */
export function slaState(dueAtMs: number, satisfiedAtMs: number, nowMs: number): SlaState {
  if (!Number.isFinite(dueAtMs)) return 'none'
  if (Number.isFinite(satisfiedAtMs)) return satisfiedAtMs <= dueAtMs ? 'met' : 'breached'
  return nowMs > dueAtMs ? 'breached' : 'due'
}

/**
 * Business minutes left, or overdue by. Negative means late.
 *
 * Reported in business minutes rather than wall-clock ones so it agrees with the
 * clock that set the deadline: "2 hours left" on a Friday afternoon must not mean
 * two hours that include Saturday.
 */
export function minutesUntilDue(
  dueAtMs: number,
  nowMs: number,
  hours: TradingHours = DEFAULT_TRADING_HOURS,
): number | null {
  if (!Number.isFinite(dueAtMs)) return null
  if (nowMs <= dueAtMs) return businessMinutesBetween(nowMs, dueAtMs, hours)
  return -businessMinutesBetween(dueAtMs, nowMs, hours)
}

/** "3h 20m", "45m", "2 days 1h" — a duration a person reads, not 200 minutes. */
export function formatBusinessMinutes(minutes: number, hoursPerDay: number): string {
  const abs = Math.abs(Math.round(minutes))
  if (abs < 60) return `${abs}m`

  const perDay = hoursPerDay > 0 ? hoursPerDay * 60 : MINS_PER_DAY
  if (abs < perDay) {
    const h = Math.floor(abs / 60)
    const m = abs % 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  const days = Math.floor(abs / perDay)
  const h = Math.round((abs - days * perDay) / 60)
  const dayPart = `${days} ${days === 1 ? 'day' : 'days'}`
  return h === 0 ? dayPart : `${dayPart} ${h}h`
}

/** Is this mask well-formed? Seven characters, each '0' or '1'. */
export function isDayMask(value: string): boolean {
  return /^[01]{7}$/.test(value)
}

export const DAY_MASK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** 'Mon-Fri', 'Mon, Wed, Fri', 'Every day' — the mask as a sentence. */
export function describeDayMask(mask: string): string {
  if (!isDayMask(mask)) return 'Not set'
  const open = [...mask].map((c, i) => (c === '1' ? i : -1)).filter((i) => i >= 0)
  if (open.length === 0) return 'Never'
  if (open.length === 7) return 'Every day'

  // A single unbroken run reads as a range; anything else lists the days.
  const contiguous = open.every((d, i) => i === 0 || d === open[i - 1] + 1)
  if (contiguous && open.length > 2) {
    return `${DAY_MASK_LABELS[open[0]]}-${DAY_MASK_LABELS[open[open.length - 1]]}`
  }
  return open.map((d) => DAY_MASK_LABELS[d]).join(', ')
}

/* ── HEADLINES, TASKS AND CHECKS ───────────────────────────────────────────
 *
 * A headline is what KIND of job this is, and it brings its work with it. The
 * migration header sets out why one item table serves both tasks and checks; this
 * file holds the part that has to run in the browser, because the setup screen and
 * the technician list are both client components.
 */

/**
 * What completing an item records.
 *
 * 'none' is a plain task — ticked or not. Everything else captures a value, which
 * is the only structural difference between a task and a check.
 */
export const RESPONSE_TYPES = [
  'none',
  'yesno',
  'passfail',
  'number',
  'measure',
  'text',
  'photo',
  'signature',
] as const
export type ResponseType = (typeof RESPONSE_TYPES)[number]

export const RESPONSE_TYPE_LABEL: Record<ResponseType, string> = {
  none: 'Just tick it',
  yesno: 'Yes or no',
  passfail: 'Pass or fail',
  number: 'A number',
  measure: 'A measurement',
  text: 'Some text',
  photo: 'A photograph',
  signature: 'A signature',
}

/** The two words the trade uses. Structurally identical — see the migration. */
export const ITEM_KINDS = ['task', 'check'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  task: 'Task',
  check: 'Check',
}

export const WORK_PHASES = ['before', 'during', 'after'] as const
export type WorkPhase = (typeof WORK_PHASES)[number]

export const WORK_PHASE_LABEL: Record<WorkPhase, string> = {
  before: 'Before work starts',
  during: 'While working',
  after: 'Before leaving',
}

/** Does this response type carry a unit? Only a measurement does. */
export function responseHasUnit(type: ResponseType): boolean {
  return type === 'measure'
}

/**
 * Can this response type fail?
 *
 * Only the two with a bad answer. A measurement of 12 is not a failure — whether
 * 12 is acceptable is engineering judgement this system does not have, and
 * inventing a threshold field would be guessing at every trade at once.
 */
export function responseCanFail(type: ResponseType): boolean {
  return type === 'yesno' || type === 'passfail'
}

/**
 * Is a recorded response a failure?
 *
 * Deliberately narrow: only an explicit no or fail. An EMPTY response is not a
 * failure, it is unanswered — and treating the two the same would put every
 * untouched job on the exception report.
 */
export function isFailedResponse(type: ResponseType, response: string | null): boolean {
  if (!responseCanFail(type)) return false
  if (response === null) return false
  const value = response.trim().toLowerCase()
  return value === 'no' || value === 'fail'
}

/** The answers a picker should offer, or null when the response is free-form. */
export function responseOptions(type: ResponseType): readonly string[] | null {
  if (type === 'yesno') return ['yes', 'no']
  if (type === 'passfail') return ['pass', 'fail']
  return null
}

/**
 * Is an item finished?
 *
 * `completedAt` is the authority, not the presence of a response. A task has no
 * response and still gets done; a check answered "no" is complete AND failing.
 * Reading completeness off the response would make a failed check look
 * outstanding, which is the one thing an exception report must not do.
 */
export function isItemComplete(item: {
  completedAt: string | Date | null
}): boolean {
  return item.completedAt !== null && item.completedAt !== undefined
}

/**
 * Whether a response satisfies its own type.
 *
 * Returns a refusal string or null, so the screen and the action refuse the same
 * things for the same reasons.
 */
export function validateResponse(
  type: ResponseType,
  response: string | null,
): string | null {
  // A task takes no response, and an unanswered item is a normal state rather
  // than an error — the required-item check is what enforces answering.
  if (type === 'none' || response === null || response.trim() === '') return null

  const value = response.trim()
  if (value.length > 500) return 'That answer is too long.'

  if (type === 'number' || type === 'measure') {
    if (!Number.isFinite(Number(value))) return 'That has to be a number.'
  }

  const options = responseOptions(type)
  if (options && !options.includes(value.toLowerCase())) {
    return `Answer with ${options.join(' or ')}.`
  }
  return null
}

/**
 * Does this response type produce a FILE rather than a sentence?
 *
 * The two where the artefact is the answer. A photo of a corroded flue and a
 * customer signature are evidence; every other type is a technician telling us
 * something, which we take on trust because we sent them.
 */
export function responseIsEvidence(type: ResponseType): boolean {
  return type === 'photo' || type === 'signature'
}

/**
 * Can this item be completed?
 *
 * The single place the evidence rule lives, so the pad, the action and the close
 * guard cannot drift apart on what "done" means.
 *
 * Until 119 a photo item was satisfied by typing a reference, which recorded
 * that somebody claimed to have taken a photo. For a gas certificate or a
 * customer sign-off that is not evidence of anything — the file IS the record,
 * and a dispute turns on having it.
 *
 * `evidenceRequired` is read off the item and not derived from `responseType`
 * here, deliberately. Items answered before 119 were backfilled to 0 and stay
 * complete: a job closed correctly under the rules of the day must not reopen
 * because the rules improved.
 */
export function itemBlocker(item: {
  responseType: ResponseType
  evidenceRequired: boolean
  attachmentId: number | null
  response: string | null
}): string | null {
  if (item.evidenceRequired && item.attachmentId === null) {
    return item.responseType === 'signature'
      ? 'This needs a signature. Ask the customer to sign on the pad.'
      : 'This needs a photo attached.'
  }
  // A non-evidence item still has to be answered if its type takes an answer.
  if (
    item.responseType !== 'none' &&
    !responseIsEvidence(item.responseType) &&
    (item.response === null || item.response.trim() === '')
  ) {
    return 'This needs an answer.'
  }
  return null
}

export type HeadlineItemDraft = {
  kind: ItemKind
  name: string
  hint: string | null
  responseType: ResponseType
  unit: string | null
  workPhase: WorkPhase
  isRequired: boolean
  evidenceRequired: boolean
}

/**
 * Pure validation for a headline and its items.
 *
 * The load-bearing rule is the duplicate-name check. Section 8 requires that
 * selecting two headlines which share an item does not produce it twice, and the
 * cheapest place to prevent half of that problem is refusing a headline that
 * duplicates itself.
 */
export function validateHeadline(input: {
  code: string
  name: string
  suggestedMinutes: number | null
  items: readonly HeadlineItemDraft[]
}): string | null {
  const code = input.code.trim()
  if (!code) return 'Give the headline a short code.'
  if (!/^[A-Z0-9_-]{1,40}$/.test(code)) {
    return 'A code may only use capital letters, numbers, hyphens and underscores.'
  }
  if (!input.name.trim()) return 'Give the headline a name.'
  if (input.name.trim().length > 120) return 'That name is too long.'

  if (input.suggestedMinutes !== null) {
    if (!Number.isFinite(input.suggestedMinutes) || input.suggestedMinutes <= 0) {
      return 'A suggested duration must be more than zero minutes, or left blank.'
    }
    // Ten working days. Past this it is a project, not an appointment length.
    if (input.suggestedMinutes > 4800) return 'That duration is longer than ten working days.'
  }

  const seen = new Set<string>()
  for (const item of input.items) {
    if (!item.name.trim()) return 'Every task and check needs a name.'
    if (item.name.trim().length > 190) return `That name is too long: ${item.name.slice(0, 40)}…`

    const key = item.name.trim().toLowerCase()
    if (seen.has(key)) return `This headline lists "${item.name.trim()}" twice.`
    seen.add(key)

    if (responseHasUnit(item.responseType) && !item.unit?.trim()) {
      return `"${item.name.trim()}" is a measurement, so it needs a unit.`
    }
    if (!responseHasUnit(item.responseType) && item.unit?.trim()) {
      return `"${item.name.trim()}" is not a measurement, so it cannot carry a unit.`
    }

    // Refused rather than silently ignored. A yes/no item flagged "must attach a
    // file" has no way to satisfy itself, so the job could never be closed and
    // the reason would not be on any screen.
    if (item.evidenceRequired && !responseIsEvidence(item.responseType)) {
      return `"${item.name.trim()}" cannot require a file — only a photo or a signature can.`
    }
  }
  return null
}

/**
 * Merge the items several headlines bring, dropping duplicates.
 *
 * Section 8 again: two headlines that both require "Check gas pressure" must
 * produce ONE item, and the user should be told it was merged rather than left to
 * wonder. Matched on the trimmed lower-cased name — the same rule the
 * single-headline check above uses, so the two cannot disagree.
 *
 * The FIRST occurrence wins, and a later duplicate that is REQUIRED promotes the
 * survivor: if either headline insists on it, the job insists on it. Silently
 * keeping the optional copy would drop a requirement somebody configured.
 */
export function mergeHeadlineItems<T extends { name: string; isRequired: boolean }>(
  groups: readonly { headlineName: string; items: readonly T[] }[],
): { items: T[]; merged: { name: string; from: string[] }[] } {
  const byKey = new Map<string, { item: T; from: string[] }>()

  for (const group of groups) {
    for (const item of group.items) {
      const key = item.name.trim().toLowerCase()
      const existing = byKey.get(key)
      if (existing) {
        existing.from.push(group.headlineName)
        if (item.isRequired) existing.item = { ...existing.item, isRequired: true }
      } else {
        byKey.set(key, { item, from: [group.headlineName] })
      }
    }
  }

  const items: T[] = []
  const merged: { name: string; from: string[] }[] = []
  for (const entry of byKey.values()) {
    items.push(entry.item)
    if (entry.from.length > 1) {
      merged.push({ name: entry.item.name.trim(), from: entry.from })
    }
  }
  return { items, merged }
}

/** "3 of 8 done, 1 failing" — the progress line a job card header carries. */
export function describeItemProgress(items: readonly {
  completedAt: string | Date | null
  isFailed: boolean
  isRequired: boolean
}[]): string {
  if (items.length === 0) return 'Nothing to do'
  const done = items.filter(isItemComplete).length
  const failed = items.filter((i) => i.isFailed).length
  const outstanding = items.filter((i) => i.isRequired && !isItemComplete(i)).length

  const parts = [`${done} of ${items.length} done`]
  if (failed > 0) parts.push(`${failed} failing`)
  if (outstanding > 0) parts.push(`${outstanding} still required`)
  return parts.join(', ')
}

/* ── Stock availability warnings (§26.7) ─────────────────────────────────── */

/**
 * What the shop wants to happen when a job asks for more than it has.
 *
 * Pure and here rather than in a server module because the issue dialog needs
 * the same vocabulary the action enforces. A mode the screen understood and the
 * server did not would be a warning somebody could click past.
 */
export const STOCK_WARN_MODES = ['inform', 'confirm', 'prevent', 'order'] as const
export type StockWarnMode = (typeof STOCK_WARN_MODES)[number]

export const STOCK_WARN_LABEL: Record<StockWarnMode, string> = {
  inform: 'Just say so',
  confirm: 'Ask them to confirm',
  prevent: 'Do not allow it',
  order: 'Offer to order it',
}

export const STOCK_WARN_HINT: Record<StockWarnMode, string> = {
  inform: 'Shows what is short and lets the work carry on.',
  confirm: 'Shows what is short and makes somebody agree to it before it goes ahead.',
  prevent: 'Refuses until the stock is there. Strict, and right where every unit is counted.',
  order: 'Shows what is short and offers to raise a part request for the difference.',
}

export function isStockWarnMode(value: string): value is StockWarnMode {
  return (STOCK_WARN_MODES as readonly string[]).includes(value)
}

/**
 * Does this mode stop the work, rather than merely comment on it?
 *
 * Only `prevent` refuses outright. `confirm` refuses ONCE — the caller re-sends
 * with an acknowledgement — which is why it is not folded in here: the two need
 * different messages and only one of them can be got past.
 */
export function warnModeBlocks(mode: StockWarnMode): boolean {
  return mode === 'prevent'
}
