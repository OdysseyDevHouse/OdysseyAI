import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import {
  DEFAULT_SETTINGS,
  canTransition,
  dateKey,
  formatHm,
  parseHm,
  parseOpeningHours,
  type OpeningHours,
  type Reservation,
  type ReservationSettings,
  type ReservationSource,
  type ReservationStatus,
  type StaffReservationInput,
} from '../reservationTypes'

/**
 * Table reservations — settings, bookable slots, and the booking lifecycle.
 *
 * ── THE CENTRAL IDEA ──────────────────────────────────────────────────────
 *
 * A reservation is a promise about a future seat, not a sale. Nothing in this
 * module writes to sales_documents, posts stock or takes money. The link to the
 * till happens by NAME: staff seat a party against a table_name, and the till
 * opens that table exactly as it does for a walk-in.
 *
 * ── SLOTS ARE GENERATED SERVER-SIDE, ALWAYS ───────────────────────────────
 *
 * The public form offers only times bookableSlots() produced, and
 * submitReservation() re-derives the same list and refuses anything not on it.
 * A client that posts a hand-crafted time gets the same answer as a client that
 * never loaded the form — the UI hiding an option is a convenience, never the
 * control.
 *
 * ── EVERY TIME HERE IS THE SITE'S WALL CLOCK ──────────────────────────────
 *
 * The DATETIME column stores wall-clock, the opening hours are wall-clock, and
 * the report ranges elsewhere in this codebase are already built against DB
 * wall-clock rather than UTC. This module never converts between the two.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── time helpers ─────────────────────────────────────────────────────────── */

/**
 * A DATETIME column back to the wall-clock string it was stored as.
 *
 * The site pool is opened with `timezone: 'Z'` (siteDb.ts), so mysql2 parses
 * "2026-08-09 19:00:00" as if it were UTC and the wall-clock fields land in the
 * Date's UTC accessors. Reading them with getUTC* returns exactly what the shop
 * typed; reading them with getHours() would shift every booking by the server's
 * offset — which on a machine set to SAST silently moves a 19:00 dinner to
 * 21:00. `dateStrings` is not set for DATETIME, so this cannot be skipped.
 */
function wallClock(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    // Defensive: a driver configured with dateStrings would hand back
    // "2026-08-09 19:00:00" — normalise it to the same ISO shape.
    return value.replace(' ', 'T').slice(0, 19)
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/** "YYYY-MM-DD" + "HH:MM" -> a MySQL DATETIME literal, or null when malformed. */
export function combineLocal(date: string, time: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const mins = parseHm(time)
  if (!dm || mins === null) return null
  const y = Number(dm[1])
  const mo = Number(dm[2])
  const d = Number(dm[3])
  // Rejects impossible dates that Date silently rolls over (2026-02-31).
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return `${dm[1]}-${dm[2]}-${dm[3]} ${formatHm(mins)}:00`
}

/* ── settings ─────────────────────────────────────────────────────────────── */

/** The site's reservation settings, defaulted when never configured. */
export async function getReservationSettings(siteId: number): Promise<ReservationSettings> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM reservation_settings WHERE id = 1')
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    isEnabled: Number(row.is_enabled) === 1,
    /*
     * An enabled shop with no parseable hours takes NO bookings, rather than
     * falling back to DEFAULT_OPENING_HOURS. Silently inventing trading hours
     * for a real restaurant — and then promising strangers a table inside them
     * — is worse than showing nothing.
     */
    openingHours: parseOpeningHours((row.opening_hours as string | null) ?? null),
    slotMinutes: Number(row.slot_minutes) || 30,
    defaultDurationMinutes: Number(row.default_duration_minutes) || 90,
    leadTimeMinutes: Number(row.lead_time_minutes) || 0,
    horizonDays: Number(row.horizon_days) || 60,
    maxPartySize: Number(row.max_party_size) || 12,
    autoConfirm: Number(row.auto_confirm) === 1,
    blurb: (row.blurb as string) ?? '',
    maxPerPhonePerDay: Number(row.max_per_phone_per_day) || 0,
  }
}

/** Create or update the settings (single row, id = 1). */
export async function saveReservationSettings(
  siteId: number,
  input: ReservationSettings,
): Promise<void> {
  await siteExecute(
    siteId,
    `INSERT INTO reservation_settings
       (id, is_enabled, opening_hours, slot_minutes, default_duration_minutes,
        lead_time_minutes, horizon_days, max_party_size, auto_confirm, blurb,
        max_per_phone_per_day)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       is_enabled = VALUES(is_enabled),
       opening_hours = VALUES(opening_hours),
       slot_minutes = VALUES(slot_minutes),
       default_duration_minutes = VALUES(default_duration_minutes),
       lead_time_minutes = VALUES(lead_time_minutes),
       horizon_days = VALUES(horizon_days),
       max_party_size = VALUES(max_party_size),
       auto_confirm = VALUES(auto_confirm),
       blurb = VALUES(blurb),
       max_per_phone_per_day = VALUES(max_per_phone_per_day)`,
    [
      input.isEnabled ? 1 : 0,
      JSON.stringify(input.openingHours ?? {}),
      clamp(input.slotMinutes, 5, 180, 30),
      clamp(input.defaultDurationMinutes, 15, 600, 90),
      clamp(input.leadTimeMinutes, 0, 40_320, 0),
      clamp(input.horizonDays, 1, 365, 60),
      clamp(input.maxPartySize, 1, 500, 12),
      input.autoConfirm ? 1 : 0,
      (input.blurb ?? '').slice(0, 500),
      clamp(input.maxPerPhonePerDay, 0, 100, 0),
    ],
  )
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* ── bookable slots ───────────────────────────────────────────────────────── */

export type DaySlots = {
  /** "YYYY-MM-DD" */
  date: string
  /** Weekday label for the heading. */
  label: string
  /** Bookable "HH:MM" times, in order. Empty when the shop is shut. */
  times: string[]
}

/**
 * The times a booking may be made for, for each day inside the horizon.
 *
 * A slot survives only if it is inside a sitting, far enough ahead to respect
 * the lead time, and inside the horizon.
 *
 * A RANGE IS [first seating, LAST SEATING] — both ends inclusive. "18:00 to
 * 21:30" means the last table goes out at 21:30, NOT that the room empties
 * then; the kitchen closing time is a different number the shop never tells us.
 * Treating the end as exclusive would silently drop the 21:30 booking a
 * restaurant explicitly asked for, which is the more damaging way to be wrong:
 * a manager can see a slot they don't want and shorten the range, but cannot
 * conjure back one that never appears.
 *
 * durationMinutes deliberately does NOT shorten the last slot. It describes how
 * long a table is held, and a restaurant routinely seats a 21:30 booking that
 * runs past closing. Subtracting it here would turn a planning figure into a
 * booking rule nobody asked for.
 *
 * v1 does NOT remove a slot because the room is full — there are no capacity
 * rules yet, by design. When they arrive they filter THIS list, which is why
 * every caller comes through here rather than deriving times of its own.
 */
export function bookableSlots(settings: ReservationSettings, from: Date = new Date()): DaySlots[] {
  if (!settings.isEnabled) return []
  const slot = Math.max(5, settings.slotMinutes)
  const earliest = from.getTime() + settings.leadTimeMinutes * 60_000
  const days: DaySlots[] = []

  for (let i = 0; i < settings.horizonDays; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
    day.setDate(day.getDate() + i)
    const ranges: OpeningHours[string] = settings.openingHours[String(day.getDay())] ?? []
    const times: string[] = []

    for (const [open, close] of ranges) {
      const o = parseHm(open)
      const c = parseHm(close)
      if (o === null || c === null) continue
      // `m <= c`, not `m + slot <= c`: the range end is the last seating and is
      // itself bookable. See the note above.
      for (let m = o; m <= c; m += slot) {
        const at = new Date(day)
        at.setHours(Math.floor(m / 60), m % 60, 0, 0)
        if (at.getTime() < earliest) continue
        times.push(formatHm(m))
      }
    }

    days.push({
      date: dateKey(day),
      label: day.toLocaleDateString('en-ZA', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }),
      times,
    })
  }
  return days
}

/** True when `date`/`time` is one of the slots the shop is currently offering. */
function isBookableSlot(settings: ReservationSettings, date: string, time: string): boolean {
  const day = bookableSlots(settings).find((d) => d.date === date)
  return !!day && day.times.includes(time)
}

/* ── reading ──────────────────────────────────────────────────────────────── */

function mapRow(r: Row): Reservation {
  return {
    id: Number(r.id),
    reference: (r.reference as string) ?? '',
    status: ((r.status as string) || 'pending') as ReservationStatus,
    source: ((r.source as string) || 'online') as ReservationSource,
    contactName: (r.contact_name as string) ?? '',
    contactPhone: (r.contact_phone as string) ?? '',
    contactEmail: (r.contact_email as string) ?? '',
    partySize: Number(r.party_size) || 0,
    reservedFor: wallClock(r.reserved_for) ?? '',
    durationMinutes: Number(r.duration_minutes) || 0,
    tableName: (r.table_name as string) ?? '',
    customerNote: (r.customer_note as string) ?? '',
    cancelReason: (r.cancel_reason as string) ?? '',
    seatedAt: wallClock(r.seated_at),
    documentId: r.document_id === null ? null : Number(r.document_id),
    /* Only present on the list query, which joins the bill. getReservation reads
       the row alone, so these are null there — and nothing that calls it wants a
       running total. */
    billTotal:
      r.bill_total === null || r.bill_total === undefined ? null : Number(r.bill_total),
    billNumber: (r.bill_number as string | null) ?? null,
    createdAt: wallClock(r.created_at) ?? '',
    userName: (r.user_name as string) ?? '',
  }
}

/** One reservation, or null. */
export async function getReservation(
  siteId: number,
  id: number,
): Promise<Reservation | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM reservations WHERE id = ?', [id])
  return row ? mapRow(row) : null
}

/**
 * Points a seated booking at the bill its party is running up.
 *
 * ── WHY THIS IS FOUND BY TABLE AND NOT PASSED BY THE CALLER ───────────────
 *
 * The till does not know which booking it is serving. A waiter seats the
 * Naidoo party on T01 from the gate, walks away, comes back when they have
 * chosen, and rings up a round — and that last act is the first time a bill
 * exists. Nothing in the basket remembers a booking, and threading one through
 * the whole till so it could be handed back here would be a lot of plumbing to
 * carry a fact the table already implies.
 *
 * So the booking is found the way a human would find it: the party sitting at
 * this table, right now.
 *
 * ── AND WHY IT NEVER FAILS LOUDLY ─────────────────────────────────────────
 *
 * Returns quietly when there is no seated booking on that table, which is the
 * ORDINARY case — a walk-in, a shop that takes no bookings, a party seated
 * before this existed. The caller opens tables for a living and must not have a
 * sale refused because a booking lookup found nothing to link.
 */
export async function linkSeatedBookingToBill(
  siteId: number,
  tableName: string,
  documentId: number,
): Promise<void> {
  const name = tableName.trim()
  if (!name || !documentId) return

  /* The most recently seated one, and only if it has no bill yet. A table that
     turns twice in an evening has two seated bookings against it in the day's
     book, and the party sitting there now is the later one — while a booking
     that already points at a document is a party whose bill was linked and then
     settled, which this must not steal. */
  await siteExecute(
    siteId,
    `UPDATE reservations
        SET document_id = ?
      WHERE table_name = ?
        AND status = 'seated'
        AND document_id IS NULL
      ORDER BY seated_at DESC
      LIMIT 1`,
    [documentId, name],
  )
}

export type ReservationListFilter = {
  /** "YYYY-MM-DD" — bookings on or after this day. */
  fromDate?: string
  /** "YYYY-MM-DD" — bookings on or before this day. */
  toDate?: string
  statuses?: ReservationStatus[]
  /** Free text over name, phone and reference. */
  search?: string
  limit?: number
}

/**
 * The queue's list, in booking-time order.
 *
 * Ascending by reserved_for, not by created_at: staff work tonight's book in
 * the order parties will walk through the door, not the order they happened to
 * book in.
 */
export async function listReservations(
  siteId: number,
  filter: ReservationListFilter = {},
): Promise<Reservation[]> {
  const where: string[] = []
  const params: unknown[] = []

  /* Qualified with `r.` throughout, because the query below joins the bill and
     `status` exists on both tables. An unqualified one would be ambiguous — and
     worse, could silently start filtering on the wrong table's column. */
  if (filter.fromDate) {
    where.push('r.reserved_for >= ?')
    params.push(`${filter.fromDate} 00:00:00`)
  }
  if (filter.toDate) {
    where.push('r.reserved_for <= ?')
    params.push(`${filter.toDate} 23:59:59`)
  }
  if (filter.statuses?.length) {
    where.push(`r.status IN (${filter.statuses.map(() => '?').join(', ')})`)
    params.push(...filter.statuses)
  }
  if (filter.search?.trim()) {
    where.push('(r.contact_name LIKE ? OR r.contact_phone LIKE ? OR r.reference LIKE ?)')
    const like = `%${filter.search.trim()}%`
    params.push(like, like, like)
  }

  // Interpolated, not bound: LIMIT is one of the placeholders mysql2 refuses in
  // a prepared statement, so it is clamped to a number instead.
  const limit = clamp(filter.limit ?? 500, 1, 1000, 500)
  /*
   * The bill comes with the booking, where there is one.
   *
   * A LEFT JOIN rather than a second query per row: a busy Saturday's book is
   * hundreds of rows and asking the database once per party for a total nobody
   * may look at is how a list screen becomes slow.
   *
   * Only what is UNPAID shows a running figure. A finalised bill is a party who
   * has settled and gone, and "R840" beside them would read as money still on
   * the table — so the join narrows to the statuses that mean "still eating",
   * and a settled booking simply carries its number without a total.
   */
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.*,
            d.document_number AS bill_number,
            CASE WHEN d.status IN ('draft', 'saved') THEN d.total_incl ELSE NULL END
              AS bill_total,
            d.status AS bill_status
       FROM reservations r
       LEFT JOIN sales_documents d ON d.id = r.document_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.reserved_for ASC, r.id ASC
      LIMIT ${limit}`,
    params,
  )
  return rows.map(mapRow)
}

/* ── writing ──────────────────────────────────────────────────────────────── */

export type SubmitResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; error: string }

export type ActionResult = { ok: true } | { ok: false; error: string }

/** Digits only — how two phone numbers are compared for the daily cap. */
function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Insert a booking and stamp its reference, in one transaction.
 *
 * The reference is derived from the id rather than allocated from the numbering
 * table, so it needs the id before it can be written — hence the insert-then-
 * update. Both happen inside a transaction so a booking can never exist with an
 * empty reference, which is the string staff quote over the phone.
 */
async function insertReservation(
  siteId: number,
  values: {
    status: ReservationStatus
    source: ReservationSource
    contactName: string
    contactPhone: string
    contactEmail: string
    partySize: number
    reservedFor: string
    durationMinutes: number
    tableName: string
    customerNote: string
    submittedIp: string
    userId: number | null
    userName: string
  },
): Promise<number> {
  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO reservations
         (reference, status, source, contact_name, contact_phone, contact_email,
          party_size, reserved_for, duration_minutes, table_name, customer_note,
          submitted_ip, user_id, user_name)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.status,
        values.source,
        values.contactName,
        values.contactPhone,
        values.contactEmail,
        values.partySize,
        values.reservedFor,
        values.durationMinutes,
        values.tableName,
        values.customerNote,
        values.submittedIp,
        values.userId,
        values.userName,
      ] as never,
    )
    const id = (res as { insertId: number }).insertId
    await tx.execute('UPDATE reservations SET reference = ? WHERE id = ?', [
      `RS${String(id).padStart(6, '0')}`,
      id,
    ] as never)
    return id
  })
}

/**
 * Accept a booking from the public form.
 *
 * EVERY RULE IS RE-CHECKED HERE. The form only ever offers valid slots, but the
 * form is not the control — this function is. A request that skips the page
 * entirely hits exactly the same validation.
 *
 * The honeypot deserves its own note: `website` is a hidden field no human ever
 * sees. When it arrives filled we return SUCCESS and write nothing, because
 * telling a bot it was detected is how it learns to stop filling the field.
 */
export async function submitReservation(
  siteId: number,
  input: {
    contactName: string
    contactPhone: string
    contactEmail: string
    partySize: number
    date: string
    time: string
    customerNote: string
    website?: string
  },
  meta: { ip?: string } = {},
): Promise<SubmitResult> {
  const settings = await getReservationSettings(siteId)
  if (!settings.isEnabled) {
    return { ok: false, error: 'This shop is not taking online bookings.' }
  }

  // Honeypot — see above. Looks like success, stores nothing.
  if ((input.website ?? '').trim()) {
    return {
      ok: true,
      reservation: {
        id: 0,
        reference: 'RS000000',
        status: 'pending',
        source: 'online',
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        contactEmail: input.contactEmail,
        partySize: input.partySize,
        reservedFor: '',
        durationMinutes: settings.defaultDurationMinutes,
        tableName: '',
        customerNote: '',
        cancelReason: '',
        seatedAt: null,
        documentId: null,
        billTotal: null,
        billNumber: null,
        createdAt: '',
        userName: '',
      },
    }
  }

  const name = input.contactName.trim()
  if (name.length < 2) return { ok: false, error: 'Please enter your name.' }

  const phone = input.contactPhone.trim()
  if (phoneKey(phone).length < 7) {
    return { ok: false, error: 'Please enter a valid contact number.' }
  }

  const email = input.contactEmail.trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Please enter a valid email address.' }
  }

  const partySize = Math.trunc(Number(input.partySize) || 0)
  if (partySize < 1) return { ok: false, error: 'Please choose how many people.' }
  if (partySize > settings.maxPartySize) {
    return {
      ok: false,
      error: `For parties over ${settings.maxPartySize}, please call the shop.`,
    }
  }

  const reservedFor = combineLocal(input.date, input.time)
  if (!reservedFor) return { ok: false, error: 'Please choose a date and time.' }
  if (!isBookableSlot(settings, input.date, input.time)) {
    // Covers closed days, times outside the sitting, inside the lead time and
    // beyond the horizon with one message — the form already showed only valid
    // slots, so a visitor sees this mainly when a slot lapsed while they typed.
    return { ok: false, error: 'That time is no longer available — please pick another.' }
  }

  // Daily cap per phone number: the cheap abuse control that needs no
  // confirmation step. Counts only today's SUBMISSIONS, so a regular booking
  // several weeks of dinners in one sitting is unaffected.
  if (settings.maxPerPhonePerDay > 0) {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM reservations
        WHERE contact_phone = ? AND DATE(created_at) = CURDATE() AND status <> 'cancelled'`,
      [phone.slice(0, 50)],
    )
    if (Number(row?.n ?? 0) >= settings.maxPerPhonePerDay) {
      return {
        ok: false,
        error: 'You have made several bookings today. Please call the shop to make another.',
      }
    }
  }

  const id = await insertReservation(siteId, {
    status: settings.autoConfirm ? 'confirmed' : 'pending',
    source: 'online',
    contactName: name.slice(0, 120),
    contactPhone: phone.slice(0, 50),
    contactEmail: email.slice(0, 190),
    partySize,
    reservedFor,
    durationMinutes: settings.defaultDurationMinutes,
    tableName: '',
    customerNote: (input.customerNote ?? '').trim().slice(0, 500),
    submittedIp: (meta.ip ?? '').slice(0, 45),
    userId: null,
    userName: '',
  })

  const saved = await getReservation(siteId, id)
  if (!saved) return { ok: false, error: 'Could not save the booking.' }
  return { ok: true, reservation: saved }
}

/**
 * Create a booking from the back office — the phone call, or a walk-in the
 * manager wants on tonight's book.
 *
 * Deliberately NOT bound by the public form's rules: staff may seat a party of
 * thirty, book inside the lead time, or take a booking on a day the online form
 * is closed. Those rules exist to stop the shop over-promising to strangers,
 * not to overrule the person standing in the room.
 */
export async function createStaffReservation(
  siteId: number,
  input: StaffReservationInput,
  actor: { userId: number; userName: string },
): Promise<SubmitResult> {
  const name = input.contactName.trim()
  if (name.length < 2) return { ok: false, error: 'Please enter a name.' }

  const reservedFor = combineLocal(input.date, input.time)
  if (!reservedFor) return { ok: false, error: 'Please choose a valid date and time.' }

  const partySize = Math.trunc(Number(input.partySize) || 0)
  if (partySize < 1) return { ok: false, error: 'Please enter the party size.' }

  const settings = await getReservationSettings(siteId)
  const id = await insertReservation(siteId, {
    // Confirmed on creation: a booking taken by a person IS the promise.
    status: 'confirmed',
    source: input.source ?? 'phone',
    contactName: name.slice(0, 120),
    contactPhone: input.contactPhone.trim().slice(0, 50),
    contactEmail: (input.contactEmail ?? '').trim().slice(0, 190),
    partySize,
    reservedFor,
    durationMinutes: settings.defaultDurationMinutes,
    tableName: (input.tableName ?? '').trim().slice(0, 50),
    customerNote: (input.customerNote ?? '').trim().slice(0, 500),
    submittedIp: '',
    userId: actor.userId || null,
    userName: actor.userName.slice(0, 120),
  })

  const saved = await getReservation(siteId, id)
  if (!saved) return { ok: false, error: 'Could not save the booking.' }
  return { ok: true, reservation: saved }
}

/**
 * Move a booking to a new status.
 *
 * The transition table is the authority (see reservationTypes.ts) — a status
 * that is not a legal next step is refused HERE rather than in the UI, so a
 * stale queue left open in another tab cannot walk a completed booking
 * backwards.
 *
 * Seating stamps seated_at, and takes an optional documentId: when the till
 * already has a sale open on the table, recording it lets the queue show the
 * party's running bill. It stays NULL otherwise, which is entirely normal.
 */
export async function setReservationStatus(
  siteId: number,
  id: number,
  to: ReservationStatus,
  actor: { userId: number; userName: string },
  opts: { reason?: string; documentId?: number | null } = {},
): Promise<ActionResult> {
  const current = await getReservation(siteId, id)
  if (!current) return { ok: false, error: 'Booking not found.' }
  if (current.status === to) return { ok: true }
  if (!canTransition(current.status, to)) {
    return { ok: false, error: `A ${current.status} booking cannot be marked ${to}.` }
  }

  const reason = (opts.reason ?? '').trim().slice(0, 255)
  await siteExecute(
    siteId,
    `UPDATE reservations
        SET status = ?,
            cancel_reason = CASE WHEN ? <> '' THEN ? ELSE cancel_reason END,
            seated_at = CASE WHEN ? = 'seated' THEN NOW() ELSE seated_at END,
            document_id = COALESCE(?, document_id),
            user_id = ?, user_name = ?
      WHERE id = ?`,
    [to, reason, reason, to, opts.documentId ?? null, actor.userId || null, actor.userName.slice(0, 120), id],
  )
  return { ok: true }
}

/**
 * Put a booking on a table, or clear it with "".
 *
 * Free text matched by name, exactly like the floor plan and the open sale. v1
 * does not validate the name against the plan, because a shop that has never
 * drawn one must still be able to write "Patio 3" on a booking.
 */
export async function setReservationTable(
  siteId: number,
  id: number,
  tableName: string,
  actor: { userId: number; userName: string },
): Promise<ActionResult> {
  const found = await getReservation(siteId, id)
  if (!found) return { ok: false, error: 'Booking not found.' }
  await siteExecute(
    siteId,
    'UPDATE reservations SET table_name = ?, user_id = ?, user_name = ? WHERE id = ?',
    [tableName.trim().slice(0, 50), actor.userId || null, actor.userName.slice(0, 120), id],
  )
  return { ok: true }
}
