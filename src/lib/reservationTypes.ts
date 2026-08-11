import type { BadgeTone } from '@/components/ui'

/**
 * Reservations — the shapes, and the small amount of logic both the server and
 * the client need: what a status means, what may follow it, and how a shop's
 * bookable week is written down.
 *
 * Kept OUT of src/lib/site/reservations.ts on purpose. That module opens with
 * `import 'server-only'`, so a client component importing a status label from
 * it would fail the build. This file has no database import and is safe from
 * either side — the same split the rest of the app makes for shared types.
 */

/* ── status ───────────────────────────────────────────────────────────────── */

export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'seated',
  'completed',
  'no_show',
  'cancelled',
] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

export type ReservationSource = 'online' | 'phone' | 'walk_in'

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  seated: 'Seated',
  completed: 'Completed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
}

/**
 * Colour carries meaning here, it does not decorate: warning is the only tone
 * that means ACT ON ME (a request nobody has answered yet), danger marks the
 * table that was held and wasted, and everything settled recedes to neutral.
 */
export const STATUS_TONE: Record<ReservationStatus, BadgeTone> = {
  pending: 'warning',
  confirmed: 'success',
  seated: 'brand',
  completed: 'neutral',
  no_show: 'danger',
  cancelled: 'neutral',
}

export const SOURCE_LABEL: Record<ReservationSource, string> = {
  online: 'Online',
  phone: 'Phone',
  walk_in: 'Walk-in',
}

/**
 * Which statuses may follow another — the workflow, in one place.
 *
 * 'pending' is deliberately NOT reachable again: once staff have confirmed or
 * declined, the guest has been told something, and silently returning the
 * booking to the queue would strand that promise.
 *
 * 'no_show' is reachable only from 'confirmed' — a booking nobody confirmed was
 * never promised a table, so the party failing to arrive is not a no-show
 * against the shop's own count.
 */
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['seated', 'no_show', 'cancelled'],
  seated: ['completed', 'cancelled'],
  completed: [],
  no_show: [],
  cancelled: [],
}

/** The statuses a reservation may move to next. */
export function allowedNext(from: ReservationStatus): ReservationStatus[] {
  return TRANSITIONS[from]
}

/** True when `to` is a legal next status. */
export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** What the button for a transition should say. */
export const TRANSITION_LABEL: Record<ReservationStatus, string> = {
  pending: 'Reopen',
  confirmed: 'Confirm',
  seated: 'Seat now',
  completed: 'Complete',
  no_show: 'No-show',
  cancelled: 'Cancel',
}

/** Statuses still expecting the party — what "tonight's book" counts. */
export const OPEN_STATUSES: ReservationStatus[] = ['pending', 'confirmed', 'seated']

/* ── opening hours ────────────────────────────────────────────────────────── */

/**
 * A shop's bookable week: weekday (0=Sunday) -> list of [open, close] ranges in
 * "HH:MM". Two ranges express lunch and dinner; an absent or empty day means no
 * bookings that day.
 */
export type TimeRange = [string, string]
export type OpeningHours = Record<string, TimeRange[]>

export const WEEKDAY_LABEL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** "HH:MM" -> minutes past midnight, or null when unparseable. */
export function parseHm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** Minutes past midnight -> "HH:MM". */
export function formatHm(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Parse stored opening hours, tolerant of junk.
 *
 * A malformed row must leave the shop CLOSED to bookings, never crash the
 * public page — the same defensive posture onlineStore.ts takes with its
 * department allow-list.
 */
export function parseOpeningHours(raw: string | null): OpeningHours {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: OpeningHours = {}
    for (const [day, ranges] of Object.entries(parsed as Record<string, unknown>)) {
      const dayNum = Number(day)
      if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) continue
      if (!Array.isArray(ranges)) continue
      const clean: TimeRange[] = []
      for (const r of ranges) {
        if (!Array.isArray(r) || r.length !== 2) continue
        const [open, close] = r as unknown[]
        if (typeof open !== 'string' || typeof close !== 'string') continue
        const o = parseHm(open)
        const c = parseHm(close)
        // A range that ends before it starts is meaningless; drop it rather than
        // generate a day's worth of slots backwards.
        if (o === null || c === null || c <= o) continue
        clean.push([formatHm(o), formatHm(c)])
      }
      if (clean.length) out[String(dayNum)] = clean
    }
    return out
  } catch {
    return {}
  }
}

/** A sensible starting week for a shop that has never configured one. */
export const DEFAULT_OPENING_HOURS: OpeningHours = {
  '1': [
    ['12:00', '14:30'],
    ['18:00', '21:30'],
  ],
  '2': [
    ['12:00', '14:30'],
    ['18:00', '21:30'],
  ],
  '3': [
    ['12:00', '14:30'],
    ['18:00', '21:30'],
  ],
  '4': [
    ['12:00', '14:30'],
    ['18:00', '21:30'],
  ],
  '5': [
    ['12:00', '14:30'],
    ['18:00', '22:00'],
  ],
  '6': [
    ['12:00', '15:00'],
    ['18:00', '22:00'],
  ],
}

/* ── settings ─────────────────────────────────────────────────────────────── */

export type ReservationSettings = {
  isEnabled: boolean
  openingHours: OpeningHours
  slotMinutes: number
  defaultDurationMinutes: number
  leadTimeMinutes: number
  horizonDays: number
  maxPartySize: number
  autoConfirm: boolean
  blurb: string
  maxPerPhonePerDay: number
}

/**
 * Defaults for a site with no settings row.
 *
 * `isEnabled: false` is the important one — a shop that has never configured
 * reservations must not silently start taking them the moment the table exists.
 */
export const DEFAULT_SETTINGS: ReservationSettings = {
  isEnabled: false,
  openingHours: DEFAULT_OPENING_HOURS,
  slotMinutes: 30,
  defaultDurationMinutes: 90,
  leadTimeMinutes: 120,
  horizonDays: 60,
  maxPartySize: 12,
  autoConfirm: false,
  blurb: '',
  maxPerPhonePerDay: 3,
}

/* ── the booking ──────────────────────────────────────────────────────────── */

export type Reservation = {
  id: number
  reference: string
  status: ReservationStatus
  source: ReservationSource
  contactName: string
  contactPhone: string
  contactEmail: string
  partySize: number
  /**
   * Local wall-clock ISO with no timezone suffix: "2026-08-09T19:00:00".
   *
   * A STRING, not a Date, deliberately. The booking is a wall-clock fact in the
   * shop's own day; handing a Date across the server/client boundary would have
   * the browser re-read it in the viewer's timezone and shift every time on
   * screen for anyone travelling.
   */
  reservedFor: string
  durationMinutes: number
  tableName: string
  customerNote: string
  cancelReason: string
  seatedAt: string | null
  documentId: number | null
  createdAt: string
  userName: string
}

/** What the queue's "add a booking" form sends. */
export type StaffReservationInput = {
  contactName: string
  contactPhone: string
  contactEmail?: string
  partySize: number
  /** "YYYY-MM-DD" */
  date: string
  /** "HH:MM" */
  time: string
  tableName?: string
  customerNote?: string
  source?: ReservationSource
}

/* ── date helpers, shared by both sides ───────────────────────────────────── */

/** "YYYY-MM-DD" for a Date's LOCAL fields. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

/** The "YYYY-MM-DD" part of a wall-clock ISO string. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** The "HH:MM" part of a wall-clock ISO string. */
export function timeOf(iso: string): string {
  return iso.slice(11, 16)
}

/** "Friday, 9 Aug" for a "YYYY-MM-DD" key. */
export function dayLabel(key: string): string {
  // Midday, so a DST shift cannot roll the label onto the neighbouring day.
  const d = new Date(`${key}T12:00:00`)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'short' })
}
