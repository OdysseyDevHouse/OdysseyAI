import 'server-only'
import { sendAs, isConfiguredFor } from '../mail'
import { escapeHtml, htmlToText } from '../orderEmailTemplate'
import { formatMoney } from '../decimals'
import { absoluteUrl } from '../appUrl'
import { createPublicStoreToken } from '../publicStoreToken'
import { publicSiteName } from '../sites'
import { getOnlineSettings } from './onlineStore'
import { dueForReminder, markReminded, type SavedBasket } from './savedBaskets'
import { publishedProducts, storefrontContext } from './storefront'

/**
 * The one email about a basket somebody left behind.
 *
 * ── EVERY GUARD IS A REASON NOT TO SEND ──────────────────────────────────
 *
 * A shop must opt in, the app must have a public address to link back to, mail
 * must be configured, and the basket must still contain something the shop
 * actually sells. Any of those missing means no email — never a half one.
 *
 * ── MARKED AS REMINDED EVEN WHEN THE SEND FAILS ──────────────────────────
 *
 * A dead mail server must not turn into the same shopper being retried every
 * five minutes for a week. One attempt is what "one reminder, ever" means, and
 * a basket nobody could be told about is not worth a queue.
 *
 * ── IT RE-READS THE CATALOGUE ────────────────────────────────────────────
 *
 * The stored subtotal is what the basket was worth when it was saved. The email
 * quotes what the shop charges NOW, because that is what the shopper will pay
 * if they come back — and a product that has since been archived or unpublished
 * is dropped from the list rather than advertised.
 */

export type BasketTickResult = {
  /** Baskets that met every condition and were attempted. */
  attempted: number
  sent: number
  /** Skipped after the query, e.g. every line has since gone off sale. */
  skipped: number
  failed: number
}

const EMPTY: BasketTickResult = { attempted: 0, sent: 0, skipped: 0, failed: 0 }

export async function remindAbandonedBaskets(siteId: number): Promise<BasketTickResult> {
  const settings = await getOnlineSettings(siteId).catch(() => null)
  // Off by default, and off means off — see 072_saved_baskets.sql.
  if (!settings?.isEnabled || !settings.basketReminders) return EMPTY
  if (!(await isConfiguredFor(siteId))) return EMPTY

  // No public address means no link to come back to, and a reminder without one
  // is just a note about shopping the shopper cannot act on.
  const storeToken = await createPublicStoreToken(siteId).catch(() => null)
  if (!storeToken) return EMPTY
  if (!absoluteUrl('/')) return EMPTY

  const context = await storefrontContext(siteId)
  if (!context) return EMPTY

  const due = await dueForReminder(siteId, settings.basketReminderHours)
  if (due.length === 0) return EMPTY

  const storeName = (await publicSiteName(siteId)) ?? context.storeName

  const result: BasketTickResult = { attempted: 0, sent: 0, skipped: 0, failed: 0 }

  for (const basket of due) {
    /*
     * Claimed BEFORE the send, not after.
     *
     * If this throws halfway — a mail server timing out mid-loop — the basket
     * must not be picked up again by the next tick. Marking first means the
     * worst case is one reminder that never arrived, rather than one that
     * arrives every five minutes.
     */
    await markReminded(siteId, basket.id)
    result.attempted++

    try {
      const email = await composeReminder(siteId, context, basket, storeName, storeToken, {
        note: settings.basketReminderNote,
      })
      if (!email) {
        result.skipped++
        continue
      }
      const outcome = await sendAs(siteId, email)
      if (outcome.ok) result.sent++
      else result.failed++
    } catch {
      result.failed++
    }
  }

  return result
}

async function composeReminder(
  siteId: number,
  context: Awaited<ReturnType<typeof storefrontContext>>,
  basket: SavedBasket,
  storeName: string,
  storeToken: string,
  opts: { note: string },
): Promise<{ to: string; subject: string; text: string; html: string } | null> {
  if (!context) return null

  // Priced from the catalogue, now — not from what was stored days ago.
  const ids = basket.lines.map((l) => l.productId)
  const live = await publishedProducts(context, { ids, limit: 120 })
  const byId = new Map(live.map((p) => [p.id, p]))

  const items = basket.lines
    .map((line) => ({ line, product: byId.get(line.productId) }))
    .filter((entry): entry is { line: typeof entry.line; product: NonNullable<typeof entry.product> } =>
      Boolean(entry.product),
    )

  // Everything in it has since gone off sale. There is nothing to come back
  // for, and "you left these behind" over an empty list is worse than silence.
  if (items.length === 0) return null

  const total = items.reduce((sum, e) => sum + e.product.priceIncl * e.line.qty, 0)

  const recoverUrl = absoluteUrl(`/store/${storeToken}/basket/${basket.recoveryToken}`)
  const stopUrl = absoluteUrl(`/store/${storeToken}/basket/${basket.recoveryToken}/stop`)
  if (!recoverUrl || !stopUrl) return null

  const firstName = basket.contactName.trim().split(/\s+/)[0] ?? ''
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'

  const lines = items.map(
    (e) => `${e.line.qty} × ${e.product.description} — ${formatMoney(e.product.priceIncl * e.line.qty)}`,
  )

  const note = opts.note.trim()
  const text = [
    greeting,
    '',
    note || `You left some shopping in your basket at ${storeName}.`,
    '',
    ...lines,
    '',
    `Total: ${formatMoney(total)}`,
    '',
    'Pick up where you left off:',
    recoverUrl,
    '',
    `Kind regards,`,
    storeName,
    '',
    `Don't want these emails? ${stopUrl}`,
  ].join('\n')

  const rows = items
    .map(
      (e) => `<tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280">${escapeHtml(String(e.line.qty))} ×</td>
        <td style="padding:6px 0">${escapeHtml(e.product.description)}</td>
        <td style="padding:6px 0 6px 12px;text-align:right">${escapeHtml(
          formatMoney(e.product.priceIncl * e.line.qty),
        )}</td>
      </tr>`,
    )
    .join('')

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#111827">
  <p>${escapeHtml(greeting)}</p>
  <p>${escapeHtml(note || `You left some shopping in your basket at ${storeName}.`)}</p>
  <table style="border-collapse:collapse;margin:16px 0">${rows}</table>
  <p style="font-weight:600">Total: ${escapeHtml(formatMoney(total))}</p>
  <p style="margin:20px 0">
    <a href="${escapeHtml(recoverUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none">Pick up where you left off</a>
  </p>
  <p>Kind regards,<br>${escapeHtml(storeName)}</p>
  <p style="font-size:12px;color:#6b7280;margin-top:24px">
    Don&rsquo;t want these emails? <a href="${escapeHtml(stopUrl)}" style="color:#6b7280">Unsubscribe</a>.
  </p>
</div>`

  return {
    to: basket.contactEmail,
    subject: `You left something behind — ${storeName}`,
    text: htmlToText(html) || text,
    html,
  }
}
