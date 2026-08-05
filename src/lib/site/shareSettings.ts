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

/**
 * Whether a store should carry a product at all.
 *
 * Separate from the sharing flags above, and asked first: sharing decides how
 * much of a product travels, availability decides whether it belongs in the
 * store in the first place. A store can carry a product while keeping its own
 * price for it.
 *
 * With no row recorded, the answer is what is ALREADY TRUE in this store: a
 * product present is available, a product absent is not. That is what keeps
 * adding a store deliberate — saving a product never introduces it to a store
 * that has never had it, which is precisely what the old fan-out did wrong.
 * Stores linked before this existed keep every product they had, because those
 * rows are present.
 */
export async function availabilityFor(siteId: number, productCode: string): Promise<boolean> {
  const row = await siteQueryOne<RowDataPacket & { available: number }>(
    siteId,
    'SELECT available FROM product_share_settings WHERE product_code = ? LIMIT 1',
    [productCode],
  )
  if (row) return Boolean(row.available)

  // No explicit choice — fall back to whether the store actually holds it.
  // Archived counts as not available: it is how a switch-off is recorded.
  const product = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM products WHERE code = ? AND is_archived = 0 LIMIT 1',
    [productCode],
  )
  return Boolean(product)
}

/**
 * Records whether this store carries the product.
 *
 * Unlike the sharing flags, an availability row is never deleted to "return to
 * the default": the default is read from what the store holds, so dropping a
 * row would just re-derive the same answer with no record that anyone chose it.
 * The row is written into the TARGET store's database — each store holds its
 * own answer.
 */
export async function setAvailability(
  siteId: number,
  productCode: string,
  available: boolean,
): Promise<void> {
  await siteExecute(
    siteId,
    `INSERT INTO product_share_settings (product_code, available)
     VALUES (?,?)
     ON DUPLICATE KEY UPDATE available = VALUES(available)`,
    [productCode, available ? 1 : 0],
  )
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
    // Only the sharing flags go back to the default — the row itself may still
    // be carrying `available = 0`, and deleting it would silently re-stock the
    // product in a store the user deliberately switched off. The row is removed
    // only once it holds nothing but defaults.
    await siteExecute(
      siteId,
      `DELETE FROM product_share_settings WHERE product_code = ? AND available = 1`,
      [productCode],
    )
    await siteExecute(
      siteId,
      `UPDATE product_share_settings
          SET shares_cost = ?, shares_selling = ?
        WHERE product_code = ?`,
      [groupDefaultCost ? 1 : 0, groupDefaultSelling ? 1 : 0, productCode],
    )
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
