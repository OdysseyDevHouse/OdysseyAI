import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { linkedStores, type GroupMember } from '../storeGroups'
import { shareSettingsFor, availabilityFor, setAvailability } from './shareSettings'

/**
 * Writing a product edit out to every linked store.
 *
 * Each store is a separate database, so this is a fan-out of independent
 * writes — NOT one transaction. MySQL cannot span a transaction across
 * connections, and pretending otherwise would be worse than being honest: each
 * store either succeeds or is reported as failed, and the caller shows which.
 *
 * WHETHER A STORE IS WRITTEN TO AT ALL is asked first, from that store's
 * availability flag. Product sharing being on does not mean every store carries
 * every product — it means they CAN. A store switched off for this product is
 * archived rather than written, and one that never had it is left alone.
 *
 * WHAT TRAVELS to an available store depends on the product's share settings:
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
   * Properties-tab settings. Shared for the same reason the description is:
   * they describe what the product IS and how it behaves, so a scale item in
   * one store must be a scale item in the next. Column name -> value, built by
   * the caller so this module does not need to know the list.
   */
  properties?: Record<string, unknown>
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
  /**
   * The department, by NAME rather than id.
   *
   * Departments are per-database like everything else: on the dev data,
   * department 9 is "Cooldrinks" in one store and does not exist in the other,
   * whose 11-16 are entirely different departments. Sending the id would file
   * the product under whatever happened to share that number.
   *
   * Undefined leaves the target's own department alone. A target with no
   * department of that name is REPORTED rather than having one invented —
   * creating departments as a side effect of saving a product is not something
   * this screen should do.
   */
  departmentName?: string | null
}

export type FanoutOutcome = {
  siteId: number
  storeName: string
  status: 'written' | 'created' | 'archived' | 'skipped' | 'failed'
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
/**
 * The target store's department carrying a given name.
 *
 * By name for the same reason price structures are: an id from the origin store
 * names a different department, or nothing at all, in another database.
 *
 * Returns undefined when the caller sent no name (leave it alone) and null when
 * a name was sent but the store has no such department (report it).
 */
async function departmentIdFor(
  targetSiteId: number,
  name: string | null | undefined,
): Promise<number | null | undefined> {
  if (name === undefined) return undefined
  if (name === null || name.trim() === '') return undefined

  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    targetSiteId,
    'SELECT id FROM departments WHERE name = ? LIMIT 1',
    [name.trim()],
  )
  return row ? Number(row.id) : null
}

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
 * `available` decides which of four things happens:
 *   available, exists      -> updated in place
 *   available, missing     -> created
 *   unavailable, exists    -> archived, keeping its stock and history
 *   unavailable, missing   -> nothing at all
 *
 * Archiving rather than deleting is what makes the toggle safe to flip back:
 * the store keeps its own stock figures, prices and sales history, so switching
 * a product on again restores what was there instead of starting from zero.
 */
async function applyToStore(
  targetSiteId: number,
  /** The store whose catalogue this product belongs to — stamped on the copy. */
  originSiteId: number,
  code: string,
  values: FanoutValues,
  shareCost: boolean,
  shareSelling: boolean,
  available: boolean,
  originStructures: { id: number; name: string }[],
): Promise<Omit<FanoutOutcome, 'siteId' | 'storeName'>> {
  const existing = await siteQueryOne<RowDataPacket & { id: number }>(
    targetSiteId,
    'SELECT id FROM products WHERE code = ? LIMIT 1',
    [code],
  )

  if (!available) {
    // Nothing to archive, and nothing to create — this store simply does not
    // carry the product.
    if (!existing) return { status: 'skipped', detail: 'Not carried in this store' }

    await siteExecute(
      targetSiteId,
      'UPDATE products SET is_archived = 1, last_edit_date = NOW() WHERE id = ?',
      [Number(existing.id)],
    )
    return { status: 'archived', detail: 'Stock and history kept' }
  }

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

  // Resolved whatever the price sharing says: which department a product sits
  // in describes what it IS, like its description — not what it costs.
  const departmentId = await departmentIdFor(targetSiteId, values.departmentName)

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
        // Switching availability back on un-archives: the store already has the
        // row with its own stock and prices, and writing to it while leaving it
        // archived would update a product nobody can see.
        'is_archived = 0',
      ]
      const params: unknown[] = [
        values.description,
        values.barcode,
        values.extraDescription,
        values.productType,
      ]

      // Properties travel with the description — same product, same behaviour.
      for (const [column, value] of Object.entries(values.properties ?? {})) {
        sets.push(`${column} = ?`)
        params.push(value)
      }

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
      // Resolved by name above. Undefined = nothing sent, null = sent but this
      // store has no such department; both leave the existing value alone, and
      // the second is reported.
      if (departmentId !== undefined && departmentId !== null) {
        sets.push('department_id = ?')
        params.push(departmentId)
      }
      /* Reorder levels are NOT fanned out. They belong to a (product,
         location) pair in the receiving store's own product_location_stock,
         and this fan-out knows nothing about that store's rooms — it matches
         products by code across databases, not locations. A store sets its own
         levels on its own product screen. */

      /* The origin is (re)stamped on every fan-out, not only on creation.
         A copy that arrived before this column existed carries NULL, which
         reads as "this store's own" and would leave a branch able to edit head
         office's product. Writing it here heals those on the next edit, and is
         a no-op once correct. */
      sets.push('origin_site_id = ?')
      params.push(originSiteId)

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

      // Properties are appended as named columns so a store creating the
      // product for the first time gets the same behaviour as the origin,
      // rather than falling back to the schema defaults.
      const propertyEntries = Object.entries(values.properties ?? {})
      const propertyColumns = propertyEntries.length
        ? `, ${propertyEntries.map(([c]) => c).join(', ')}`
        : ''
      const propertyPlaceholders = propertyEntries.length
        ? `, ${propertyEntries.map(() => '?').join(', ')}`
        : ''

      const [res] = await tx.execute(
        `INSERT INTO products
           (code, barcode, description, extra_description, product_type,
            purchase_vat_rate_id, selling_vat_rate_id,
            last_cost, average_cost, stock_on_hand,
            is_archived, origin_site_id, department_id${propertyColumns}, last_edit_date)
         VALUES (?,?,?,?,?, ?,?, ?,?, 0, 0, ?, ?${propertyPlaceholders}, NOW())`,
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
          // WHOSE catalogue this belongs to. Stamped only on the copy arriving
          // in another store — the origin's own row keeps NULL, which reads as
          // "mine" and survives the group being dissolved.
          originSiteId,
          // Null when this store has no department of that name: the product is
          // still created, unfiled, and the outcome says why.
          departmentId ?? null,
          ...propertyEntries.map(([, value]) => value),
        ] as never,
      )
      productId = (res as { insertId: number }).insertId
    }

    if (pricesToWrite && structureMap) {
      const rows = Object.entries(pricesToWrite)
        .map(([originId, price]) => ({
          productId,
          priceStructureId: structureMap.get(Number(originId)) ?? 0,
          priceIncl: price,
        }))
        .filter((r) => r.priceStructureId > 0)
      if (rows.length > 0) {
        // Through the one definition of a price write (144): the receiving
        // site's history says the shelf moved because a linked store said so.
        const { writePriceRows } = await import('./reprice')
        await writePriceRows(tx, rows, { source: 'fanout', userName: 'Linked store' })
      }
    }

    /*
     * ── WHAT COULD NOT BE TRANSLATED ────────────────────────────────────────
     *
     * Price structures are matched by NAME and VAT rates by RATE, because ids
     * are per-database and mean nothing across stores. A target that has no
     * matching row is skipped rather than having one invented — which is
     * right, but was until now SILENT.
     *
     * Silent is the problem. A store missing a "Wholesale" tier kept its old
     * wholesale price while the screen reported the save as written, so the
     * figure on the shelf and the figure on the screen disagreed and nothing
     * said why. Reported here so the caller can show it.
     */
    const untranslated: string[] = []
    if (structureMap) {
      const missing = originStructures.filter((s) => !structureMap.has(s.id))
      if (missing.length > 0) {
        untranslated.push(
          `no ${missing.map((s) => s.name).join(', ')} price tier here`,
        )
      }
    }
    if (shareCost && values.purchaseVatPercent !== undefined && purchaseVatId === null) {
      untranslated.push(`no ${values.purchaseVatPercent}% purchase tax rate here`)
    }
    if (shareSelling && values.sellingVatPercent !== undefined && sellingVatId === null) {
      untranslated.push(`no ${values.sellingVatPercent}% selling tax rate here`)
    }
    if (departmentId === null && values.departmentName) {
      untranslated.push(`no "${values.departmentName}" department here`)
    }

    return {
      status: existing ? ('written' as const) : ('created' as const),
      ...(untranslated.length > 0
        ? { detail: `${untranslated.join('; ')} — that part was left as it was` }
        : {}),
    }
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
  /**
   * Availability chosen on the product screen, keyed by site id. A store absent
   * from this map keeps whatever it already had, so a caller that does not show
   * the toggles cannot accidentally un-stock anything.
   */
  availability: Record<number, boolean> = {},
): Promise<FanoutOutcome[]> {
  /*
   * ── A PRODUCT ONLY TRAVELS FROM ITS OWNER ────────────────────────────────
   *
   * Until this check existed, any store could be the origin: a branch editing
   * head office's can of Coke pushed that edit back up to head office and
   * across to every sibling. The rule "head office owns the range" was
   * enforced nowhere.
   *
   * Refused here rather than only in the save action, because this is the
   * function that does the travelling. A future caller that forgets the action
   * guard still cannot fan somebody else's product out.
   *
   * Silent by design — an empty result, not a throw. The save into this store's
   * OWN database already succeeded and must stand; a branch that edits its own
   * copy of a head-office product simply keeps that edit to itself.
   */
  const { ownershipOf } = await import('./productOwnership')
  const ownership = await ownershipOf(originSiteId, code)
  if (!ownership.canEdit) return []

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

    // What the user chose on this save, falling back to what the store already
    // recorded. Persisted before the write so a store that turns out to be
    // unreachable still remembers the decision and applies it on the next save.
    let available = availability[store.siteId]
    try {
      if (available === undefined) available = await availabilityFor(store.siteId, code)
      else await setAvailability(store.siteId, code, available)
    } catch {
      // Migration 005 not run for that store yet. Fall back to whether the
      // store already holds the product rather than to `true`: a missing
      // migration must not quietly restore the old behaviour of creating the
      // product everywhere.
      if (available === undefined) {
        available = await siteQueryOne<RowDataPacket & { id: number }>(
          store.siteId,
          'SELECT id FROM products WHERE code = ? AND is_archived = 0 LIMIT 1',
          [code],
        )
          .then(Boolean)
          .catch(() => false)
      }
    }

    try {
      const result = await applyToStore(
        store.siteId,
        originSiteId,
        code,
        values,
        shareCost,
        shareSelling,
        available,
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
  /**
   * Whether this store is set to carry the product. Distinct from `found`: an
   * archived product is still present in the database, so the switch state has
   * to be read rather than inferred from the row existing.
   */
  available: boolean
  /** True when the row exists but is archived — i.e. it was switched off here. */
  archived: boolean
  lastCost: number
  prices: { structureName: string; sellIncl: number }[]
  /** Stock is never shared — it is a physical fact about one location. */
  stockOnHand: number
  /**
   * That store's own stock rooms and what each holds.
   *
   * Read from the store's own database, because locations are per-site: store
   * 2's warehouse is a row in store 2's stock_locations, unrelated to any id
   * here. The codes may even collide — two stores can both call a room MAIN —
   * so these are only ever displayed grouped under their store, never merged
   * into one list.
   */
  locations: { locationId: number; code: string; name: string; isMain: boolean; stockOnHand: number; minStock: number; maxStock: number }[]
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
          is_archived: number
        }
      >(
        store.siteId,
        'SELECT id, last_cost, stock_on_hand, is_archived FROM products WHERE code = ? LIMIT 1',
        [code],
      )
      const settings = await shareSettingsFor(
        store.siteId,
        code,
        store.sharesCost,
        store.sharesSelling,
      ).catch(() => ({ sharesCost: store.sharesCost, sharesSelling: store.sharesSelling }))
      // On failure fall back to what the store holds — never to a bare `true`,
      // which would render the switch on for a store that has never had it.
      const available = await availabilityFor(store.siteId, code).catch(
        () => Boolean(product) && !product?.is_archived,
      )

      if (!product) {
        views.push({
          store,
          found: false,
          available,
          archived: false,
          lastCost: 0,
          prices: [],
          stockOnHand: 0,
          locations: [],
          sharesCost: settings.sharesCost,
          sharesSelling: settings.sharesSelling,
        })
        continue
      }

      /*
       * That store's rooms, from ITS database.
       *
       * LEFT JOIN so a room holding none of this product still appears with a
       * zero — "the warehouse has none" is an answer, and a missing row would
       * read as though the room did not exist. Inactive rooms are included
       * only when they still hold something, matching locationStockFor here.
       *
       * Tolerates failure: a linked store that has not run the locations
       * migration yet has no such table, and that must not take out the whole
       * product page.
       */
      const locationRows = await siteQuery<
        RowDataPacket & Record<string, unknown>
      >(
        store.siteId,
        `SELECT l.id, l.code, l.name, l.is_main,
                COALESCE(pls.stock_on_hand, 0) AS stock_on_hand,
                COALESCE(pls.min_stock, 0)     AS min_stock,
                COALESCE(pls.max_stock, 0)     AS max_stock
           FROM stock_locations l
           LEFT JOIN product_location_stock pls
                  ON pls.location_id = l.id AND pls.product_id = ?
          WHERE l.is_active = 1 OR COALESCE(pls.stock_on_hand, 0) <> 0
          ORDER BY l.is_main DESC, l.sort_order ASC, l.code ASC`,
        [product.id],
      ).catch(() => [])

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
        available,
        archived: Boolean(product.is_archived),
        lastCost: Number(product.last_cost),
        prices: priceRows.map((r) => ({
          structureName: String(r.name),
          sellIncl: Number(r.selling_price_incl),
        })),
        stockOnHand: Number(product.stock_on_hand),
        locations: locationRows.map((r) => ({
          locationId: Number(r.id),
          code: String(r.code),
          name: String(r.name),
          isMain: Boolean(r.is_main),
          stockOnHand: Number(r.stock_on_hand),
          minStock: Number(r.min_stock),
          maxStock: Number(r.max_stock),
        })),
        sharesCost: settings.sharesCost,
        sharesSelling: settings.sharesSelling,
      })
    } catch {
      // The store could not be read at all. It is not known to carry the
      // product, so the switch renders off rather than inviting a save that
      // would create it there.
      views.push({
        store,
        found: false,
        available: false,
        archived: false,
        lastCost: 0,
        prices: [],
        stockOnHand: 0,
        locations: [],
        sharesCost: store.sharesCost,
        sharesSelling: store.sharesSelling,
      })
    }
  }

  return views
}

/**
 * Carries a stock-code rename across the store group.
 *
 * fanoutProduct() cannot express this. Every step of it — the share settings,
 * the availability lookup, applyToStore() itself — MATCHES the target row by
 * code, which is the one thing a rename changes. Pointing it at the new code
 * would find nothing in a sibling store and create a second product there,
 * leaving the original stranded under the old code: one product becomes two,
 * silently, in every branch.
 *
 * So this matches on the OLD code and moves the row, plus the two code-keyed
 * side tables that live in each store's own database (share settings and
 * availability, both keyed by product_code per 004 and 005).
 *
 * Only the owner may rename, enforced by the caller the same way fanoutProduct
 * enforces it — and re-checked here, because this function does the travelling.
 *
 * Every store is attempted even if one fails: a branch that is down must not
 * strand the rename in the stores that are reachable. The outcomes are
 * returned so the screen can say which stores did not follow.
 */
export async function fanoutCodeRename(
  originSiteId: number,
  fromCode: string,
  toCode: string,
): Promise<FanoutOutcome[]> {
  const { ownershipOf } = await import('./productOwnership')
  const ownership = await ownershipOf(originSiteId, toCode)
  if (!ownership.canEdit) return []

  const stores = await linkedStores(originSiteId)
  const targets = stores.filter((s) => s.siteId !== originSiteId)
  if (targets.length === 0) return []

  const outcomes: FanoutOutcome[] = []

  for (const store of targets) {
    try {
      const existing = await siteQueryOne<RowDataPacket & { id: number }>(
        store.siteId,
        'SELECT id FROM products WHERE code = ? LIMIT 1',
        [fromCode],
      )
      if (!existing) {
        outcomes.push({
          siteId: store.siteId,
          storeName: store.displayName,
          status: 'skipped',
          detail: 'Does not stock this product.',
        })
        continue
      }

      // A store that already has something at the new code cannot take the
      // rename — its own unique key would refuse it. Report rather than throw:
      // the other stores must still get their rename.
      const clash = await siteQueryOne<RowDataPacket & { id: number }>(
        store.siteId,
        'SELECT id FROM products WHERE code = ? AND id <> ? LIMIT 1',
        [toCode, existing.id],
      )
      if (clash) {
        outcomes.push({
          siteId: store.siteId,
          storeName: store.displayName,
          status: 'failed',
          detail: `Already has a different product coded ${toCode}.`,
        })
        continue
      }

      await siteTransaction(store.siteId, async (tx) => {
        await tx.execute('UPDATE products SET code = ? WHERE id = ?', [
          toCode,
          existing.id,
        ] as never)

        /* The one code-keyed side table in this store's own database. It
           carries BOTH the sharing flags and this store's availability — 005
           added `available` as a column here rather than as a table of its
           own — so moving this row moves both. Best effort: a store that has
           not run 004 has no row to move. */
        try {
          await tx.execute(
            'UPDATE product_share_settings SET product_code = ? WHERE product_code = ?',
            [toCode, fromCode] as never,
          )
        } catch (err) {
          if ((err as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw err
        }
      })

      outcomes.push({ siteId: store.siteId, storeName: store.displayName, status: 'written' })
    } catch (err) {
      outcomes.push({
        siteId: store.siteId,
        storeName: store.displayName,
        status: 'failed',
        detail: err instanceof Error ? err.message : 'Unknown error.',
      })
    }
  }

  return outcomes
}
