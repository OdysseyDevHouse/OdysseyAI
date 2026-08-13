import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { toNum, round } from '../decimals'
import { getSettings } from './settings'
import { duePricesFor } from './priceSchedules'
import { parseVariableBarcode } from '../barcodes'
import type { ProductTypeId } from '../productTypes'
import { toVariableType, type VariableTypeId } from '../productProperties'

/**
 * Finding a product at the till.
 *
 * Separate from listProducts because the till asks a different question: not
 * "show me the product file" but "what did this scan or these three characters
 * mean, right now, at the price this customer pays". It returns only what a
 * line needs, which keeps the query narrow enough to run on every keystroke.
 */

export type TillProduct = {
  id: number
  code: string
  barcode: string | null
  /**
   * Additional barcodes this product answers to (143). Empty for most. The
   * offline till indexes these so an alias scans with the server gone.
   */
  barcodes: string[]
  description: string
  productType: ProductTypeId
  departmentId: number | null
  /** VAT-inclusive, from the chosen price structure. The figure on the shelf. */
  priceIncl: number
  vatRatePct: number
  costExcl: number
  stockOnHand: number
  /** Committed to open sales orders. Derived — no stock has moved for it. */
  reservedQty: number
  /**
   * What can still be sold to the person at the counter: on hand less
   * reserved. Goes negative when the shop is already over-committed, which is
   * exactly the case worth showing rather than hiding behind a zero.
   */
  availableQty: number
  askPriceAtSale: boolean
  allowFractions: boolean
  /**
   * Sold by weight. A scan of a scale barcode arrives with the weight embedded
   * (scannedQty); any other way of adding it must PROMPT for one — the promise
   * the product-properties switch has made since 006.
   */
  scaleItem: boolean
  /**
   * What a variable barcode embeds for THIS product: a weight or money. This
   * is where "the caller decides" actually happens — resolveScan reads it and
   * sets scannedQty OR scannedPrice, never both (both at once multiplied:
   * qty × unit price = value², a silent overcharge squared).
   */
  variableType: VariableTypeId
  maxDiscountPct: number
  /**
   * The swatch a manager chose for this product, as a `tile-*` token — null when
   * none was picked, which is nearly always.
   *
   * Null rather than a default so the till can tell "chosen" from "never set" and
   * fall back to the department's colour. Handing back a swatch nobody picked would
   * make the fallback impossible to distinguish from a real choice.
   */
  imageColor: string | null
  /** Quantity parsed out of a weighed-goods barcode, if the scan carried one. */
  scannedQty?: number
  /** Price parsed out of a value-embedded barcode, if the scan carried one. */
  scannedPrice?: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapProduct(r: Row): TillProduct {
  const stockOnHand = toNum(r.stock_on_hand)
  const reservedQty = toNum(r.reserved_qty)

  return {
    id: Number(r.id),
    code: String(r.code),
    barcode: (r.barcode as string | null) ?? null,
    barcodes: r.extra_barcodes ? String(r.extra_barcodes).split('\n').filter(Boolean) : [],
    description: String(r.description),
    productType: String(r.product_type) as ProductTypeId,
    departmentId: r.department_id === null ? null : Number(r.department_id),
    priceIncl: toNum(r.price_incl),
    vatRatePct: toNum(r.vat_rate),
    costExcl: toNum(r.cost_excl),
    stockOnHand,
    reservedQty,
    availableQty: round(stockOnHand - reservedQty, 3),
    askPriceAtSale: !!r.ask_price_at_sale,
    allowFractions: !!r.allow_fractions,
    scaleItem: !!r.scale_item,
    variableType: toVariableType(r.variable_type),
    maxDiscountPct: toNum(r.max_discount_pct),
    /* Empty string normalised to null: a cleared colour picker writes '' rather than
       NULL, and the two mean the same thing to everything downstream. */
    imageColor: (r.image_color as string | null) || null,
  }
}

/**
 * The till's product query.
 *
 * `cost_excl` follows the site's cost basis so the GP report reflects what the
 * store actually values stock at, rather than always the last invoice.
 */
function selectProduct(costBasis: string): string {
  return `
    SELECT p.id, p.code, p.barcode, p.description, p.product_type, p.department_id,
           p.ask_price_at_sale, p.allow_fractions, p.scale_item, p.variable_type,
           p.max_discount_pct, p.image_color,
           -- The alias barcodes (143). A correlated subquery, NOT a join — a
           -- join would multiply the row per alias and break every other figure.
           (SELECT GROUP_CONCAT(pb.barcode SEPARATOR '\n')
              FROM product_barcodes pb WHERE pb.product_id = p.id) AS extra_barcodes,
           -- Stock the counter can actually hand over: the MAIN pile, not the
           -- site total. Goods in a back warehouse are owned but not sellable
           -- here until someone carries them across, and a till that offered
           -- them would promise what it cannot give.
           COALESCE((
             SELECT pls.stock_on_hand
               FROM product_location_stock pls
               JOIN stock_locations sl ON sl.id = pls.location_id AND sl.is_main = 1
              WHERE pls.product_id = p.id
              LIMIT 1
           ), 0)                                                      AS stock_on_hand,
           COALESCE(pp.selling_price_incl, 0)                         AS price_incl,
           COALESCE(v.rate, 0)                                        AS vat_rate,
           ${costBasis === 'last' ? 'p.last_cost' : 'p.average_cost'} AS cost_excl,
           -- Spoken for: open sales orders PLUS open lay-bys. Correlated
           -- subqueries rather than JOINs — joining the line tables would
           -- multiply the product row once per line and quietly break every
           -- other figure here.
           COALESCE((
             SELECT SUM(ol.qty - ol.qty_delivered)
               FROM sales_document_lines ol
               JOIN sales_documents od     ON od.id = ol.document_id
               JOIN sales_order_details oo ON oo.document_id = od.id
              WHERE ol.product_id = p.id
                AND od.doc_type = 'sales_order'
                AND od.status IN ('draft','saved','issued')
                AND oo.fulfilment_status IN ('open','part_delivered')
                AND oo.reserves_stock = 1
           ), 0)
           + COALESCE((
             SELECT SUM(ll.qty)
               FROM layby_lines ll
               JOIN laybys lb ON lb.id = ll.layby_id
              WHERE ll.product_id = p.id AND lb.status = 'open'
           ), 0)                                                      AS reserved_qty
      FROM products p
      LEFT JOIN product_prices pp
             ON pp.product_id = p.id AND pp.price_structure_id = ?
      LEFT JOIN vat_rates v ON v.id = p.selling_vat_rate_id
  `
}

/**
 * Type-ahead search, for the Combobox.
 *
 * Barcode matches EXACTLY rather than by LIKE: a scanner sends the whole code,
 * and a wildcard on it would turn every scan into a full table scan. Code and
 * description are the ones a person types, so those stay fuzzy.
 */
export async function searchForTill(
  siteId: number,
  term: string,
  priceStructureId: number | null,
  limit = 20,
): Promise<TillProduct[]> {
  const needle = term.trim()
  if (needle.length < 2) return []

  const { cost_basis: costBasis } = await getSettings(siteId, ['cost_basis'])
  const like = `%${needle}%`
  const capped = Math.min(Math.max(limit, 1), 50)

  const rows = await siteQuery<Row>(
    siteId,
    `${selectProduct(costBasis)}
      WHERE p.is_archived = 0
        AND p.visible_in_pos = 1
        -- A variant parent holds no stock and recordMovement refuses it, so it
        -- must never reach a till line. Its variants are ordinary products and
        -- appear here normally. Not folded into visible_in_pos: that flag is
        -- the shopkeeper's to toggle, and switching it on must not be able to
        -- make an unsellable row sellable.
        AND p.has_variants = 0
        AND (p.barcode = ? OR p.code LIKE ? OR p.description LIKE ?
             OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id))
      ORDER BY
        -- An exact barcode, alias or code match is what was meant; put it first.
        CASE WHEN p.barcode = ? OR p.code = ?
               OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id)
             THEN 0 ELSE 1 END,
        p.description ASC
      LIMIT ${capped}`,
    [priceStructureId ?? 0, needle, like, like, needle, needle, needle, needle],
  )

  return rows.map(mapProduct)
}

/**
 * Products for a tile grid, or for the offline catalog.
 *
 * The BROWSE counterpart to `searchForTill`: no search term, an optional
 * department, and a much higher ceiling. Shares `selectProduct` with every other
 * function here, which is the whole point — pricing, main-pile stock and the
 * reserved-quantity arithmetic have exactly one definition, so a tile, a scan and
 * the offline catalog can never disagree about what something costs or whether it
 * is on the shelf.
 *
 * ── THE DEPARTMENT ARGUMENT EXPANDS THE SUBTREE ───────────────────────────
 *
 * Drilling into "Groceries" must show everything beneath it, not only what is filed
 * directly there — a shop files products at the leaves and browses from the top. The
 * expansion happens HERE rather than in the caller so that "what is in this
 * department" has one answer; a client-side version of it would be a second one, and
 * the two would drift.
 *
 * ── THE LIMIT IS A BACKSTOP, NOT A PAGE SIZE ──────────────────────────────
 *
 * The offline catalog asks for 50,000. Measured on a real seeded store: 40,083
 * products in 209ms, 0.92 MB gzipped. The cap exists so a runaway query cannot pin
 * the database, not to shape a response.
 */
export async function browseForTill(
  siteId: number,
  options: {
    /**
     * Narrows by code, barcode or description, as searchForTill does. Optional
     * because the offline catalog wants everything — but the invoice picker
     * needs one query that both browses and searches, or a term typed while a
     * department is chosen would have to abandon the department to run.
     */
    term?: string
    departmentId?: number | null
    priceStructureId?: number | null
    limit?: number
  } = {},
): Promise<TillProduct[]> {
  const { cost_basis: costBasis } = await getSettings(siteId, ['cost_basis'])
  // 50,000 rather than searchForTill's 50: this is the offline catalog's ceiling,
  // and it is deliberately generous. A store past it cannot trade fully offline and
  // the till says so rather than silently selling from a truncated product file.
  const capped = Math.min(Math.max(options.limit ?? 200, 1), 50_000)

  /* The subtree, resolved with a recursive CTE.
     MariaDB 12.3 supports these, and the alternative — fetching every department
     and walking the tree in JS — is a second round trip plus a second definition of
     what "beneath" means. */
  const scope = options.departmentId
    ? `AND p.department_id IN (
         WITH RECURSIVE tree (id) AS (
           SELECT ? UNION ALL
           SELECT d.id FROM departments d JOIN tree t ON d.parent_id = t.id
         )
         SELECT id FROM tree
       )`
    : ''

  const params: unknown[] = [options.priceStructureId ?? 0]
  if (options.departmentId) params.push(options.departmentId)

  /* Same matching rule as searchForTill: barcode exact, code and description
     fuzzy. Under two characters is treated as no term at all rather than as a
     wildcard — "a" would match most of the file and read as broken. */
  const needle = (options.term ?? '').trim()
  const filter =
    needle.length >= 2
      ? `AND (p.barcode = ? OR p.code LIKE ? OR p.description LIKE ?
              OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id))`
      : ''
  if (filter) params.push(needle, `%${needle}%`, `%${needle}%`, needle)

  // Exact matches first, but only when something was typed — with no term every
  // row scores the same and the CASE is wasted work over 40,000 rows.
  const ranking = needle.length >= 2 ? 'CASE WHEN p.barcode = ? OR p.code = ? THEN 0 ELSE 1 END,' : ''
  if (ranking) params.push(needle, needle)

  const rows = await siteQuery<Row>(
    siteId,
    `${selectProduct(costBasis)}
      WHERE p.is_archived = 0
        AND p.visible_in_pos = 1
        -- A variant parent holds no stock and recordMovement refuses it, so it
        -- must never reach a till line. Its variants are ordinary products and
        -- appear here normally. Not folded into visible_in_pos: that flag is
        -- the shopkeeper's to toggle, and switching it on must not be able to
        -- make an unsellable row sellable.
        AND p.has_variants = 0
        ${scope}
        ${filter}
      ORDER BY ${ranking} p.description ASC
      LIMIT ${capped}`,
    params,
  )

  return rows.map(mapProduct)
}

/**
 * Resolves a scan to a single product.
 *
 * Tries a plain barcode first, then a variable-weight barcode, then the product
 * code. Returns null rather than guessing when nothing matches — a till that
 * silently rings up the wrong item is worse than one that beeps.
 */
export async function resolveScan(
  siteId: number,
  scanned: string,
  priceStructureId: number | null,
): Promise<TillProduct | null> {
  const code = scanned.trim()
  if (!code) return null

  const settings = await getSettings(siteId, [
    'cost_basis',
    'barcode_variable_prefix',
    'barcode_plu_length',
    'barcode_value_divisor',
  ])

  const exact = await siteQueryOne<Row>(
    siteId,
    `${selectProduct(settings.cost_basis)}
      WHERE p.is_archived = 0 AND p.has_variants = 0
        AND (p.barcode = ? OR p.code = ?
             OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id))
      LIMIT 1`,
    [priceStructureId ?? 0, code, code, code],
  )
  if (exact) return mapProduct(exact)

  // A scale barcode: prefix + PLU + embedded value + check digit. Formats vary
  // by scale vendor, which is why the parts are settings and not constants.
  const variable = parseVariableBarcode(code, {
    prefix: settings.barcode_variable_prefix,
    pluLength: Number(settings.barcode_plu_length),
    divisor: Number(settings.barcode_value_divisor),
  })
  if (!variable) return null

  const byPlu = await siteQueryOne<Row>(
    siteId,
    `${selectProduct(settings.cost_basis)}
      WHERE p.is_archived = 0 AND p.has_variants = 0
        AND (p.code = ? OR p.barcode = ?
             OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id))
      LIMIT 1`,
    [priceStructureId ?? 0, variable.plu, variable.plu, variable.plu],
  )
  if (!byPlu) return null

  const product = mapProduct(byPlu)

  /*
   * A weight barcode carries a quantity; a value barcode carries money. The
   * product's variableType says which — decided HERE, not "by the caller":
   * this used to return both, no caller ever chose, and the basket applied
   * value as the quantity AND the unit price, charging value² for anything
   * scanned off a scale label.
   */
  return product.variableType === 'price'
    ? { ...product, scannedPrice: variable.value }
    : { ...product, scannedQty: variable.value }
}

/* parseVariableBarcode moved to @/lib/barcodes so the OFFLINE till can call it —
   this module is `server-only`, and a till with no network still has to read a
   scale barcode or it cannot sell anything weighed. Re-exported here so every
   existing import keeps working. */
export { parseVariableBarcode, type VariableBarcode } from '../barcodes'

/**
 * One product by id, for re-pricing a recalled line.
 *
 * Priced through any scheduled change that is already due, not straight off
 * `product_prices`. A basket parked at five to six and recalled at five past
 * must come back at the new price — the till in front of it has been charging
 * that price since six, and the cron may not have caught up yet.
 */
export async function getTillProduct(
  siteId: number,
  productId: number,
  priceStructureId: number | null,
): Promise<TillProduct | null> {
  const { cost_basis: costBasis } = await getSettings(siteId, ['cost_basis'])
  const row = await siteQueryOne<Row>(
    siteId,
    `${selectProduct(costBasis)} WHERE p.id = ? LIMIT 1`,
    [priceStructureId ?? 0, productId],
  )
  if (!row) return null

  const product = mapProduct(row)
  const due = await duePricesFor(siteId, priceStructureId, [productId])
  const scheduled = due.get(productId)
  return scheduled === undefined ? product : { ...product, priceIncl: scheduled }
}
