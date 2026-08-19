import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { sanitiseEmailHtml } from '../orderEmailTemplate'
// The pure model — labels, roles and shapes the SETUP SCREEN also needs.
// Re-exported so server callers have one import, while the client imports
// straight from the model and never reaches this file.
import {
  REQUIRED_ROLES,
  STATUS_NOTIFY_KINDS,
  roleMeaning,
  type OrderStatus,
  type OrderStatusInput,
  type StatusNotifyKind,
} from '../orderStatusModel'
export {
  NOTIFY_KIND_LABEL,
  REQUIRED_ROLES,
  ROLE_LABEL,
  STATUS_NOTIFY_KINDS,
  type OrderStatus,
  type OrderStatusInput,
  type StatusNotifyKind,
} from '../orderStatusModel'
import { canTakePayments } from './payments'

/**
 * The online store's configuration.
 *
 * This module owns the settings row, the delivery zones and the counts the
 * Setup screen needs to tell an owner what a choice will actually do.
 *
 * ── THE RULE THAT SHAPES ALL OF IT ───────────────────────────────────────
 *
 * The storefront is PUBLIC. Whatever it publishes is visible to anyone with
 * the link, and an order placed on it is a commitment the shop has to honour.
 * So every default here is the cautious one, and the checks that matter run at
 * the moment the store is switched ON rather than on every save — which is
 * what lets an owner configure over two sittings without being half-exposed in
 * between.
 */

type Row = RowDataPacket & Record<string, unknown>

export type PaymentMode = 'on_collection' | 'online'
export type PublishMode = 'departments' | 'flagged' | 'all'

export type OnlineSettings = {
  isEnabled: boolean
  collectEnabled: boolean
  deliverEnabled: boolean
  paymentMode: PaymentMode
  allowAccount: boolean
  publishMode: PublishMode
  priceStructureId: number | null
  leadTimeMinutes: number
  minOrderIncl: number
  blurb: string
  paidStatusId: number | null
  /** Whether the storefront shows reviews and invites new ones. */
  reviewsEnabled: boolean
  /**
   * Whether shoppers see how many are left.
   *
   * Off by default. "Only 3 left" converts, but it also publishes what the
   * shop is holding to anyone who looks, and it is only ever as accurate as
   * the last stock take — so it is the owner's call, not ours. Off means the
   * count never leaves the server; a product reads simply as in stock or
   * sold out.
   */
  showStock: boolean
  /** Whether product photographs are shown. Off falls back to a text list. */
  showPhotos: boolean
  /** Whether brand names are shown and offered as a filter. */
  showBrands: boolean
  /**
   * Whether the shop offers to save a basket and send ONE reminder about it.
   *
   * Off unless a shop turns it on. Emailing shoppers is a decision a business
   * makes, not something that starts happening because a migration ran.
   */
  basketReminders: boolean
  /** How long a basket sits untouched before it counts as abandoned. */
  basketReminderHours: number
  /** The shop's own wording above the items. Empty means the standard line. */
  basketReminderNote: string
  /**
   * How long a placed order holds its stock before the claim lapses.
   *
   * 0 switches holding off entirely — the pre-076 behaviour, and a legitimate
   * choice for a shop with deep stock that would rather never refuse a
   * shopper.
   */
  holdMinutes: number
  /**
   * Whether search engines may index the storefront.
   *
   * READ-ONLY here. The column belongs to the presentation settings added in
   * 077 and is written from the page builder's theme, so this exposes it for
   * anything that needs to ASK — the sitemap, the structured data — without
   * creating a second place to set it. Two write paths for one switch is how a
   * shop turns indexing off in one screen and finds it still on.
   */
  readonly allowIndexing: boolean
  /**
   * The shop's own public address, e.g. "shop.example.co.za".
   *
   * The storefront lives behind an opaque signed token, so a canonical link and
   * a sitemap need to be told which domain actually points here. Empty falls
   * back to APP_URL.
   */
  publicDomain: string
  /**
   * Whether departments show their picture — on the rail under the search and
   * on the "Shop by department" tiles.
   *
   * Off by default and for existing shops, because a shop that upgrades into
   * this has no department pictures yet: switching it on for them would turn
   * every tile into a colour-and-letter placeholder overnight. The owner turns
   * it on once the pictures are in, which is also when they can see the result.
   */
  showDepartmentImages: boolean
  /**
   * What money the SHOP takes — see 190.
   *
   * Read by the storefront and by nothing else. The back office, the till and
   * every printed document keep the Rand default, because threading a currency
   * through their thousand call sites is a different piece of work.
   */
  currencyCode: string
  currencySymbol: string
  updatedAt: Date | null
  updatedBy: string
}

/**
 * How many products each publish mode would expose.
 *
 * The point is to show the CONSEQUENCE of a mode before it is chosen. A store
 * that never ticked anything gets zero under 'flagged', and finding that out
 * from a live, empty storefront is the failure this prevents.
 */
export type PublishCounts = {
  departments: number
  flagged: number
  all: number
  /** Every sellable product, as the denominator for "23 of 1 284". */
  total: number
}

export type DeliveryZone = {
  id: number
  name: string
  matchType: 'suburb' | 'postcode'
  matchValue: string
  feeIncl: number
  freeOverIncl: number
  minOrderIncl: number
  isActive: boolean
  sortOrder: number
}


/* ── Settings ─────────────────────────────────────────────────────────────── */

/**
 * A product is publishable only if it is something a shop can actually sell:
 * not archived, and a stocked or returnable line rather than a department key
 * or an open-price placeholder. Used by every count below so they cannot
 * disagree with each other or with the storefront.
 */
const SELLABLE = `p.is_archived = 0 AND p.product_type IN ('normal','returnable')`

export async function getOnlineSettings(siteId: number): Promise<OnlineSettings> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM online_store_settings WHERE id = 1`,
  )

  // The migration seeds the row, so a miss means a site that predates it. Fall
  // back to the same closed, cautious defaults rather than throwing: settings
  // that are wrong are recoverable, a screen that will not load is not.
  if (!row) {
    return {
      isEnabled: false,
      collectEnabled: true,
      deliverEnabled: false,
      paymentMode: 'on_collection',
      allowAccount: false,
      publishMode: 'departments',
      priceStructureId: null,
      leadTimeMinutes: 30,
      minOrderIncl: 0,
      blurb: '',
      paidStatusId: null,
      reviewsEnabled: false,
      showStock: false,
      showPhotos: true,
      showBrands: true,
      showDepartmentImages: false,
      currencyCode: 'ZAR',
      currencySymbol: 'R',
      basketReminders: false,
      basketReminderHours: 4,
      basketReminderNote: '',
      holdMinutes: 60,
      allowIndexing: false,
      publicDomain: '',
      updatedAt: null,
      updatedBy: '',
    }
  }

  return {
    isEnabled: !!row.is_enabled,
    collectEnabled: !!row.collect_enabled,
    deliverEnabled: !!row.deliver_enabled,
    paymentMode: String(row.payment_mode) as PaymentMode,
    allowAccount: !!row.allow_account,
    publishMode: String(row.publish_mode) as PublishMode,
    priceStructureId: row.price_structure_id === null ? null : Number(row.price_structure_id),
    leadTimeMinutes: Number(row.lead_time_minutes ?? 30),
    minOrderIncl: toNum(row.min_order_incl),
    blurb: String(row.blurb ?? ''),
    paidStatusId: row.paid_status_id === null ? null : Number(row.paid_status_id),
    reviewsEnabled: !!row.reviews_enabled,
    showStock: !!row.show_stock,
    showPhotos: !!row.show_photos,
    showBrands: !!row.show_brands,
    showDepartmentImages: !!row.show_department_images,
    currencyCode: String(row.currency_code ?? 'ZAR').slice(0, 3).toUpperCase(),
    currencySymbol: String(row.currency_symbol ?? 'R').slice(0, 4),
    basketReminders: !!row.basket_reminders,
    // Defaulted rather than trusted: a store that has not run 072 yet returns
    // undefined here, and 0 hours would make every basket instantly "abandoned".
    basketReminderHours: Number(row.basket_reminder_hours) > 0
      ? Number(row.basket_reminder_hours)
      : 4,
    basketReminderNote: String(row.basket_reminder_note ?? ''),
    // Defaulted rather than trusted: a store that has not run 076 yet returns
    // undefined here, and NaN would silently switch holding off.
    holdMinutes: Number.isFinite(Number(row.hold_minutes)) ? Number(row.hold_minutes) : 60,
    // Both default to "not indexed" when the column is absent, so a store that
    // has not run 078 keeps the pre-078 behaviour rather than being published
    // by a missing value.
    allowIndexing: !!row.allow_indexing,
    publicDomain: String(row.public_domain ?? ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : null,
    updatedBy: String(row.updated_by ?? ''),
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/** What the Setup screen may change. Everything else on the row is derived. */
/**
 * What the Setup screen may write.
 *
 * `allowIndexing` is omitted alongside the audit columns because it is not this
 * screen's to set — it belongs to the page builder's presentation settings
 * (077). Leaving it in the input type would let a save from here silently
 * overwrite what the builder had chosen.
 */
export type OnlineSettingsInput = Omit<
  OnlineSettings,
  'updatedAt' | 'updatedBy' | 'allowIndexing'
>

/**
 * The checks that run before a storefront may go live.
 *
 * Each one exists because the failure it prevents is silent and looks to the
 * shopper like a decision the shop made:
 *
 *   No fulfilment method — nothing can be ordered at all.
 *   An empty publish mode — a shop with no products in it.
 *   Delivery with no zones — every address is refused, which reads as
 *     "we don't deliver to you" rather than "setup is unfinished".
 *
 * They run ONLY when enabling. Saving a half-configured store while it is off
 * is legitimate and must stay possible.
 */
async function blockingProblem(
  siteId: number,
  input: OnlineSettingsInput,
): Promise<string | null> {
  if (!input.isEnabled) return null

  if (!input.collectEnabled && !input.deliverEnabled) {
    return 'Choose collection, delivery, or both before opening the store.'
  }

  if (input.publishMode !== 'all') {
    const counts = await getPublishCounts(siteId)
    if (input.publishMode === 'departments' && counts.departments === 0) {
      return (
        'No departments are set to show online, so the store would be empty. ' +
        'Tick “Show in online store” on a department first.'
      )
    }
    if (input.publishMode === 'flagged' && counts.flagged === 0) {
      return (
        'No products are set to show online, so the store would be empty. ' +
        'Tick “Show in online store” on a product first.'
      )
    }
  }

  if (input.deliverEnabled) {
    const zones = await listDeliveryZones(siteId, true)
    if (zones.length === 0) {
      return (
        'Add at least one delivery area before offering delivery — ' +
        'otherwise every delivery address is turned away.'
      )
    }
  }

  // Taking money online needs a payment account that actually works. Without
  // one the storefront would offer a Pay button that goes nowhere, and the
  // shopper would conclude the shop is broken rather than unconfigured.
  if (input.paymentMode === 'online' && !(await canTakePayments(siteId))) {
    return 'Connect a working payment account before asking customers to pay online.'
  }

  return null
}

export async function saveOnlineSettings(
  siteId: number,
  input: OnlineSettingsInput,
  updatedBy: string,
): Promise<SaveResult> {
  if (input.leadTimeMinutes < 0 || input.leadTimeMinutes > 10_080) {
    return { ok: false, error: 'Preparation time must be between 0 minutes and 7 days.' }
  }
  if (input.minOrderIncl < 0) {
    return { ok: false, error: 'Minimum order cannot be negative.' }
  }

  const problem = await blockingProblem(siteId, input)
  if (problem) return { ok: false, error: problem }

  await siteExecute(
    siteId,
    `UPDATE online_store_settings
        SET is_enabled = ?, collect_enabled = ?, deliver_enabled = ?,
            payment_mode = ?, allow_account = ?, publish_mode = ?,
            price_structure_id = ?, lead_time_minutes = ?, min_order_incl = ?,
            blurb = ?, paid_status_id = ?, reviews_enabled = ?,
            show_stock = ?, show_photos = ?, show_brands = ?,
            show_department_images = ?,
            currency_code = ?, currency_symbol = ?,
            basket_reminders = ?, basket_reminder_hours = ?, basket_reminder_note = ?,
            hold_minutes = ?,
            public_domain = ?,
            updated_by = ?
      WHERE id = 1`,
    [
      input.isEnabled ? 1 : 0,
      input.collectEnabled ? 1 : 0,
      input.deliverEnabled ? 1 : 0,
      input.paymentMode,
      input.allowAccount ? 1 : 0,
      input.publishMode,
      input.priceStructureId,
      input.leadTimeMinutes,
      input.minOrderIncl.toFixed(4),
      input.blurb.slice(0, 500),
      input.paidStatusId,
      input.reviewsEnabled ? 1 : 0,
      input.showStock ? 1 : 0,
      input.showPhotos ? 1 : 0,
      input.showBrands ? 1 : 0,
      input.showDepartmentImages ? 1 : 0,
      // Three letters, upper case — the shape schema.org and a gateway expect.
      String(input.currencyCode ?? 'ZAR').trim().toUpperCase().slice(0, 3) || 'ZAR',
      String(input.currencySymbol ?? 'R').trim().slice(0, 4) || 'R',
      input.basketReminders ? 1 : 0,
      // Clamped rather than trusted: 0 would make every basket instantly
      // "abandoned" and chase someone who is still shopping, and an absurd
      // upper value would silently disable the feature.
      Math.min(Math.max(Math.round(input.basketReminderHours) || 4, 1), 168),
      input.basketReminderNote.slice(0, 500),
      // Clamped to a week. 0 is meaningful — it switches holding off — so the
      // floor is 0 rather than 1, unlike the reminder delay above.
      Math.min(Math.max(Math.round(input.holdMinutes) || 0, 0), 60 * 24 * 7),
      // allow_indexing is deliberately absent: it is written from the page
      // builder's presentation settings (077), and writing it here too would
      // give one switch two owners.
      //
      // Normalised to a bare host: a shopkeeper types whatever is in their
      // address bar, and "https://shop.example.co.za/" with a scheme and a
      // trailing slash would produce "https://https://shop…/" in a canonical.
      normaliseDomain(input.publicDomain),
      updatedBy.slice(0, 120),
    ],
  )

  return { ok: true }
}

/**
 * A bare host, from whatever a shopkeeper pasted in.
 *
 * They type what is in their address bar, which is usually a whole URL. Stored
 * raw, "https://shop.example.co.za/" becomes "https://https://shop…/" the
 * moment a canonical link is built from it — a broken tag on every page, and
 * one nobody would notice without viewing source.
 */
export function normaliseDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return ''
  const withoutScheme = trimmed.replace(/^https?:\/\//, '')
  const host = withoutScheme.split('/')[0]?.split('?')[0] ?? ''
  // A host has a dot and no spaces. Anything else is a typo, and storing it
  // would put a broken canonical on every page rather than none.
  if (!host.includes('.') || /\s/.test(host)) return ''
  return host.slice(0, 190)
}

/* ── Publish counts ───────────────────────────────────────────────────────── */

/**
 * What each publish mode would expose, in one round trip.
 *
 * 'departments' counts products whose department is ticked — including
 * products filed under a ticked department's CHILDREN, since a shop that ticks
 * "Groceries" means everything under it. The recursive CTE is what makes that
 * true for a tree of any depth.
 */
export async function getPublishCounts(siteId: number): Promise<PublishCounts> {
  const row = await siteQueryOne<Row>(
    siteId,
    `WITH RECURSIVE published AS (
       SELECT id FROM departments WHERE show_online = 1
       UNION ALL
       SELECT d.id FROM departments d JOIN published pub ON d.parent_id = pub.id
     )
     SELECT
       COUNT(*) AS total,
       SUM(p.department_id IN (SELECT id FROM published)) AS in_departments,
       SUM(p.show_online = 1)                             AS flagged
     FROM products p
     WHERE ${SELLABLE}`,
  )

  const total = Number(row?.total ?? 0)
  return {
    total,
    all: total,
    departments: Number(row?.in_departments ?? 0),
    flagged: Number(row?.flagged ?? 0),
  }
}

/* ── Which departments publish ────────────────────────────────────────────── */

export type DepartmentVisibility = {
  id: number
  parentId: number | null
  name: string
  showOnline: boolean
  /** Products filed directly here, not counting descendants. */
  productCount: number
  /** True when an ancestor is ticked, so this publishes without its own tick. */
  publishedByParent: boolean
}

/**
 * The department tree with its publish flags.
 *
 * `publishedByParent` is the part that matters: ticking "Groceries" publishes
 * everything under it, so a child showing an unticked switch would read as
 * "this is hidden" when it is not. The screen uses this to say
 * "shown via Groceries" instead, which is the difference between a control an
 * owner trusts and one they fight.
 */
export async function listDepartmentVisibility(
  siteId: number,
): Promise<DepartmentVisibility[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.parent_id, d.name, d.show_online, d.sort_order,
            (SELECT COUNT(*) FROM products p
              WHERE p.department_id = d.id AND ${SELLABLE}) AS product_count
       FROM departments d
      WHERE d.is_active = 1
      ORDER BY d.sort_order, d.name`,
  )

  const all = rows.map((r) => ({
    id: Number(r.id),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    name: String(r.name),
    showOnline: !!r.show_online,
    productCount: Number(r.product_count ?? 0),
    publishedByParent: false,
  }))

  // Walk up each department's ancestry. Done here rather than in SQL because
  // the tree is small and read once, and a second recursive CTE for a flag the
  // screen only displays is not worth the query.
  const byId = new Map(all.map((d) => [d.id, d]))
  for (const dept of all) {
    let parentId = dept.parentId
    const seen = new Set<number>([dept.id])
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      if (parent.showOnline) {
        dept.publishedByParent = true
        break
      }
      parentId = parent.parentId
    }
  }

  return all
}

export async function setDepartmentVisibility(
  siteId: number,
  departmentId: number,
  showOnline: boolean,
): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE departments SET show_online = ? WHERE id = ?`,
    [showOnline ? 1 : 0, departmentId],
  )
  if (result.affectedRows === 0) {
    return { ok: false, error: 'That department no longer exists.' }
  }
  return { ok: true }
}

/* ── Individual product visibility ──────────────────────────────────────────
 *
 * The per-product counterpart to the department tree above. Same idea, one level
 * lower: a tick per product rather than per department.
 */

export type ProductVisibility = {
  id: number
  code: string
  description: string
  departmentId: number | null
  /** The tile token, so a row shows the same colour the till does. */
  imageColor: string | null
  showOnline: boolean
  /**
   * True when this product's DEPARTMENT publishes it, tick or no tick.
   *
   * The same reasoning as `DepartmentVisibility.publishedByParent`: under
   * `departments` publish mode a product with an unticked switch may still be in the
   * shop, and a switch whose position contradicts the storefront is a control an owner
   * fights rather than trusts. The screen says "shown via its department" instead.
   */
  publishedByDepartment: boolean
}

export type ProductVisibilityOptions = {
  search?: string
  /**
   * Departments to narrow to — a subtree, expanded by the CALLER.
   *
   * Passed as a resolved list rather than one id because the page already holds the
   * whole department tree for its filter dropdown, so expanding there costs nothing
   * while a recursive CTE here would be a second definition of "beneath".
   */
  departmentIds?: number[] | null
  /** `shown` and `hidden` filter on the product's OWN tick, not on the effective one. */
  only?: 'shown' | 'hidden' | null
  limit?: number
  offset?: number
}

/**
 * The product file with its publish flags, filtered and paged.
 *
 * Returns `total` for the whole filter rather than the page, because the screen's bulk
 * actions act on the filter — "Show all 4,312" has to be able to say 4,312 while
 * showing 50.
 */
export async function listProductVisibility(
  siteId: number,
  options: ProductVisibilityOptions = {},
): Promise<{ items: ProductVisibility[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
  const offset = Math.max(options.offset ?? 0, 0)

  const where: string[] = [SELLABLE]
  const params: unknown[] = []

  const search = options.search?.trim()
  if (search) {
    where.push('(p.code LIKE ? OR p.description LIKE ? OR p.barcode = ?)')
    params.push(`%${search}%`, `%${search}%`, search)
  }
  if (options.departmentIds && options.departmentIds.length > 0) {
    where.push(`p.department_id IN (${options.departmentIds.map(() => '?').join(',')})`)
    params.push(...options.departmentIds)
  }
  if (options.only === 'shown') where.push('p.show_online = 1')
  if (options.only === 'hidden') where.push('p.show_online = 0')

  const clause = where.join(' AND ')

  const countRow = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM products p WHERE ${clause}`,
    params,
  )

  /* `published` is the same recursive expansion getPublishCounts uses: ticking a parent
     department publishes everything beneath it. Shared shape rather than shared code
     because that one aggregates and this one joins per row — but if either changes, the
     other has to, and a mismatch would show as a badge that disagrees with the shop. */
  const rows = await siteQuery<Row>(
    siteId,
    `WITH RECURSIVE published (id) AS (
       SELECT id FROM departments WHERE show_online = 1 AND is_active = 1
       UNION ALL
       SELECT d.id FROM departments d JOIN published pub ON d.parent_id = pub.id
     )
     SELECT p.id, p.code, p.description, p.department_id, p.image_color, p.show_online,
            (p.department_id IN (SELECT id FROM published)) AS published_by_department
       FROM products p
      WHERE ${clause}
      ORDER BY p.description
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )

  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      code: String(r.code ?? ''),
      description: String(r.description ?? ''),
      departmentId: r.department_id === null ? null : Number(r.department_id),
      imageColor: r.image_color ? String(r.image_color) : null,
      showOnline: !!r.show_online,
      publishedByDepartment: !!r.published_by_department,
    })),
    total: Number(countRow?.n ?? 0),
  }
}

/** Ticks or unticks one product. */
export async function setProductVisibility(
  siteId: number,
  productId: number,
  showOnline: boolean,
): Promise<SaveResult> {
  const result = await siteExecute(siteId, `UPDATE products SET show_online = ? WHERE id = ?`, [
    showOnline ? 1 : 0,
    productId,
  ])
  if (result.affectedRows === 0) {
    return { ok: false, error: 'That product no longer exists.' }
  }
  return { ok: true }
}

/**
 * Ticks or unticks everything the filter matches — not just the page.
 *
 * One UPDATE against the same predicate `listProductVisibility` selects on, rather than
 * a loop over ids the client sent. Two reasons, and the second is the important one:
 * 40,000 individual updates would be slow, and a client-supplied id list is a client
 * deciding which rows to change. "Show all 4,312" must mean the 4,312 the filter
 * describes, which is what the button says.
 *
 * `only` is deliberately IGNORED here. Bulk-applying to a filter that includes "only
 * the hidden ones" would make the set shrink as the update ran, so the button acts on
 * the search and department filter and leaves the tick state out of its own condition.
 */
export async function setProductVisibilityBulk(
  siteId: number,
  options: ProductVisibilityOptions,
  showOnline: boolean,
): Promise<{ ok: true; changed: number } | { ok: false; error: string }> {
  const where: string[] = [SELLABLE]
  const params: unknown[] = [showOnline ? 1 : 0]

  const search = options.search?.trim()
  if (search) {
    where.push('(p.code LIKE ? OR p.description LIKE ? OR p.barcode = ?)')
    params.push(`%${search}%`, `%${search}%`, search)
  }
  if (options.departmentIds && options.departmentIds.length > 0) {
    where.push(`p.department_id IN (${options.departmentIds.map(() => '?').join(',')})`)
    params.push(...options.departmentIds)
  }

  const result = await siteExecute(
    siteId,
    `UPDATE products p SET p.show_online = ? WHERE ${where.join(' AND ')}`,
    params,
  )
  return { ok: true, changed: result.affectedRows }
}

/* ── Delivery zones ───────────────────────────────────────────────────────── */

export async function listDeliveryZones(
  siteId: number,
  activeOnly = false,
): Promise<DeliveryZone[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM online_delivery_zones
      ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order, name`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    matchType: String(r.match_type) as DeliveryZone['matchType'],
    matchValue: String(r.match_value),
    feeIncl: toNum(r.fee_incl),
    freeOverIncl: toNum(r.free_over_incl),
    minOrderIncl: toNum(r.min_order_incl),
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order),
  }))
}

export type ZoneInput = {
  id?: number
  name: string
  matchType: 'suburb' | 'postcode'
  matchValue: string
  feeIncl: number
  freeOverIncl: number
  minOrderIncl: number
  isActive: boolean
  sortOrder: number
}

export async function saveDeliveryZone(siteId: number, input: ZoneInput): Promise<SaveResult> {
  const name = input.name.trim()
  const matchValue = input.matchValue.trim()
  if (!name) return { ok: false, error: 'Give the area a name.' }
  if (!matchValue) {
    return {
      ok: false,
      error:
        input.matchType === 'suburb'
          ? 'Enter the suburb this area covers.'
          : 'Enter the postal code this area covers.',
    }
  }
  if (input.feeIncl < 0) return { ok: false, error: 'A delivery fee cannot be negative.' }

  try {
    if (input.id) {
      await siteExecute(
        siteId,
        `UPDATE online_delivery_zones
            SET name = ?, match_type = ?, match_value = ?, fee_incl = ?,
                free_over_incl = ?, min_order_incl = ?, is_active = ?, sort_order = ?
          WHERE id = ?`,
        [
          name,
          input.matchType,
          matchValue,
          input.feeIncl.toFixed(4),
          input.freeOverIncl.toFixed(4),
          input.minOrderIncl.toFixed(4),
          input.isActive ? 1 : 0,
          input.sortOrder,
          input.id,
        ],
      )
    } else {
      await siteExecute(
        siteId,
        `INSERT INTO online_delivery_zones
           (name, match_type, match_value, fee_incl, free_over_incl, min_order_incl, is_active, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          name,
          input.matchType,
          matchValue,
          input.feeIncl.toFixed(4),
          input.freeOverIncl.toFixed(4),
          input.minOrderIncl.toFixed(4),
          input.isActive ? 1 : 0,
          input.sortOrder,
        ],
      )
    }
    return { ok: true }
  } catch (error) {
    // The unique key on (match_type, match_value) is what stops two areas
    // claiming one suburb, which would make the fee depend on row order.
    if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
      return { ok: false, error: `Another area already covers “${matchValue}”.` }
    }
    throw error
  }
}

export async function deleteDeliveryZone(siteId: number, id: number): Promise<SaveResult> {
  // Orders keep their zone_id, so a deleted zone would strand the fee's
  // explanation. Refuse while any order references it and let the store
  // deactivate instead.
  const used = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM online_orders WHERE zone_id = ?`,
    [id],
  )
  if (Number(used?.n ?? 0) > 0) {
    return {
      ok: false,
      error: 'Orders have been delivered to this area. Switch it off instead of deleting it.',
    }
  }
  await siteExecute(siteId, `DELETE FROM online_delivery_zones WHERE id = ?`, [id])
  return { ok: true }
}

/* ── Order statuses ───────────────────────────────────────────────────────── */

export async function listOrderStatuses(
  siteId: number,
  activeOnly = false,
): Promise<OrderStatus[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM online_order_statuses
      ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order, id`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    tone: String(r.tone) as OrderStatus['tone'],
    sortOrder: Number(r.sort_order),
    role: String(r.role) as OrderStatus['role'],
    isActive: !!r.is_active,
    // Coerced rather than trusted: one malformed row must not take down the
    // whole order queue.
    notifyKind: (STATUS_NOTIFY_KINDS as readonly string[]).includes(String(r.notify_kind))
      ? (String(r.notify_kind) as StatusNotifyKind)
      : '',
    useTemplate: !!r.use_template,
    emailSubject: String(r.email_subject ?? ''),
    // Sanitised on READ as well as on write: a row could predate the
    // sanitiser, or have been edited straight in the database.
    emailHtml: sanitiseEmailHtml(String(r.email_html ?? '')),
  }))
}

/* ── Editing the pipeline ─────────────────────────────────────────────────── */

/** How many orders sit in each status right now, keyed by status id. */
export async function statusOrderCounts(siteId: number): Promise<Map<number, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT status_id, COUNT(*) AS n FROM online_orders GROUP BY status_id`,
  )
  return new Map(rows.map((r) => [Number(r.status_id), Number(r.n)]))
}

/**
 * A stable key derived from the name ONCE, on creation.
 *
 * Never regenerated on rename: the code is what an order carries, so renaming
 * "Ready" to "Waiting at the counter" must not strand every order sitting in
 * it. That is the whole reason a code exists separately from a name.
 */
function makeCode(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return base || 'status'
}

export async function saveOrderStatus(
  siteId: number,
  input: OrderStatusInput,
): Promise<SaveResult> {
  const name = input.name.trim().slice(0, 60)
  if (!name) return { ok: false, error: 'Give the status a name.' }

  const useTemplate = input.useTemplate
  const emailHtml = sanitiseEmailHtml(input.emailHtml)
  const emailSubject = input.emailSubject.trim().slice(0, 255)

  if (useTemplate && !emailHtml.trim()) {
    return { ok: false, error: 'Write the email you want this status to send, or switch it off.' }
  }
  if (useTemplate && !emailSubject) {
    return { ok: false, error: 'Give the email a subject line.' }
  }

  const existing = await listOrderStatuses(siteId)
  const current = input.id ? existing.find((s) => s.id === input.id) : null

  /*
   * A required role cannot simply be moved off a status — it has to be given
   * to another one first. Otherwise a shop can leave itself with nowhere for a
   * new order to land, and only find out when the next one arrives.
   */
  if (current && current.role && (REQUIRED_ROLES as readonly string[]).includes(current.role)) {
    if (input.role !== current.role) {
      return {
        ok: false,
        error: `“${current.name}” is the status that means ${roleMeaning(current.role)}. Give that to another status first, then change this one.`,
      }
    }
    if (!input.isActive) {
      return {
        ok: false,
        error: `“${current.name}” is the status that means ${roleMeaning(current.role)}, so it has to stay switched on. Give that to another status first.`,
      }
    }
  }

  if (!current && input.role && (REQUIRED_ROLES as readonly string[]).includes(input.role) && !input.isActive) {
    return { ok: false, error: 'A status with a job to do has to stay switched on.' }
  }

  return siteTransaction(siteId, async (tx) => {
    /*
     * A role is MOVED, never duplicated. Clearing it from whoever holds it now
     * is what makes "only one status can mean this" true, rather than a rule
     * the screen merely asks people to respect.
     */
    if (input.role) {
      await tx.query(
        `UPDATE online_order_statuses SET role = '' WHERE role = ? AND id <> ?`,
        [input.role, input.id ?? 0],
      )
    }

    if (input.id) {
      await tx.query(
        `UPDATE online_order_statuses
            SET name = ?, tone = ?, role = ?, is_active = ?,
                notify_kind = ?, use_template = ?, email_subject = ?, email_html = ?
          WHERE id = ?`,
        [
          name,
          input.tone,
          input.role,
          input.isActive ? 1 : 0,
          input.notifyKind,
          useTemplate ? 1 : 0,
          emailSubject,
          emailHtml,
          input.id,
        ],
      )
      return { ok: true as const }
    }

    // A new status lands at the END. Slotting it into the middle would change
    // the meaning of a pipeline the shop already works to.
    const nextSort = Math.max(0, ...existing.map((s) => s.sortOrder)) + 10

    // The code has to be unique, and two statuses can easily be named
    // similarly. Suffix until one is free rather than refusing the name.
    const base = makeCode(name)
    const taken = new Set(existing.map((s) => s.code))
    let code = base
    for (let n = 2; taken.has(code) && n < 500; n++) code = `${base.slice(0, 26)}_${n}`
    if (taken.has(code)) {
      return { ok: false as const, error: 'Too many statuses with that name — try a different one.' }
    }

    await tx.query(
      `INSERT INTO online_order_statuses
         (code, name, tone, sort_order, role, is_active,
          notify_kind, use_template, email_subject, email_html)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        code,
        name,
        input.tone,
        nextSort,
        input.role,
        input.isActive ? 1 : 0,
        input.notifyKind,
        useTemplate ? 1 : 0,
        emailSubject,
        emailHtml,
      ],
    )
    return { ok: true as const }
  })
}

export async function deleteOrderStatus(siteId: number, id: number): Promise<SaveResult> {
  const status = (await listOrderStatuses(siteId)).find((s) => s.id === id)
  if (!status) return { ok: false, error: 'That status no longer exists.' }

  if (status.role && (REQUIRED_ROLES as readonly string[]).includes(status.role)) {
    return {
      ok: false,
      error: `“${status.name}” is the status that means ${roleMeaning(status.role)}, so it can't be deleted. Give that to another status first.`,
    }
  }

  /*
   * Orders in it block deletion, because the alternative is orders pointing at
   * a status that no longer exists. The refusal names the way out — switching
   * it off keeps those orders labelled and takes it off the buttons.
   */
  const count = (await statusOrderCounts(siteId)).get(id) ?? 0
  if (count > 0) {
    return {
      ok: false,
      error: `${count} order${count === 1 ? ' is' : 's are'} in “${status.name}”, so deleting it would leave ${count === 1 ? 'it' : 'them'} with no status. Switch it off instead — it disappears from the buttons and those orders keep their label.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM online_order_statuses WHERE id = ?`, [id])
  return { ok: true }
}

/**
 * Put the pipeline in this order.
 *
 * Ids the caller left out are APPENDED rather than dropped, and ids that are
 * not this shop's are ignored — so a stale browser tab cannot silently remove
 * a status from the workflow by not knowing about it.
 */
export async function reorderOrderStatuses(siteId: number, ids: number[]): Promise<SaveResult> {
  const existing = await listOrderStatuses(siteId)
  const known = new Set(existing.map((s) => s.id))
  const ordered = ids.filter((id) => known.has(id))
  for (const s of existing) if (!ordered.includes(s.id)) ordered.push(s.id)

  await siteTransaction(siteId, async (tx) => {
    for (const [index, id] of ordered.entries()) {
      // Gaps of ten, so a later insert can be slotted between two without
      // rewriting the whole list.
      await tx.query(`UPDATE online_order_statuses SET sort_order = ? WHERE id = ?`, [
        (index + 1) * 10,
        id,
      ])
    }
  })
  return { ok: true }
}
