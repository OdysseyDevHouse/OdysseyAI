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
  /** The maker's name, when the shop records one. */
  brand: string | null
  /**
   * The price before a reduction, when this product is on special.
   *
   * Always null today: this schema has one selling price per structure and no
   * promotions table. Carried on the type because the tiles and the product
   * page draw savings from it, so a specials feature becomes a query change
   * rather than a change to every screen that shows a price.
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
}

export type StorefrontDepartment = { id: number; name: string; productCount: number }

export type StorefrontContext = {
  siteId: number
  settings: OnlineSettings
  /** The shop's own name, for the page title and the header. */
  storeName: string
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
 */
const SELLABLE = `
  p.is_archived = 0
  AND p.product_type IN ('normal','returnable')
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
  dep.name AS department_name,
  br.name AS brand_name,
  pp.selling_price_incl AS price_incl,
  (p.stock_on_hand > 0) AS in_stock,
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
`

/**
 * Resolve a storefront request to a store, or null when it cannot serve one.
 *
 * Null means "there is no shop here" and the route must 404 — an off store and
 * a bad token are deliberately indistinguishable from outside, so a closed
 * shop's link cannot be used to confirm the store exists.
 */
export async function storefrontContext(siteId: number): Promise<StorefrontContext | null> {
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

    return { siteId, settings, storeName }
  } catch {
    // An unreachable database must not leak a stack trace to the public.
    return null
  }
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
}

export async function publishedProducts(
  context: StorefrontContext,
  options: CatalogueOptions = {},
): Promise<StorefrontProduct[]> {
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
    if (picked.length === 0) return []
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

  const limit = Math.min(Math.max(options.limit ?? 60, 1), 120)
  const offset = Math.max(options.offset ?? 0, 0)

  const rows = await siteQuery<Row>(
    context.siteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY ${picked ? `FIELD(p.id, ${picked.join(',')})` : 'p.description'}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  return rows.map((r) => mapStorefrontProduct(r, context.settings))
}

/** One product, but ONLY if the store actually publishes it. */
export async function publishedProduct(
  context: StorefrontContext,
  productId: number,
): Promise<StorefrontProduct | null> {
  const rows = await siteQuery<Row>(
    context.siteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE p.id = ? AND ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}`,
    [context.settings.priceStructureId, productId],
  )
  const r = rows[0]
  return r ? mapStorefrontProduct(r, context.settings) : null
}

/** Departments worth showing: the ones with something published in them. */
export async function publishedDepartments(
  context: StorefrontContext,
): Promise<StorefrontDepartment[]> {
  const rows = await siteQuery<Row>(
    context.siteId,
    `SELECT dep.id, dep.name, COUNT(*) AS product_count
       FROM products p
       JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.price_structure_id = COALESCE(?, (
              SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
            ))
       JOIN departments dep ON dep.id = p.department_id
      WHERE ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}
      GROUP BY dep.id, dep.name
      ORDER BY dep.name`,
    [context.settings.priceStructureId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    productCount: Number(r.product_count),
  }))
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
    context.siteId,
    `SELECT ${PRODUCT_COLUMNS}
     ${PRODUCT_JOINS}
      WHERE ${SELLABLE} AND ${publishFilter(context.settings.publishMode)}
      ORDER BY p.id DESC
      LIMIT ${capped}`,
    [context.settings.priceStructureId],
  )
  return rows.map((r) => mapStorefrontProduct(r, context.settings))
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
  const onHand = r.stock_on_hand === null || r.stock_on_hand === undefined
    ? null
    : Number(r.stock_on_hand)

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
    // No promotions table yet — see the note on the type. Every screen that
    // shows a saving already reads this, so adding one is a query change.
    wasPriceIncl: null,
    imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
    // Falls back to the product's own name: an <img> with no alt is invisible
    // to a screen reader, and "" would announce nothing at all.
    imageAlt: String(r.image_alt ?? '') || String(r.description ?? ''),
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
export async function resolveSectionContent(
  context: StorefrontContext,
  sections: readonly {
    kind: string
    maxItems?: number
    source?: string
    departmentId?: number | null
    productIds?: number[]
  }[],
): Promise<{ products?: StorefrontProduct[]; departments?: StorefrontDepartment[] }[]> {
  return Promise.all(
    sections.map(async (section) => {
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

/** Quote against the store's CURRENT zones. What checkout actually calls. */
export async function quoteDeliveryFor(
  siteId: number,
  address: { suburb: string; postcode: string },
  goodsTotal: number,
): Promise<DeliveryQuote> {
  return quoteDelivery(await listDeliveryZones(siteId, true), address, goodsTotal)
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
}

export type PlaceOrderResult =
  | { ok: true; orderId: number; orderNumber: string; total: number }
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
 */
export async function placePublicOrder(
  siteId: number,
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

  const context = await storefrontContext(siteId)
  if (!context) return { ok: false, error: "This store isn't taking online orders." }

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

  // The fee is MONEY, so it is quoted server-side against the current zones.
  // A browser-supplied one could be set to zero.
  let deliveryFee = 0
  let zoneId: number | null = null
  if (input.fulfilment === 'deliver') {
    const quote = await quoteDeliveryFor(
      siteId,
      { suburb: input.deliverySuburb ?? '', postcode: input.deliveryPostcode ?? '' },
      goodsTotal,
    )
    if (!quote.zone || quote.belowMinimum) return { ok: false, error: quote.reason }
    deliveryFee = quote.fee
    zoneId = quote.zone.id
  }

  const total = round(goodsTotal + deliveryFee, 2)

  // Where a new order lands is the store's choice, not this file's.
  const startStatus = (await listOrderStatuses(siteId)).find((s) => s.role === 'new')
  if (!startStatus) {
    return { ok: false, error: 'This store cannot take orders right now. Please phone us.' }
  }

  try {
    return await siteTransaction(siteId, async (tx) => {
      const orderNumber = await nextOrderNumber(siteId)

      const [result] = await tx.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO online_orders
           (order_number, status_id, fulfilment, contact_name, contact_phone, contact_email,
            delivery_line1, delivery_line2, delivery_suburb, delivery_postcode, delivery_notes,
            delivery_fee_incl, zone_id, total_incl, customer_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

      return { ok: true as const, orderId, orderNumber, total }
    })
  } catch (error) {
    // Two shoppers checking out in the same instant can pick the same number;
    // the unique key catches it and a retry gets the next one.
    if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
      return { ok: false, error: 'That was busy — please try once more.' }
    }
    throw error
  }
}
