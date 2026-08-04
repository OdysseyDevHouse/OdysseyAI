import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { linkedStores, type GroupMember } from '../storeGroups'
import { shareSettingsFor } from './shareSettings'

/**
 * Writing a product edit out to every linked store.
 *
 * Each store is a separate database, so this is a fan-out of independent
 * writes — NOT one transaction. MySQL cannot span a transaction across
 * connections, and pretending otherwise would be worse than being honest: each
 * store either succeeds or is reported as failed, and the caller shows which.
 *
 * WHAT TRAVELS depends on the product's share settings:
 *   shared cost    -> the edited cost is written to every linked store
 *   shared selling -> the edited selling prices are written to every store
 *   not shared     -> the origin store keeps its own value; others are left
 *                     exactly as they are
 *
 * Product identity across databases is the CODE. Ids increment independently
 * per database and say nothing about each other.
 */

export type FanoutValues = {
  /** Cost excl. tax, as entered for the origin store. */
  lastCost: number
  /** Selling price incl. tax for the origin store, keyed by price_structure id. */
  prices: Record<number, number>
  /** Descriptive fields — always shared: they are what makes it one product. */
  description: string
  barcode: string | null
  extraDescription: string | null
  productType: string
  /**
   * Values typed directly against another store, keyed by that store's site id.
   *
   * Used when a figure is NOT shared: the product screen still shows and edits
   * every linked store's own cost and prices, and those go here. A shared
   * figure ignores this and takes the origin value instead, so a stale entry
   * can never quietly override what sharing is supposed to do.
   */
  perStore?: Record<
    number,
    {
      lastCost?: number
      prices?: Record<number, number>
      /** Reorder levels are never shared — always that store's own. */
      minStock?: number
      maxStock?: number
    }
  >
  /**
   * Tax rates as PERCENTAGES, not ids.
   *
   * vat_rates ids are per-database like price structures, so an id from the
   * origin store means nothing in another. The percentage is the portable
   * fact; each target store is asked for its own row carrying that rate.
   * Undefined leaves the target's existing rate alone.
   */
  purchaseVatPercent?: number
  sellingVatPercent?: number
}

export type FanoutOutcome = {
  siteId: number
  storeName: string
  status: 'written' | 'created' | 'skipped' | 'failed'
  /** Why it was skipped, or what went wrong. */
  detail?: string
}

/**
 * The target store's vat_rates row carrying a given percentage.
 *
 * Matched by rate rather than id or code: the percentage is what actually
 * affects the money, and two stores can easily use different codes for the same
 * 15%. Returns null when the store has no row at that rate, in which case its
 * existing rate is left alone rather than a new one being invented.
 */
async function vatRateIdFor(
  targetSiteId: number,
  vatType: 'purchase' | 'sales',
  percent: number,
): Promise<number | null> {
  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    targetSiteId,
    'SELECT id FROM vat_rates WHERE vat_type = ? AND rate = ? LIMIT 1',
    [vatType, percent.toFixed(3)],
  )
  return row ? Number(row.id) : null
}

/**
 * Price structures are per-database, so a structure id from the origin store is
 * meaningless in another. They are matched by NAME instead, and a structure the
 * target store does not have is skipped rather than invented — creating pricing
 * tiers as a side effect of saving a product would be a surprising thing for
 * this screen to do.
 */
async function mapStructureIds(
  targetSiteId: number,
  originStructures: { id: number; name: string }[],
): Promise<Map<number, number>> {
  const mapped = new Map<number, number>()
  for (const structure of originStructures) {
    const row = await siteQueryOne<RowDataPacket & { id: number }>(
      targetSiteId,
      'SELECT id FROM price_structures WHERE name = ? LIMIT 1',
      [structure.name],
    )
    if (row) mapped.set(structure.id, Number(row.id))
  }
  return mapped
}

/**
 * Applies an edit to one linked store.
 *
 * Creates the product if that store does not have the code yet — a linked store
 * that is missing a shared product is the case that most needs fixing, and
 * silently skipping it would leave the group permanently out of step.
 */
async function applyToStore(
  targetSiteId: number,
  code: string,
  values: FanoutValues,
  shareCost: boolean,
  shareSelling: boolean,
  originStructures: { id: number; name: string }[],
): Promise<Omit<FanoutOutcome, 'siteId' | 'storeName'>> {
  const existing = await siteQueryOne<RowDataPacket & { id: number }>(
    targetSiteId,
    'SELECT id FROM products WHERE code = ? LIMIT 1',
    [code],
  )

  // A shared figure comes from the origin store; an unshared one comes from
  // what was typed against THIS store on the product screen.
  const own = values.perStore?.[targetSiteId]
  const costToWrite = shareCost ? values.lastCost : own?.lastCost
  const pricesToWrite = shareSelling ? values.prices : own?.prices

  // Prices always need mapping when there is something to write — the target
  // store's structure ids differ from the origin's even for its own values.
  const structureMap = pricesToWrite ? await mapStructureIds(targetSiteId, originStructures) : null

  // Tax rates follow whichever figure they belong to: purchase VAT with a
  // shared cost (it is what turns cost excl. into cost incl.), selling VAT with
  // shared prices. An unshared figure leaves the target's own rate untouched.
  const purchaseVatId =
    shareCost && values.purchaseVatPercent !== undefined
      ? await vatRateIdFor(targetSiteId, 'purchase', values.purchaseVatPercent)
      : null
  const sellingVatId =
    shareSelling && values.sellingVatPercent !== undefined
      ? await vatRateIdFor(targetSiteId, 'sales', values.sellingVatPercent)
      : null

  return siteTransaction(targetSiteId, async (tx) => {
    let productId: number

    if (existing) {
      productId = Number(existing.id)

      // Built column by column rather than as fixed variants: cost and each tax
      // rate are independently shared, so a fixed statement would need one
      // variant per combination and would silently overwrite what it omitted.
      const sets = [
        'description = ?',
        'barcode = ?',
        'extra_description = ?',
        'product_type = ?',
      ]
      const params: unknown[] = [
        values.description,
        values.barcode,
        values.extraDescription,
        values.productType,
      ]

      // Undefined only when the figure is unshared AND nothing was typed for
      // this store — then it keeps whatever it already had.
      if (costToWrite !== undefined) {
        sets.push('last_cost = ?')
        params.push(costToWrite.toFixed(4))
      }
      if (purchaseVatId !== null) {
        sets.push('purchase_vat_rate_id = ?')
        params.push(purchaseVatId)
      }
      if (sellingVatId !== null) {
        sets.push('selling_vat_rate_id = ?')
        params.push(sellingVatId)
      }
      // Levels are always that store's own; stock_on_hand is never written from
      // here, since it is a consequence of movements rather than a setting.
      if (own?.minStock !== undefined) {
        sets.push('min_stock = ?')
        params.push(own.minStock.toFixed(3))
      }
      if (own?.maxStock !== undefined) {
        sets.push('max_stock = ?')
        params.push(own.maxStock.toFixed(3))
      }

      sets.push('last_edit_date = NOW()')
      params.push(productId)

      await tx.execute(
        `UPDATE products SET ${sets.join(', ')} WHERE id = ?`,
        params as never,
      )
    } else {
      // A store seeing this product for the first time takes the origin's tax
      // rates even where the figure is unshared — it has no prior rate of its
      // own, and NULL would leave cost incl. and every margin unusable.
      const newPurchaseVat =
        purchaseVatId ??
        (values.purchaseVatPercent !== undefined
          ? await vatRateIdFor(targetSiteId, 'purchase', values.purchaseVatPercent)
          : null)
      const newSellingVat =
        sellingVatId ??
        (values.sellingVatPercent !== undefined
          ? await vatRateIdFor(targetSiteId, 'sales', values.sellingVatPercent)
          : null)

      const [res] = await tx.execute(
        `INSERT INTO products
           (code, barcode, description, extra_description, product_type,
            purchase_vat_rate_id, selling_vat_rate_id,
            last_cost, average_cost, stock_on_hand, min_stock, max_stock,
            is_archived, last_edit_date)
         VALUES (?,?,?,?,?, ?,?, ?,?, 0,0,0, 0, NOW())`,
        [
          code,
          values.barcode,
          values.description,
          values.extraDescription,
          values.productType,
          newPurchaseVat,
          newSellingVat,
          // Needs a starting cost even when cost is unshared; zero would read
          // as free.
          (costToWrite ?? values.lastCost).toFixed(4),
          (costToWrite ?? values.lastCost).toFixed(4),
        ] as never,
      )
      productId = (res as { insertId: number }).insertId
    }

    if (pricesToWrite && structureMap) {
      for (const [originId, price] of Object.entries(pricesToWrite)) {
        const targetStructureId = structureMap.get(Number(originId))
        if (!targetStructureId) continue
        await tx.execute(
          `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
           VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
          [productId, targetStructureId, price.toFixed(4)] as never,
        )
      }
    }

    return { status: existing ? ('written' as const) : ('created' as const) }
  })
}

/**
 * Fans a saved product out to the other stores in its group.
 *
 * Returns one outcome per linked store. Never throws: a store that cannot be
 * reached is reported, not allowed to fail the save that already succeeded in
 * the origin store.
 */
export async function fanoutProduct(
  originSiteId: number,
  code: string,
  values: FanoutValues,
  originStructures: { id: number; name: string }[],
): Promise<FanoutOutcome[]> {
  const stores = await linkedStores(originSiteId)
  const targets = stores.filter((s) => s.siteId !== originSiteId)
  if (targets.length === 0) return []

  const outcomes: FanoutOutcome[] = []

  for (const store of targets) {
    // Read the per-product setting from the TARGET store: that store decides
    // whether it accepts a shared price, which is what lets one branch keep its
    // own pricing while the rest follow the group.
    let shareCost = store.sharesCost
    let shareSelling = store.sharesSelling
    try {
      const settings = await shareSettingsFor(
        store.siteId,
        code,
        store.sharesCost,
        store.sharesSelling,
      )
      shareCost = settings.sharesCost
      shareSelling = settings.sharesSelling
    } catch {
      // No product_share_settings table yet (migration not run for that store).
      // Fall back to the group default rather than refusing to write.
    }

    try {
      const result = await applyToStore(
        store.siteId,
        code,
        values,
        shareCost,
        shareSelling,
        originStructures,
      )
      outcomes.push({ siteId: store.siteId, storeName: store.displayName, ...result })
    } catch (err) {
      outcomes.push({
        siteId: store.siteId,
        storeName: store.displayName,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return outcomes
}

/**
 * Reads the same product from every linked store, for the comparison view.
 *
 * A store that does not have the code yet returns null rather than an error —
 * "not carried here" is ordinary, not a fault.
 */
export type LinkedProductView = {
  store: GroupMember
  found: boolean
  lastCost: number
  prices: { structureName: string; sellIncl: number }[]
  /** Stock is never shared — it is a physical fact about one location. */
  stockOnHand: number
  minStock: number
  maxStock: number
  sharesCost: boolean
  sharesSelling: boolean
}

export async function readLinkedProducts(
  originSiteId: number,
  code: string,
): Promise<LinkedProductView[]> {
  const stores = await linkedStores(originSiteId)
  const views: LinkedProductView[] = []

  for (const store of stores) {
    try {
      const product = await siteQueryOne<
        RowDataPacket & {
          id: number
          last_cost: string
          stock_on_hand: string
          min_stock: string
          max_stock: string
        }
      >(
        store.siteId,
        'SELECT id, last_cost, stock_on_hand, min_stock, max_stock FROM products WHERE code = ? LIMIT 1',
        [code],
      )
      const settings = await shareSettingsFor(
        store.siteId,
        code,
        store.sharesCost,
        store.sharesSelling,
      ).catch(() => ({ sharesCost: store.sharesCost, sharesSelling: store.sharesSelling }))

      if (!product) {
        views.push({
          store,
          found: false,
          lastCost: 0,
          prices: [],
          stockOnHand: 0,
          minStock: 0,
          maxStock: 0,
          sharesCost: settings.sharesCost,
          sharesSelling: settings.sharesSelling,
        })
        continue
      }

      const priceRows = await siteQuery<
        RowDataPacket & { name: string; selling_price_incl: string }
      >(
        store.siteId,
        `SELECT ps.name, pp.selling_price_incl
           FROM product_prices pp
           JOIN price_structures ps ON ps.id = pp.price_structure_id
          WHERE pp.product_id = ?
          ORDER BY ps.position ASC`,
        [product.id],
      )

      views.push({
        store,
        found: true,
        lastCost: Number(product.last_cost),
        prices: priceRows.map((r) => ({
          structureName: String(r.name),
          sellIncl: Number(r.selling_price_incl),
        })),
        stockOnHand: Number(product.stock_on_hand),
        minStock: Number(product.min_stock),
        maxStock: Number(product.max_stock),
        sharesCost: settings.sharesCost,
        sharesSelling: settings.sharesSelling,
      })
    } catch {
      views.push({
        store,
        found: false,
        lastCost: 0,
        prices: [],
        stockOnHand: 0,
        minStock: 0,
        maxStock: 0,
        sharesCost: store.sharesCost,
        sharesSelling: store.sharesSelling,
      })
    }
  }

  return views
}
