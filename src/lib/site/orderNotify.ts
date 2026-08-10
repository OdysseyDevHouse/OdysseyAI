import 'server-only'
import { formatMoney } from '../decimals'
import { send, isConfigured } from '../mail'
import {
  escapeHtml,
  htmlToText,
  renderTemplate,
  sanitiseEmailHtml,
  starterTemplate,
} from '../orderEmailTemplate'
import { NOTIFY_KIND_LABEL, type OrderStatus } from './onlineStore'
import { getOrder } from './onlineOrders'
import { publicSiteName } from '../sites'
import { createPublicStoreToken } from '../publicStoreToken'
import { createOrderTrackToken } from '../orderTrackToken'
import { absoluteUrl } from '../appUrl'

/**
 * Telling a customer their order has moved.
 *
 * ── IT NEVER THROWS, AND NEVER BLOCKS THE MOVE ───────────────────────────
 *
 * A dead mail server must not stop staff working the queue. Every failure is
 * caught and reported in the return value; the caller moves the order either
 * way. The alternative — a status change that rolls back because an SMTP host
 * was slow — is a shop that cannot process orders when its email breaks.
 *
 * ── THE STATUS DECIDES, IN ONE PLACE ─────────────────────────────────────
 *
 * Own template, then standard message, then silence. `messageFor` is the only
 * implementation of that precedence, so no caller can reinvent it and get a
 * different answer.
 */

export type NotifyResult =
  | { sent: true; to: string }
  | { sent: false; reason: 'no-message' | 'no-address' | 'not-configured' | 'failed'; error?: string }

/** What this status should send, if anything. */
export function messageFor(
  status: Pick<OrderStatus, 'notifyKind' | 'useTemplate' | 'emailSubject' | 'emailHtml'>,
): { kind: 'template' } | { kind: 'standard' } | null {
  if (status.useTemplate && status.emailHtml.trim()) return { kind: 'template' }
  if (status.notifyKind) return { kind: 'standard' }
  return null
}

/**
 * The standard messages, as plain text.
 *
 * Text is authoritative here and the HTML is a wrapper around it — the
 * opposite way round from a shop's own template. These are short enough that
 * markup would add nothing, and keeping them as text means the same words
 * could go out over another channel later without being re-written.
 */
function standardBody(
  kind: Exclude<OrderStatus['notifyKind'], ''>,
  values: {
    firstName: string
    orderNumber: string
    storeName: string
    total: string
    /** Absolute "follow your order" URL, or null when there is no public address. */
    trackLink: string | null
  },
): string {
  const greeting = values.firstName ? `Hi ${values.firstName},` : 'Hi,'
  const line = {
    accepted: `We've got your order ${values.orderNumber} and we're getting it ready.`,
    ready: `Your order ${values.orderNumber} is ready.`,
    on_the_way: `Your order ${values.orderNumber} is on its way.`,
    cancelled: `Your order ${values.orderNumber} has been cancelled.`,
  }[kind]

  /*
   * Not offered on a cancelled order. There is nothing left to follow, and a
   * "see how it's going" link under "your order has been cancelled" reads as
   * though the shop has not noticed.
   */
  const follow =
    values.trackLink && kind !== 'cancelled'
      ? `\n\nFollow your order:\n${values.trackLink}`
      : ''

  return `${greeting}\n\n${line}\n\nTotal: ${values.total}${follow}\n\nKind regards,\n${values.storeName}`
}

/**
 * The absolute "follow your order" URL, or null when one cannot be built.
 *
 * Two tokens, because the route needs both: the STORE token says which shop's
 * storefront this is (and is the same eternal one printed on till slips), and
 * the TRACK token names one order and expires. Neither alone is enough — see
 * orderTrackToken.ts.
 *
 * Null rather than a guess when APP_URL is unset. Every caller treats that as
 * "leave the link out", which is why this can never put localhost in a
 * customer's inbox.
 */
async function orderTrackLink(siteId: number, orderId: number): Promise<string | null> {
  try {
    const [storeToken, trackToken] = await Promise.all([
      createPublicStoreToken(siteId),
      createOrderTrackToken({ siteId, orderId }),
    ])
    return absoluteUrl(`/store/${storeToken}/o/${trackToken}`)
  } catch {
    // Signing needs SESSION_SECRET. A store with none configured still gets
    // its email — without a link — rather than an exception thrown from the
    // middle of a status change.
    return null
  }
}

/** The items, as a table. The one merge field whose value is markup. */
function itemsTable(lines: { qty: number; description: string; lineTotalIncl: number }[]): string {
  if (lines.length === 0) return ''
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:4px 0;font-size:14px;color:#111827">${escapeHtml(
          `${l.qty} × ${l.description}`,
        )}</td><td style="padding:4px 0;font-size:14px;color:#111827;text-align:right">${escapeHtml(
          formatMoney(l.lineTotalIncl),
        )}</td></tr>`,
    )
    .join('')
  return `<table style="width:100%;border-collapse:collapse">${rows}</table>`
}

/**
 * Send the message this status carries, if it carries one.
 *
 * Call AFTER the status change is committed. Nothing here is transactional —
 * an email cannot be rolled back once it has left.
 */
/** A composed email, before anything tries to send it. */
export type ComposedEmail = { to: string; subject: string; html: string; text: string }

/**
 * Build the email a status would send, WITHOUT sending it.
 *
 * Separate from `notifyStatusReached` so the composition can be inspected —
 * by a test, and later by a preview on the setup screen — on a machine with no
 * mail server. An email that can only be examined by receiving it is one whose
 * merge fields get checked by a customer.
 *
 * Returns null when this status has nothing to say.
 */
export async function composeStatusEmail(
  siteId: number,
  orderId: number,
  status: OrderStatus,
): Promise<ComposedEmail | null> {
  const message = messageFor(status)
  if (!message) return null

  const order = await getOrder(siteId, orderId)
  if (!order) return null

  const storeName = (await publicSiteName(siteId)) ?? 'your store'
  const firstName = order.contactName.trim().split(/\s+/)[0] ?? ''
  const to = order.contactEmail.trim()

  /*
   * The "follow your order" link.
   *
   * Empty string when the app has no configured public address, so a shop
   * whose template uses {{track_link}} gets an email with the line missing
   * rather than one pointing at localhost — which would look real, sit in a
   * customer's inbox forever, and never work.
   */
  const trackLink = await orderTrackLink(siteId, order.id)

  if (message.kind === 'template') {
    const values: Record<string, string> = {
      order_number: order.orderNumber,
      customer_name: order.contactName,
      first_name: firstName,
      status: status.name,
      items: itemsTable(order.lines),
      total: formatMoney(order.totalIncl),
      delivery_fee: formatMoney(order.deliveryFeeIncl),
      fulfilment: order.fulfilment === 'deliver' ? 'Delivery' : 'Collection',
      delivery_address: [order.deliveryLine1, order.deliverySuburb, order.deliveryPostcode]
        .filter(Boolean)
        .join(', '),
      payment: order.payOnAccount ? 'On account' : 'Pay on collection',
      customer_note: order.customerNote,
      store_name: storeName,
      track_link: trackLink ?? '',
    }

    // Sanitised AGAIN after rendering. A merge value cannot introduce markup
    // — only `items` is inserted as HTML and we build that ourselves — but
    // sanitising the final string is one line and removes the need to reason
    // about it.
    const html = sanitiseEmailHtml(renderTemplate(status.emailHtml, values))
    return {
      to,
      html,
      subject:
        renderTemplate(status.emailSubject, values).trim() ||
        `Order ${order.orderNumber} — ${storeName}`,
      // Derived from the HTML, so the two versions cannot say different things.
      text: htmlToText(html),
    }
  }

  const kind = status.notifyKind as Exclude<OrderStatus['notifyKind'], ''>
  const text = standardBody(kind, {
    firstName,
    orderNumber: order.orderNumber,
    storeName,
    total: formatMoney(order.totalIncl),
    trackLink,
  })
  return {
    to,
    text,
    subject: `${NOTIFY_KIND_LABEL[kind]} — ${order.orderNumber}`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;white-space:pre-wrap;color:#111827">${escapeHtml(
      text,
    )}</div>`,
  }
}

export async function notifyStatusReached(
  siteId: number,
  orderId: number,
  status: OrderStatus,
): Promise<NotifyResult> {
  try {
    const email = await composeStatusEmail(siteId, orderId, status)
    if (!email) return { sent: false, reason: 'no-message' }

    // No address is not a failure — plenty of shoppers leave a phone number
    // instead. Reported separately so it is not counted as something broken.
    if (!email.to) return { sent: false, reason: 'no-address' }
    if (!isConfigured()) return { sent: false, reason: 'not-configured' }

    const { to, subject, text, html } = email
    const result = await send({ to, subject, text, html })
    return result.ok ? { sent: true, to } : { sent: false, reason: 'failed', error: result.error }
  } catch (error) {
    /*
     * The outermost guard. Everything above is already defensive, but this
     * function is called from the middle of a status change and MUST NOT be
     * the reason one fails.
     */
    return {
      sent: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/** The starter template, re-exported so the setup screen has one import. */
export { starterTemplate }
