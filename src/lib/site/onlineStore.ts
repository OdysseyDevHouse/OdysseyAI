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
    updatedAt: row.updated_at instanceof Date ? row.updated_at : null,
    updatedBy: String(row.updated_by ?? ''),
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/** What the Setup screen may change. Everything else on the row is derived. */
export type OnlineSettingsInput = Omit<OnlineSettings, 'updatedAt' | 'updatedBy'>

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
            show_stock = ?, show_photos = ?, show_brands = ?, updated_by = ?
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
      updatedBy.slice(0, 120),
    ],
  )

  return { ok: true }
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
