import 'server-only'
import { send, isConfigured } from '../mail'
import { getSetting, setSetting } from './settings'
import { mainLocationId } from './stockLocations'
import { reorderSuggestions, type ReorderSuggestion } from './reorderSuggestions'

/**
 * The low-stock digest — everything below its minimum at the main location,
 * emailed to whoever does the buying.
 *
 * Every guard is a reason NOT to send (the basketReminder doctrine), and the
 * claim is written BEFORE the send: last_sent stamps first, so a dead mail
 * server means one missed digest, not one every five minutes. A healthy shop
 * with nothing low also stamps — otherwise it re-scans every tick forever.
 */

export type LowStockDigest = {
  lines: ReorderSuggestion[]
  subject: string
  text: string
  html: string
}

/** Render only — what the email would say. Null when nothing is below min. */
export async function buildLowStockDigest(siteId: number): Promise<LowStockDigest | null> {
  const locationId = await mainLocationId(siteId)
  // The engine caps rows at its LIMIT — ask for the maximum so a big shop's
  // digest carries every shortage, not the first pageful. A shortage that
  // exists but is not in the email defeats the point of sending one.
  const lines = await reorderSuggestions(siteId, {
    locationId,
    basis: 'below_minimum',
    limit: 2000,
  })
  if (lines.length === 0) return null

  const subject = `Low stock: ${lines.length} product${lines.length === 1 ? '' : 's'} below minimum`
  const rows = lines
    .map(
      (l) =>
        `${l.code.padEnd(14)} ${l.description.slice(0, 40).padEnd(42)} on hand ${String(l.stockOnHand).padStart(6)}  min ${String(l.minStock).padStart(6)}  on order ${String(l.onOrder).padStart(6)}  suggest ${String(l.suggested).padStart(6)}`,
    )
    .join('\n')
  const htmlRows = lines
    .map(
      (l) =>
        `<tr><td>${l.code}</td><td>${l.description}</td><td align="right">${l.stockOnHand}</td><td align="right">${l.minStock}</td><td align="right">${l.onOrder}</td><td align="right"><strong>${l.suggested}</strong></td></tr>`,
    )
    .join('')

  return {
    lines,
    subject,
    text: `These products are below their minimum at the main location.\n\n${rows}\n\nOpen Purchasing → Reorder suggestions to raise the orders.`,
    html: `<p>These products are below their minimum at the main location.</p><table cellpadding="4" border="1" style="border-collapse:collapse"><tr><th>Code</th><th>Product</th><th>On hand</th><th>Min</th><th>On order</th><th>Suggest</th></tr>${htmlRows}</table><p>Open Purchasing → Reorder suggestions to raise the orders.</p>`,
  }
}

export type LowStockTickResult = {
  sent: boolean
  lines: number
  skipped: 'off' | 'not_due' | 'nothing_low' | 'mail_unconfigured' | null
  error?: string
}

export async function sendLowStockDigest(siteId: number): Promise<LowStockTickResult> {
  const email = (await getSetting(siteId, 'low_stock_alert_email'))?.trim() ?? ''
  if (!email) return { sent: false, lines: 0, skipped: 'off' }

  const hours = Number(await getSetting(siteId, 'low_stock_alert_hours')) || 24
  const lastSent = (await getSetting(siteId, 'low_stock_alert_last_sent')) ?? ''
  if (lastSent) {
    const elapsed = Date.now() - Date.parse(lastSent)
    if (Number.isFinite(elapsed) && elapsed < hours * 3_600_000) {
      return { sent: false, lines: 0, skipped: 'not_due' }
    }
  }

  if (!isConfigured()) return { sent: false, lines: 0, skipped: 'mail_unconfigured' }

  const digest = await buildLowStockDigest(siteId)

  // The CLAIM — stamped before any send, and stamped even when there is
  // nothing to say, so the next scan waits its full interval either way.
  await setSetting(siteId, 'low_stock_alert_last_sent', new Date().toISOString())

  if (!digest) return { sent: false, lines: 0, skipped: 'nothing_low' }

  // The bell, beside the email — cadence already governed by the last_sent
  // claim above, so this can never fire more often than the digest itself.
  // Honest limitation: a shop with no digest email set (or no SMTP) returns
  // before this line and gets no in-app alert either; decoupling that needs a
  // second claim stamp, deliberately not taken on here.
  const { notify } = await import('./notifications')
  await notify(siteId, {
    event: 'low_stock',
    audience: 'purchasing.view',
    title: digest.subject,
    body: 'Open Purchasing and raise the suggested orders.',
    href: '/purchasing/suggest',
  })

  // The outbound mirror, riding the SAME claim — so it fires at the digest
  // cadence and can never spam an endpoint per-sale. Capped payload; the full
  // picture is /api/v1/products?updatedSince= away.
  const { enqueueEvent } = await import('./webhooks')
  await enqueueEvent(siteId, 'stock.low', {
    count: digest.lines.length,
    products: digest.lines.slice(0, 100).map((l) => ({
      productId: l.productId,
      code: l.code,
      stockOnHand: l.stockOnHand,
      minStock: l.minStock,
      onOrder: l.onOrder,
      suggested: l.suggested,
    })),
  })

  try {
    const outcome = await send({ to: email, subject: digest.subject, text: digest.text, html: digest.html })
    if (!outcome.ok) {
      return { sent: false, lines: digest.lines.length, skipped: null, error: outcome.error }
    }
    return { sent: true, lines: digest.lines.length, skipped: null }
  } catch (error) {
    return {
      sent: false,
      lines: digest.lines.length,
      skipped: null,
      error: error instanceof Error ? error.message : 'send failed',
    }
  }
}
