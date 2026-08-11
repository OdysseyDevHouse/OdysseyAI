import 'server-only'
import { isConfigured, send } from '../mail'
import { publicSiteName } from '../sites'
import { escapeHtml } from '../orderEmailTemplate'
import { dayOf, timeOf, type Reservation, type ReservationStatus } from '../reservationTypes'
import { getReservation } from './reservations'

/**
 * What a guest is told about their booking.
 *
 * ── COMPOSE AND SEND ARE SEPARATE ─────────────────────────────────────────
 *
 * `composeReservationEmail` builds the message without sending it, so the
 * wording can be checked by a test on a machine with no mail server. An email
 * that can only be examined by receiving it is one whose merge fields get
 * proof-read by a customer. Same split orderNotify.ts makes.
 *
 * ── IT NEVER THROWS, AND IT IS CALLED AFTER THE COMMIT ────────────────────
 *
 * A booking that was confirmed IS confirmed, whether or not the mail server was
 * reachable. Nothing here is transactional — an email cannot be rolled back
 * once it has left — so the caller changes the status first and tells the guest
 * second, and a failure comes back as a result rather than an exception.
 *
 * ── THE SHOP'S PHONE NUMBER IS DELIBERATELY ABSENT ────────────────────────
 *
 * `publicSiteName` returns the NAME only, on purpose: the site record also
 * carries the VAT number, registration number and postal address, none of which
 * belongs in a public-facing props object. So these messages tell the guest to
 * reply or use the number they already called, rather than quoting a number
 * this layer would have to widen a deliberate boundary to read.
 */

export type ReservationNotifyKind = 'received' | 'confirmed' | 'declined' | 'cancelled'

export type NotifyResult =
  | { sent: true; to: string }
  | { sent: false; reason: 'no-message' | 'no-address' | 'not-configured' | 'failed'; error?: string }

/** A composed email, before anything tries to send it. */
export type ComposedEmail = { to: string; subject: string; html: string; text: string }

/** "Saturday, 09 Aug at 19:00" — how a booking time reads to a guest. */
export function whenLabel(reservedFor: string): string {
  const day = dayOf(reservedFor)
  const time = timeOf(reservedFor)
  // Midday, so a DST shift cannot roll the label onto the neighbouring day. The
  // time is taken from the string rather than the Date for the same reason the
  // rest of this feature does: it is a wall-clock fact, not an instant.
  const d = new Date(`${day}T12:00:00`)
  if (Number.isNaN(d.getTime())) return reservedFor
  const label = d.toLocaleDateString('en-ZA', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  })
  return `${label} at ${time}`
}

/**
 * Subject and body per kind. Plain text is the source of truth.
 *
 * 'received' is careful about what it promises: when a shop confirms bookings by
 * hand, the guest must be told this is a REQUEST, or they will arrive at a
 * restaurant that never agreed to seat them.
 */
function compose(
  kind: ReservationNotifyKind,
  r: Reservation,
  storeName: string,
): { subject: string; text: string } | null {
  const who = r.contactName.trim() ? ` ${r.contactName.trim().split(/\s+/)[0]}` : ''
  const when = whenLabel(r.reservedFor)
  const people = `${r.partySize} ${r.partySize === 1 ? 'person' : 'people'}`
  const detail = `${when}\n${people}\nReference ${r.reference}`
  const sign = `\n\nKind regards,\n${storeName}`

  switch (kind) {
    case 'received':
      return {
        subject: `Booking request ${r.reference} — ${storeName}`,
        text:
          `Hi${who},\n\nThanks — we have your table request and will confirm it shortly.\n\n${detail}\n\n` +
          'You will get another message once it is confirmed.' +
          sign,
      }
    case 'confirmed':
      return {
        subject: `Table confirmed for ${when} — ${storeName}`,
        text:
          `Hi${who},\n\nYour table is confirmed. We look forward to seeing you.\n\n${detail}\n\n` +
          'If your plans change, please let us know as soon as you can.' +
          sign,
      }
    case 'declined':
      return {
        subject: `Booking ${r.reference} — ${storeName}`,
        text:
          `Hi${who},\n\nWe are sorry — we cannot take your booking for ${when}.` +
          (r.cancelReason ? `\n\n${r.cancelReason}` : '') +
          '\n\nPlease get in touch and we will try to find another time.' +
          sign,
      }
    case 'cancelled':
      return {
        subject: `Booking ${r.reference} cancelled — ${storeName}`,
        text:
          `Hi${who},\n\nYour booking for ${when} has been cancelled.` +
          (r.cancelReason ? `\n\nReason: ${r.cancelReason}` : '') +
          '\n\nIf this is a mistake, please get in touch.' +
          sign,
      }
    default:
      return null
  }
}

/**
 * Build the email a booking would send, WITHOUT sending it.
 *
 * Takes the reservation rather than an id so the caller can pass the row it has
 * just written, and returns null when there is nothing to say.
 */
export async function composeReservationEmail(
  siteId: number,
  reservation: Reservation,
  kind: ReservationNotifyKind,
): Promise<ComposedEmail | null> {
  const storeName = (await publicSiteName(siteId)) ?? 'your restaurant'
  const message = compose(kind, reservation, storeName)
  if (!message) return null

  return {
    to: reservation.contactEmail.trim(),
    subject: message.subject,
    text: message.text,
    // The HTML is a wrapper around the escaped text, so the two versions can
    // never say different things.
    html:
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'font-size:14px;line-height:1.55;white-space:pre-wrap;color:#111827">' +
      `${escapeHtml(message.text)}</div>`,
  }
}

/**
 * Tell a guest where their booking stands.
 *
 * Every failure is a returned reason, never a throw. "No address" is reported
 * separately from "failed" because it is not something broken: plenty of guests
 * book with a phone number and no email.
 */
export async function notifyReservationGuest(
  siteId: number,
  reservation: Reservation,
  kind: ReservationNotifyKind,
): Promise<NotifyResult> {
  try {
    const email = await composeReservationEmail(siteId, reservation, kind)
    if (!email) return { sent: false, reason: 'no-message' }
    if (!email.to) return { sent: false, reason: 'no-address' }
    if (!isConfigured()) return { sent: false, reason: 'not-configured' }

    const { to, subject, text, html } = email
    const result = await send({ to, subject, text, html })
    return result.ok ? { sent: true, to } : { sent: false, reason: 'failed', error: result.error }
  } catch (error) {
    return {
      sent: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/** Re-read the booking, then tell the guest. For callers holding only an id. */
export async function notifyReservationById(
  siteId: number,
  reservationId: number,
  kind: ReservationNotifyKind,
): Promise<NotifyResult> {
  try {
    const reservation = await getReservation(siteId, reservationId)
    if (!reservation) return { sent: false, reason: 'no-message' }
    return notifyReservationGuest(siteId, reservation, kind)
  } catch (error) {
    return {
      sent: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Which status changes are worth telling a guest about.
 *
 * 'seated' and 'completed' are deliberately silent — the guest is standing in
 * the room, and a phone buzzing to say "you have been seated" is noise. So is
 * 'no_show': chasing somebody who did not arrive is the shop's judgement call
 * to make by phone, not an automatic accusation.
 *
 * A cancellation from 'pending' is a DECLINE — the shop never agreed to it —
 * and reads differently from cancelling a table that was promised. The caller
 * passes the status the booking was in before the change so this can tell them
 * apart.
 */
export function notifyKindForStatus(
  to: ReservationStatus,
  from: ReservationStatus,
): ReservationNotifyKind | null {
  if (to === 'confirmed') return 'confirmed'
  if (to === 'cancelled') return from === 'pending' ? 'declined' : 'cancelled'
  return null
}
