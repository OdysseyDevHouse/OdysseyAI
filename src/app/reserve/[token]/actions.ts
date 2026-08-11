'use server'

import { headers } from 'next/headers'
import { verifyPublicReserveToken } from '@/lib/publicReserveToken'
import { getReservationSettings, submitReservation } from '@/lib/site/reservations'
import { notifyReservationGuest, whenLabel } from '@/lib/site/reservationNotify'

/**
 * The public booking action.
 *
 * ── THE TOKEN IS RESOLVED AGAIN, FROM SCRATCH ─────────────────────────────
 *
 * A server action is a public HTTP endpoint. The page that rendered the form
 * already checked the token, but that check protected the PAGE, not this — a
 * script can call this directly with any token it likes. So the token is
 * verified again on every call, and the browser never names the site: it hands
 * over a token, and this decides which tenant that means.
 *
 * ── AND SO IS EVERY RULE ──────────────────────────────────────────────────
 *
 * `submitReservation` re-derives the bookable slots and re-checks the party
 * size, the lead time, the horizon and the daily cap. The form showing only
 * valid options is a convenience for the guest, never the control.
 */

export type BookResult =
  | {
      ok: true
      /** True when the shop auto-confirms; false when staff must accept it. */
      confirmed: boolean
      reference: string
      /** "Saturday, 09 Aug at 19:00" — echoed back so the guest sees what was booked. */
      when: string
    }
  | { ok: false; error: string }

/** The guest's IP, for abuse triage on a form with no login. */
async function clientIp(): Promise<string> {
  const head = await headers()
  const forwarded = head.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? ''
  return head.get('x-real-ip') ?? ''
}

export async function bookTableAction(
  token: string,
  input: {
    contactName: string
    contactPhone: string
    contactEmail: string
    partySize: number
    date: string
    time: string
    customerNote: string
    /** Honeypot. A human never fills this in. */
    website?: string
  },
): Promise<BookResult> {
  const siteId = await verifyPublicReserveToken(token)
  // Deliberately the same message a closed shop gets: a bad token must not be
  // usable to confirm that a site exists.
  if (siteId === null) return { ok: false, error: 'This booking link is not available.' }

  const settings = await getReservationSettings(siteId)
  if (!settings.isEnabled) {
    return { ok: false, error: 'This restaurant is not taking online bookings.' }
  }

  const result = await submitReservation(
    siteId,
    {
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail,
      partySize: input.partySize,
      date: input.date,
      time: input.time,
      customerNote: input.customerNote,
      website: input.website,
    },
    { ip: await clientIp() },
  )
  if (!result.ok) return result

  const booking = result.reservation

  /*
   * The honeypot's fake success has id 0 and no reservedFor. Sending mail for it
   * would turn the trap into an open relay pointed at whatever address a bot
   * typed, so this returns the same cheerful answer and does nothing else.
   */
  if (booking.id === 0) {
    return { ok: true, confirmed: settings.autoConfirm, reference: booking.reference, when: '' }
  }

  // After the write, and best-effort. A mail server that is down must not lose
  // the booking — notifyReservationGuest never throws.
  await notifyReservationGuest(siteId, booking, settings.autoConfirm ? 'confirmed' : 'received')

  return {
    ok: true,
    confirmed: booking.status === 'confirmed',
    reference: booking.reference,
    when: whenLabel(booking.reservedFor),
  }
}
