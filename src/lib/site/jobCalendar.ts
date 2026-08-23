import 'server-only'
import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { encryptSecret, decryptSecret } from '../crypto/secrets'
import { logActivity, type Actor } from './activityLog'
import {
  eventTitle,
  eventDescription,
  eventFingerprint,
  isMeaningfulChange,
  PROVIDER_LABEL,
  type CalendarProviderName,
  type OutboundEvent,
} from '../calendarModel'
import { providerFor } from './calendarProviders'
import { storedMillis } from '../jobStatusModel'

/**
 * Keeping a technician's calendar and their job visits in step (§46.13).
 *
 * ── ODYSSEY IS THE SYSTEM OF RECORD ─────────────────────────────────────────
 *
 * 226's header argues this at length and it governs every function here. Out
 * goes the truth; back comes busy time and PROPOSALS. Nothing in this file
 * writes an appointment because an external calendar said so — acceptChange()
 * exists precisely so that a person makes that call, and the change then runs
 * through the same booking path a dispatcher uses.
 *
 * ── NOTHING HERE IS EVER THE REASON A BOOKING FAILS ─────────────────────────
 *
 * Every entry point swallows. A dispatcher booking a visit at 16:55 on a Friday
 * must not be stopped because Google is having an afternoon, and a technician
 * must not lose a job because their token expired. Failures are RECORDED on the
 * account row in words and shown on the setup screen — which is the same stance
 * jobNotify takes about a mail server being down, for the same reason.
 *
 * The cost is stated plainly: a sync that fails quietly is a sync somebody
 * believes is working. That is why last_error is a column rather than a log
 * line, and why reconcileJobCalendar reports accounts that have not pushed.
 */

type Row = RowDataPacket & Record<string, unknown>

export type CalendarAccount = {
  id: number
  userId: number
  userName: string
  provider: CalendarProviderName
  accountEmail: string
  calendarId: string
  pushEnabled: boolean
  pullEnabled: boolean
  /** False when the refresh token is missing or cannot be decrypted. */
  isUsable: boolean
  lastError: string
  lastPushAt: Date | null
  lastPullAt: Date | null
}

export type CalendarResult = { ok: true } | { ok: false; error: string }

const SELECT_ACCOUNT = `
  SELECT id, user_id, user_name, provider, account_email, calendar_id,
         push_enabled, pull_enabled, refresh_token_enc, last_error,
         last_push_at, last_pull_at
    FROM job_calendar_accounts`

function mapAccount(r: Row): CalendarAccount {
  const enc = r.refresh_token_enc === null ? null : String(r.refresh_token_enc)
  let usable = false
  if (enc) {
    try {
      usable = decryptSecret(enc).length > 0
    } catch {
      /*
       * A token that will not decrypt is NOT usable, and saying so here is the
       * point. ENCRYPTION_KEY changing turns every stored token into noise, and
       * without this the screen would show a healthy-looking account that fails
       * at every tick with a message about the provider rather than the key.
       */
      usable = false
    }
  }
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    userName: String(r.user_name ?? ''),
    provider: String(r.provider) as CalendarProviderName,
    accountEmail: String(r.account_email ?? ''),
    calendarId: String(r.calendar_id ?? 'primary'),
    pushEnabled: Number(r.push_enabled) === 1,
    pullEnabled: Number(r.pull_enabled) === 1,
    isUsable: usable,
    lastError: String(r.last_error ?? ''),
    lastPushAt: (r.last_push_at as Date | null) ?? null,
    lastPullAt: (r.last_pull_at as Date | null) ?? null,
  }
}

export async function listCalendarAccounts(siteId: number): Promise<CalendarAccount[]> {
  const rows = await siteQuery<Row>(siteId, `${SELECT_ACCOUNT} ORDER BY user_name`).catch(
    () => [],
  )
  return rows.map(mapAccount)
}

export async function calendarAccountFor(
  siteId: number,
  userId: number,
): Promise<CalendarAccount | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ACCOUNT} WHERE user_id = ? LIMIT 1`,
    [userId],
  ).catch(() => null)
  return row ? mapAccount(row) : null
}

/** The refresh token, or null when there is nothing usable. */
async function tokenFor(siteId: number, accountId: number): Promise<string | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT refresh_token_enc FROM job_calendar_accounts WHERE id = ?`,
    [accountId],
  ).catch(() => null)
  if (!row || row.refresh_token_enc === null) return null
  try {
    return decryptSecret(String(row.refresh_token_enc))
  } catch {
    return null
  }
}

/** Record why an account stopped working, in words a person can act on. */
async function noteError(siteId: number, accountId: number, message: string): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE job_calendar_accounts SET last_error = ? WHERE id = ?`,
    [message.slice(0, 400), accountId],
  ).catch(() => {})
}

async function clearError(siteId: number, accountId: number): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE job_calendar_accounts SET last_error = '' WHERE id = ? AND last_error <> ''`,
    [accountId],
  ).catch(() => {})
}

/* ── Linking ──────────────────────────────────────────────────────────────── */

/**
 * Save the account somebody just granted access to.
 *
 * The refresh token is enveloped by crypto/secrets — the same AES-256-GCM this
 * app uses for site database passwords. It is written NOWHERE else: not in the
 * activity log, not in last_error, not in any screen.
 */
export async function linkCalendarAccount(
  siteId: number,
  actor: Actor,
  input: {
    userId: number
    userName: string
    provider: CalendarProviderName
    refreshToken: string
    accountEmail: string
  },
): Promise<CalendarResult> {
  if (!input.refreshToken) return { ok: false, error: 'No access was granted.' }

  const enc = encryptSecret(input.refreshToken)

  /*
   * Re-linking REPLACES, and clears the error.
   *
   * The commonest reason somebody arrives here twice is that the first token
   * was revoked and they are fixing it. Leaving the old error on the row would
   * show a freshly linked account as broken.
   */
  await siteExecute(
    siteId,
    `INSERT INTO job_calendar_accounts
       (user_id, user_name, provider, account_email, refresh_token_enc, last_error)
     VALUES (?,?,?,?,?,'')
     ON DUPLICATE KEY UPDATE
       user_name = VALUES(user_name),
       account_email = VALUES(account_email),
       refresh_token_enc = VALUES(refresh_token_enc),
       last_error = ''`,
    [input.userId, input.userName.slice(0, 120), input.provider, input.accountEmail.slice(0, 190), enc],
  )

  await logActivity(siteId, actor, {
    entity: 'job_calendar',
    entityId: input.userId,
    action: 'calendar_linked',
    // The address, never the token.
    detail: `${PROVIDER_LABEL[input.provider]}${input.accountEmail ? ` — ${input.accountEmail}` : ''}`,
  })
  return { ok: true }
}

/**
 * Unlink, and take the events with it.
 *
 * The removal happens FIRST and its failure does not stop the unlink. Somebody
 * unlinking has decided this app should not have their calendar any more, and
 * refusing to let go because the provider is unreachable would be the wrong
 * answer to that request. The cost is stated: events already written may be left
 * behind, which is why the caller is told.
 */
export async function unlinkCalendarAccount(
  siteId: number,
  actor: Actor,
  accountId: number,
): Promise<CalendarResult> {
  const account = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ACCOUNT} WHERE id = ?`,
    [accountId],
  )
  if (!account) return { ok: false, error: 'That calendar is not linked.' }
  const mapped = mapAccount(account)

  let orphaned = 0
  try {
    const links = await siteQuery<Row>(
      siteId,
      `SELECT external_id FROM job_calendar_links WHERE account_id = ?`,
      [accountId],
    )
    if (links.length > 0) {
      const token = await tokenFor(siteId, accountId)
      if (token) {
        const provider = providerFor(mapped.provider)
        const access = await provider.accessToken(token)
        for (const link of links) {
          await provider
            .removeEvent(access, mapped.calendarId, String(link.external_id))
            .catch(() => {
              orphaned += 1
            })
        }
      } else {
        orphaned = links.length
      }
    }
  } catch {
    // Unreachable provider. The unlink still goes ahead — see the header.
  }

  // The links and any busy rows CASCADE from the account.
  await siteExecute(siteId, `DELETE FROM job_calendar_accounts WHERE id = ?`, [accountId])

  await logActivity(siteId, actor, {
    entity: 'job_calendar',
    entityId: mapped.userId,
    action: 'calendar_unlinked',
    detail:
      `${PROVIDER_LABEL[mapped.provider]}` +
      (orphaned > 0 ? ` — ${orphaned} event(s) could not be removed and remain in the calendar` : ''),
  })
  return { ok: true }
}

export async function setCalendarDirections(
  siteId: number,
  actor: Actor,
  accountId: number,
  input: { push: boolean; pull: boolean; calendarId?: string },
): Promise<CalendarResult> {
  const account = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE id = ?`, [accountId])
  if (!account) return { ok: false, error: 'That calendar is not linked.' }

  await siteExecute(
    siteId,
    `UPDATE job_calendar_accounts
        SET push_enabled = ?, pull_enabled = ?, calendar_id = ?
      WHERE id = ?`,
    [
      input.push ? 1 : 0,
      input.pull ? 1 : 0,
      (input.calendarId ?? String(account.calendar_id ?? 'primary')).slice(0, 255),
      accountId,
    ],
  )

  /*
   * Turning PULL off clears the busy cache immediately.
   *
   * Somebody switching it off is withdrawing consent to have their private
   * calendar read, and leaving last week's blocks in the table would keep
   * feeding a scheduler from data they have just asked us to stop collecting.
   */
  if (!input.pull) {
    await siteExecute(siteId, `DELETE FROM job_calendar_busy WHERE account_id = ?`, [accountId])
  }

  await logActivity(siteId, actor, {
    entity: 'job_calendar',
    entityId: Number(account.user_id),
    action: 'calendar_changed',
    detail: `push ${input.push ? 'on' : 'off'}, pull ${input.pull ? 'on' : 'off'}`,
  })
  return { ok: true }
}

/* ── Pushing out ──────────────────────────────────────────────────────────── */

/** The event for one appointment, as this app wants it written. */
async function buildEvent(siteId: number, appointmentId: number): Promise<OutboundEvent | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT a.id, a.starts_at, a.duration_minutes, a.status, a.visit_type, a.notes,
            j.id AS job_id, j.document_number AS job_number, j.title AS job_title,
            j.customer_name, j.customer_phone,
            s.address_line1, s.address_line2, s.city, s.postal_code, s.access_notes
       FROM job_card_appointments a
       JOIN job_cards j ON j.id = a.job_card_id
       LEFT JOIN service_addresses s ON s.id = a.service_address_id
      WHERE a.id = ?`,
    [appointmentId],
  ).catch(() => null)
  if (!row) return null

  const text = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v).trim()
    return s.length > 0 ? s : null
  }

  const starts = new Date(storedMillis(row.starts_at as string | Date))
  if (Number.isNaN(starts.getTime())) return null
  const mins = Math.max(1, Number(row.duration_minutes) || 60)

  const address = [row.address_line1, row.address_line2, row.city, row.postal_code]
    .map(text)
    .filter((p): p is string => p !== null)
    .join(', ')

  /*
   * A link back to the job, when this server knows its own address.
   *
   * APP_URL is not always set — a dev box, a site behind a tunnel — and a
   * half-built link is worse than none: a technician taps it, gets a 404, and
   * stops trusting the calendar entry. So it is all or nothing.
   */
  const appUrl = process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/$/, '')}/jobs/${Number(row.job_id)}`
    : null

  return {
    summary: eventTitle({
      jobNumber: text(row.job_number),
      jobTitle: String(row.job_title ?? 'Job'),
      customerName: text(row.customer_name),
      visitType: text(row.visit_type),
    }),
    description: eventDescription({
      jobNumber: text(row.job_number),
      jobTitle: String(row.job_title ?? 'Job'),
      /*
       * The visit's notes AND the address's access notes.
       *
       * access_notes is where a business writes "gate code 4471, park in the
       * side street, dog is friendly" — the single most useful thing a
       * technician can have on their phone at 07:40, and it lives on the
       * address rather than the visit so nobody retypes it every time.
       */
      notes:
        [text(row.notes), text(row.access_notes)].filter(Boolean).join('\n\n') || null,
      contactPhone: text(row.customer_phone),
      appUrl,
    }),
    location: address,
    startsAt: starts,
    endsAt: new Date(starts.getTime() + mins * 60_000),
    /*
     * cancelled and no_show both read as called off. completed does NOT: a visit
     * that happened should stay in the calendar as a record of the day, and
     * striking it through would rewrite somebody's history every evening.
     */
    cancelled: String(row.status) === 'cancelled' || String(row.status) === 'no_show',
  }
}

const hash = (value: string) => createHash('sha1').update(value).digest('hex')

/**
 * A Date as the wall clock this schema stores: 'YYYY-MM-DD HH:MM:SS'.
 *
 * The pair to storedMillis, and needed for the same reason. The pool is set to
 * timezone 'Z', so a DATETIME goes in and comes back as the same wall clock —
 * which means writing one requires the UTC parts, never the local ones, and
 * never String(date), which is a locale string in Node.
 */
function toStored(value: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    ` ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/**
 * Push one appointment to everybody attending it.
 *
 * Called from the booking path after the commit, never inside it — a provider
 * round-trip inside a transaction holds row locks for the length of somebody
 * else's network. Never throws; see the header.
 */
export async function pushAppointment(siteId: number, appointmentId: number): Promise<void> {
  try {
    const accounts = await siteQuery<Row>(
      siteId,
      `${SELECT_ACCOUNT}
        WHERE push_enabled = 1
          AND refresh_token_enc IS NOT NULL
          AND user_id IN (SELECT user_id FROM job_appointment_assignees WHERE appointment_id = ?)`,
      [appointmentId],
    ).catch(() => [])
    if (accounts.length === 0) return

    const event = await buildEvent(siteId, appointmentId)
    if (!event) return
    const fingerprint = hash(eventFingerprint(event))

    for (const row of accounts) {
      const account = mapAccount(row)
      try {
        const link = await siteQueryOne<Row>(
          siteId,
          `SELECT id, external_id, pushed_hash FROM job_calendar_links
            WHERE account_id = ? AND appointment_id = ?`,
          [account.id, appointmentId],
        )

        // Nothing a calendar can see has changed. See eventFingerprint.
        if (link && String(link.pushed_hash) === fingerprint) continue

        const token = await tokenFor(siteId, account.id)
        if (!token) {
          await noteError(siteId, account.id, 'The stored access could not be read. Link again.')
          continue
        }

        const provider = providerFor(account.provider)
        const access = await provider.accessToken(token)
        const externalId = await provider.writeEvent(
          access,
          account.calendarId,
          link ? String(link.external_id) : null,
          event,
        )

        /*
         * The link is written AFTER the provider confirms, with the id it gave.
         *
         * Writing it first would mean a failed call leaves a row claiming an
         * event that does not exist — and the next push would PATCH that id,
         * get a 404, and never recover. The cost of this order is the opposite
         * failure: a created event whose link never got written, which shows up
         * as a duplicate on the next push. Duplicates are visible and fixable;
         * a permanently broken link is neither.
         */
        if (externalId) {
          await siteExecute(
            siteId,
            `INSERT INTO job_calendar_links
               (account_id, appointment_id, external_id, pushed_hash, pushed_at)
             VALUES (?,?,?,?,NOW())
             ON DUPLICATE KEY UPDATE
               external_id = VALUES(external_id),
               pushed_hash = VALUES(pushed_hash),
               pushed_at = NOW()`,
            [account.id, appointmentId, externalId, fingerprint],
          )
        }

        await siteExecute(
          siteId,
          `UPDATE job_calendar_accounts SET last_push_at = NOW() WHERE id = ?`,
          [account.id],
        )
        await clearError(siteId, account.id)
      } catch (err) {
        await noteError(siteId, account.id, err instanceof Error ? err.message : 'Push failed.')
      }
    }
  } catch {
    /* Never the reason a booking fails. See the header. */
  }
}

/**
 * Remove an appointment's events, BEFORE the appointment row goes.
 *
 * The order matters and 226 says why: job_calendar_links CASCADEs from the
 * appointment, so deleting the appointment first destroys the only record that
 * the events exist — leaving a ghost booking in somebody's calendar that
 * nothing will ever clean up.
 */
export async function removeCalendarEvents(
  siteId: number,
  appointmentId: number,
): Promise<void> {
  try {
    const links = await siteQuery<Row>(
      siteId,
      `SELECT l.id, l.external_id, l.account_id,
              a.provider, a.calendar_id
         FROM job_calendar_links l
         JOIN job_calendar_accounts a ON a.id = l.account_id
        WHERE l.appointment_id = ?`,
      [appointmentId],
    ).catch(() => [])

    for (const link of links) {
      try {
        const token = await tokenFor(siteId, Number(link.account_id))
        if (!token) continue
        const provider = providerFor(String(link.provider) as CalendarProviderName)
        const access = await provider.accessToken(token)
        await provider.removeEvent(
          access,
          String(link.calendar_id ?? 'primary'),
          String(link.external_id),
        )
        await siteExecute(siteId, `DELETE FROM job_calendar_links WHERE id = ?`, [link.id])
      } catch (err) {
        await noteError(
          siteId,
          Number(link.account_id),
          err instanceof Error ? err.message : 'Could not remove an event.',
        )
      }
    }
  } catch {
    /* Never the reason a visit cannot be deleted. */
  }
}

/* ── Pulling back ─────────────────────────────────────────────────────────── */

/** How far ahead busy time is read. A fortnight covers any real schedule. */
const PULL_DAYS = 14

/**
 * Read one account's busy time, and notice anything moved.
 *
 * Two jobs in one pass because they are one provider round-trip. Never throws.
 */
export async function pullCalendar(siteId: number, accountId: number): Promise<void> {
  try {
    const row = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE id = ?`, [accountId])
    if (!row) return
    const account = mapAccount(row)
    if (!account.pullEnabled) return

    const token = await tokenFor(siteId, accountId)
    if (!token) {
      await noteError(siteId, accountId, 'The stored access could not be read. Link again.')
      return
    }

    const provider = providerFor(account.provider)
    const access = await provider.accessToken(token)
    const from = new Date()
    const to = new Date(from.getTime() + PULL_DAYS * 86_400_000)
    const blocks = await provider.busy(access, account.calendarId, from, to)

    // Our own pushed events, so the sync does not accuse itself. See 226.
    const ours = await siteQuery<Row>(
      siteId,
      `SELECT l.external_id, a.starts_at, a.duration_minutes
         FROM job_calendar_links l
         JOIN job_card_appointments a ON a.id = l.appointment_id
        WHERE l.account_id = ?`,
      [accountId],
    ).catch(() => [])
    const ourIds = new Set(ours.map((o) => String(o.external_id)))
    const ourTimes = ours.map((o) => {
      const s = new Date(storedMillis(o.starts_at as string | Date)).getTime()
      return { start: s, end: s + Math.max(1, Number(o.duration_minutes) || 60) * 60_000 }
    })

    /*
     * Two ways to recognise our own block, because the providers differ.
     *
     * Microsoft's calendarView returns event ids, so the id match is exact.
     * Google's freeBusy returns times ONLY — no ids at all — so an exact time
     * match is the best available, and it is good enough: a block starting and
     * ending at the same instants as a visit we pushed IS that visit, and the
     * only cost of a false positive is not warning about a private appointment
     * that happens to occupy precisely the same minutes.
     */
    const isOurs = (b: { startsAt: Date; endsAt: Date; externalId?: string | null }) => {
      if (b.externalId && ourIds.has(b.externalId)) return true
      return ourTimes.some(
        (t) => t.start === b.startsAt.getTime() && t.end === b.endsAt.getTime(),
      )
    }

    /*
     * Replace wholesale rather than merge — 226 calls this a cache and means it.
     * A deleted dentist appointment must stop being busy, and merging would keep
     * it forever.
     */
    await siteExecute(siteId, `DELETE FROM job_calendar_busy WHERE account_id = ?`, [accountId])
    for (const b of blocks) {
      if (Number.isNaN(b.startsAt.getTime()) || Number.isNaN(b.endsAt.getTime())) continue
      await siteExecute(
        siteId,
        `INSERT INTO job_calendar_busy (account_id, user_id, starts_at, ends_at, is_ours)
         VALUES (?,?,?,?,?)`,
        [
          accountId,
          account.userId,
          toStored(b.startsAt),
          toStored(b.endsAt),
          isOurs(b) ? 1 : 0,
        ],
      ).catch(() => {})
    }

    await detectMovedEvents(siteId, account, blocks)

    await siteExecute(
      siteId,
      `UPDATE job_calendar_accounts SET last_pull_at = NOW() WHERE id = ?`,
      [accountId],
    )
    await clearError(siteId, accountId)
  } catch (err) {
    await noteError(siteId, accountId, err instanceof Error ? err.message : 'Pull failed.')
  }
}

/**
 * Somebody dragged one of our events. Record it as a PROPOSAL.
 *
 * Only possible where the provider returns event ids — Microsoft does,
 * Google's freeBusy does not. That asymmetry is real and is not papered over:
 * on Google a moved event is seen as busy time in the new slot, which still
 * warns the dispatcher, but no proposal is raised. Pretending otherwise would
 * mean guessing which busy block used to be which visit, and a wrong guess
 * reschedules the wrong customer.
 */
async function detectMovedEvents(
  siteId: number,
  account: CalendarAccount,
  blocks: readonly { startsAt: Date; endsAt: Date; externalId?: string | null }[],
): Promise<void> {
  const withIds = blocks.filter((b) => b.externalId)
  if (withIds.length === 0) return

  const links = await siteQuery<Row>(
    siteId,
    `SELECT l.external_id, l.appointment_id, a.starts_at, a.duration_minutes, a.status
       FROM job_calendar_links l
       JOIN job_card_appointments a ON a.id = l.appointment_id
      WHERE l.account_id = ?`,
    [account.id],
  ).catch(() => [])
  if (links.length === 0) return

  const byId = new Map(withIds.map((b) => [String(b.externalId), b]))

  for (const link of links) {
    const block = byId.get(String(link.external_id))
    if (!block) continue

    // A visit already over or called off is not a reschedule proposal.
    const status = String(link.status)
    if (status === 'completed' || status === 'cancelled' || status === 'no_show') continue

    const prevStart = new Date(storedMillis(link.starts_at as string | Date))
    const prevMins = Math.max(1, Number(link.duration_minutes) || 60)
    const newMins = Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60_000)

    if (!isMeaningfulChange(prevStart, prevMins, block.startsAt, newMins)) continue

    /*
     * One pending proposal per appointment.
     *
     * Every pull would otherwise raise the same proposal again — the calendar
     * still says 14:00 and the appointment still says 09:00 until somebody
     * decides — and the queue would grow by one row per appointment per tick
     * until nobody could find the proposal that mattered.
     */
    const existing = await siteQuery<Row>(
      siteId,
      `SELECT id FROM job_calendar_changes
        WHERE appointment_id = ? AND status = 'pending' LIMIT 1`,
      [Number(link.appointment_id)],
    ).catch(() => [])
    if (existing.length > 0) continue

    await siteExecute(
      siteId,
      `INSERT INTO job_calendar_changes
         (account_id, appointment_id, proposed_starts_at, proposed_duration_minutes,
          previous_starts_at, previous_duration_minutes)
       VALUES (?,?,?,?,?,?)`,
      [
        account.id,
        Number(link.appointment_id),
        toStored(block.startsAt),
        newMins > 0 ? newMins : null,
        toStored(prevStart),
        prevMins,
      ],
    ).catch(() => {})
  }
}

/* ── The proposal queue ───────────────────────────────────────────────────── */

export type ProposedChange = {
  id: number
  appointmentId: number
  jobId: number
  jobNumber: string | null
  jobTitle: string
  customerName: string | null
  userName: string
  previousStartsAt: Date
  previousMinutes: number
  proposedStartsAt: Date
  proposedMinutes: number | null
  /** True when the appointment has moved since, so this is about a dead state. */
  isStale: boolean
}

export async function pendingChanges(siteId: number): Promise<ProposedChange[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.id, c.appointment_id, c.proposed_starts_at, c.proposed_duration_minutes,
            c.previous_starts_at, c.previous_duration_minutes,
            a.starts_at AS current_starts_at, a.duration_minutes AS current_minutes,
            j.id AS job_id, j.document_number AS job_number, j.title AS job_title,
            j.customer_name, acc.user_name
       FROM job_calendar_changes c
       JOIN job_card_appointments a  ON a.id = c.appointment_id
       JOIN job_cards j              ON j.id = a.job_card_id
       JOIN job_calendar_accounts acc ON acc.id = c.account_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at`,
  ).catch(() => [])

  return rows.map((r) => {
    const prev = new Date(storedMillis(r.previous_starts_at as string | Date))
    const current = new Date(storedMillis(r.current_starts_at as string | Date))
    return {
      id: Number(r.id),
      appointmentId: Number(r.appointment_id),
      jobId: Number(r.job_id),
      jobNumber: r.job_number === null ? null : String(r.job_number),
      jobTitle: String(r.job_title ?? ''),
      customerName: r.customer_name === null ? null : String(r.customer_name),
      userName: String(r.user_name ?? ''),
      previousStartsAt: prev,
      previousMinutes: Number(r.previous_duration_minutes),
      proposedStartsAt: new Date(storedMillis(r.proposed_starts_at as string | Date)),
      proposedMinutes:
        r.proposed_duration_minutes === null ? null : Number(r.proposed_duration_minutes),
      /*
       * The appointment has moved since the proposal was raised — a dispatcher
       * rescheduled it while the technician's drag was waiting to be read.
       *
       * Shown rather than hidden: accepting it would silently undo whatever the
       * dispatcher did, and the person deciding needs to know that is the choice
       * in front of them.
       */
      isStale:
        current.getTime() !== prev.getTime() ||
        Number(r.current_minutes) !== Number(r.previous_duration_minutes),
    }
  })
}

/**
 * Put a proposed change through the ordinary booking path.
 *
 * The whole point of the proposal design: this calls the SAME function a
 * dispatcher's reschedule calls, so the conflict checks run, the activity entry
 * is written, and a closed job still refuses. An UPDATE here instead would be
 * the silent write 226's header refuses.
 */
export async function acceptChange(
  siteId: number,
  actor: Actor,
  changeId: number,
): Promise<CalendarResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT c.id, c.appointment_id, c.proposed_starts_at, c.proposed_duration_minutes,
            c.status, a.duration_minutes
       FROM job_calendar_changes c
       JOIN job_card_appointments a ON a.id = c.appointment_id
      WHERE c.id = ?`,
    [changeId],
  )
  if (!row) return { ok: false, error: 'That change is no longer there.' }
  if (String(row.status) !== 'pending') {
    return { ok: false, error: 'That change has already been decided.' }
  }

  const { saveAppointment, getAppointment, findConflicts } = await import('./jobAppointments')

  /*
   * The WHOLE appointment is read and passed back, not just the new time.
   *
   * saveAppointment replaces the aggregate — assignees included — which is how
   * every document editor in this app saves. Sending only the changed fields
   * would silently unassign everybody going, and the technician whose drag
   * started this would be taken off their own visit.
   */
  const current = await getAppointment(siteId, Number(row.appointment_id))
  if (!current) return { ok: false, error: 'That visit no longer exists.' }

  const minutes =
    row.proposed_duration_minutes === null
      ? Number(row.duration_minutes)
      : Number(row.proposed_duration_minutes)

  /*
   * Through storedMillis and back out through toStored.
   *
   * String(driverDate).slice(0, 19) looks right and is not: the driver hands
   * back a Date, String() makes it a LOCALE string, and slicing that yields
   * 'Wed Mar 04 2099 13:0' — which saveAppointment correctly refuses as not a
   * real date and time. It cost a starred assertion here passing for the wrong
   * reason: it saw a refusal and believed it was the closed-job one.
   */
  const startsAt = toStored(new Date(storedMillis(row.proposed_starts_at as string | Date)))

  /* Which conflicts this accept may wave through. See the comment below. */
  const OWN_DIARY: readonly string[] = ['overlap', 'travel_gap', 'outside_hours']
  const conflicts = await findConflicts(siteId, {
    appointmentId: current.id,
    jobCardId: current.jobCardId,
    startsAt,
    durationMinutes: minutes,
    assignees: current.assignees,
  })
  const overridable =
    conflicts.length > 0 && conflicts.every((c) => OWN_DIARY.includes(c.kind))

  const moved = await saveAppointment(siteId, actor, {
    id: current.id,
    jobCardId: current.jobCardId,
    startsAt,
    durationMinutes: minutes,
    serviceAddressId: current.serviceAddressId,
    visitType: current.visitType,
    notes: current.notes,
    assignees: current.assignees.map((a) => ({
      userId: a.userId,
      userName: a.userName,
      isLead: a.isLead,
    })),
    /*
     * The override, and ONLY for the conflicts an accepted drag implies.
     *
     * The first version passed a reason unconditionally, reasoning that a
     * change already in somebody's day should not be refused. That was too
     * broad, and the test caught it: saveAppointment treats a CLOSED job as an
     * overridable warning, so a blanket reason let a visit be booked onto a
     * closed job with nobody told.
     *
     * The distinction is who the conflict is about. A clash with the
     * technician's own diary — an overlap, a gap too short, being outside
     * working hours — is the very thing they were expressing by dragging the
     * event, and refusing it leaves the proposal undecidable. A conflict about
     * the JOB is not: the job being closed, or the person being on approved
     * leave, are facts a calendar drag knows nothing about and cannot consent
     * to on somebody else's behalf.
     */
    overrideReason: overridable ? 'Accepted from the linked calendar' : null,
  })
  if (!moved.ok) return { ok: false, error: moved.error }

  await siteExecute(
    siteId,
    `UPDATE job_calendar_changes
        SET status = 'accepted', decided_at = NOW(), decided_by_user_id = ?, decided_by_name = ?
      WHERE id = ?`,
    [actor.userId, actor.userName.slice(0, 120), changeId],
  )
  return { ok: true }
}

/**
 * Refuse it, and put the calendar back.
 *
 * The re-push is what makes declining mean something. Without it the technician
 * sees the visit at the time they dragged it to, forever, while Odyssey and the
 * customer both believe the original — which is the exact confusion this whole
 * mechanism exists to prevent.
 */
export async function declineChange(
  siteId: number,
  actor: Actor,
  changeId: number,
): Promise<CalendarResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, appointment_id, account_id, status FROM job_calendar_changes WHERE id = ?`,
    [changeId],
  )
  if (!row) return { ok: false, error: 'That change is no longer there.' }
  if (String(row.status) !== 'pending') {
    return { ok: false, error: 'That change has already been decided.' }
  }

  await siteExecute(
    siteId,
    `UPDATE job_calendar_changes
        SET status = 'declined', decided_at = NOW(), decided_by_user_id = ?, decided_by_name = ?
      WHERE id = ?`,
    [actor.userId, actor.userName.slice(0, 120), changeId],
  )

  /*
   * Force the next push by clearing the fingerprint.
   *
   * The event's content has not changed from Odyssey's point of view, so the
   * fingerprint still matches and pushAppointment would skip it — leaving the
   * calendar showing the dragged time. Clearing the hash is what makes the
   * re-push happen.
   */
  await siteExecute(
    siteId,
    `UPDATE job_calendar_links SET pushed_hash = '' WHERE appointment_id = ? AND account_id = ?`,
    [Number(row.appointment_id), Number(row.account_id)],
  )
  await pushAppointment(siteId, Number(row.appointment_id))
  return { ok: true }
}

/* ── The tick ─────────────────────────────────────────────────────────────── */

/**
 * Pull every account that wants pulling.
 *
 * Sequential rather than parallel, deliberately: both providers rate-limit per
 * application, and twenty technicians' calendars fetched at once is how a
 * business earns a 429 that fails all twenty. A calendar sync has no deadline
 * measured in seconds.
 */
export async function pullAllCalendars(siteId: number): Promise<number> {
  const accounts = await siteQuery<Row>(
    siteId,
    `SELECT id FROM job_calendar_accounts
      WHERE pull_enabled = 1 AND refresh_token_enc IS NOT NULL`,
  ).catch(() => [])
  for (const a of accounts) await pullCalendar(siteId, Number(a.id))
  return accounts.length
}

/* ── Drift ────────────────────────────────────────────────────────────────── */

export type CalendarDrift = {
  /** Accounts carrying an error — the sync is not working and somebody must relink. */
  failing: { accountId: number; userName: string; provider: string; error: string }[]
  /**
   * Linked, push on, and nothing pushed in a week despite live visits.
   *
   * The failure last_error cannot catch: a sync that never RAN. Nobody notices,
   * because the absence of an event looks exactly like a quiet week.
   */
  silent: { accountId: number; userName: string; lastPushAt: Date | null }[]
  /** Proposals nobody has decided. A queue that grows is a queue nobody reads. */
  undecided: number
}

/** Reports, never repairs. */
export async function reconcileJobCalendar(siteId: number): Promise<CalendarDrift> {
  const empty: CalendarDrift = { failing: [], silent: [], undecided: 0 }
  try {
    const [failing, silent, undecided] = await Promise.all([
      siteQuery<Row>(
        siteId,
        `SELECT id, user_name, provider, last_error FROM job_calendar_accounts
          WHERE last_error <> ''`,
      ),
      siteQuery<Row>(
        siteId,
        `SELECT c.id, c.user_name, c.last_push_at
           FROM job_calendar_accounts c
          WHERE c.push_enabled = 1
            AND c.refresh_token_enc IS NOT NULL
            AND (c.last_push_at IS NULL OR c.last_push_at < DATE_SUB(NOW(), INTERVAL 7 DAY))
            AND EXISTS (
              SELECT 1 FROM job_appointment_assignees s
               JOIN job_card_appointments a ON a.id = s.appointment_id
              WHERE s.user_id = c.user_id
                AND a.starts_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                AND a.status NOT IN ('cancelled','no_show'))`,
      ),
      siteQuery<Row>(
        siteId,
        `SELECT COUNT(*) AS n FROM job_calendar_changes WHERE status = 'pending'`,
      ),
    ])

    return {
      failing: failing.map((r) => ({
        accountId: Number(r.id),
        userName: String(r.user_name ?? ''),
        provider: String(r.provider),
        error: String(r.last_error ?? ''),
      })),
      silent: silent.map((r) => ({
        accountId: Number(r.id),
        userName: String(r.user_name ?? ''),
        lastPushAt: (r.last_push_at as Date | null) ?? null,
      })),
      undecided: Number(undecided[0]?.n ?? 0),
    }
  } catch {
    // No 226 on this site. Not a reason to fail a reconcile sweep.
    return empty
  }
}

/*
 * buildEvent and detectMovedEvents, for the suite only.
 *
 * Both are the parts worth testing and neither is anybody's API: buildEvent
 * decides what a technician actually sees on their phone, and detectMovedEvents
 * decides whether a drag becomes a proposal. Exported through __test rather
 * than made public, matching jobNotify — so a screen cannot start calling them
 * and quietly make them load-bearing.
 */
export const __test = { buildEvent, detectMovedEvents }

export { PULL_DAYS }
