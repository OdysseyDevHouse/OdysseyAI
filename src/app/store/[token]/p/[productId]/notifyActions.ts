'use server'

import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { requestStockNotification } from '@/lib/site/stockNotifications'

export async function notifyMeAction(
  token: string,
  productId: number,
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }
  return requestStockNotification(siteId, Number(productId), email)
}
