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
export const LINE_KINDS = ['part', 'labour', 'travel', 'charge'] as const
export type JobLineKind = (typeof LINE_KINDS)[number]

export const LINE_KIND_LABEL: Record<JobLineKind, string> = {
  part: 'Part',
  labour: 'Labour',
  travel: 'Travel',
  charge: 'Charge',
}

/** The unit `qty` is counted in, which differs per kind. */
export const LINE_KIND_UNIT: Record<JobLineKind, string> = {
  part: '',
  labour: 'hours',
  travel: 'km',
  charge: '',
}

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
