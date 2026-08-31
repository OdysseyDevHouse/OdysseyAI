import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { sendAs, isConfiguredFor } from '../mail'
import { absoluteUrl } from '../appUrl'
import { createPublicStoreToken } from '../publicStoreToken'
import { publicSiteName } from '../sites'
import { storefrontContext, publishedProduct } from './storefront'

/**
 * "Email me when it's back" — the backorder v1.
 *
 * A request is one row per address per product (unique key); asking again
 * after being notified re-arms the same row. The sweep follows the basket-
 * reminder rules exactly: every guard is a reason NOT to send, and a row is
 * CLAIMED before the send so a dead mail server means one missed email, not
 * one every five minutes. Whether a product counts as "back" is decided by
 * the storefront's own publish + sellable rules — the same answer the
 * product page gives — never by a second stock expression that could drift.
 */

type Row = RowDataPacket & Record<string, unknown>

const safeEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase()
  if (email.length < 6 || email.length > 190) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export async function requestStockNotification(
  siteId: number,
  productId: number,
  emailRaw: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = safeEmail(emailRaw)
  if (!email) return { ok: false, error: 'Please enter a valid email address.' }
  if (!Number.isInteger(productId) || productId <= 0) {
    return { ok: false, error: 'That product no longer exists.' }
  }

  const exists = await siteQuery<Row>(siteId, 'SELECT id FROM products WHERE id = ? LIMIT 1', [
    productId,
  ])
  if (exists.length === 0) return { ok: false, error: 'That product no longer exists.' }

  await siteExecute(
    siteId,
    `INSERT INTO stock_notifications (product_id, email)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE notified_at = NULL, created_at = NOW()`,
    [productId, email],
  )
  return { ok: true }
}

export type StockNotifyResult = { sent: number; failed: number }

/** The sweep — rides the storefront housekeeping tick. */
export async function sweepStockNotifications(siteId: number): Promise<StockNotifyResult> {
  const empty: StockNotifyResult = { sent: 0, failed: 0 }
  if (!(await isConfiguredFor(siteId))) return empty

  const context = await storefrontContext(siteId)
  if (!context) return empty

  const storeToken = await createPublicStoreToken(siteId).catch(() => null)
  if (!storeToken || !absoluteUrl('/')) return empty

  const pending = await siteQuery<Row>(
    siteId,
    `SELECT sn.id, sn.product_id, sn.email
       FROM stock_notifications sn
      WHERE sn.notified_at IS NULL
      ORDER BY sn.id
      LIMIT 200`,
  )
  if (pending.length === 0) return empty

  const storeName = (await publicSiteName(siteId)) ?? context.storeName
  const result: StockNotifyResult = { sent: 0, failed: 0 }

  // Publish + sellable judged per product by the storefront's own reader, so
  // "back in stock" here means exactly what the product page will show when
  // the shopper clicks through.
  const productCache = new Map<number, Awaited<ReturnType<typeof publishedProduct>>>()
  for (const row of pending) {
    const productId = Number(row.product_id)
    if (!productCache.has(productId)) {
      productCache.set(productId, await publishedProduct(context, productId).catch(() => null))
    }
    const product = productCache.get(productId)
    if (!product || !product.inStock) continue

    // Claimed BEFORE the send — the basketReminder rule.
    const claimed = await siteExecute(
      siteId,
      'UPDATE stock_notifications SET notified_at = NOW() WHERE id = ? AND notified_at IS NULL',
      [Number(row.id)],
    )
    if (claimed.affectedRows !== 1) continue

    const link = absoluteUrl(`/store/${storeToken}/p/${productId}`)
    try {
      const outcome = await sendAs(siteId, {
        to: String(row.email),
        subject: `${product.description} is back in stock`,
        text: `Good news — ${product.description} is back at ${storeName}.\n\n${link}\n\nYou asked to be told; this is the once-off note.`,
        html: `<p>Good news — <strong>${product.description}</strong> is back at ${storeName}.</p><p><a href="${link}">See it in the shop</a></p><p>You asked to be told; this is the once-off note.</p>`,
      })
      if (outcome.ok) result.sent++
      else result.failed++
    } catch {
      result.failed++
    }
  }
  return result
}
