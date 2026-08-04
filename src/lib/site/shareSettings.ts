import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteExecute } from '../siteDb'

/**
 * Whether one product's cost and selling price are shared across linked stores.
 *
 * Keyed by product CODE, not id: each store has its own database with its own
 * auto-increment, so only the code identifies "the same product" across them.
 *
 * A product with no row follows the group default from cp2_store_group_members.
 * Only a deliberate per-product choice writes one, so this table stays small
 * and "no row" reads as "nothing special about this product".
 */

export type ShareSettings = {
  sharesCost: boolean
  sharesSelling: boolean
}

type ShareRow = RowDataPacket & {
  shares_cost: number
  shares_selling: number
}

/**
 * The effective setting for a product, falling back to the group default.
 *
 * Both arguments come from the group membership row; passing them in rather
 * than looking them up keeps this function usable inside a fan-out loop that
 * already knows them.
 */
export async function shareSettingsFor(
  siteId: number,
  productCode: string,
  groupDefaultCost: boolean,
  groupDefaultSelling: boolean,
): Promise<ShareSettings> {
  const row = await siteQueryOne<ShareRow>(
    siteId,
    'SELECT shares_cost, shares_selling FROM product_share_settings WHERE product_code = ? LIMIT 1',
    [productCode],
  )
  if (!row) return { sharesCost: groupDefaultCost, sharesSelling: groupDefaultSelling }
  return { sharesCost: Boolean(row.shares_cost), sharesSelling: Boolean(row.shares_selling) }
}

/**
 * Records a per-product choice, or clears it when it matches the group default.
 *
 * Deleting a row that matches the default matters: leaving it behind would pin
 * the product to today's default and silently ignore a later change to the
 * group setting, which is the opposite of what "follows the default" means.
 */
export async function setShareSettings(
  siteId: number,
  productCode: string,
  settings: ShareSettings,
  groupDefaultCost: boolean,
  groupDefaultSelling: boolean,
): Promise<void> {
  const matchesDefault =
    settings.sharesCost === groupDefaultCost && settings.sharesSelling === groupDefaultSelling

  if (matchesDefault) {
    await siteExecute(siteId, 'DELETE FROM product_share_settings WHERE product_code = ?', [
      productCode,
    ])
    return
  }

  await siteExecute(
    siteId,
    `INSERT INTO product_share_settings (product_code, shares_cost, shares_selling)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE shares_cost = VALUES(shares_cost),
                             shares_selling = VALUES(shares_selling)`,
    [productCode, settings.sharesCost ? 1 : 0, settings.sharesSelling ? 1 : 0],
  )
}
