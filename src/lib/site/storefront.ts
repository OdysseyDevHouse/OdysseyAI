import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { publicSiteName } from '../sites'
import {
  getOnlineSettings,
  listDeliveryZones,
  listOrderStatuses,
  type DeliveryZone,
  type OnlineSettings,
} from './onlineStore'
import { accountCanCover, customerAccount } from './customerAuth'
import { validateCode, redeemCode } from './discountCodes'
import { placeHolds, heldQtyFor } from './stockHolds'
import { soldOutToday, tradingRules } from './branchTrading'
import { isOfferedSlot, openState } from '../tradingHours'
import {
  branchProductsByCode,
  missingAtBranchMessage,
  translateToBranch,
} from './branchCatalogue'
import { liveSpecials, specialPriceFor } from './specials'
import { storefrontImagesByIds, type StorefrontImage } from './storefrontImages'
import { recentApprovedReviews, type ProductReview } from './productReviews'

/**
 * What the PUBLIC storefront may see and do.
 *
 * Everything a shopper's browser sends is untrusted, and this module is the
 * boundary that treats it that way. Three rules run through all of it:
 *
 *   1. FAIL CLOSED. A store that is switched off, or has published nothing,
 *      exposes nothing. Every read starts from the settings row, and an
 *      unreadable or missing one yields an empty shop rather than the whole
 *      product file.
 *
 *   2. PRICE FROM THE CATALOGUE, NEVER FROM THE PAYLOAD. The basket a browser
 *      posts carries product ids and quantities and nothing else that matters.
 *      Prices, descriptions and the delivery fee are all resolved server-side.
 *      A posted price is not validated — it is ignored.
 *
 *   3. THE ORDER IS A REQUEST. Placing one writes to online_orders and moves
 *      no stock and no money. Staff accept it, which re-prices it again and
 *      writes the sale. See site/onlineOrders.ts.
 */

type Row = RowDataPacket & Record<string, unknown>

export type StorefrontProduct = {
  id: number
  code: string
  description: string
  departmentId: number | null
  departmentName: string | null
  priceIncl: number
  /** Whether the shop has any on the shelf. */
  inStock: boolean
  /**
   * Set when staff have marked this off for today — see 178.
   *
   * NOT the same as being out of stock, and the shop says so differently. Out
   * of stock is a number that reached zero and might be wrong; this is a person
   * saying "we have run out", which is the one thing the storefront treats as
   * certain enough to refuse an order over.
   *
   * The BRANCH's answer: the Claremont kitchen running out of wings says
   * nothing about Sea Point. Null when it is on the menu.
   */
  soldOutNote: string | null
  /**
   * How many are left, or null when the shop does not publish stock levels.
   *
   * Gated on the store's `showStock` setting rather than always sent, because
   * the exact figure is genuinely sensitive: it tells a competitor what the
   * shop is holding, and it is only ever as good as the last stock take. A
   * shop that opts in gets "Only 3 left"; one that does not gets a plain
   * in-stock/sold-out and this stays null all the way to the browser, so the
   * number is never in the page source for someone to read.
   */
  stockOnHand: number | null
  /**
   * What the shop OWNS, before holds and regardless of `showStock`.
   *
   * Never rendered — it exists so the order path can ask "is there enough
   * left" without depending on a figure the shop may have chosen not to
   * publish. `stockOnHand` is the publishing decision; this is the fact.
   */
  stockRaw: number
  /** The maker's name, when the shop records one. */
  brand: string | null
  /**
   * The shelf price, when a special has reduced this product.
   *
   * Null when nothing applies. When it is set, `priceIncl` is ALREADY the
   * reduced price — so every total computed downstream is the real one, and
   * this is only what gets struck through beside it.
   */
  wasPriceIncl: number | null
  /**
   * The id of the picture to show, or null for none.
   *
   * Carried on the product rather than fetched per tile: a listing renders 120
   * of these, and a query per row is 120 round trips for one page. The join
   * below picks the primary image, falling back to the lowest-sorted one.
   */
  imageId: number | null
  imageAlt: string
  /**
   * The group this product is one of, or null when it stands alone.
   *
   * Carried on the CHILD rather than fetched per group, because the listing
   * already reads every child and a second query per group would be one round
   * trip per tile. `groupVariants` below folds siblings into a single tile from
   * exactly this.
   */
  variantOf: {
    parentId: number
    /** The shared name — what the tile is titled once siblings collapse. */
    groupName: string
    axis1: string
    axis2: string
    sort: number
  } | null
}

export type StorefrontDepartment = {
  id: number
  name: string
  productCount: number
  /**
   * The department's shop picture, as an id into `storefront_images`, or null.
   *
   * Carried on the department rather than resolved to a URL here, for the same
   * reason a banner's is: the shop and the builder read the same bytes through
   * different routes, and only the caller knows which. See ImageSrc.
   *
   * Null draws the colour-and-initial tile — a shop is expected to be part way
   * through adding these, so a missing picture is the normal case, not a fault.
   */
  imageId: number | null
  /** The department's colour, for that fallback tile. Null means the default. */
  color: string | null
}

// Re-exported so a caller rendering a front page has one import for everything
// on it — the same reasoning as storefrontLayout re-exporting the model.
export type { StorefrontImage }

/**
 * Which store a storefront request is talking to — and, for a group, which two.
 *
 * ── WHY THERE ARE TWO SITE IDS ──────────────────────────────────────────────
 *
 * A chain of ten shops runs ONE storefront, but an order placed on it has to
 * land in the branch that will actually pack it — not at head office. Those are
 * two different databases, so a single siteId cannot express the request:
 *
 *   catalogueSiteId — where the PRODUCTS come from. The group's primary store,
 *                     which owns the product file, the branding and the pages.
 *   siteId          — the BRANCH. Its stock, its delivery zones, its order
 *                     queue, its sale. Everything that is a commitment by a
 *                     particular shop to a particular customer.
 *
 * For a shop that is not in a group — which is every shop today — the two are
 * equal and every query behaves exactly as it did before. That equality is the
 * property to preserve: `catalogueSiteId` is never null and never optional, so
 * no caller has to remember which one it wanted.
 *
 * The rule for choosing between them: if it decides what a shopper can SEE, it
 * is the catalogue; if it decides what the shop OWES them, it is the branch.
 */
export type StorefrontContext = {
  /** The BRANCH. Stock, holds, orders, delivery zones, the sale. */
  siteId: number
  /** Where the catalogue, settings, branding and pages come from. */
  catalogueSiteId: number
  settings: OnlineSettings
  /** The shop's own name, for the page title and the header. */
  storeName: string
  /**
   * What to CALL the branch when speaking about it — "Claremont doesn't carry
   * that", "ready in 20 minutes at Claremont".
   *
   * Equal to storeName for a single shop. Separate from it because storeName is
   * the name of the SHOP FRONT, which for a chain is head office's, and telling
   * a shopper that head office does not stock something when it is the branch
   * that does not is a confusing lie about the wrong shop.
   */
  branchName: string
}

/**
 * True when this context is a group storefront — the catalogue and the branch
 * are different shops.
 *
 * Worth a named helper rather than an inline comparison: `a !== b` at a call
 * site says nothing about why the two might differ, and the answer decides
 * whether a stock figure is a promise or a guess.
 */
export function isGroupStorefront(context: StorefrontContext): boolean {
  return context.catalogueSiteId !== context.siteId
}

/* ── The published catalogue ──────────────────────────────────────────────── */

/**
 * The WHERE clause deciding what is public, per publish mode.
 *
 * `departments` walks the department tree, so ticking a parent publishes
 * everything filed beneath it — the same recursion `getPublishCounts` uses, so
 * the number the owner saw on the Setup screen is the number of products that
 * actually appear.
 *
 * An unrecognised mode falls through to publishing NOTHING. That is the
 * fail-closed default: a typo in a settings row must not expose a catalogue.
 */
function publishFilter(mode: OnlineSettings['publishMode']): string {
  switch (mode) {
    case 'all':
      return '1 = 1'
    case 'flagged':
      return 'p.show_online = 1'
    case 'departments':
      return `p.department_id IN (
        WITH RECURSIVE published AS (
          SELECT id FROM departments WHERE show_online = 1
          UNION ALL
          SELECT d.id FROM departments d JOIN published pub ON d.parent_id = pub.id
        )
        SELECT id FROM published
      )`
    default:
      return '1 = 0'
  }
}

/**
 * A product must be sellable before it can be published: not archived, a real
 * stocked line, and PRICED. An unpriced product would otherwise appear at
 * R0.00, which is an invitation rather than a listing.
 *
 * A variant PARENT is excluded here too, and that single line covers the
 * catalogue, the search, a department listing and the specials row at once —
 * which is why it belongs in the shared clause rather than in each query. The
 * parent carries no price of its own and cannot be ordered; its children are
 * ordinary products and appear normally. The shop collapses them back into one
 * tile at render time (see variantGroupsFor below), so a shopper still sees a
 * single card with a picker rather than five siblings competing in the grid.
 */
const SELLABLE = `
  p.is_archived = 0
  AND p.product_type IN ('normal','returnable')
  AND p.has_variants = 0
  AND pp.selling_price_incl > 0
`

/**
 * The columns every storefront product query selects.
 *
 * ONE fragment, three callers — the listing, the single product and the newest
 * row. These were three hand-maintained copies of the same SELECT, and when
 * the picture subquery was added a `replace_all` matched two of them and
 * silently skipped the third: a product showed its photograph on its own page
 * and a bare tile in every listing. Sharing the text makes that impossible.
 *
 * `mapStorefrontProduct` is the other half of the contract — add a column here
 * and read it there.
 */
const PRODUCT_COLUMNS = `
  p.id, p.code, p.description, p.department_id,
  -- Which group this belongs to, and where in it. NULL for the great majority
  -- of products, which have no siblings and are drawn as a plain tile.
  p.parent_id, p.axis_1_value, p.axis_2_value, p.variant_sort,
  parent.description AS group_description,
  dep.name AS department_name,
  br.name AS brand_name,
  pp.selling_price_incl AS price_incl,
  -- ── What the SHOP may promise, not what the shop owns ──────────────────
  --
  -- stock_on_hand less anything a placed-but-unaccepted online order is
  -- holding (076). Two shoppers could otherwise both be told "In stock" for
  -- the last item within the same minute, and one is disappointed at
  -- acceptance.
  --
  -- A hold is LIVE only while it is unreleased and unexpired, checked here
  -- rather than read from a status — so a hold whose window has passed stops
  -- hiding stock immediately, even if nothing has swept it.
  --
  -- Correlated subqueries rather than a join: a join would multiply the
  -- product row once per hold, and these read a handful of rows off
  -- ix_hold_live.
  GREATEST(p.stock_on_hand - COALESCE((
    SELECT SUM(h.qty) FROM online_stock_holds h
     WHERE h.product_id = p.id
       AND h.released_at IS NULL AND h.expires_at > NOW()
  ), 0), 0) AS sellable_qty,
  (p.stock_on_hand - COALESCE((
    SELECT SUM(h.qty) FROM online_stock_holds h
     WHERE h.product_id = p.id
       AND h.released_at IS NULL AND h.expires_at > NOW()
  ), 0) > 0) AS in_stock,
  -- The raw figure travels; whether it reaches the browser is decided by the
  -- store's show_stock setting in mapStorefrontProduct, so a shop that does
  -- not publish stock never has the number in its page source at all.
  p.stock_on_hand,
  -- The picture, by the same rule everywhere: the primary one, else the
  -- lowest-sorted. Correlated subqueries rather than a JOIN, which would
  -- multiply the product row once per photo.
  (SELECT pi.id FROM product_images pi
    WHERE pi.product_id = p.id
    ORDER BY pi.is_primary DESC, pi.sort_order, pi.id LIMIT 1) AS image_id,
  (SELECT pi.alt_text FROM product_images pi
    WHERE pi.product_id = p.id
    ORDER BY pi.is_primary DESC, pi.sort_order, pi.id LIMIT 1) AS image_alt
`

/** The joins those columns need. Travels with them for the same reason. */
const PRODUCT_JOINS = `
  FROM products p
  JOIN product_prices pp
    ON pp.product_id = p.id
   AND pp.price_structure_id = COALESCE(?, (
         SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
       ))
  LEFT JOIN departments dep ON dep.id = p.department_id
  LEFT JOIN brands br ON br.id = p.brand_id
  -- The group this product belongs to, for its shared name. LEFT because the
  -- great majority of products have no parent at all.
  LEFT JOIN products parent ON parent.id = p.parent_id
`

/**
 * Resolve a storefront request to a store, or null when it cannot serve one.
 *
 * Null means "there is no shop here" and the route must 404 — an off store and
 * a bad token are deliberately indistinguishable from outside, so a closed
 * shop's link cannot be used to confirm the store exists.
 *
 * `branchSiteId` names the shop that will FULFIL the order, when that is not the
 * shop whose catalogue is being browsed. Omitted — which is every call today —
 * the branch is the catalogue, and the returned context is exactly what it has
 * always been.
 *
 * The settings read here are deliberately the CATALOGUE's: publish mode, price
 * structure and branding are what the group's primary store decided, and a
 * branch does not get to publish a different product file. Settings that are a
 * branch's own commitment — its delivery zones, its lead time, whether it is
 * taking orders at all — are read from `siteId` at the point they are used, not
 * bundled in here where a caller could mistake one for the other.
 */
export async function storefrontContext(
  siteId: number,
  branchSiteId?: number,
): Promise<StorefrontContext | null> {
  try {
    const settings = await getOnlineSettings(siteId)
    if (!settings.isEnabled) return null

    // The shop's name lives in the CONTROL database, not the site's own. Only
    // the name is fetched: the rest of that record is the company's VAT
    // number, registration number and contact details, none of which belong in
    // a public page.
    const storeName = await publicSiteName(siteId)
    // A suspended or archived site has no storefront, which publicSiteName
    // signals by returning null.
    if (!storeName) return null

    /*
     * ── A SIGNED-IN ACCOUNT SEES ITS OWN PRICES (135) ────────────────────
     *
     * The resolved structure (customer → group → store setting) overlays the
     * store's default, so every catalogue query downstream — browsing, the
     * basket, the checkout quote — prices through the account's structure
     * with no call-site change. Every path that RAISES money re-resolves
     * server-side (onlineOrders does its own lookup), so this overlay only
     * ever changes what is shown, never what is charged.
     *
     * Guarded, not assumed: outside a request (the basket-reminder cron, the
     * sitemap) there is no cookie jar, getCustomerSession throws, and the
     * catch keeps the store default — which is also the anonymous shopper's
     * path.
     */
    let priceStructureId = settings.priceStructureId
    try {
      const { getCustomerSession } = await import('../customerSession')
      const session = await getCustomerSession(siteId)
      if (session) {
        const { getTillCustomer } = await import('./tillCustomers')
        const account = await getTillCustomer(siteId, session.customerId)
        if (account?.priceStructureId) priceStructureId = account.priceStructureId
      }
    } catch {
      // No request scope, or the session store is unreachable — store default.
    }

    /*
     * The argument is the CATALOGUE; the branch is the argument again unless a
     * caller named one. Written this way round because the overwhelmingly
     * common case must be the one that needs no thought — a single shop passes
     * one id and gets a context whose two ids agree.
     */
    /*
     * The branch's own name, read only when it IS a different shop — a single
     * store must not pay for a second control-database lookup to be told its
     * own name again. Falls back to the shop front's name if that read comes
     * back empty, so a sentence never ends up naming nothing.
     */
    const branchName =
      branchSiteId && branchSiteId !== siteId
        ? (await publicSiteName(branchSiteId)) || storeName
        : storeName

    return {
      siteId: branchSiteId ?? siteId,
      catalogueSiteId: siteId,
      settings: { ...settings, priceStructureId },
      storeName,
      branchName,
    }
  } catch {
    // An unreachable database must not leak a stack trace to the public.
    return null
  }
}

/**
 * How a listing is ordered.
 *
 * ── A FIXED SET, MAPPED TO LITERAL SQL ───────────────────────────────────
 *
 * The value arrives from a query string, and the thing it decides is an
 * ORDER BY. Those two facts together are why this is a union mapped through
 * a literal record and never a string reaching the query: a sort parameter
 * is the classic place an injection gets in, and a fixed vocabulary makes
 * one unrepresentable rather than something to escape.
 */
export const CATALOGUE_SORTS = ['name', 'priceAsc', 'priceDesc', 'newest'] as const
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number]

/**
 * Each sort's ORDER BY, written out here and never built.
 *
 * Every one ends with `p.id` as a tie-break. Without it, two products with
 * the same price or the same name have no defined order between pages, and
 * a shopper paging through a department can see one product twice and miss
 * another entirely — the bug that looks like the catalogue losing stock.
 */
const SORT_SQL: Record<CatalogueSort, string> = {
  name: 'p.description, p.id',
  priceAsc: 'pp.selling_price_incl, p.id',
  priceDesc: 'pp.selling_price_incl DESC, p.id',
  // Newest by id, not by a date column: a product has no "added on" field,
  // and the id is monotonic, which is the same thing for this purpose.
  newest: 'p.id DESC',
}

/** Anything else — a stale link, a typo, a probe — reads as the default. */
export function safeSort(value: unknown): CatalogueSort {
  const raw = String(value ?? '')
  return (CATALOGUE_SORTS as readonly string[]).includes(raw) ? (raw as CatalogueSort) : 'name'
}

export type CatalogueOptions = {
  departmentId?: number
  search?: string
  limit?: number
  offset?: number
  /**
   * Restrict to specific products — the page builder's "products I pick".
   *
   * Goes through this function rather than a SELECT of its own so a picked
   * product still has to pass SELLABLE and the publish mode. An owner who
   * picks something and later unpublishes it should see it LEAVE the row,
   * not have the pick override the visibility rules from inside the layout.
   *
   * An empty array is not the same as undefined: it means "nothing was
   * picked" and must return nothing, where undefined means "no restriction".
   */
  ids?: number[]
  /** Facets (Phase 10): brand by NAME, and a VAT-inclusive price band. */
  brand?: string
  minPriceIncl?: number
  maxPriceIncl?: number
  /** How to order the page. Absent reads as `name`, which is what it was. */
  sort?: CatalogueSort
}

/**
 * The WHERE and its parameters, for one set of catalogue options.
 *
 * ── ONE DEFINITION, TWO CALLERS ───────────────────────────────────
 *
 * The listing and its COUNT have to agree exactly, or the pager promises
 * pages the grid cannot fill — "1–24 of 380" over a department that runs out
 * at 200 is a shopper clicking into empty pages and concluding the shop is
 * broken. Two copies of a filter this long would drift on the first facet
 * anybody added, so there is one.
 */
function catalogueFilter(
  context: StorefrontContext,
  options: CatalogueOptions,
): { where: string[]; params: unknown[]; picked: number[] | null } | null {
  const where: string[] = [SELLABLE, publishFilter(context.settings.publishMode)]
  const params: unknown[] = [context.settings.priceStructureId]

  /*
   * A picked list. Filtered to integers before interpolation — these go into
   * the SQL text rather than as placeholders because the count varies, so
   * anything that is not provably a number must not reach the string.
   */
  let picked: number[] | null = null
  if (options.ids) {
    picked = [...new Set(options.ids.filter((id) => Number.isInteger(id) && id > 0))]
    // Asked for nothing, get nothing — an empty IN () is a syntax error, and
    // silently dropping the clause would return the entire catalogue.
    // Asked for nothing, get nothing. Null rather than an empty list: the
    // caller has to distinguish "no matches" from "nothing was asked for",
    // and only one of those is a page worth drawing.
    if (picked.length === 0) return null
    where.push(`p.id IN (${picked.join(',')})`)
  }

  if (options.departmentId) {
    // Includes the chosen department's descendants, so browsing a parent shows
    // what browsing its children would.
    where.push(`p.department_id IN (
      WITH RECURSIVE branch AS (
        SELECT id FROM departments WHERE id = ?
        UNION ALL
        SELECT d.id FROM departments d JOIN branch b ON d.parent_id = b.id
      )
      SELECT id FROM branch
    )`)
    params.push(options.departmentId)
  }

  if (options.search?.trim()) {
    const term = `%${options.search.trim()}%`
    where.push('(p.description LIKE ? OR p.code LIKE ?)')
    params.push(term, term)
  }

  // The facets, applied BEFORE the 120 cap so a filtered page is honest
  // rather than a client-side sieve over whatever the cap happened to admit.
  if (options.brand?.trim()) {
    where.push('br.name = ?')
    params.push(options.brand.trim())
  }
  if (options.minPriceIncl !== undefined && Number.isFinite(options.minPriceIncl)) {
    where.push('pp.selling_price_incl >= ?')
    params.push(options.minPriceIncl)
  }
  if (options.maxPriceIncl !== undefined && Number.isFinite(options.maxPriceIncl)) {
    where.push('pp.selling_price_incl <= ?')
    params.push(options.maxPriceIncl)
  }

  return { where, params, picked }
}

export async function publishedProducts(
  context: StorefrontContext,
  options: CatalogueOptions = {},
): Promise<StorefrontProduct[]> {
  const filter = catalogueFilter(context, options)
  if (!filter) return []
  const { where, params, picked } = filter
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 120)
  const offset = Math.max(options.offset ?? 0, 0)

  // A picked row keeps the owner’s order — that IS the choice — and
  // everything else takes the sort.
  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY ${picked ? `FIELD(p.id, ${picked.join(',')})` : SORT_SQL[options.sort ?? 'name']}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  return withSpecials(context, rows.map((r) => mapStorefrontProduct(r, context.settings)))
}

/**
 * How many products a listing would hold, unpaged.
 *
 * ── WHY THE PAGER NEEDS ITS OWN QUERY ────────────────────────────────────
 *
 * A department used to stop at 120 products, ordered by description, with a
 * footnote telling the shopper to search. That is not a cap on a page — it is
 * a shop with 400 products showing 120 of them, permanently, with no way to
 * reach the rest. Paging fixes it, and paging needs a total: without one a
 * pager can only say "next" until a page comes back short, which is how a
 * shopper ends up on an empty page deciding the shop is broken.
 *
 * Runs the SAME filter as the listing — see catalogueFilter. COUNT(DISTINCT)
 * because the joins can multiply a row, and a total larger than the pages can
 * fill is the exact failure this exists to prevent.
 */
export async function publishedProductsCount(
  context: StorefrontContext,
  options: CatalogueOptions = {},
): Promise<number> {
  const filter = catalogueFilter(context, options)
  if (!filter) return 0
  const { where, params } = filter

  const row = await siteQueryOne<{ total: number }>(
    context.catalogueSiteId,
    `SELECT COUNT(DISTINCT p.id) AS total
     ${PRODUCT_JOINS}
      WHERE ${where.join(' AND ')}`,
    params,
  )
  return Number(row?.total ?? 0)
}

/**
 * What a department's facet bar has to offer: which brands, and the price
 * span. One GROUP BY over the same publish + sellable rules the listing
 * itself uses, so a facet can never promise products the grid will not show.
 */
export async function catalogueFacets(
  context: StorefrontContext,
  departmentId: number,
): Promise<{ brands: { name: string; count: number }[]; minPrice: number; maxPrice: number }> {
  const where = [SELLABLE, publishFilter(context.settings.publishMode)]
  const params: unknown[] = [context.settings.priceStructureId]

  where.push(`p.department_id IN (
    WITH RECURSIVE branch AS (
      SELECT id FROM departments WHERE id = ?
      UNION ALL
      SELECT d.id FROM departments d JOIN branch b ON d.parent_id = b.id
    )
    SELECT id FROM branch
  )`)
  params.push(departmentId)

  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT br.name AS brand, COUNT(*) AS n,
            MIN(pp.selling_price_incl) AS min_price, MAX(pp.selling_price_incl) AS max_price
     ${PRODUCT_JOINS}
      WHERE ${where.join(' AND ')}
      GROUP BY br.name`,
    params,
  )

  let minPrice = Number.POSITIVE_INFINITY
  let maxPrice = 0
  const brands: { name: string; count: number }[] = []
  for (const r of rows) {
    minPrice = Math.min(minPrice, toNum(r.min_price))
    maxPrice = Math.max(maxPrice, toNum(r.max_price))
    if (r.brand) brands.push({ name: String(r.brand), count: Number(r.n) })
  }
  brands.sort((a, b) => b.count - a.count)
  return { brands, minPrice: Number.isFinite(minPrice) ? minPrice : 0, maxPrice }
}

/**
 * The axis labels a group's picker is titled with — 'Size', 'Colour'.
 *
 * Empty when the product stands alone, so the detail page can ask
 * unconditionally and draw nothing when there is nothing to draw.
 */
export async function axisLabelsFor(
  siteId: number,
  parentId: number,
): Promise<{ position: number; label: string }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT position, label FROM product_variant_axes
      WHERE product_id = ? ORDER BY position`,
    [parentId],
  )
  return rows.map((r) => ({ position: Number(r.position), label: String(r.label) }))
}

/**
 * The siblings of one product, for its detail page's picker.
 *
 * Reads the group directly rather than filtering a listing, because a product
 * page knows its parent and must show every sibling — including ones a
 * department or search filter would have excluded.
 */
export async function siblingsOf(
  context: StorefrontContext,
  product: StorefrontProduct,
): Promise<StorefrontProduct[]> {
  if (!product.variantOf) return []

  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE ${SELLABLE}
        AND ${publishFilter(context.settings.publishMode)}
        AND p.parent_id = ?
      ORDER BY p.variant_sort, pp.selling_price_incl`,
    [context.settings.priceStructureId, product.variantOf.parentId],
  )

  return withSpecials(
    context,
    rows.map((r) => mapStorefrontProduct(r, context.settings)),
  )
}

/** One product, but ONLY if the store actually publishes it. */
export async function publishedProduct(
  context: StorefrontContext,
  productId: number,
): Promise<StorefrontProduct | null> {
  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE p.id = ? AND ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}`,
    [context.settings.priceStructureId, productId],
  )
  const r = rows[0]
  if (!r) return null
  const [priced] = await withSpecials(context, [mapStorefrontProduct(r, context.settings)])
  return priced ?? null
}

/** Departments worth showing: the ones with something published in them. */
export async function publishedDepartments(
  context: StorefrontContext,
): Promise<StorefrontDepartment[]> {
  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT dep.id, dep.name, dep.online_image_id, dep.color, COUNT(*) AS product_count
       FROM products p
       JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.price_structure_id = COALESCE(?, (
              SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
            ))
       JOIN departments dep ON dep.id = p.department_id
      WHERE ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}
      GROUP BY dep.id, dep.name, dep.online_image_id, dep.color
      ORDER BY dep.name`,
    [context.settings.priceStructureId],
  )
  return rows.map((r) => {
    // 0 and junk both read as "no picture" — see `imageId` in departments.ts
    // for why a 0 must never survive as an id.
    const image = Number(r.online_image_id)
    return {
      id: Number(r.id),
      name: String(r.name),
      productCount: Number(r.product_count),
      imageId: Number.isInteger(image) && image > 0 ? image : null,
      color: (r.color as string | null) ?? null,
    }
  })
}

/**
 * The newest published products.
 *
 * Ordered by id rather than a created_at: every product has an id, it is
 * monotonic, and it is indexed — where created_at is nullable on rows that
 * predate it and would sort a whole legacy catalogue into one arbitrary blob.
 */
export async function newestProducts(
  context: StorefrontContext,
  limit: number,
): Promise<StorefrontProduct[]> {
  const capped = Math.min(Math.max(limit, 1), 24)
  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}
      ORDER BY p.id DESC
      LIMIT ${capped}`,
    [context.settings.priceStructureId],
  )
  return withSpecials(context, rows.map((r) => mapStorefrontProduct(r, context.settings)))
}

/**
 * Published products that a live special has actually reduced.
 *
 * ── WHY THIS ASKS THE PRICING ENGINE RATHER THAN THE SPECIALS TABLE ──────
 *
 * A special can name a product OR a whole department, can be scheduled, can be
 * inactive, and can be a kind that does not reduce a shelf price at all (a
 * buy-two-get-one is not a markdown). Reading `special_items` and calling the
 * product ids in it "the specials" would put products on the front page at
 * their normal price, and miss every product covered by a departmental one.
 *
 * So the question is asked the only way that cannot disagree with the shelf:
 * price a page of the catalogue exactly as the shop does, then keep the rows
 * where a `wasPriceIncl` actually appeared. If it is struck through in the
 * row, it is on special; if it is not, it is not.
 *
 * ── WHY IT SCANS A WINDOW ────────────────────────────────────────────────
 *
 * `withSpecials` prices whatever list it is handed, so the candidates have to
 * be fetched first. The window is capped: a catalogue of 40 000 products must
 * not be paged through to fill a row of eight. A shop whose specials all sit
 * alphabetically past the window shows fewer than it could — the honest
 * failure, and far better than a front page that takes ten seconds.
 */
const SPECIALS_SCAN_LIMIT = 120

export async function productsOnSpecial(
  context: StorefrontContext,
  limit: number,
): Promise<StorefrontProduct[]> {
  const capped = Math.min(Math.max(limit, 1), 24)

  // No live specials means no query at all — the common case for most shops
  // on most days.
  const specials = await liveSpecials(context.catalogueSiteId)
  if (specials.length === 0) return []

  const candidates = await publishedProducts(context, { limit: SPECIALS_SCAN_LIMIT })

  // Already priced by publishedProducts, so a struck-through price IS the
  // answer. The saving is computed once per product rather than inside the
  // comparator, which a sort calls O(n log n) times for the same figures.
  const reduced = candidates
    .map((product) => ({ product, saving: (product.wasPriceIncl ?? 0) - product.priceIncl }))
    .filter((entry) => entry.saving > 0)

  // Biggest saving first: a specials row is a shop window, and the best deal
  // earns the first tile.
  reduced.sort((a, b) => b.saving - a.saving)
  return reduced.slice(0, capped).map((entry) => entry.product)
}

/**
 * The published products that have sold most recently.
 *
 * ── NINETY DAYS, AND WHY IT IS NOT "EVER" ────────────────────────────────
 *
 * All-time best sellers are a monument: the thing that sold well three years
 * ago stays at the top of the front page forever, and no amount of trading
 * changes it. A trailing window makes the row reflect the shop as it is now,
 * and lets a new line reach the front page by actually selling.
 *
 * ── FINALISED ONLY, AND CREDIT NOTES SUBTRACT ────────────────────────────
 *
 * Quotes, orders and parked sales have not happened. Credit notes carry a
 * negative qty by the sign convention in 015_sales_core.sql, so summing plain
 * `qty` across both means a returned product correctly falls back down the
 * list rather than counting twice.
 *
 * ── THE PUBLISH RULES ARE IN THE RANKING, NOT AFTER IT ───────────────────
 *
 * This query joins the catalogue and applies SELLABLE and the publish filter
 * BEFORE taking the top N, so the N it returns are N publishable products.
 *
 * Ranking first and filtering afterwards looks equivalent and is not: a shop
 * publishing 5 of its 40 000 products has a best-seller list whose first
 * several hundred rows are all things it does not sell online, so the filter
 * removes everything and the row comes back empty while the shop plainly has
 * recent sales. Over-fetching a fixed multiple only moves the number at which
 * that happens — it does not fix it. Found exactly that way on a real store.
 */
export async function popularProducts(
  context: StorefrontContext,
  limit: number,
): Promise<StorefrontProduct[]> {
  const capped = Math.min(Math.max(limit, 1), 24)

  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT l.product_id, SUM(l.qty) AS sold
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
       JOIN products p ON p.id = l.product_id
       JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.price_structure_id = COALESCE(?, (
              SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
            ))
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_note')
        AND d.document_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        AND l.product_id IS NOT NULL
        AND ${SELLABLE}
        AND ${publishFilter(context.settings.publishMode)}
      GROUP BY l.product_id
      HAVING sold > 0
      ORDER BY sold DESC
      LIMIT ${capped}`,
    [context.settings.priceStructureId],
  )

  const ids = rows.map((r) => Number(r.product_id)).filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return []

  // Still fetched through the ordinary published query rather than selecting
  // the columns here: that is the one place a storefront product is built, and
  // it is what applies specials to the prices.
  const products = await publishedProducts(context, { ids, limit: ids.length })

  // publishedProducts returns them in FIELD() order — the id order it was
  // given — which is already the sold-most-first order from above.
  return products
}

/**
 * Apply the shop's live specials to a list of products.
 *
 * ── ONE LOAD PER REQUEST, NOT ONE PER PRODUCT ────────────────────────────
 *
 * A listing renders 120 products; asking the database for the specials once
 * per row would be 120 round trips to answer the same question. They are
 * loaded once and the pure engine does the rest.
 *
 * ── THE SAME FUNCTION FEEDS THE SHOP AND THE ORDER ───────────────────────
 *
 * Which is why a shopper cannot be shown one price and charged another: there
 * is no second place where a special price is worked out.
 */
async function withSpecials(
  context: StorefrontContext,
  products: StorefrontProduct[],
): Promise<StorefrontProduct[]> {
  if (products.length === 0) return products

  /*
   * Two reads from two shops, in parallel and once for the whole list.
   *
   * Specials are the CATALOGUE's — a chain runs one promotion, not nine. What
   * has run out today is the BRANCH's, because that is a fact about one
   * kitchen. Getting these the wrong way round would advertise head office's
   * sold-out list to every branch in the group.
   */
  const [specials, soldOut] = await Promise.all([
    liveSpecials(context.catalogueSiteId),
    soldOutToday(context.siteId),
  ])

  const marked =
    soldOut.size === 0
      ? products
      : products.map((product) => {
          const off = soldOut.get(product.id)
          if (!off) return product
          return { ...product, soldOutNote: off.note || 'Sold out today' }
        })

  if (specials.length === 0) return marked
  const priced = marked

  const now = new Date()
  return priced.map((product) => {
    const deal = specialPriceFor(
      {
        productId: product.id,
        departmentId: product.departmentId,
        priceIncl: product.priceIncl,
      },
      specials,
      now,
    )
    if (!deal) return product
    // The reduced price becomes THE price, and the old one is what gets
    // struck through — so every total downstream is already the real one.
    return { ...product, priceIncl: deal.priceIncl, wasPriceIncl: deal.wasPriceIncl }
  })
}

/**
 * Shared row → product mapping, so every query here agrees on the shape.
 *
 * Takes the settings because one field is a PUBLISHING decision rather than a
 * formatting one: the exact stock figure is withheld here, at the boundary,
 * rather than in the component that draws it. A component that decides not to
 * render a number it was given still ships that number in the HTML.
 */
function mapStorefrontProduct(r: Row, settings: OnlineSettings): StorefrontProduct {
  /*
   * The SELLABLE figure, not the owned one.
   *
   * "Only 3 left" has to mean three a shopper can actually have. Publishing
   * the raw stock_on_hand would count items another shopper's placed order is
   * already holding, and the shop would be advertising goods it has promised
   * away — which is the exact failure holds exist to prevent.
   *
   * Falls back to the raw figure when the sellable one is absent, so a store
   * that has not run 076 behaves exactly as it did before.
   */
  const raw = r.stock_on_hand === null || r.stock_on_hand === undefined
    ? null
    : Number(r.stock_on_hand)
  const onHand = r.sellable_qty === null || r.sellable_qty === undefined
    ? raw
    : Number(r.sellable_qty)

  return {
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    departmentName: (r.department_name as string | null) ?? null,
    brand: (r.brand_name as string | null) ?? null,
    priceIncl: toNum(r.price_incl),
    inStock: !!r.in_stock,
    stockOnHand: settings.showStock ? onHand : null,
    stockRaw: raw ?? 0,
    // Filled in by `withSpecials` after the query returns — specials are
    // loaded once per request rather than once per product.
    wasPriceIncl: null,
    // Likewise: one read of what the BRANCH has run out of, applied to the
    // whole list rather than queried per product.
    soldOutNote: null,
    imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
    // Falls back to the product's own name: an <img> with no alt is invisible
    // to a screen reader, and "" would announce nothing at all.
    imageAlt: String(r.image_alt ?? '') || String(r.description ?? ''),
    variantOf:
      r.parent_id === null || r.parent_id === undefined
        ? null
        : {
            parentId: Number(r.parent_id),
            groupName: String(r.group_description ?? ''),
            axis1: String(r.axis_1_value ?? ''),
            axis2: String(r.axis_2_value ?? ''),
            sort: Number(r.variant_sort ?? 0),
          },
  }
}

/**
 * Fill each section with the products or departments it should show.
 *
 * Shared by the SHOP and the page BUILDER, deliberately. What a section
 * contains is a rule — "the newest eight", "everything in Groceries" — and if
 * the builder re-implemented it the preview would drift from the shop the
 * moment either changed. One function, two callers, no drift.
 *
 * One pass, in parallel: a page with four product rows costs four queries at
 * once rather than four in sequence.
 */
/**
 * What else people bought when they bought this.
 *
 * ── REAL BASKETS, NOT A GUESS ────────────────────────────────────────────
 *
 * Every pair here comes from an actual finalised sale: two lines on one
 * document. That is worth more than "other things in the same department",
 * because it is the shop's own customers saying what goes together — bread and
 * jam sit in different aisles.
 *
 * ── THE SELF-JOIN, AND WHY IT IS BOUNDED ─────────────────────────────────
 *
 * `a` finds every document containing the anchor product; `b` is everything
 * else on those documents. That is a self-join on the busiest table in the
 * database, so three things keep it cheap: the 90-day window (the same one
 * `popularProducts` uses, and the same reasoning — what sold together two years
 * ago is not a recommendation), the anchor-product filter which is an indexed
 * lookup rather than a scan, and the LIMIT.
 *
 * ── AND WHY IT CAN LEGITIMATELY RETURN NOTHING ───────────────────────────
 *
 * A new product, a shop that has just opened, or a line nobody buys alongside
 * anything. That is the normal case at first and it is not a fault — the
 * section renders nothing and the builder says why.
 */
export async function boughtTogether(
  context: StorefrontContext,
  productId: number,
  limit: number,
): Promise<StorefrontProduct[]> {
  if (!Number.isInteger(productId) || productId <= 0) return []
  const capped = Math.min(Math.max(limit, 1), 24)

  const rows = await siteQuery<Row>(
    context.catalogueSiteId,
    `SELECT b.product_id, COUNT(DISTINCT d.id) AS baskets
       FROM sales_document_lines a
       JOIN sales_documents d ON d.id = a.document_id
       JOIN sales_document_lines b
         ON b.document_id = a.document_id
        -- Everything on the basket EXCEPT the anchor itself, which would
        -- otherwise always be the top result and recommend the product the
        -- shopper is already looking at.
        AND b.product_id <> a.product_id
       JOIN products p ON p.id = b.product_id
       JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.price_structure_id = COALESCE(?, (
              SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
            ))
      WHERE a.product_id = ?
        AND d.status = 'finalised'
        -- Invoices only. A credit note is a RETURN, and counting one as
        -- evidence that two things go together recommends the thing somebody
        -- brought back.
        AND d.doc_type = 'invoice'
        AND d.document_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        AND b.product_id IS NOT NULL
        AND ${SELLABLE}
        AND ${publishFilter(context.settings.publishMode)}
      GROUP BY b.product_id
      -- COUNT(DISTINCT d.id), not SUM(qty): a customer buying twelve of
      -- something once is one person's opinion, and quantity would let a
      -- single bulk order decide the whole row.
      ORDER BY baskets DESC, b.product_id
      LIMIT ${capped}`,
    [context.settings.priceStructureId, productId],
  )

  const ids = rows.map((r) => Number(r.product_id)).filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return []

  // Through the ordinary published query, exactly as popularProducts does —
  // that is the one place a storefront product is built, and it is what
  // applies specials to the prices.
  return publishedProducts(context, { ids, limit: ids.length })
}

export async function resolveSectionContent(
  context: StorefrontContext,
  sections: readonly {
    kind: string
    maxItems?: number
    source?: string
    departmentId?: number | null
    productIds?: number[]
    imageId?: number | null
    slides?: { imageId: number | null }[]
    logoImageIds?: number[]
    minRating?: number
    specialId?: number | null
  }[],
  /**
   * What the page is ABOUT, when it is about one thing.
   *
   * A product page passes the product; a department page passes the department
   * with `id: 0`, since there is no product to exclude and no basket history to
   * read — only a department for `sameDepartment` to follow. Everywhere else
   * it is absent and the rules that need it resolve to nothing.
   *
   * Passed in rather than looked up: both callers already fetched this to
   * render the page's own heading, and a second query for the same row on
   * every request would be pure waste.
   */
  anchor?: { id: number; departmentId: number | null },
): Promise<{
  products?: StorefrontProduct[]
  departments?: StorefrontDepartment[]
  image?: StorefrontImage | null
  slideImages?: Map<number, StorefrontImage>
  reviews?: ProductReview[]
  logoImages?: Map<number, StorefrontImage>
  /** countdown: the special's real end, when it is bound to one. */
  specialEndsAt?: string
}[]> {
  /*
   * Every picture on the page, in ONE query.
   *
   * Resolved up front rather than inside the map: a page can hold several
   * banners and a carousel of eight slides, and asking per section — worse,
   * per slide — is a round trip each to answer one question. An id that no
   * longer resolves is simply absent — see the module header of
   * storefrontImages.ts on why a deleted picture is not an error.
   *
   * Banners and slides share the query because they share the library. Keeping
   * them separate would double the round trips to fetch from one table.
   */
  const imageIds = sections.flatMap((s) =>
    s.kind === 'banner' || s.kind === 'split'
      ? [s.imageId]
      : s.kind === 'carousel'
        ? (s.slides ?? []).map((slide) => slide.imageId)
        : s.kind === 'logos'
          ? s.logoImageIds ?? []
          : [],
  )
  const images = await storefrontImagesByIds(
    context.catalogueSiteId,
    imageIds.filter((id): id is number => typeof id === 'number' && id > 0),
  )

  return Promise.all(
    sections.map(async (section) => {
      // Both are one picture beside or behind words, resolved identically.
      if (section.kind === 'banner' || section.kind === 'split') {
        return { image: section.imageId ? images.get(section.imageId) ?? null : null }
      }

      if (section.kind === 'logos') {
        /*
         * Only THIS section's pictures, for the same reason a carousel gets
         * only its own: `sectionIsEmpty` counts what resolved, and handing
         * over the page-wide map would let a strip inherit the answer for a
         * picture belonging to somewhere else.
         */
        const mine = new Map<number, StorefrontImage>()
        for (const id of section.logoImageIds ?? []) {
          const found = images.get(id)
          if (found) mine.set(id, found)
        }
        return { logoImages: mine }
      }

      if (section.kind === 'reviews') {
        return {
          reviews: await recentApprovedReviews(context.catalogueSiteId, {
            limit: section.maxItems ?? 6,
            minRating: section.minRating ?? 4,
            departmentId: section.departmentId ?? null,
          }),
        }
      }

      if (section.kind === 'countdown') {
        /*
         * A special's real end, read fresh on every request.
         *
         * The stored `endsAt` is only a fallback for shops not using specials.
         * When the section names one, the SPECIAL is the truth — an owner who
         * extends a sale by two days must not have to remember a countdown on
         * the front page still says Friday.
         */
        if (!section.specialId) return {}
        const special = (await liveSpecials(context.catalogueSiteId)).find(
          (s) => s.id === section.specialId,
        )
        return { specialEndsAt: special?.endsAt ?? '' }
      }

      if (section.kind === 'carousel') {
        /*
         * Only THIS section's slides, not the page-wide map.
         *
         * Handing every section the whole map would work and would be wrong:
         * `sectionIsEmpty` asks whether a slide's picture resolves, so a
         * carousel would inherit the answer for a picture belonging to some
         * other section and count a dead slide as live.
         */
        const mine = new Map<number, StorefrontImage>()
        for (const slide of section.slides ?? []) {
          const found = slide.imageId ? images.get(slide.imageId) : undefined
          if (found) mine.set(slide.imageId as number, found)
        }
        return { slideImages: mine }
      }

      if (section.kind === 'categories') {
        const all = await publishedDepartments(context)
        const max = section.maxItems ?? 0
        return { departments: max > 0 ? all.slice(0, max) : all }
      }

      if (section.kind === 'products') {
        const limit = section.maxItems ?? 8
        if (section.source === 'newest') {
          return { products: await newestProducts(context, limit) }
        }
        if (section.source === 'special') {
          return { products: await productsOnSpecial(context, limit) }
        }
        if (section.source === 'popular') {
          return { products: await popularProducts(context, limit) }
        }
        /*
         * The two ANCHORED rules. Both need an anchor, and both correctly
         * resolve to nothing without one — a cross-sell row on a page with no
         * product is not an error, it is a rule that does not apply. The
         * builder hides these sources off the pages that cannot supply one
         * (see `sourcesFor`), so reaching here without an anchor means a layout
         * saved before the page kind changed.
         */
        if (section.source === 'together') {
          // Product pages only: a department has no basket history of its own.
          if (!anchor?.id) return { products: [] }
          return { products: await boughtTogether(context, anchor.id, limit) }
        }
        if (section.source === 'sameDepartment') {
          if (!anchor?.departmentId) return { products: [] }
          const siblings = await publishedProducts(context, {
            departmentId: anchor.departmentId,
            /*
             * One extra, because a PRODUCT page's anchor is almost certainly in
             * its own department and is filtered out below — without the spare,
             * a row of eight would quietly show seven. A DEPARTMENT page anchors
             * with id 0, so nothing is filtered and the slice drops the spare.
             */
            limit: limit + 1,
          })
          return { products: siblings.filter((p) => p.id !== anchor.id).slice(0, limit) }
        }
        if (section.source === 'department' && section.departmentId) {
          return {
            products: await publishedProducts(context, {
              departmentId: section.departmentId,
              limit,
            }),
          }
        }
        if (section.source === 'manual') {
          /*
           * The owner's own list, in the owner's own order. Still subject to
           * the publish rules, so a pick that stops being sellable drops out
           * of the row rather than 404-ing from the front page.
           *
           * NOT capped by maxItems: the picked list IS the intent. A stale
           * maxItems of 8 left over from a "newest" rule must not silently
           * swallow the 9th product someone deliberately chose.
           */
          const ids = section.productIds ?? []
          return { products: await publishedProducts(context, { ids, limit: Math.max(ids.length, 1) }) }
        }
        // A department rule whose department was never chosen. Empty, which
        // the shop draws as nothing and the builder explains.
        return { products: [] }
      }

      return {}
    }),
  )
}

/* ── Delivery quoting ─────────────────────────────────────────────────────── */

export type DeliveryQuote = {
  /** Null when nowhere covers this address. */
  zone: DeliveryZone | null
  fee: number
  belowMinimum: boolean
  /** Shown to the shopper as-is. */
  reason: string
}

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

/** A zone's match value may list several terms, comma-separated. */
const terms = (value: string) => value.split(',').map(normalise).filter(Boolean)

/**
 * Price a delivery for an address.
 *
 * Zones are considered in sort order and the FIRST match wins, so a store can
 * put a specific suburb above a broad catch-all. The ordering is deterministic
 * on purpose: a shopper re-quoting the same address must never see a different
 * price.
 *
 * Returns a quote rather than throwing — "we don't deliver there" is a normal
 * answer the storefront has to give politely.
 */
export function quoteDelivery(
  zones: DeliveryZone[],
  address: { suburb: string; postcode: string },
  goodsTotal: number,
): DeliveryQuote {
  const suburb = normalise(address.suburb)
  const postcode = normalise(address.postcode)

  const active = zones
    .filter((z) => z.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  for (const zone of active) {
    const list = terms(zone.matchValue)
    const hit =
      zone.matchType === 'postcode'
        ? postcode !== '' && list.includes(postcode)
        : // Generous in ONE direction only: "Sandton" covers "Sandton Central",
          // but "Sand" must not match "Sandton".
          suburb !== '' && list.some((t) => suburb === t || suburb.startsWith(`${t} `))
    if (!hit) continue

    if (zone.minOrderIncl > 0 && goodsTotal < zone.minOrderIncl) {
      return {
        zone,
        fee: zone.feeIncl,
        belowMinimum: true,
        reason: `${zone.name} has a minimum of R${zone.minOrderIncl.toFixed(2)} for delivery.`,
      }
    }
    if (zone.freeOverIncl > 0 && goodsTotal >= zone.freeOverIncl) {
      return { zone, fee: 0, belowMinimum: false, reason: `Free delivery to ${zone.name}.` }
    }
    return {
      zone,
      fee: zone.feeIncl,
      belowMinimum: false,
      reason:
        zone.feeIncl > 0
          ? `Delivery to ${zone.name}: R${zone.feeIncl.toFixed(2)}.`
          : `Free delivery to ${zone.name}.`,
    }
  }

  return {
    zone: null,
    fee: 0,
    belowMinimum: false,
    reason: "We don't deliver to that area yet — please choose collection.",
  }
}

/**
 * Quote against the store's CURRENT zones. What checkout actually calls.
 *
 * `siteId` here is the BRANCH, never the catalogue. Delivery is a promise by
 * one shop to drive to one address for one price — Claremont charging R35 to a
 * suburb Wynberg charges R50 for is the normal case, not a misconfiguration.
 * Quoting from the group's primary would price every branch off head office's
 * zone list and quietly undercharge or refuse half of them.
 */
export async function quoteDeliveryFor(
  branchSiteId: number,
  address: { suburb: string; postcode: string },
  goodsTotal: number,
): Promise<DeliveryQuote> {
  return quoteDelivery(await listDeliveryZones(branchSiteId, true), address, goodsTotal)
}

/* ── Placing an order ─────────────────────────────────────────────────────── */

export type BasketLine = { productId: number; qty: number; note?: string }

export type PublicOrderInput = {
  fulfilment: 'collect' | 'deliver'
  contactName: string
  contactPhone: string
  contactEmail: string
  deliveryLine1?: string
  deliveryLine2?: string
  deliverySuburb?: string
  deliveryPostcode?: string
  deliveryNotes?: string
  customerNote?: string
  lines: BasketLine[]
  /**
   * The signed-in customer, resolved from the session by the CALLER.
   *
   * Deliberately not a customer id in the payload. This function is reached
   * from a server action a script can call with any body it likes, and an id
   * taken from that body would let anyone charge any account in the shop.
   * The caller must read it from the session cookie.
   */
  customerId?: number | null
  /** Whether the shopper asked to charge it. Only a REQUEST — see below. */
  payOnAccount?: boolean
  /**
   * The discount code as typed. Only a REQUEST, exactly like payOnAccount:
   * whether it applies, and for how much, is decided here from the catalogue
   * and the code's own rules — never from anything the browser computed.
   */
  discountCode?: string
  /**
   * A gift card covering the WHOLE order (147). A request like the others:
   * the card is read and judged here, partial cover is refused online, and
   * the actual spend happens inside finaliseDocument when the caller
   * invoices the order against the GIFT_CARD tender.
   */
  giftCardCode?: string
  /**
   * A loyalty value voucher (052). Stored on the order for the payment
   * callback to hand to finaliseDocument; ownership is enforced HERE because
   * the shared engine deliberately leaves it to the staff-mediated till.
   */
  voucherCode?: string
  /**
   * The collection time the shopper picked, as an ISO string. '' or absent
   * means as soon as possible.
   *
   * A REQUEST, like every other field here. The shop's real slots are
   * re-derived from its trading hours when the order arrives and a time that is
   * no longer offered is refused — a stale tab whose shop has since closed
   * early must not book a slot the kitchen never had.
   */
  requestedFor?: string
}

export type PlaceOrderResult =
  | {
      ok: true
      orderId: number
      orderNumber: string
      total: number
      /** What the server DECIDED, which may differ from what was asked. */
      onAccount: boolean
      /** True when a gift card covers the whole order — no gateway needed. */
      giftCard: boolean
      /** Rand of the total a voucher will settle at invoicing. */
      voucherCredit: number
    }
  | { ok: false; error: string }

/** Sequential per store, and readable over the phone. */
async function nextOrderNumber(siteId: number): Promise<string> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT order_number FROM online_orders
      WHERE order_number REGEXP '^WEB-[0-9]+$'
      ORDER BY CAST(SUBSTRING(order_number, 5) AS UNSIGNED) DESC LIMIT 1`,
  )
  const last = row ? Number(String(row.order_number).slice(4)) : 0
  return `WEB-${String(last + 1).padStart(5, '0')}`
}

/**
 * Place an order from the storefront.
 *
 * EVERY figure is resolved here. The browser contributes product ids,
 * quantities and contact details; it does not contribute prices, the delivery
 * fee, or the total. A payload claiming a R1.00 television is priced at the
 * catalogue's figure and the shopper is charged that.
 *
 * Takes either a siteId or an already-resolved context. The context form is
 * what a group storefront uses: it is the only way to say "price this from head
 * office's product file, but write the order into the branch" — a bare siteId
 * cannot express two stores. The caller has usually resolved the context
 * already, so passing it also saves re-reading the settings.
 */
export async function placePublicOrder(
  store: number | StorefrontContext,
  input: PublicOrderInput,
): Promise<PlaceOrderResult> {
  const name = input.contactName.trim()
  if (!name) return { ok: false, error: 'Please enter your name.' }
  if (!input.contactPhone.trim() && !input.contactEmail.trim()) {
    return { ok: false, error: 'Please enter a phone number or an email address.' }
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, error: 'Your basket is empty.' }
  }
  if (input.lines.length > 200) {
    return { ok: false, error: "That's too many items for one order." }
  }

  const context = typeof store === 'number' ? await storefrontContext(store) : store
  if (!context) return { ok: false, error: "This store isn't taking online orders." }

  /*
   * From here on `siteId` is the BRANCH — the shop that will pack this order,
   * take the money and owe the customer. Every write below is its own: the
   * holds, the account check, the order number, the transaction, the webhook.
   *
   * Catalogue reads go through `context`, which carries the primary's id. The
   * two are the same store for every shop that is not in a group.
   */
  const siteId = context.siteId

  const { settings } = context
  if (input.fulfilment === 'collect' && !settings.collectEnabled) {
    return { ok: false, error: "This store isn't offering collection at the moment." }
  }
  if (input.fulfilment === 'deliver' && !settings.deliverEnabled) {
    return { ok: false, error: "This store isn't offering delivery at the moment." }
  }
  if (input.fulfilment === 'deliver' && !input.deliveryLine1?.trim()) {
    return { ok: false, error: 'Please enter the delivery address.' }
  }

  /*
   * ── Is this shop taking orders at all? ──────────────────────────────────
   *
   * The checkout disables its button when the queue is stopped, but a disabled
   * button is a courtesy and this is the rule. A stale tab, a resubmitted form
   * and a script all arrive here.
   *
   * Only a PAUSED shop refuses. Closed does not: "order for tomorrow at 08:15"
   * is the normal path at half past ten at night, and refusing it would turn
   * away exactly the trade this is for. A shop with no hours set is never
   * either — see tradingHours.
   */
  const trading = await tradingRules(siteId)
  const placedAt = new Date()
  const nowState = openState(trading, placedAt)
  if (nowState.state === 'paused') {
    return {
      ok: false,
      error: nowState.note
        ? `${context.branchName} isn't taking orders right now — ${nowState.note}`
        : `${context.branchName} isn't taking orders at the moment.`,
    }
  }

  /*
   * The collection time, re-derived rather than trusted.
   *
   * The browser was handed a list of slots when the page rendered; this decides
   * whether the one it sends back is still real. A tab left open through the
   * shop closing early, or a payload naming any time at all, is refused here —
   * the same posture as the delivery fee, which is also never taken from the
   * browser.
   *
   * An empty value is "as soon as possible" and is always fine.
   */
  let requestedFor: Date | null = null
  const wanted = (input.requestedFor ?? '').trim()
  if (wanted) {
    const at = new Date(wanted)
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: 'Please choose a collection time.' }
    }
    if (!isOfferedSlot(trading, at, placedAt)) {
      return {
        ok: false,
        error: `${context.branchName} can no longer do that time. Please pick another.`,
      }
    }
    requestedFor = at
  }

  // Price from the CATALOGUE. Anything the basket claimed is discarded, and a
  // product the store does not publish is not orderable at any price.
  const ids = [...new Set(input.lines.map((l) => Number(l.productId)).filter(Number.isInteger))]
  if (ids.length === 0) return { ok: false, error: 'Your basket is empty.' }

  const published = await Promise.all(ids.map((id) => publishedProduct(context, id)))
  const byId = new Map(published.filter((p): p is StorefrontProduct => p !== null).map((p) => [p.id, p]))

  const priced: {
    productId: number
    code: string
    description: string
    qty: number
    unitPriceIncl: number
    lineTotalIncl: number
    note: string
  }[] = []

  /*
   * What is already spoken for, read ONCE for the whole basket rather than per
   * line — a ten-line order would otherwise be ten round trips.
   *
   * Empty when the shop has holding switched off, so nothing is queried at all
   * in that case.
   */
  /*
   * Not read for a group storefront: the ids in the basket are the catalogue's
   * and the holds are the branch's, so the lookup would silently miss every
   * time and report nothing held. Skipped outright rather than run and ignored,
   * so nobody later mistakes an empty map for "nothing is spoken for".
   */
  const alreadyHeld =
    settings.holdMinutes > 0 && !isGroupStorefront(context)
      ? await heldQtyFor(siteId, input.lines.map((l) => Number(l.productId)))
      : new Map<number, number>()

  let goodsTotal = 0
  for (const line of input.lines) {
    const product = byId.get(Number(line.productId))
    if (!product) {
      return {
        ok: false,
        error: 'One of the items is no longer available. Please refresh and try again.',
      }
    }
    const qty = Number(line.qty)
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) {
      return { ok: false, error: `Please check the quantity for ${product.description}.` }
    }

    /*
     * ── Is there actually enough left to promise? ─────────────────────────
     *
     * Only when the shop holds stock. With holding off (hold_minutes = 0) the
     * pre-076 behaviour stands: the shop takes the order and sorts it out at
     * acceptance, which is a deliberate choice for a business with deep stock.
     *
     * Checked HERE and not only in the browser, because the storefront hiding
     * a sold-out product stops someone BROWSING to it — it does nothing about
     * a stale tab, a resubmitted form, or two shoppers whose baskets were
     * filled before either checked out. Without this, holds hide stock from
     * the next shopper while still letting them order it.
     */
    /*
     * Skipped for a group storefront, because the figures being compared are the
     * wrong shop's: product.stockRaw is the CATALOGUE's stock and the holds were
     * read from the branch. Judging one against the other would refuse orders a
     * branch could fill and accept ones it could not.
     *
     * The branch's own stock is checked below, after the codes are translated,
     * and it warns rather than refuses — a chain's branch accepts or declines
     * an order it cannot fill, which is what an order being a request means.
     */
    if (settings.holdMinutes > 0 && !isGroupStorefront(context)) {
      const spokenFor = alreadyHeld.get(product.id) ?? 0
      const free = round(product.stockRaw - spokenFor, 3)
      if (free < qty) {
        return {
          ok: false,
          error:
            free <= 0
              ? `Sorry — ${product.description} has just sold out.`
              : `Sorry — only ${free} of ${product.description} ${free === 1 ? 'is' : 'are'} left.`,
        }
      }
    }

    const lineTotal = round(qty * product.priceIncl, 2)
    priced.push({
      productId: product.id,
      code: product.code,
      description: product.description,
      qty,
      unitPriceIncl: product.priceIncl,
      lineTotalIncl: lineTotal,
      note: (line.note ?? '').slice(0, 190),
    })
    goodsTotal = round(goodsTotal + lineTotal, 2)
  }

  if (settings.minOrderIncl > 0 && goodsTotal < settings.minOrderIncl) {
    return {
      ok: false,
      error: `Orders start at R${settings.minOrderIncl.toFixed(2)}. Please add a little more.`,
    }
  }

  /*
   * ── Onto the branch's own product ids ───────────────────────────────────
   *
   * Everything above priced against the CATALOGUE. Everything below writes into
   * the BRANCH, where online_order_lines.product_id and online_stock_holds
   * .product_id are foreign keys into that branch's own products table.
   *
   * Ids do not travel between databases; codes do. Translated once, here, so
   * that every write after this point is an ordinary single-site order — which
   * is exactly why acceptOrder needs no knowledge of any of this.
   *
   * A no-op for a single shop: the map is not built and the ids are already the
   * ones being written.
   */
  if (isGroupStorefront(context)) {
    const branchProducts = await branchProductsByCode(
      context.siteId,
      priced.map((p) => p.code),
    )
    const translated = translateToBranch(priced, branchProducts)
    if (!translated.ok) {
      return { ok: false, error: missingAtBranchMessage(translated.missing, context.branchName) }
    }
    for (let i = 0; i < priced.length; i++) {
      priced[i].productId = translated.lines[i].branchProductId
    }
  }

  /*
   * ── Sold out for today ──────────────────────────────────────────────────
   *
   * The ONE thing that blocks an order outright, and deliberately so. Elsewhere
   * a shortage is a warning and the branch decides — because the shop might
   * have the goods in the back, or be able to make more. This is different:
   * staff have said, explicitly and by hand, that they have run out today.
   * "We'll confirm your order" is then a promise about something already known
   * to be false.
   *
   * Read after the translation so the ids are the branch's own, which is where
   * the mark lives — the Claremont kitchen running out says nothing about
   * Sea Point.
   */
  const soldOut = await soldOutToday(siteId)
  if (soldOut.size > 0) {
    const gone = priced.filter((p) => soldOut.has(p.productId))
    if (gone.length > 0) {
      const names = gone.map((g) => g.description).slice(0, 3).join(', ')
      const note = soldOut.get(gone[0].productId)?.note
      return {
        ok: false,
        error: note
          ? `${names} — ${note}. Please remove ${gone.length === 1 ? 'it' : 'them'} to continue.`
          : `${names} ${gone.length === 1 ? 'is' : 'are'} sold out today. Please remove ${gone.length === 1 ? 'it' : 'them'} to continue.`,
      }
    }
  }

  /*
   * ── The discount code, re-validated from scratch ────────────────────────
   *
   * The browser previewed one; this is the check that decides. Everything the
   * preview looked at — dates, limits, the minimum, whether the shopper has
   * ordered before — is re-read here, because a preview is a suggestion and
   * several of those facts can change between the two.
   *
   * A code that has become invalid REFUSES the order rather than quietly
   * dropping the discount. Someone who typed SAVE10 and pressed a button
   * reading "Place order · R90" must not be charged R100 without being told.
   */
  let discountIncl = 0
  let freeDelivery = false
  let discountApplied: { id: number; code: string } | null = null

  if (input.discountCode?.trim()) {
    const check = await validateCode(
      siteId,
      input.discountCode,
      {
        lines: priced.map((p) => ({
          productId: p.productId,
          qty: p.qty,
          unitPriceIncl: p.unitPriceIncl,
          onSpecial: byId.get(p.productId)?.wasPriceIncl !== null,
          departmentId: byId.get(p.productId)?.departmentId ?? null,
        })),
        customerId: input.customerId ?? null,
        contactEmail: input.contactEmail,
      },
    )
    if (!check.ok) return { ok: false, error: check.error }
    discountIncl = check.application.discountIncl
    freeDelivery = check.application.freeDelivery
    discountApplied = { id: check.application.code.id, code: check.application.code.code }
  }

  // Goods AFTER the discount. This is what the shopper is actually spending,
  // so it is what a free-delivery-over-R500 threshold has to be measured
  // against — a threshold met only before a R100 discount was not really met.
  const discountedGoods = round(goodsTotal - discountIncl, 2)

  // The fee is MONEY, so it is quoted server-side against the current zones.
  // A browser-supplied one could be set to zero.
  let deliveryFee = 0
  let zoneId: number | null = null
  if (input.fulfilment === 'deliver') {
    const quote = await quoteDeliveryFor(
      siteId,
      { suburb: input.deliverySuburb ?? '', postcode: input.deliveryPostcode ?? '' },
      discountedGoods,
    )
    if (!quote.zone || quote.belowMinimum) return { ok: false, error: quote.reason }
    deliveryFee = freeDelivery ? 0 : quote.fee
    zoneId = quote.zone.id
  }

  const total = round(discountedGoods + deliveryFee, 2)

  /*
   * ── Whether this goes on account is decided HERE, not by the browser ────
   *
   * `payOnAccount` in the payload is a request. Everything that grants it is
   * re-checked server-side against the current record: the store allows it,
   * the shopper is actually signed in, the account is open, and the credit
   * covers TOTAL — which the browser did not compute and cannot influence.
   *
   * Refusing outright rather than silently falling back to pay-on-collection:
   * a shopper who chose their account and then finds an invoice waiting has
   * been told something untrue at the moment they committed.
   */
  let onAccount = false
  if (input.payOnAccount) {
    if (!settings.allowAccount) {
      return { ok: false, error: 'This shop is not taking orders on account.' }
    }
    if (!input.customerId) {
      return { ok: false, error: 'Please sign in to put this order on your account.' }
    }
    const account = await customerAccount(siteId, input.customerId)
    const allowed = accountCanCover(account, total)
    if (!allowed.ok) return { ok: false, error: allowed.reason }
    onAccount = true
  }

  /*
   * ── A gift card, judged now, spent at invoicing ─────────────────────────
   *
   * Full cover only, online: a partly-covered order would need the gateway
   * AND the card to settle together, and a card debited against a payment
   * that never completes is a dispute. The card is checked again — under the
   * row lock — inside finaliseDocument when the order is invoiced.
   */
  let giftCard = false
  if (input.giftCardCode?.trim()) {
    if (onAccount) {
      return { ok: false, error: 'Choose the gift card OR your account for this order, not both.' }
    }
    if (settings.paymentMode !== 'online') {
      return { ok: false, error: 'Gift cards work at checkout only where this shop takes payment online — please use it at the till.' }
    }
    const { findGiftCard, giftCardRefusal } = await import('./giftCards')
    const { today } = await import('./ledger')
    const card = await findGiftCard(siteId, input.giftCardCode)
    const refusal = giftCardRefusal(card, input.giftCardCode, today())
    if (refusal) return { ok: false, error: refusal }
    if (card!.balance + 0.005 < total) {
      return {
        ok: false,
        error: `That card holds R${card!.balance.toFixed(2)}, which does not cover the R${total.toFixed(2)} total. Gift cards cover the whole order online — keep it for the shop, or take something off the basket.`,
      }
    }
    giftCard = true
  }

  /*
   * ── A loyalty voucher, ownership enforced HERE ──────────────────────────
   *
   * The shared redeem machinery deliberately does not check who a voucher
   * belongs to — the till is staff-mediated. Online is not, so a code only
   * counts when the SIGNED-IN shopper owns it. Stored on the order; the
   * payment callback hands it to finaliseDocument, which nets it off what
   * the gateway collected and spends it under the row lock.
   */
  let voucherCredit = 0
  let voucherCode = ''
  if (input.voucherCode?.trim()) {
    if (!input.customerId) {
      return { ok: false, error: 'Sign in to use your voucher.' }
    }
    if (settings.paymentMode !== 'online' || onAccount || giftCard) {
      return { ok: false, error: 'Vouchers work online only on orders paid by card — please use it at the till.' }
    }
    const { findVoucher } = await import('./loyaltyCards')
    const voucher = await findVoucher(siteId, input.voucherCode)
    if (!voucher || voucher.customerId !== input.customerId) {
      return { ok: false, error: 'That voucher is not on your account.' }
    }
    if (voucher.status !== 'issued') {
      return { ok: false, error: 'That voucher has already been used.' }
    }
    // Local date, not toISOString — UTC would expire it two hours early here.
    const { today } = await import('./ledger')
    if (voucher.expiresOn && voucher.expiresOn < today()) {
      return { ok: false, error: `That voucher expired on ${voucher.expiresOn}.` }
    }
    if (voucher.rewardType !== 'value') {
      return { ok: false, error: 'That voucher is for a free item — please use it at the till.' }
    }
    if (voucher.rewardValue + 0.005 >= total) {
      return {
        ok: false,
        error: 'That voucher is worth more than the rest of the order — please use it at the till so nothing goes to waste.',
      }
    }
    voucherCredit = round(voucher.rewardValue, 2)
    voucherCode = voucher.code
  }

  // Where a new order lands is the store's choice, not this file's.
  const startStatus = (await listOrderStatuses(siteId)).find((s) => s.role === 'new')
  if (!startStatus) {
    return { ok: false, error: 'This store cannot take orders right now. Please phone us.' }
  }

  try {
    // Filled inside the transaction, kicked only after it commits.
    let webhookDeliveryIds: number[] = []
    const placed = await siteTransaction(siteId, async (tx) => {
      const orderNumber = await nextOrderNumber(siteId)

      const [result] = await tx.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO online_orders
           (order_number, status_id, fulfilment, contact_name, contact_phone, contact_email,
            delivery_line1, delivery_line2, delivery_suburb, delivery_postcode, delivery_notes,
            delivery_fee_incl, zone_id, total_incl, customer_note,
            customer_id, pay_on_account,
            discount_code_id, discount_code, discount_incl, voucher_code, requested_for)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orderNumber,
          startStatus.id,
          input.fulfilment,
          name.slice(0, 160),
          input.contactPhone.trim().slice(0, 40),
          input.contactEmail.trim().slice(0, 190),
          (input.deliveryLine1 ?? '').trim().slice(0, 190),
          (input.deliveryLine2 ?? '').trim().slice(0, 190),
          (input.deliverySuburb ?? '').trim().slice(0, 120),
          (input.deliveryPostcode ?? '').trim().slice(0, 20),
          (input.deliveryNotes ?? '').trim().slice(0, 500),
          deliveryFee.toFixed(4),
          zoneId,
          total.toFixed(4),
          (input.customerNote ?? '').trim().slice(0, 500),
          /*
           * The customer is recorded whenever one is signed in, even for an
           * order they are paying for now. Staff seeing "this is Jan's Spaza"
           * on a collection order is useful, and it is what lets the shopper's
           * own order history show every order rather than only the credit
           * ones.
           */
          input.customerId ?? null,
          onAccount ? 1 : 0,
          discountApplied?.id ?? null,
          discountApplied?.code ?? '',
          discountIncl.toFixed(4),
          voucherCode,
          /*
           * NULL is "as soon as possible", which is what this column has always
           * meant and what every order placed before slots existed carries.
           * Written as a Date; the pool's timezone handling does the rest.
           */
          requestedFor,
        ],
      )

      const orderId = result.insertId
      let lineNumber = 1
      for (const line of priced) {
        await tx.query(
          `INSERT INTO online_order_lines
             (order_id, line_number, product_id, product_code, description,
              qty, unit_price_incl, line_total_incl, line_note)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            orderId,
            lineNumber++,
            line.productId,
            line.code,
            line.description,
            line.qty.toFixed(3),
            line.unitPriceIncl.toFixed(4),
            line.lineTotalIncl.toFixed(4),
            line.note,
          ],
        )
      }

      /*
       * ── Spending the code, under a row lock ─────────────────────────────
       *
       * Inside the SAME transaction as the order, and after the lines, so a
       * code can never be counted without an order to show for it.
       *
       * redeemCode re-checks the limit against the LOCKED counter. Two
       * shoppers redeeming the last use of a single-use code in the same
       * instant both pass validation above — they each read uses_count = 0 —
       * and the lock is what makes exactly one of them win.
       *
       * The loser is refused rather than quietly charged full price, because
       * they pressed a button that named a discounted total.
       */
      /*
       * ── Hold the stock this order has claimed ───────────────────────────
       *
       * In the SAME transaction as the order and its lines: a hold written
       * outside it could survive a rollback and keep goods off the shelf for
       * an order that does not exist.
       *
       * It moves no stock and writes no movement — see 076. All it changes is
       * what the storefront advertises to the NEXT shopper, which is exactly
       * where the "both told In stock" problem was.
       *
       * `holdMinutes` of 0 means the shop has switched holding off, and
       * placeHolds writes nothing at all.
       */
      await placeHolds(
        tx,
        orderId,
        priced.map((p) => ({ productId: p.productId, qty: p.qty })),
        settings.holdMinutes,
      )

      if (discountApplied) {
        const spent = await redeemCode(tx, {
          codeId: discountApplied.id,
          orderId,
          customerId: input.customerId ?? null,
          contactEmail: input.contactEmail,
          amountIncl: discountIncl,
        })
        if (!spent) {
          throw new DiscountExhausted('That code has just been fully used.')
        }
      }

      // The webhook row rides the SAME transaction: it exists exactly when
      // the order does, and a rollback takes both. Delivery is kicked only
      // AFTER the commit — never inline from a shopper's checkout request.
      const { enqueueEventTx } = await import('./webhooks')
      webhookDeliveryIds = await enqueueEventTx(siteId, tx, 'order.placed', {
        orderId,
        orderNumber,
        totalIncl: total,
        onAccount,
        customerId: input.customerId ?? null,
      })

      return { ok: true as const, orderId, orderNumber, total, onAccount, giftCard, voucherCredit }
    })

    // Post-commit, un-awaited: the due-now fast path. If it dies, the tick
    // sends the rows a minute later.
    if (webhookDeliveryIds.length > 0) {
      const { deliverNow } = await import('./webhooks')
      void deliverNow(siteId, webhookDeliveryIds)
    }
    return placed
  } catch (error) {
    /*
     * The code ran out between validation and the lock. Thrown rather than
     * returned so the whole transaction rolls back — the order must not exist
     * at a discounted total the shop is not honouring.
     */
    if (error instanceof DiscountExhausted) {
      return { ok: false, error: error.message }
    }
    // Two shoppers checking out in the same instant can pick the same number;
    // the unique key catches it and a retry gets the next one.
    if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
      return { ok: false, error: 'That was busy — please try once more.' }
    }
    throw error
  }
}

/**
 * A code that was valid a moment ago and is not any more.
 *
 * Its own class so the catch above can tell it from a genuine failure and turn
 * it into something a shopper can act on, rather than "something went wrong".
 */
class DiscountExhausted extends Error {}
