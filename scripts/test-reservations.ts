/**
 * Table reservations — a booking is a promise about a future seat.
 *
 * The rules that must be TRUE in the data rather than merely commented:
 *
 *  1. A booking is NOT a sale. Nothing here writes a sales_document, moves
 *     stock or touches money — so the queue can never leak an empty draft into
 *     a sales report for a party that may never arrive.
 *  2. The transition table is the authority. A status that is not a legal next
 *     step is refused by the SERVER, so a stale queue in another tab cannot
 *     walk a completed booking backwards.
 *  3. The public form is a convenience, never the control. submitReservation
 *     re-derives the bookable slots and refuses anything not on the list, so a
 *     hand-crafted POST gets the same answer as a browser that never loaded it.
 *  4. Wall-clock in is wall-clock out. A 19:00 booking reads back as 19:00
 *     regardless of the server's timezone — the pool parses DATETIME as UTC.
 *  5. Staff are not bound by the public form's rules. The person on the phone
 *     can see the room; the rules exist to stop the shop over-promising to
 *     strangers, not to overrule the person standing in it.
 *
 *   npm run test:reservations
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  createPublicReserveToken,
  verifyPublicReserveToken,
} from '../src/lib/publicReserveToken'
import { createPublicStoreToken } from '../src/lib/publicStoreToken'
import {
  composeReservationEmail,
  notifyKindForStatus,
  whenLabel,
} from '../src/lib/site/reservationNotify'
import {
  bookableSlots,
  combineLocal,
  createStaffReservation,
  getReservation,
  getReservationSettings,
  listReservations,
  saveReservationSettings,
  setReservationStatus,
  setReservationTable,
  submitReservation,
} from '../src/lib/site/reservations'
import {
  DEFAULT_SETTINGS,
  allowedNext,
  canTransition,
  dateKey,
  dayOf,
  formatHm,
  parseHm,
  parseOpeningHours,
  timeOf,
  type ReservationSettings,
  type ReservationStatus,
} from '../src/lib/reservationTypes'

const SITE = 1
const actor = { userId: 1, userName: 'Reservation Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Every booking this run creates, so the finally block can take them away. */
const created: number[] = []

/** Phone numbers nothing else in the suite will collide with. */
const TEST_PHONE = '0820000917'
/** Kept separate so the per-phone daily cap can be tested from a clean slate. */
const CAP_PHONE = '0820000918'

async function track<T extends { ok: boolean }>(
  result: T & { reservation?: { id: number } },
): Promise<T> {
  if (result.ok && result.reservation?.id) created.push(result.reservation.id)
  return result
}

/** "YYYY-MM-DD" a given number of days from today. */
function dayFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

async function main() {
  /* ── pure rules: no database ────────────────────────────────────────────── */

  ok('parseHm reads a time', parseHm('18:30') === 18 * 60 + 30)
  ok('parseHm rejects 24:00', parseHm('24:00') === null)
  ok('parseHm rejects junk', parseHm('half six') === null)
  ok('formatHm pads', formatHm(9 * 60 + 5) === '09:05')

  // A range that ends before it starts is meaningless — dropped, not reversed.
  const backwards = parseOpeningHours('{"3":[["21:00","18:00"]]}')
  ok('opening hours drop a backwards range', Object.keys(backwards).length === 0)
  ok('opening hours survive junk', Object.keys(parseOpeningHours('not json')).length === 0)
  ok('opening hours reject a bad weekday', Object.keys(parseOpeningHours('{"9":[["18:00","21:00"]]}')).length === 0)
  const twoSittings = parseOpeningHours('{"6":[["12:00","15:00"],["18:00","22:00"]]}')
  ok('a day can hold two sittings', twoSittings['6']?.length === 2)

  // The workflow. 'pending' is never reachable again, and a no-show can only
  // follow a booking the shop actually promised.
  ok('pending may be confirmed', canTransition('pending', 'confirmed'))
  ok('pending may be cancelled', canTransition('pending', 'cancelled'))
  ok('a pending booking is NOT a no-show', !canTransition('pending', 'no_show'))
  ok('confirmed may become a no-show', canTransition('confirmed', 'no_show'))
  ok('a completed booking is terminal', allowedNext('completed').length === 0)
  ok('a no-show is terminal', allowedNext('no_show').length === 0)
  ok('a cancelled booking is terminal', allowedNext('cancelled').length === 0)
  ok('nothing returns to pending', (['confirmed', 'seated', 'completed', 'no_show', 'cancelled'] as ReservationStatus[])
    .every((s) => !canTransition(s, 'pending')))

  // combineLocal must reject a date Date would silently roll over.
  ok('combineLocal builds a DATETIME', combineLocal('2026-08-09', '19:00') === '2026-08-09 19:00:00')
  ok('combineLocal rejects 31 February', combineLocal('2026-02-31', '19:00') === null)
  ok('combineLocal rejects a bad time', combineLocal('2026-08-09', '99:99') === null)

  /* ── slot generation ────────────────────────────────────────────────────── */

  // A shop that is switched off offers nothing, whatever its hours say.
  ok('a disabled shop offers no slots', bookableSlots({ ...DEFAULT_SETTINGS, isEnabled: false }).length === 0)

  // The range end is the LAST SEATING and is itself bookable. This is the rule
  // that would silently drop a 21:30 booking the restaurant asked for.
  const friday: ReservationSettings = {
    ...DEFAULT_SETTINGS,
    isEnabled: true,
    leadTimeMinutes: 0,
    horizonDays: 14,
    slotMinutes: 30,
    openingHours: { '0': [['18:00', '21:30']], '1': [['18:00', '21:30']], '2': [['18:00', '21:30']],
                    '3': [['18:00', '21:30']], '4': [['18:00', '21:30']], '5': [['18:00', '21:30']],
                    '6': [['18:00', '21:30']] },
  }
  // Tomorrow, so "today" cannot be partly eaten by the current time of day.
  const tomorrow = bookableSlots(friday).find((d) => d.date === dayFromNow(1))
  ok('the last seating is bookable', !!tomorrow?.times.includes('21:30'), tomorrow?.times.join(' '))
  ok('the first seating is bookable', !!tomorrow?.times.includes('18:00'))
  ok('nothing past the last seating', !tomorrow?.times.includes('22:00'))
  ok('slots step by slotMinutes', !!tomorrow?.times.includes('18:30') && !tomorrow?.times.includes('18:15'))

  // The lead time must hide today's remaining slots without touching tomorrow.
  const longLead = bookableSlots({ ...friday, leadTimeMinutes: 60 * 24 * 2 })
  ok('a long lead time empties the near days', (longLead[0]?.times.length ?? 0) === 0)
  ok('a long lead time still opens later days', longLead.some((d) => d.times.length > 0))

  // The horizon is a hard stop.
  ok('the horizon bounds the days offered', bookableSlots({ ...friday, horizonDays: 3 }).length === 3)

  // A closed day offers nothing while its neighbours still do.
  const mondayClosed = bookableSlots({ ...friday, openingHours: { ...friday.openingHours, '1': [] } })
  ok('a closed weekday offers nothing', mondayClosed.every((d) => new Date(`${d.date}T12:00:00`).getDay() !== 1 || d.times.length === 0))

  /* ── settings round-trip ────────────────────────────────────────────────── */

  const original = await getReservationSettings(SITE)
  let settingsTouched = false
  try {
    settingsTouched = true
    await saveReservationSettings(SITE, {
      ...DEFAULT_SETTINGS,
      isEnabled: true,
      leadTimeMinutes: 0,
      maxPartySize: 8,
      maxPerPhonePerDay: 0, // off, so the cap cannot interfere with the lifecycle below
      autoConfirm: false,
      openingHours: friday.openingHours,
    })
    const saved = await getReservationSettings(SITE)
    ok('settings round-trip: enabled', saved.isEnabled === true)
    ok('settings round-trip: hours', JSON.stringify(saved.openingHours) === JSON.stringify(friday.openingHours))
    ok('settings round-trip: max party', saved.maxPartySize === 8)

    // Out-of-range values are clamped, never stored raw.
    await saveReservationSettings(SITE, { ...saved, slotMinutes: 9999, horizonDays: -5 })
    const clamped = await getReservationSettings(SITE)
    ok('slot minutes are clamped', clamped.slotMinutes === 180, String(clamped.slotMinutes))
    ok('horizon days are clamped', clamped.horizonDays === 1, String(clamped.horizonDays))
    await saveReservationSettings(SITE, { ...saved })

    /* ── the public form ──────────────────────────────────────────────────── */

    const slotDay = dayFromNow(2)

    // The honeypot: SUCCESS is reported and nothing is written, because telling
    // a bot it was detected is how it learns to stop filling the field.
    const before = (await listReservations(SITE, { fromDate: slotDay, toDate: slotDay })).length
    const trapped = await submitReservation(SITE, {
      contactName: 'Bot', contactPhone: TEST_PHONE, contactEmail: '', partySize: 2,
      date: slotDay, time: '19:00', customerNote: '', website: 'http://spam.example',
    })
    const after = (await listReservations(SITE, { fromDate: slotDay, toDate: slotDay })).length
    ok('the honeypot reports success', trapped.ok === true)
    ok('the honeypot writes nothing', before === after, `${before} -> ${after}`)

    // A time the shop is not offering is refused even though the form would
    // never have shown it — the server re-derives the list.
    const offSlot = await submitReservation(SITE, {
      contactName: 'Chancer', contactPhone: TEST_PHONE, contactEmail: '', partySize: 2,
      date: slotDay, time: '03:00', customerNote: '',
    })
    ok('a slot the shop never offered is refused', offSlot.ok === false)

    // The party of forty goes to the phone, where a human belongs.
    const tooBig = await submitReservation(SITE, {
      contactName: 'Coach Party', contactPhone: TEST_PHONE, contactEmail: '', partySize: 40,
      date: slotDay, time: '19:00', customerNote: '',
    })
    ok('a party over the maximum is refused', tooBig.ok === false)

    ok('a nameless booking is refused', (await submitReservation(SITE, {
      contactName: '', contactPhone: TEST_PHONE, contactEmail: '', partySize: 2,
      date: slotDay, time: '19:00', customerNote: '',
    })).ok === false)
    ok('an unreachable booking is refused', (await submitReservation(SITE, {
      contactName: 'No Phone', contactPhone: '123', contactEmail: '', partySize: 2,
      date: slotDay, time: '19:00', customerNote: '',
    })).ok === false)
    ok('a malformed email is refused', (await submitReservation(SITE, {
      contactName: 'Typo', contactPhone: TEST_PHONE, contactEmail: 'not-an-email', partySize: 2,
      date: slotDay, time: '19:00', customerNote: '',
    })).ok === false)

    // The good one.
    const online = await track(await submitReservation(SITE, {
      contactName: 'Ada Online', contactPhone: TEST_PHONE, contactEmail: 'ada@example.com',
      partySize: 4, date: slotDay, time: '19:00', customerNote: 'Window table please',
    }))
    ok('a valid online booking is accepted', online.ok === true, online.ok ? '' : online.error)
    if (!online.ok) throw new Error('cannot continue without a booking')

    const booking = online.reservation
    ok('a booking starts pending when autoConfirm is off', booking.status === 'pending')
    ok('an online booking is sourced online', booking.source === 'online')
    ok('the reference is derived from the id', booking.reference === `RS${String(booking.id).padStart(6, '0')}`)

    // Rule 4: wall-clock in, wall-clock out. This is the one that silently
    // breaks on a server whose timezone is not UTC.
    ok('the booked time reads back unshifted', timeOf(booking.reservedFor) === '19:00', booking.reservedFor)
    ok('the booked day reads back unshifted', dayOf(booking.reservedFor) === slotDay, booking.reservedFor)

    /* ── the lifecycle ────────────────────────────────────────────────────── */

    // Rule 2: the server refuses an illegal jump, whatever the client believes.
    const illegal = await setReservationStatus(SITE, booking.id, 'completed', actor)
    ok('pending cannot jump to completed', illegal.ok === false, illegal.ok ? '' : illegal.error)
    ok('the refused jump left the status alone', (await getReservation(SITE, booking.id))?.status === 'pending')

    ok('confirming works', (await setReservationStatus(SITE, booking.id, 'confirmed', actor)).ok === true)

    // Seating stamps the time it happened.
    ok('seating works', (await setReservationStatus(SITE, booking.id, 'seated', actor)).ok === true)
    const seated = await getReservation(SITE, booking.id)
    ok('seating stamps seated_at', !!seated?.seatedAt)
    ok('a seated booking cannot become a no-show', !canTransition('seated', 'no_show'))

    ok('completing works', (await setReservationStatus(SITE, booking.id, 'completed', actor)).ok === true)
    const done = await getReservation(SITE, booking.id)
    ok('a completed booking stays completed', done?.status === 'completed')
    ok('a completed booking accepts nothing further',
      (await setReservationStatus(SITE, booking.id, 'cancelled', actor)).ok === false)

    // Rule 1: none of that wrote a sale.
    ok('no sale was created for the booking', done?.documentId === null)

    /* ── the table, matched by name ───────────────────────────────────────── */

    const walkIn = await track(await createStaffReservation(SITE, {
      contactName: 'Grace Phone', contactPhone: TEST_PHONE, partySize: 30,
      date: slotDay, time: '03:00', tableName: 'Patio 3', customerNote: '',
    }, actor))
    // Rule 5: party of 30 at 03:00 — over the cap and outside the sitting, both
    // of which the PUBLIC form refused above. Staff are not bound by either.
    ok('staff may book past the public maximum', walkIn.ok === true, walkIn.ok ? '' : walkIn.error)
    if (walkIn.ok) {
      ok('a staff booking is confirmed on creation', walkIn.reservation.status === 'confirmed')
      ok('a staff booking is sourced phone', walkIn.reservation.source === 'phone')
      ok('a table need not exist on a floor plan', walkIn.reservation.tableName === 'Patio 3')
      ok('the booking records who took it', walkIn.reservation.userName === actor.userName)

      ok('a table can be changed', (await setReservationTable(SITE, walkIn.reservation.id, 'Table 12', actor)).ok === true)
      ok('the new table stuck', (await getReservation(SITE, walkIn.reservation.id))?.tableName === 'Table 12')
      ok('a table can be cleared', (await setReservationTable(SITE, walkIn.reservation.id, '', actor)).ok === true)
      ok('the table cleared', (await getReservation(SITE, walkIn.reservation.id))?.tableName === '')

      // A no-show is its own terminal status, and carries the reason.
      ok('a confirmed party can be a no-show',
        (await setReservationStatus(SITE, walkIn.reservation.id, 'no_show', actor, { reason: 'Never arrived' })).ok === true)
      const noShow = await getReservation(SITE, walkIn.reservation.id)
      ok('the no-show reason is kept', noShow?.cancelReason === 'Never arrived')
      ok('a no-show is terminal in the data',
        (await setReservationStatus(SITE, walkIn.reservation.id, 'completed', actor)).ok === false)
    }

    ok('a missing booking is reported, not thrown',
      (await setReservationStatus(SITE, 2_000_000_000, 'confirmed', actor)).ok === false)

    /* ── the daily cap ────────────────────────────────────────────────────── */

    // A phone number of its own. The cap counts SUBMISSIONS made today, not
    // bookings for a given date, so TEST_PHONE has already used its allowance
    // on the bookings above — reusing it here would test nothing.
    await saveReservationSettings(SITE, { ...saved, maxPerPhonePerDay: 1 })
    const capDay = dayFromNow(3)
    const first = await track(await submitReservation(SITE, {
      contactName: 'Cap One', contactPhone: CAP_PHONE, contactEmail: '', partySize: 2,
      date: capDay, time: '19:00', customerNote: '',
    }))
    const second = await track(await submitReservation(SITE, {
      contactName: 'Cap Two', contactPhone: CAP_PHONE, contactEmail: '', partySize: 2,
      date: capDay, time: '19:30', customerNote: '',
    }))
    ok('the first booking of the day is taken', first.ok === true)
    ok('the daily cap refuses the next one', second.ok === false)
    await saveReservationSettings(SITE, { ...saved })

    /* ── the queue's own query ────────────────────────────────────────────── */

    /* ── the public booking link ──────────────────────────────────────────── */

    const reserveToken = await createPublicReserveToken(SITE)
    ok('a booking token resolves to its site', (await verifyPublicReserveToken(reserveToken)) === SITE)
    // Deterministic: the QR code printed on the door last month must still work.
    ok('the token is the same every time', (await createPublicReserveToken(SITE)) === reserveToken)
    ok('a different site gets a different token', (await createPublicReserveToken(SITE + 1)) !== reserveToken)
    ok('junk is refused', (await verifyPublicReserveToken('not-a-token')) === null)
    ok('an empty token is refused', (await verifyPublicReserveToken('')) === null)
    /*
     * The audience check, which is the whole reason this is its own module: a
     * storefront link must never be replayable as a booking link. Both carry
     * nothing but a siteId and are signed with the same secret, so without the
     * audience they would be interchangeable.
     */
    const storeToken = await createPublicStoreToken(SITE)
    ok('a storefront token is NOT a booking token', (await verifyPublicReserveToken(storeToken)) === null)

    /* ── what the guest is told ───────────────────────────────────────────── */

    // Only the changes that affect the guest, and a decline reads differently
    // from a cancellation because the shop never promised the table.
    ok('confirming tells the guest', notifyKindForStatus('confirmed', 'pending') === 'confirmed')
    ok('cancelling a pending booking is a decline', notifyKindForStatus('cancelled', 'pending') === 'declined')
    ok('cancelling a confirmed booking is a cancellation', notifyKindForStatus('cancelled', 'confirmed') === 'cancelled')
    ok('seating is silent', notifyKindForStatus('seated', 'confirmed') === null)
    ok('completing is silent', notifyKindForStatus('completed', 'seated') === null)
    ok('a no-show is silent', notifyKindForStatus('no_show', 'confirmed') === null)

    ok('whenLabel reads as a person would say it', whenLabel('2026-08-09T19:00:00').includes('19:00'))
    ok('whenLabel survives junk', whenLabel('nonsense') === 'nonsense')

    // Composed WITHOUT a mail server — the point of the compose/send split.
    const emailBooking = await track(await createStaffReservation(SITE, {
      contactName: 'Mary Email', contactPhone: TEST_PHONE, contactEmail: 'mary@example.com',
      partySize: 2, date: slotDay, time: '19:00', customerNote: '',
    }, actor))
    if (emailBooking.ok) {
      const confirmMail = await composeReservationEmail(SITE, emailBooking.reservation, 'confirmed')
      ok('a confirmation is addressed to the guest', confirmMail?.to === 'mary@example.com')
      ok('the subject names the time', !!confirmMail?.subject.includes('19:00'))
      ok('the body quotes the reference', !!confirmMail?.text.includes(emailBooking.reservation.reference))
      ok('the body says how many people', !!confirmMail?.text.includes('2 people'))
      ok('the html mirrors the text', !!confirmMail?.html.includes('19:00'))
      // The HTML is an escaped wrapper, so a guest's name can never inject markup.
      const nastyName = { ...emailBooking.reservation, contactName: '<script>x</script>' }
      const escaped = await composeReservationEmail(SITE, nastyName, 'confirmed')
      ok('a guest name cannot inject markup', !escaped?.html.includes('<script>'))

      const received = await composeReservationEmail(SITE, emailBooking.reservation, 'received')
      // The promise a store-side confirmation has NOT yet made.
      ok('a request does not promise a table', !!received?.text.toLowerCase().includes('confirm'))

      const declined = await composeReservationEmail(
        SITE,
        { ...emailBooking.reservation, cancelReason: 'Fully booked' },
        'declined',
      )
      ok('a decline carries the reason', !!declined?.text.includes('Fully booked'))

      // No address is not a failure — plenty of guests book by phone only.
      const noEmail = await composeReservationEmail(
        SITE,
        { ...emailBooking.reservation, contactEmail: '' },
        'confirmed',
      )
      ok('a booking with no email composes with no recipient', noEmail?.to === '')
    }

    const listed = await listReservations(SITE, { fromDate: slotDay, toDate: slotDay })
    ok('the list is in booking-time order',
      listed.every((r, i) => i === 0 || listed[i - 1]!.reservedFor <= r.reservedFor))
    ok('the list finds a booking by name', (await listReservations(SITE, { search: 'Ada Online' })).length > 0)
    ok('the list finds a booking by reference', (await listReservations(SITE, { search: booking.reference })).length === 1)
    ok('the list filters by status',
      (await listReservations(SITE, { statuses: ['completed'], fromDate: slotDay, toDate: slotDay }))
        .every((r) => r.status === 'completed'))
  } finally {
    /* ── cleanup ───────────────────────────────────────────────────────────
       A leaked booking would sit on the UNIQUE reference and in every future
       run's counts. Delete by id, and restore the shop's real settings. */
    for (const id of created) {
      await siteExecute(SITE, 'DELETE FROM reservations WHERE id = ?', [id])
    }
    // Anything this run's phone numbers created that we failed to track.
    await siteExecute(SITE, 'DELETE FROM reservations WHERE contact_phone IN (?, ?)', [
      TEST_PHONE,
      CAP_PHONE,
    ])
    if (settingsTouched) await saveReservationSettings(SITE, original)

    const leaked = await siteQueryOne<{ n: number }>(
      SITE,
      'SELECT COUNT(*) AS n FROM reservations WHERE contact_phone IN (?, ?)',
      [TEST_PHONE, CAP_PHONE],
    )
    ok('the test left no bookings behind', Number(leaked?.n ?? 0) === 0)
  }

  console.log(fails === 0 ? '\nAll reservation checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
