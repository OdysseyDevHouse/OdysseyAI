import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { toNum, round } from '../decimals'
import { getSettings } from './settings'
import { duePricesFor } from './priceSchedules'
import { parseVariableBarcode } from '../barcodes'
import { parseGs1, gtinCandidates, lotCaptureFor } from '../gs1'
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
  /**
   * The picture a manager uploaded for this product's tile, as the stored file
   * name. Null on almost every product, which is why the tile keeps a glyph
   * fallback rather than treating a missing icon as a fault.
   *
   * The NAME, not the bytes and not a URL. The bytes would put a photograph per
   * product into every catalog response and into IndexedDB on every till; a URL
   * built here would bake a route shape into the data and go stale the moment
   * the route moves. The till only needs to know WHETHER there is one — it can
   * build `/api/product-icon/{id}` itself from the id it already holds.
   */
  imageIcon: string | null
  /**
   * Where the shop dragged this tile within its department (121). 0 means
   * nobody has placed it, and sorts AFTER every positioned row rather than
   * first — see 121 for why 0 cannot mean "first".
   */
  posSortOrder: number
  /** Quantity parsed out of a weighed-goods barcode, if the scan carried one. */
  scannedQty?: number
  /** Price parsed out of a value-embedded barcode, if the scan carried one. */
  scannedPrice?: number
  /**
   * The card a gift-card product is selling, set by the till's card modal on
   * the way into add() — the scannedQty mechanism, carrying capture through
   * the one funnel every add path shares (147).
   */
  giftCardCode?: string
  /**
   * The lot this item is being sold FROM (234).
   *
   * Set two ways, both on the road into add(): read out of a GS1 barcode by
   * the scan itself, or answered by the lot modal — the giftCardCode mechanism,
   * for the same reason. Absent means nobody named one, which is the FEFO path
   * and most sales in most shops.
   */
  scannedBatchNo?: string
  /**
   * The expiry the same barcode carried, as `YYYY-MM-DD`.
   *
   * Display only — it lets the till say "this pack expired last week" at the
   * moment it is rung up, which is the one moment somebody can still do
   * something about it. The LOT decides what stock moves; this never does.
   */
  scannedExpiry?: string
  /**
   * The individual unit being sold, chosen at the till (235).
   *
   * Set by the serial modal on the way into add() — the giftCardCode
   * mechanism, carrying capture through the one funnel every add path shares.
   * An id and its text together: the id is what posts, the text is what the
   * line shows and the slip prints.
   */
  pickedSerialId?: number
  pickedSerial?: string

  /* ── The variant scheme (070) ──────────────────────────────────────────── */

  /**
   * True when this row is a variant PARENT — a grouping tile, never a line.
   *
   * A parent holds no stock and `recordMovement` refuses it, so one reaching
   * the basket would fail at the tender pad with the card already out. The
   * till's guard is in `add()`: a parent opens the picker instead of adding.
   *
   * Only `browseForTill` can return one, and only when asked (see
   * `includeVariantParents`). Search and scan never do: a scanned barcode is a
   * physical item in somebody's hand, which a group by definition is not.
   */
  hasVariants: boolean
  /** Set when this product is somebody's variant. Null on an ordinary product. */
  parentId: number | null
  /**
   * What distinguishes this child from its siblings — 'M', 'Red'. Empty on
   * everything that is not a variant.
   *
   * The VALUES only. Their labels ('Size', 'Colour') belong to the group as a
   * whole and ride the catalog feed separately, keyed by parent id — held per
   * child they would repeat on every row and could disagree.
   */
  axis1Value: string
  axis2Value: string
  /**
   * Where this member sits in its group's picker. 0 on everything else.
   *
   * Its own column rather than reusing `posSortOrder`, which orders TILES in a
   * department — a member has no tile. And the reason it exists at all is that
   * sizes are not alphabetical: S, M, L, XL sorts to L, M, S, XL, which is
   * nonsense on a shelf edge and worse in a picker (see 070).
   */
  variantSort: number
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
    /* Normalised the same way and for the same reason: a cleared upload can leave
       '' behind rather than NULL, and a tile treating '' as "there is a picture"
       would draw a broken image on every product that once had an icon. */
    imageIcon: (r.image_icon as string | null) || null,
    posSortOrder: Number(r.pos_sort_order ?? 0),
    hasVariants: Number(r.has_variants ?? 0) === 1,
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    axis1Value: String(r.axis_1_value ?? ''),
    axis2Value: String(r.axis_2_value ?? ''),
    variantSort: Number(r.variant_sort ?? 0),
  }
}

/**
 * The till's product query.
 *
 * `cost_excl` follows the site's cost basis so the GP report reflects what the
 * store actually values stock at, rather than always the last invoice.
 */
/**
 * The shared SELECT behind every till read — search, tiles, scan, one product.
 *
 * ── PARAMETER ORDER MATTERS AND IS EASY TO GET WRONG ─────────────────────
 *
 * It takes TWO bound parameters, in this order:
 *
 *   1. the stock location id, or null for "whichever is main"
 *   2. the price structure id
 *
 * The location one is first because its subquery appears above the price join
 * in the text, and mysql2 binds positionally. Every caller therefore starts its
 * params array with `locationId, priceStructureId` before adding its own — get
 * that pair the wrong way round and the query still runs, silently counting the
 * wrong room and pricing off structure 0.
 */
/**
 * A group is only a tile if something is actually IN it.
 *
 * `makeParent` creates a group with no children, and `detachChild` can empty
 * one — so a shopkeeper mid-setup, or one who ungrouped a range, leaves a
 * parent standing with nothing under it. Without this the till draws a tile
 * that opens a picker with no options, which is a dead end a cashier cannot
 * explain to the person at the counter.
 *
 * `visible_in_pos` is deliberately NOT checked on the child here: hiding one
 * size from the till should thin the picker, not delete the whole group. The
 * picker applies that flag itself. `is_archived` is checked, because an
 * archived child is gone rather than hidden.
 *
 * Written once and shared by `browseForTill` and `tillProductCounts` — they
 * must agree, and the way two copies of a clause drift is that one is edited.
 */
const LIVE_GROUP_ONLY = `AND (
  p.has_variants = 0
  OR EXISTS (SELECT 1 FROM products c
              WHERE c.parent_id = p.id AND c.is_archived = 0)
)`

function selectProduct(costBasis: string): string {
  return `
    SELECT p.id, p.code, p.barcode, p.description, p.product_type, p.department_id,
           p.ask_price_at_sale, p.allow_fractions, p.scale_item, p.variable_type,
           p.max_discount_pct, p.image_color, p.image_icon,
           -- The variant scheme (070). Shipped on every row rather than only
           -- where a group exists: the till's guard in add() reads
           -- hasVariants on whatever it is handed, and a column that were
           -- present on some reads and absent on others would make that guard
           -- pass by accident on exactly the path that skipped it.
           p.has_variants, p.parent_id, p.axis_1_value, p.axis_2_value, p.variant_sort,
           -- Where the shop dragged this tile (121). Shipped rather than left
           -- behind because the offline till sorts its own cached grid, and a
           -- column the server ordered by but never sent would give an online
           -- till the shop's order and an offline one the alphabet.
           p.pos_sort_order,
           -- The alias barcodes (143). A correlated subquery, NOT a join — a
           -- join would multiply the row per alias and break every other figure.
           (SELECT GROUP_CONCAT(pb.barcode SEPARATOR '\n')
              FROM product_barcodes pb WHERE pb.product_id = p.id) AS extra_barcodes,
           -- Stock the counter can actually hand over: THIS TILL'S pile, not the
           -- site total. Goods in a back warehouse are owned but not sellable
           -- here until someone carries them across, and a till that offered
           -- them would promise what it cannot give.
           --
           -- Which pile that is comes from the till: a register assigned to the
           -- storeroom counts the storeroom. The parameter is the location id or
           -- NULL, and NULL falls back to whichever location is main — the same
           -- answer this query always gave, and still the right one for a single
           -- room shop or any caller with no till in hand.
           --
           -- The COALESCE is on the PARAMETER rather than on two branches of
           -- SQL, so there is one query plan and one place the room is decided.
           COALESCE((
             SELECT pls.stock_on_hand
               FROM product_location_stock pls
              WHERE pls.product_id = p.id
                AND pls.location_id = COALESCE(
                      ?, (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1))
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
  /** The room this till sells from. Null counts the main location, as before. */
  locationId: number | null = null,
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
    [locationId, priceStructureId ?? 0, needle, like, like, needle, needle, needle, needle],
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
    /** The room this till sells from. Null counts the main location, as before. */
    locationId?: number | null
    /**
     * Show variant GROUPS instead of their members. Default FALSE.
     *
     * Opt-in rather than automatic because this function has three other
     * callers — the invoice picker, trade entry, the offline catalog — and a
     * parent is unsellable to all of them. Only the till's tile grid can do
     * anything with a group, because only it has a picker to resolve one.
     *
     * The caller that turns this on takes on the obligation in `add()`: a
     * product with `hasVariants` must open the picker, never become a line.
     */
    includeVariantParents?: boolean
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

  // Location first, then price structure — see selectProduct's docblock.
  const params: unknown[] = [options.locationId ?? null, options.priceStructureId ?? 0]
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

  /*
   * Menu order, but only when BROWSING.
   *
   * The menu designer has always written `products.pos_sort_order` (121) and
   * this query has always ignored it, so a shop that dragged its six best
   * sellers to the front of a department got an A-Z grid anyway and no
   * explanation. That is the gap this closes.
   *
   * The rule is `MENU_ORDER` in lib/site/menuDesigner.ts:55 and it is
   * repeated rather than imported — that module is the DESIGNER's data layer
   * and importing it here would drag a back-office read path into the till's
   * hot query. Both must sort identically; see 121 for why 0 sorts last.
   *
   * Suppressed while SEARCHING, deliberately. Once somebody has typed, the
   * useful first row is the best match for what they typed — a shop's
   * preferred display order is an answer to a different question, and letting
   * it outrank an exact code match would bury the row they meant.
   */
  const menuOrder =
    needle.length >= 2
      ? ''
      : `CASE WHEN p.pos_sort_order = 0 THEN 1 ELSE 0 END, p.pos_sort_order ASC,`

  /*
   * Variant groups: the GROUP or its MEMBERS, never both.
   *
   * Off (the default) this is the clause every till read has always carried —
   * parents excluded, children appearing as ordinary products. Every caller
   * that is not the till's tile grid keeps exactly that.
   *
   * On, the two swap: the parent stands for its children and the children drop
   * out. Showing both would put a shirt on the grid six times — five sizes and
   * the group that contains them — which is the pile of competing tiles the
   * whole feature exists to collapse.
   *
   * `visible_in_pos` still applies to the parent on its own, so hiding a group
   * from the till hides the group. A child hidden individually stays hidden
   * inside the picker, which reads the same flag.
   *
   * ⚠ Whatever this clause admits, `tillProductCounts` must count. It is a
   * promise about what tapping the department tile will show.
   */
  const variantScope = options.includeVariantParents
    ? `AND p.parent_id IS NULL ${LIVE_GROUP_ONLY}`
    : 'AND p.has_variants = 0'

  const rows = await siteQuery<Row>(
    siteId,
    `${selectProduct(costBasis)}
      WHERE p.is_archived = 0
        AND p.visible_in_pos = 1
        ${variantScope}
        ${scope}
        ${filter}
      ORDER BY ${ranking} ${menuOrder} p.description ASC
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
  /** The room this till sells from. Null counts the main location, as before. */
  locationId: number | null = null,
): Promise<TillProduct | null> {
  const code = scanned.trim()
  if (!code) return null

  const settings = await getSettings(siteId, [
    'cost_basis',
    'barcode_variable_prefix',
    'barcode_plu_length',
    'barcode_value_divisor',
    'lot_capture_mode',
    'lot_capture_strict',
  ])

  /*
   * A GS1-128 / DataBar element string, which can carry the LOT (234).
   *
   * Tried first because such a code never matches a stored barcode as it
   * stands — it is AI-structured rather than a bare number — so every scan of
   * one used to fall through to "unknown item". `parseGs1` returns null for
   * anything that is not an element string, so an ordinary EAN-13 pays one
   * regex for this and nothing else.
   *
   * Read regardless of `lot_capture_mode`: finding the PRODUCT is worth doing
   * whatever the shop does about lots, and a shop on 'fefo' that scans a GS1
   * pack should ring up the item rather than beep. Only whether the lot is
   * USED depends on the mode.
   */
  const gs1 = parseGs1(code)
  if (gs1?.gtin) {
    const candidates = gtinCandidates(gs1.gtin)
    const placeholders = candidates.map(() => '?').join(',')
    const byGtin = await siteQueryOne<Row>(
      siteId,
      `${selectProduct(settings.cost_basis)}
        WHERE p.is_archived = 0 AND p.has_variants = 0
          AND (p.barcode IN (${placeholders}) OR p.code IN (${placeholders})
               OR EXISTS (SELECT 1 FROM product_barcodes pb
                           WHERE pb.barcode IN (${placeholders}) AND pb.product_id = p.id))
        LIMIT 1`,
      [locationId, priceStructureId ?? 0, ...candidates, ...candidates, ...candidates],
    )
    if (byGtin) {
      const product = mapProduct(byGtin)
      const capture = lotCaptureFor(settings)
      return {
        ...product,
        // The lot rides along only where the shop asked for it. Under 'prompt'
        // the clerk is the source of truth and a barcode must not pre-empt
        // them; under 'fefo' there is nothing to carry it to.
        ...(capture.mode === 'barcode' && gs1.batchNo ? { scannedBatchNo: gs1.batchNo } : {}),
        ...(capture.mode === 'barcode' && gs1.expiryDate
          ? { scannedExpiry: gs1.expiryDate }
          : {}),
        // A weighed pack states its own weight; the same decide-at-source rule
        // the scale barcode follows, and never both qty and price.
        ...(gs1.weight && product.variableType !== 'price' ? { scannedQty: gs1.weight } : {}),
      }
    }
  }

  const exact = await siteQueryOne<Row>(
    siteId,
    `${selectProduct(settings.cost_basis)}
      WHERE p.is_archived = 0 AND p.has_variants = 0
        AND (p.barcode = ? OR p.code = ?
             OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.barcode = ? AND pb.product_id = p.id))
      LIMIT 1`,
    [locationId, priceStructureId ?? 0, code, code, code],
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
    [locationId, priceStructureId ?? 0, variable.plu, variable.plu, variable.plu],
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
  /** The room this till sells from. Null counts the main location, as before. */
  locationId: number | null = null,
): Promise<TillProduct | null> {
  const { cost_basis: costBasis } = await getSettings(siteId, ['cost_basis'])
  const row = await siteQueryOne<Row>(
    siteId,
    `${selectProduct(costBasis)} WHERE p.id = ? LIMIT 1`,
    [locationId, priceStructureId ?? 0, productId],
  )
  if (!row) return null

  const product = mapProduct(row)
  const due = await duePricesFor(siteId, priceStructureId, [productId])
  const scheduled = due.get(productId)
  return scheduled === undefined ? product : { ...product, priceIncl: scheduled }
}

/**
 * One product, priced on EVERY price type the shop keeps.
 *
 * ── WHY THE TILL NEEDS THIS AND `getTillProduct` WILL NOT DO ──────────────
 *
 * Every other read on this screen answers "what does THIS customer pay", so it
 * takes one structure and returns one figure. A price check asks the opposite
 * question — "what are all the prices for this?" — and it is asked by a cashier
 * with a customer in front of them wanting to know whether they qualify for
 * trade, or by a phone call asking what something costs on account. One figure
 * is the wrong answer to that no matter which structure it is read on.
 *
 * ── WHY N QUERIES RATHER THAN ONE PIVOT ──────────────────────────────────
 *
 * `getTillProduct` per structure, in parallel. It looks wasteful and it is the
 * cheap option: a shop has two or three price types, so this is three indexed
 * primary-key reads on a screen a cashier opens by hand. Writing a pivot would
 * mean a second copy of a 60-line SELECT — including the location subquery, the
 * reserved-quantity arithmetic and the VAT join — kept in step with the first by
 * hand, and it would still have to loop for the scheduled prices, because
 * `duePricesFor` is per structure.
 *
 * The scheduled price is the reason this cannot be a plain `product_prices`
 * read. A price rise due at six is what the till is already charging at five
 * past; a price check that quoted the old figure would have the cashier promise
 * one price and the slip print another, which is the exact complaint the whole
 * schedule mechanism exists to avoid.
 *
 * Structures the product has no row for come back at 0 — that is what
 * `COALESCE(pp.selling_price_incl, 0)` gives — and the caller says "not priced"
 * rather than "free". A zero here is an absence, and printing R0.00 beside a
 * price type is how somebody sells a fridge for nothing.
 */
export async function priceCheckForTill(
  siteId: number,
  productId: number,
  structureIds: number[],
  /** The room this till sells from, so the stock figure is the one it can hand over. */
  locationId: number | null = null,
): Promise<{ product: TillProduct; prices: { structureId: number; priceIncl: number }[] } | null> {
  if (structureIds.length === 0) return null

  const priced = await Promise.all(
    structureIds.map((id) => getTillProduct(siteId, productId, id, locationId)),
  )

  /* The first structure that answered carries the product's own facts — the
     description, the stock, the VAT rate. They are identical across the reads by
     construction; only the price differs. A product that answered on NONE of
     them does not exist, which is a null rather than an empty price list. */
  const product = priced.find((p): p is TillProduct => p !== null)
  if (!product) return null

  return {
    product,
    prices: structureIds.map((structureId, i) => ({
      structureId,
      priceIncl: priced[i]?.priceIncl ?? 0,
    })),
  }
}

/**
 * How many sellable products sit DIRECTLY in each department.
 *
 * Feeds the count on the till's department tiles ("54 products"). Direct only —
 * the till rolls these up into subtree totals itself, from the department list
 * it already holds, so a branch can be counted without asking the server about
 * every department beneath it.
 *
 * ⚠ The WHERE clause here MUST match browseForTill's. A count is a promise about
 * what tapping the tile will show, and the obvious source — `product_count` on
 * lib/site/departments' Department — is the wrong one: it counts every row,
 * archived products and variant parents included. A department of 240 rows where
 * 60 are archived would promise 240 and open on 180, and the cashier has no way
 * to tell which number is the lie.
 *
 * Departments with nothing in them are absent from the result rather than
 * present as 0, so the caller reads a missing key as zero. That keeps the
 * payload proportional to the departments that actually hold stock.
 */
export async function tillProductCounts(siteId: number): Promise<Record<number, number>> {
  const rows = await siteQuery<{ department_id: number; n: number }>(
    siteId,
    `SELECT p.department_id, COUNT(*) AS n
       FROM products p
      WHERE p.is_archived = 0
        AND p.visible_in_pos = 1
        -- The GROUP counts as one, its members not at all — matching
        -- browseForTill under includeVariantParents, which is how the till
        -- grid reads. Counting the children instead would promise five tiles
        -- for a shirt and open on one.
        AND p.parent_id IS NULL
        ${LIVE_GROUP_ONLY}
        AND p.department_id IS NOT NULL
      GROUP BY p.department_id`,
  )
  return Object.fromEntries(rows.map((r) => [Number(r.department_id), Number(r.n)]))
}
