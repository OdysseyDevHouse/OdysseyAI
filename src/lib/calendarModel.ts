/**
 * What a calendar provider is, without knowing which one (§46.13).
 *
 * Pure and free of `server-only`: the setup screen is a client component and
 * needs the labels and the shape checks, and the sync engine is a server module.
 * Same split jobRuleModel and jobFormModel already use.
 *
 * ── WHY AN INTERFACE RATHER THAN TWO MODULES ────────────────────────────────
 *
 * Google and Microsoft differ in their URLs, their scopes, their JSON and their
 * idea of a date. They do NOT differ in what this app asks of them: link an
 * account, write an event, delete an event, say when somebody is busy, say what
 * changed. Five operations.
 *
 * Writing that twice means every later fix gets made once and forgotten once.
 * So the differences live behind CalendarProvider and everything above it is
 * written a single time.
 */

export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const
export type CalendarProviderName = (typeof CALENDAR_PROVIDERS)[number]

export const PROVIDER_LABEL: Record<CalendarProviderName, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook',
}

export function isCalendarProvider(value: string): value is CalendarProviderName {
  return (CALENDAR_PROVIDERS as readonly string[]).includes(value)
}

/** A block of time somebody is not free. Deliberately carries nothing else. */
export type BusyBlock = {
  startsAt: Date
  endsAt: Date
  /** The provider's event id, where it gave one — used only to spot our own. */
  externalId?: string | null
}

/** An event as this app wants it written. Provider-neutral. */
export type OutboundEvent = {
  summary: string
  description: string
  location: string
  startsAt: Date
  endsAt: Date
  /**
   * A cancelled or completed visit.
   *
   * Sent as a cancellation rather than a deletion where the provider supports
   * it, so the technician sees the visit was called off instead of finding a
   * hole in their day and wondering whether they imagined it.
   */
  cancelled: boolean
}

/** What a provider must be able to do. Five operations, no more. */
export type CalendarProvider = {
  name: CalendarProviderName
  /** Where to send somebody to grant access. */
  authUrl(redirectUri: string, state: string): string
  /** Trade the code from the callback for a refresh token and an identity. */
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ refreshToken: string; email: string }>
  /** Trade a refresh token for a short-lived access token. */
  accessToken(refreshToken: string): Promise<string>
  /** Create or update one event; returns the provider's id for it. */
  writeEvent(
    accessToken: string,
    calendarId: string,
    externalId: string | null,
    event: OutboundEvent,
  ): Promise<string>
  removeEvent(accessToken: string, calendarId: string, externalId: string): Promise<void>
  /** When this person is busy in a window. Opaque — see 226's header. */
  busy(
    accessToken: string,
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<BusyBlock[]>
}

/**
 * What the event says.
 *
 * Built here rather than in either provider so the two calendars cannot end up
 * describing the same visit differently — and so the rule below is stated once.
 *
 * ── NO MONEY, EVER ──────────────────────────────────────────────────────────
 *
 * The same rule the ICS feed states: no prices, no costs, no margins, no quote
 * totals. A calendar event ends up on a phone's lock screen, on a watch, and in
 * whatever the technician's provider does with notifications. It is the least
 * controlled surface this app writes to, and 26.6 spent a whole permission set
 * deciding who may see cost — which would be worth nothing if the number then
 * arrived on everybody's wrist.
 */
export function eventTitle(input: {
  jobNumber: string | null
  jobTitle: string
  customerName: string | null
  visitType: string | null
}): string {
  const who = input.customerName?.trim()
  const what = input.visitType?.trim() || input.jobTitle.trim()
  const ref = input.jobNumber?.trim()

  // Customer first: on a phone's lock screen a calendar shows about thirty
  // characters, and "Mrs Naidoo" is what tells a technician where they are
  // going. The job number is for looking it up afterwards and goes last.
  const head = who ? `${who} — ${what}` : what
  return ref ? `${head} (${ref})` : head
}

/** The body. Same rule as the title: nothing here is a number with a currency. */
export function eventDescription(input: {
  jobNumber: string | null
  jobTitle: string
  notes: string | null
  contactPhone: string | null
  appUrl: string | null
}): string {
  const lines: string[] = []
  if (input.jobNumber) lines.push(`Job ${input.jobNumber}: ${input.jobTitle}`)
  else lines.push(input.jobTitle)
  if (input.contactPhone?.trim()) lines.push(`Phone: ${input.contactPhone.trim()}`)
  if (input.notes?.trim()) lines.push('', input.notes.trim())
  /*
   * A link back to the job.
   *
   * The single most useful thing in the body: a technician standing at a door
   * needs the parts list and the history, and this is the shortest path from the
   * calendar entry they are already looking at to the job itself.
   */
  if (input.appUrl) lines.push('', input.appUrl)
  return lines.join('\n')
}

/**
 * The fingerprint deciding whether a push is needed.
 *
 * Over exactly what a calendar can SEE. An appointment row changes for reasons
 * a calendar does not care about — arrived_at, travel_started_at, an outcome
 * note — and re-pushing on those burns provider quota and can buzz a phone to
 * announce that nothing happened.
 *
 * A plain string rather than a hash here; the caller hashes it. Keeping it
 * readable means a stuck sync can be diagnosed by looking at the two values.
 */
export function eventFingerprint(event: OutboundEvent): string {
  return [
    event.summary,
    event.location,
    event.description,
    event.startsAt.toISOString(),
    event.endsAt.toISOString(),
    event.cancelled ? 'cancelled' : 'live',
  ].join('')
}

/**
 * Is a proposed change worth asking a human about?
 *
 * Providers round, and a calendar that stores seconds against a system that
 * stores minutes will report a "change" of 30 seconds on an event nobody
 * touched. Waking a dispatcher for that is how a queue of proposals becomes a
 * queue nobody reads.
 *
 * A minute of tolerance: below it, the difference cannot have been a person
 * dragging an event, because no calendar UI offers that precision.
 */
export function isMeaningfulChange(
  previousStart: Date,
  previousMinutes: number,
  proposedStart: Date,
  proposedMinutes: number | null,
): boolean {
  const startMoved = Math.abs(proposedStart.getTime() - previousStart.getTime()) >= 60_000
  const lengthChanged =
    proposedMinutes !== null && Math.abs(proposedMinutes - previousMinutes) >= 1
  return startMoved || lengthChanged
}
