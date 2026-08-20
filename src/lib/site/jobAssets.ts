import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { nextDocumentNumber } from './sequences'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { getSetting } from './settings'

/**
 * Customer equipment: the thing the work is done on.
 *
 * ── THREE TABLES THAT LOOK ALIKE AND ARE NOT ───────────────────────────────
 *
 *   fixed_assets      what the BUSINESS owns and depreciates (046)
 *   product_serials   a unit WE bought or sold (021)
 *   customer_assets   what we look after for somebody else
 *
 * A customer air conditioner belongs only in the third. Putting it in the first
 * would place customer equipment on our balance sheet; requiring the second would
 * mean inventing a fake product and a fake serial for every unit fitted by
 * somebody else in 2011, and that fake serial would then count toward serial
 * invariant S1.
 *
 * So `product_id` and `serial_id` are nullable and set ONLY when we sold the unit.
 * `serial_text` is what is stamped on the plate, which is what a technician
 * standing in front of it will read.
 *
 * ── SERVICE HISTORY IS A QUERY ──────────────────────────────────────────────
 *
 * `assetHistory()` is `SELECT ... FROM job_cards WHERE asset_id = ?`. A history
 * table would be a second copy of what the job list already knows, and the two
 * would drift the first time a job was cancelled.
 *
 * ── THE DUPLICATE CHECK IS A GENERATED COLUMN ───────────────────────────────
 *
 * `serial_key` is `UPPER(REPLACE(REPLACE(serial_text,' ',''),'-',''))`, STORED and
 * indexed. Normalising in code would mean every caller had to remember to, and one
 * that forgot would silently create the duplicate the check exists to prevent.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * Every job an asset appears on — as the primary asset OR as one of the others.
 *
 * ── WHY THIS IS A SHARED STRING AND NOT FOUR QUERIES ───────────────────────
 *
 * Before 161 a job named one asset, and "the jobs for this asset" was
 * `WHERE asset_id = ?` written out in ELEVEN places in this file: the history
 * query, three separate job_count subqueries, an open-job count, the setter and
 * the unlinker.
 *
 * Adding a join table and updating only the history query is the failure mode
 * that looks like working software — an asset would show four jobs on its own
 * screen and six in the history below it, and neither number would look
 * obviously wrong. So every count and every listing goes through these two
 * fragments, and a fifth caller cannot forget the second half.
 *
 * `?` binds the asset id. UNION rather than UNION ALL, so a job that names an
 * asset BOTH as primary and in the join table is counted once — which is a
 * shape the UNIQUE key does not prevent, because the two live in different
 * tables.
 */
const JOB_IDS_FOR_ASSET = `
  SELECT id FROM job_cards WHERE asset_id = ?
  UNION
  SELECT job_card_id FROM job_card_assets WHERE asset_id = ?`

/**
 * The same count, correlated to an outer `a.id`.
 *
 * ── WHY THIS IS NOT THE UNION ABOVE WRAPPED IN COUNT(*) ────────────────────
 *
 * Because MySQL will not do it. A derived table — `FROM (SELECT … ) x` — cannot
 * see a column from the enclosing query, so the obvious
 * `(SELECT COUNT(*) FROM (<union on a.id>) jc)` fails at runtime with
 * "Unknown column 'a.id' in 'WHERE'". It typechecks, it reads correctly, and it
 * throws the first time a screen loads.
 *
 * Counting job_cards with an OR over the two sources does correlate, and counts
 * each job once without needing DISTINCT — a job is one row in job_cards
 * whether it names the asset as primary, as secondary, or as both.
 */
const JOB_COUNT_FOR_ASSET = `
  SELECT COUNT(*) FROM job_cards j
   WHERE j.asset_id = a.id
      OR EXISTS (SELECT 1 FROM job_card_assets ja
                  WHERE ja.job_card_id = j.id AND ja.asset_id = a.id)`

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/** A DATE column, as YYYY-MM-DD. Never String(driverDate) — that is a locale. */
const dateOnly = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  }
  const raw = String(value)
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

/* ── Types of equipment ────────────────────────────────────────────────────── */

export type AssetType = {
  id: number
  code: string
  name: string
  serviceMonths: number | null
  identifierLabel: string
  sortOrder: number
  isActive: boolean
  assetCount: number
}

export async function listAssetTypes(
  siteId: number,
  includeInactive = true,
): Promise<AssetType[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.code, t.name, t.service_months, t.identifier_label, t.sort_order, t.is_active,
            (SELECT COUNT(*) FROM customer_assets a WHERE a.asset_type_id = t.id) AS asset_count
       FROM asset_types t
      ${includeInactive ? '' : 'WHERE t.is_active = 1'}
      ORDER BY t.sort_order, t.name`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    serviceMonths: r.service_months === null ? null : Number(r.service_months),
    identifierLabel: String(r.identifier_label),
    sortOrder: Number(r.sort_order),
    isActive: Number(r.is_active) === 1,
    assetCount: Number(r.asset_count ?? 0),
  }))
}

export type AssetResult = { ok: true; id: number } | { ok: false; error: string }
export type AssetActionResult = { ok: true } | { ok: false; error: string }

export type AssetTypeInput = {
  id: number | null
  code: string
  name: string
  serviceMonths: number | null
  identifierLabel: string
  sortOrder: number
  isActive: boolean
}

/**
 * Pure, so the screen refuses what the action refuses.
 *
 * `identifierLabel` exists because the PRD asks for the asset field label to be
 * customisable: a vehicle has a VIN, a machine has a serial, a meter has an asset
 * tag, and a technician typing into a box marked the wrong thing hesitates.
 */
export function validateAssetType(input: AssetTypeInput): string | null {
  const code = input.code.trim()
  if (!code) return 'Give this kind of equipment a short code.'
  if (!/^[A-Z0-9_-]{1,40}$/.test(code)) {
    return 'A code may only use capital letters, numbers, hyphens and underscores.'
  }
  if (!input.name.trim()) return 'Give it a name.'
  if (input.name.trim().length > 120) return 'That name is too long.'
  if (!input.identifierLabel.trim()) return 'Say what the identifying number is called.'

  if (input.serviceMonths !== null) {
    if (!Number.isFinite(input.serviceMonths) || input.serviceMonths <= 0) {
      return 'A service interval must be more than zero months, or left blank for on-demand.'
    }
    // Ten years. Past this it is not an interval, it is a typo.
    if (input.serviceMonths > 120) return 'That service interval is longer than ten years.'
  }
  return null
}

export async function saveAssetType(
  siteId: number,
  actor: Actor,
  input: AssetTypeInput,
): Promise<AssetResult> {
  const refusal = validateAssetType(input)
  if (refusal) return { ok: false, error: refusal }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM asset_types WHERE code = ? AND id <> ? LIMIT 1`,
    [code, input.id ?? 0],
  )
  if (clash) return { ok: false, error: `Another kind of equipment already uses the code ${code}.` }

  if (input.id === null) {
    const result = await siteExecute(
      siteId,
      `INSERT INTO asset_types (code, name, service_months, identifier_label, sort_order, is_active)
       VALUES (?,?,?,?,?,?)`,
      [
        code,
        input.name.trim(),
        input.serviceMonths,
        input.identifierLabel.trim(),
        input.sortOrder,
        input.isActive ? 1 : 0,
      ],
    )
    return { ok: true, id: Number(result.insertId) }
  }

  // `code` is frozen after creation, the same rule job_statuses and job_headlines
  // follow: renaming relabels every asset instead of stranding it.
  await siteExecute(
    siteId,
    `UPDATE asset_types
        SET name = ?, service_months = ?, identifier_label = ?, sort_order = ?, is_active = ?
      WHERE id = ?`,
    [
      input.name.trim(),
      input.serviceMonths,
      input.identifierLabel.trim(),
      input.sortOrder,
      input.isActive ? 1 : 0,
      input.id,
    ],
  )
  return { ok: true, id: input.id }
}

export async function deleteAssetType(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<AssetActionResult> {
  const cdb = await customerDbPrefix(siteId)
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT t.name, (SELECT COUNT(*) FROM customer_assets a WHERE a.asset_type_id = t.id) AS n
       FROM asset_types t WHERE t.id = ?`,
    [id],
  )
  if (!row) return { ok: false, error: 'That kind of equipment no longer exists.' }

  const used = Number(row.n ?? 0)
  if (used > 0) {
    return {
      ok: false,
      error: `${used} ${used === 1 ? 'asset is' : 'assets are'} recorded as ${row.name}. Switch it off instead of deleting it.`,
    }
  }
  await siteExecute(siteId, `DELETE FROM asset_types WHERE id = ?`, [id])
  return { ok: true }
}

/* ── The assets ────────────────────────────────────────────────────────────── */

export type CustomerAsset = {
  id: number
  documentNumber: string | null
  assetTypeId: number | null
  assetTypeName: string | null
  /** What this trade calls the identifying number. From the type, or a default. */
  identifierLabel: string
  customerId: number | null
  customerName: string | null
  serviceAddressId: number | null
  serviceAddressName: string | null
  description: string
  make: string | null
  model: string | null
  serialText: string | null
  productId: number | null
  productCode: string | null
  /** Set only when we sold the unit — see the module header. */
  serialId: number | null
  installedOn: string | null
  purchasedOn: string | null
  purchaseReference: string | null
  warrantyUntil: string | null
  lastServiceOn: string | null
  nextServiceOn: string | null
  conditionNote: string | null
  note: string | null
  isActive: boolean
  retiredOn: string | null
  retiredReason: string | null
  /** How many jobs reference it. What makes retiring rather than deleting the answer. */
  jobCount: number
}

/**
 * A function rather than a constant: `customers` may live in the group
 * primary's database. `cdb` names it, and is empty for a store that owns its
 * own customers.
 */
const selectAsset = (cdb: string) => `
  SELECT a.id, a.document_number, a.asset_type_id, a.customer_id, a.service_address_id,
         a.description, a.make, a.model, a.serial_text, a.product_id, a.serial_id,
         a.installed_on, a.purchased_on, a.purchase_reference, a.warranty_until,
         a.last_service_on, a.next_service_on, a.condition_note, a.note,
         a.is_active, a.retired_on, a.retired_reason,
         t.name AS type_name, t.identifier_label,
         c.name AS customer_name, sa.name AS address_name, p.code AS product_code,
         (${JOB_COUNT_FOR_ASSET}) AS job_count
    FROM customer_assets a
    LEFT JOIN asset_types t        ON t.id = a.asset_type_id
    LEFT JOIN ${cdb}customers c          ON c.id = a.customer_id
    LEFT JOIN service_addresses sa ON sa.id = a.service_address_id
    LEFT JOIN products p           ON p.id = a.product_id`

const mapAsset = (r: Row): CustomerAsset => ({
  id: Number(r.id),
  documentNumber: text(r.document_number),
  assetTypeId: r.asset_type_id === null ? null : Number(r.asset_type_id),
  assetTypeName: text(r.type_name),
  // The default matters: an asset with no type still needs its field labelled.
  identifierLabel: text(r.identifier_label) ?? 'Serial number',
  customerId: r.customer_id === null ? null : Number(r.customer_id),
  customerName: text(r.customer_name),
  serviceAddressId: r.service_address_id === null ? null : Number(r.service_address_id),
  serviceAddressName: text(r.address_name),
  description: String(r.description),
  make: text(r.make),
  model: text(r.model),
  serialText: text(r.serial_text),
  productId: r.product_id === null ? null : Number(r.product_id),
  productCode: text(r.product_code),
  serialId: r.serial_id === null ? null : Number(r.serial_id),
  installedOn: dateOnly(r.installed_on),
  purchasedOn: dateOnly(r.purchased_on),
  purchaseReference: text(r.purchase_reference),
  warrantyUntil: dateOnly(r.warranty_until),
  lastServiceOn: dateOnly(r.last_service_on),
  nextServiceOn: dateOnly(r.next_service_on),
  conditionNote: text(r.condition_note),
  note: text(r.note),
  isActive: Number(r.is_active) === 1,
  retiredOn: dateOnly(r.retired_on),
  retiredReason: text(r.retired_reason),
  jobCount: Number(r.job_count ?? 0),
})

export type AssetFilter = {
  customerId?: number
  serviceAddressId?: number
  assetTypeId?: number
  search?: string
  /** Equipment whose next service has arrived. The worklist. */
  dueOnly?: boolean
  /**
   * Equipment nobody owns yet — a unit in the workshop.
   *
   * Its own flag rather than `customerId: null`, because a missing customerId
   * already means "do not filter by customer" and overloading it would make the
   * two indistinguishable at the call site.
   */
  unclaimedOnly?: boolean
  includeRetired?: boolean
  limit?: number
}

export async function listAssets(
  siteId: number,
  filter: AssetFilter = {},
): Promise<CustomerAsset[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (!filter.includeRetired) where.push('a.is_active = 1')
  if (filter.customerId) {
    where.push('a.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.serviceAddressId) {
    where.push('a.service_address_id = ?')
    params.push(filter.serviceAddressId)
  }
  if (filter.assetTypeId) {
    where.push('a.asset_type_id = ?')
    params.push(filter.assetTypeId)
  }
  if (filter.unclaimedOnly) where.push('a.customer_id IS NULL')
  if (filter.dueOnly) {
    where.push('a.next_service_on IS NOT NULL AND a.next_service_on <= CURDATE()')
  }
  if (filter.search?.trim()) {
    /*
     * The serial is matched on the NORMALISED key as well as the raw text, so
     * searching "ab12cd" finds a unit recorded as "AB-12 CD". That is the whole
     * point of the generated column, and a search that ignored it would send
     * somebody to create a duplicate.
     */
    const term = `%${filter.search.trim()}%`
    const key = `%${filter.search.trim().toUpperCase().replace(/[\s-]/g, '')}%`
    where.push(
      '(a.description LIKE ? OR a.make LIKE ? OR a.model LIKE ? OR a.serial_text LIKE ?' +
        ' OR a.serial_key LIKE ? OR a.document_number LIKE ? OR c.name LIKE ?)',
    )
    params.push(term, term, term, term, key, term, term)
  }

  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 200)))
  const cdb = await customerDbPrefix(siteId)
  const rows = await siteQuery<Row>(
    siteId,
    `${selectAsset(cdb)}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${filter.dueOnly ? 'a.next_service_on ASC,' : ''} a.description, a.id DESC
      LIMIT ${limit}`,
    params,
  )
  return rows.map(mapAsset)
}

export async function getAsset(siteId: number, id: number): Promise<CustomerAsset | null> {
  const cdb = await customerDbPrefix(siteId)
  const row = await siteQueryOne<Row>(siteId, `${selectAsset(cdb)} WHERE a.id = ?`, [id])
  return row ? mapAsset(row) : null
}

export type AssetInput = {
  id: number | null
  assetTypeId: number | null
  customerId: number | null
  serviceAddressId: number | null
  description: string
  make: string | null
  model: string | null
  serialText: string | null
  productId: number | null
  serialId: number | null
  installedOn: string | null
  purchasedOn: string | null
  purchaseReference: string | null
  warrantyUntil: string | null
  nextServiceOn: string | null
  conditionNote: string | null
  note: string | null
}

/** Pure. The date sanity checks are the ones a typo actually trips. */
export function validateAsset(input: AssetInput): string | null {
  if (!input.description.trim()) return 'Say what the equipment is.'
  if (input.description.trim().length > 190) return 'That description is too long.'

  const bad = (value: string | null) =>
    value !== null && value !== '' && Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
  for (const [label, value] of [
    ['installation', input.installedOn],
    ['purchase', input.purchasedOn],
    ['warranty', input.warrantyUntil],
    ['next service', input.nextServiceOn],
  ] as const) {
    if (bad(value)) return `That ${label} date is not a real date.`
  }

  /*
   * Installed before purchased is possible in one direction only, and worth
   * catching: a fat-fingered year makes a warranty look expired by a decade, and
   * nobody questions a date.
   */
  if (input.installedOn && input.purchasedOn && input.installedOn < input.purchasedOn) {
    return 'The installation date is before the purchase date.'
  }
  // An address belongs to a customer, so one without the other is incoherent.
  if (input.serviceAddressId !== null && input.customerId === null) {
    return 'Choose the customer before choosing which of their sites it is at.'
  }
  return null
}

export type DuplicateWarning = {
  id: number
  documentNumber: string | null
  description: string
  customerName: string | null
}

/**
 * Equipment already on file with the same serial, for the same customer.
 *
 * Matched on the generated `serial_key`, so spacing and case are ignored. Scoped
 * to the customer: two customers can each own a unit whose plate reads 001, and a
 * global check would refuse the second one.
 */
export async function findDuplicateAssets(
  siteId: number,
  serialText: string | null,
  customerId: number | null,
  excludeId = 0,
): Promise<DuplicateWarning[]> {
  const cdb = await customerDbPrefix(siteId)
  const key = (serialText ?? '').trim().toUpperCase().replace(/[\s-]/g, '')
  // No plate, nothing to match on. Section 18.3 is explicit that plenty of
  // equipment has none, so this is a normal outcome rather than a skipped check.
  if (key === '') return []

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.document_number, a.description, c.name AS customer_name
       FROM customer_assets a
       LEFT JOIN ${cdb}customers c ON c.id = a.customer_id
      WHERE a.serial_key = ? AND a.id <> ?
        AND ${customerId === null ? 'a.customer_id IS NULL' : 'a.customer_id = ?'}
      LIMIT 5`,
    customerId === null ? [key, excludeId] : [key, excludeId, customerId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    documentNumber: text(r.document_number),
    description: String(r.description),
    customerName: text(r.customer_name),
  }))
}

export type SaveAssetResult =
  | { ok: true; id: number; documentNumber: string | null; duplicates: DuplicateWarning[] }
  | { ok: false; error: string }

/**
 * Create or update a piece of equipment.
 *
 * The duplicate check WARNS by default rather than refusing: section 18.3 says
 * plenty of equipment has no legible serial, and a hard block would stop somebody
 * recording a real second unit whose plate happens to match. The setting
 * `asset_duplicate_action` makes it a refusal for businesses that want one, and
 * either way the matches come back so the screen can show them.
 */
export async function saveAsset(
  siteId: number,
  actor: Actor,
  input: AssetInput,
): Promise<SaveAssetResult> {
  const refusal = validateAsset(input)
  if (refusal) return { ok: false, error: refusal }

  const duplicates = await findDuplicateAssets(
    siteId,
    input.serialText,
    input.customerId,
    input.id ?? 0,
  )
  const action = await getSetting(siteId, 'asset_duplicate_action').catch(() => 'warn')
  if (duplicates.length > 0 && action === 'block') {
    const first = duplicates[0]
    return {
      ok: false,
      error: `${first.description} (${first.documentNumber ?? `#${first.id}`}) is already on file with that serial for this customer.`,
    }
  }

  return siteTransaction(siteId, async (tx) => {
    if (input.id === null) {
      const [result] = await tx.execute(
        `INSERT INTO customer_assets
           (asset_type_id, customer_id, service_address_id, description, make, model,
            serial_text, product_id, serial_id, installed_on, purchased_on,
            purchase_reference, warranty_until, next_service_on, condition_note, note,
            user_id, user_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.assetTypeId,
          input.customerId,
          input.serviceAddressId,
          input.description.trim(),
          text(input.make),
          text(input.model),
          text(input.serialText),
          input.productId,
          input.serialId,
          text(input.installedOn),
          text(input.purchasedOn),
          text(input.purchaseReference),
          text(input.warrantyUntil),
          text(input.nextServiceOn),
          text(input.conditionNote),
          text(input.note),
          actor.userId,
          actor.userName,
        ],
      )
      const id = Number((result as { insertId: number }).insertId)

      // LAST write before commit: nextDocumentNumber holds a row lock on the
      // sequence, so anything after it holds that lock too.
      const documentNumber = await nextDocumentNumber(tx, 'customer_asset')
      await tx.execute(`UPDATE customer_assets SET document_number = ? WHERE id = ?`, [
        documentNumber,
        id,
      ])

      await logActivityTx(tx, actor, {
        entity: 'customer_asset',
        entityId: id,
        action: 'created',
        detail: `${documentNumber} — ${input.description.trim()}`,
      })
      return { ok: true as const, id, documentNumber, duplicates }
    }

    const [beforeRows] = await tx.query<Row[]>(
      `SELECT document_number, description, customer_id, service_address_id FROM customer_assets WHERE id = ?`,
      [input.id],
    )
    const before = beforeRows[0]
    if (!before) return { ok: false as const, error: 'That equipment no longer exists.' }

    await tx.execute(
      `UPDATE customer_assets
          SET asset_type_id = ?, customer_id = ?, service_address_id = ?, description = ?,
              make = ?, model = ?, serial_text = ?, product_id = ?, serial_id = ?,
              installed_on = ?, purchased_on = ?, purchase_reference = ?, warranty_until = ?,
              next_service_on = ?, condition_note = ?, note = ?
        WHERE id = ?`,
      [
        input.assetTypeId,
        input.customerId,
        input.serviceAddressId,
        input.description.trim(),
        text(input.make),
        text(input.model),
        text(input.serialText),
        input.productId,
        input.serialId,
        text(input.installedOn),
        text(input.purchasedOn),
        text(input.purchaseReference),
        text(input.warrantyUntil),
        text(input.nextServiceOn),
        text(input.conditionNote),
        text(input.note),
        input.id,
      ],
    )

    await logActivityTx(tx, actor, {
      entity: 'customer_asset',
      entityId: input.id,
      action: 'updated',
      detail: input.description.trim(),
    })
    return {
      ok: true as const,
      id: input.id,
      documentNumber: text(before.document_number),
      duplicates,
    }
  })
}

/**
 * Retire a piece of equipment. Never delete one that has been worked on.
 *
 * `status` and `is_active` are written TOGETHER and only here: status exists
 * purely so verifySequence can separate voided numbers from live ones, and two
 * columns saying the same thing would eventually disagree. reconcileAssets()
 * reports it if they do.
 */
export async function retireAsset(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<AssetActionResult> {
  if (!reason.trim()) {
    return { ok: false, error: 'Say why it is being retired — scrapped, replaced, sold on.' }
  }
  const asset = await siteQueryOne<Row>(
    siteId,
    `SELECT id, description, is_active FROM customer_assets WHERE id = ?`,
    [id],
  )
  if (!asset) return { ok: false, error: 'That equipment no longer exists.' }
  if (Number(asset.is_active) === 0) return { ok: false, error: 'That equipment is already retired.' }

  await siteExecute(
    siteId,
    `UPDATE customer_assets
        SET is_active = 0, status = 'cancelled', retired_on = CURDATE(), retired_reason = ?
      WHERE id = ?`,
    [reason.trim(), id],
  )
  await logActivity(siteId, actor, {
    entity: 'customer_asset',
    entityId: id,
    action: 'retired',
    detail: `${asset.description} — ${reason.trim()}`,
  })
  return { ok: true }
}

/** Bring a retired asset back. The mirror of retireAsset, and the other writer. */
export async function reviveAsset(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<AssetActionResult> {
  const asset = await siteQueryOne<Row>(
    siteId,
    `SELECT id, description, is_active FROM customer_assets WHERE id = ?`,
    [id],
  )
  if (!asset) return { ok: false, error: 'That equipment no longer exists.' }
  if (Number(asset.is_active) === 1) return { ok: false, error: 'That equipment is already in use.' }

  await siteExecute(
    siteId,
    `UPDATE customer_assets
        SET is_active = 1, status = 'active', retired_on = NULL, retired_reason = NULL
      WHERE id = ?`,
    [id],
  )
  await logActivity(siteId, actor, {
    entity: 'customer_asset',
    entityId: id,
    action: 'revived',
    detail: String(asset.description),
  })
  return { ok: true }
}

/**
 * Delete, only while nothing has been done to it.
 *
 * fk_jcard_asset is RESTRICT, so a job would refuse this anyway — but a refusal
 * that explains itself beats a foreign key error, and the count is what tells
 * somebody to retire instead.
 */
export async function deleteAsset(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<AssetActionResult> {
  const asset = await siteQueryOne<Row>(
    siteId,
    `SELECT a.id, a.description,
            (${JOB_COUNT_FOR_ASSET}) AS n
       FROM customer_assets a WHERE a.id = ?`,
    [id],
  )
  if (!asset) return { ok: false, error: 'That equipment no longer exists.' }

  const jobs = Number(asset.n ?? 0)
  if (jobs > 0) {
    return {
      ok: false,
      error: `${jobs} ${jobs === 1 ? 'job has' : 'jobs have'} been done on ${asset.description}, so it cannot be deleted — that work is its history. Retire it instead.`,
    }
  }
  await siteExecute(siteId, `DELETE FROM customer_assets WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'customer_asset',
    entityId: id,
    action: 'deleted',
    detail: String(asset.description),
  })
  return { ok: true }
}

export type JobAssetSummary = {
  id: number
  description: string
  documentNumber: string | null
  serialText: string | null
  identifierLabel: string
  warrantyUntil: string | null
  nextServiceOn: string | null
  jobCount: number
}

/**
 * The equipment a job is about, if any.
 *
 * Its own query rather than six more columns on `JobCard`, which a dozen screens
 * already read: widening that type to serve one card would make every one of them
 * carry fields they do not use. The same reasoning as `jobStanding()`.
 *
 * Returns null when the job names no equipment, so the card can render its own
 * empty state rather than the page deciding.
 */
export async function jobAssetFor(
  siteId: number,
  jobId: number,
): Promise<JobAssetSummary | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT a.id, a.description, a.document_number, a.serial_text,
            a.warranty_until, a.next_service_on,
            COALESCE(t.identifier_label, 'Serial number') AS identifier_label,
            (${JOB_COUNT_FOR_ASSET}) AS job_count
       FROM job_cards j
       JOIN customer_assets a  ON a.id = j.asset_id
       LEFT JOIN asset_types t ON t.id = a.asset_type_id
      WHERE j.id = ?`,
    [jobId],
  )
  if (!row) return null
  return {
    id: Number(row.id),
    description: String(row.description),
    documentNumber: text(row.document_number),
    serialText: text(row.serial_text),
    identifierLabel: String(row.identifier_label),
    warrantyUntil: dateOnly(row.warranty_until),
    nextServiceOn: dateOnly(row.next_service_on),
    jobCount: Number(row.job_count ?? 0),
  }
}

/**
 * Point a job at a piece of equipment, or clear it.
 *
 * Refuses equipment belonging to a DIFFERENT customer. That is the mistake a
 * picker makes easy — two customers own the same model, the list is alphabetical —
 * and the consequence is a warranty claim against the wrong account and a service
 * history on the wrong unit. `reconcileAssets` reports the mismatch if one gets in
 * by another route; this stops the ordinary one.
 *
 * Unclaimed equipment (customer_id NULL) is allowed on any job, and naming it on
 * one is often how it gets claimed.
 */
export async function setJobAsset(
  siteId: number,
  actor: Actor,
  jobId: number,
  assetId: number | null,
): Promise<AssetActionResult> {
  const cdb = await customerDbPrefix(siteId)
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, customer_id, customer_name FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so the equipment cannot be changed.' }
  }

  if (assetId === null) {
    await siteExecute(siteId, `UPDATE job_cards SET asset_id = NULL WHERE id = ?`, [jobId])
    await logActivity(siteId, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'asset_cleared',
      detail: 'No equipment named',
    })
    return { ok: true }
  }

  const asset = await siteQueryOne<Row>(
    siteId,
    `SELECT a.id, a.description, a.is_active, a.customer_id, c.name AS customer_name
       FROM customer_assets a
       LEFT JOIN ${cdb}customers c ON c.id = a.customer_id
      WHERE a.id = ?`,
    [assetId],
  )
  if (!asset) return { ok: false, error: 'That equipment no longer exists.' }

  const assetCustomer = asset.customer_id === null ? null : Number(asset.customer_id)
  const jobCustomer = job.customer_id === null ? null : Number(job.customer_id)
  if (assetCustomer !== null && jobCustomer !== null && assetCustomer !== jobCustomer) {
    return {
      ok: false,
      error: `${asset.description} belongs to ${asset.customer_name ?? 'another customer'}, not to this job's customer.`,
    }
  }

  /*
   * Retired equipment can still be named, deliberately: somebody has to be able to
   * log the job that scrapped it, and a final visit to a dead unit is real work.
   * reconcileAssets reports the combination so it does not go unnoticed.
   */
  await siteExecute(siteId, `UPDATE job_cards SET asset_id = ? WHERE id = ?`, [assetId, jobId])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'asset_set',
    detail: String(asset.description),
  })
  return { ok: true }
}

/* ── The other equipment on a job (18.4, migration 161) ───────────────────── */

export type JobAssetRow = {
  id: number
  assetId: number
  documentNumber: string | null
  description: string
  serialText: string | null
  identifierLabel: string
  warrantyUntil: string | null
  isActive: boolean
  note: string | null
}

/**
 * The additional equipment on a job — never the primary one.
 *
 * The primary asset stays where it was, on `job_cards.asset_id`, and is read by
 * `jobAssetFor()`. Keeping the two apart is what lets every existing cost,
 * check and warranty question keep meaning something unambiguous: this list is
 * "what else was looked at", not "the assets, one of which happens to be first".
 */
export async function otherJobAssets(
  siteId: number,
  jobId: number,
): Promise<JobAssetRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ja.id, ja.asset_id, ja.note,
            a.document_number, a.description, a.serial_text, a.warranty_until, a.is_active,
            COALESCE(t.identifier_label, 'Serial number') AS identifier_label
       FROM job_card_assets ja
       JOIN customer_assets a  ON a.id = ja.asset_id
       LEFT JOIN asset_types t ON t.id = a.asset_type_id
      WHERE ja.job_card_id = ?
      ORDER BY ja.sort_order, ja.id`,
    [jobId],
  ).catch(() => [])

  return rows.map((r) => ({
    id: Number(r.id),
    assetId: Number(r.asset_id),
    documentNumber: text(r.document_number),
    description: String(r.description),
    serialText: text(r.serial_text),
    identifierLabel: String(r.identifier_label),
    warrantyUntil: dateOnly(r.warranty_until),
    isActive: Number(r.is_active) === 1,
    note: text(r.note),
  }))
}

/**
 * Put another piece of equipment on a job.
 *
 * Every guard `setJobAsset` applies applies here too, and for the same reasons —
 * a wrong unit added as the fourth on a visit is exactly as wrong as a wrong
 * primary, and the picker offers more chances to make the mistake.
 */
export async function addJobAsset(
  siteId: number,
  actor: Actor,
  jobId: number,
  assetId: number,
  note: string | null = null,
): Promise<AssetActionResult> {
  const cdb = await customerDbPrefix(siteId)
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, customer_id, asset_id FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its equipment cannot be changed.' }
  }

  /*
   * The primary asset is not "another" one.
   *
   * Refused rather than silently ignored: somebody adding the unit already at
   * the top of the screen has misread something, and a row that vanished on
   * save would teach them the button was broken.
   */
  if (job.asset_id !== null && Number(job.asset_id) === assetId) {
    return {
      ok: false,
      error: 'That is already the main piece of equipment on this job.',
    }
  }

  const asset = await siteQueryOne<Row>(
    siteId,
    `SELECT a.id, a.description, a.customer_id, c.name AS customer_name
       FROM customer_assets a
       LEFT JOIN ${cdb}customers c ON c.id = a.customer_id
      WHERE a.id = ?`,
    [assetId],
  )
  if (!asset) return { ok: false, error: 'That equipment no longer exists.' }

  // The same ownership guard setJobAsset applies. See its header: two customers
  // owning the same model is the ordinary way the wrong unit gets picked, and
  // the consequence is a warranty claim against the wrong account.
  const assetCustomer = asset.customer_id === null ? null : Number(asset.customer_id)
  const jobCustomer = job.customer_id === null ? null : Number(job.customer_id)
  if (assetCustomer !== null && jobCustomer !== null && assetCustomer !== jobCustomer) {
    return {
      ok: false,
      error: `${asset.description} belongs to ${asset.customer_name ?? 'another customer'}, not to this job's customer.`,
    }
  }

  // INSERT IGNORE against uq_jca: adding the same unit twice is a mistake, not
  // a quantity, and saying so beats a duplicate row or a raised error.
  const result = await siteExecute(
    siteId,
    `INSERT IGNORE INTO job_card_assets (job_card_id, asset_id, note, sort_order)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(x.sort_order), 0) + 1
                         FROM (SELECT sort_order FROM job_card_assets
                                WHERE job_card_id = ?) x))`,
    [jobId, assetId, text(note), jobId],
  )
  if (result.affectedRows === 0) {
    return { ok: false, error: `${asset.description} is already on this job.` }
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'asset_added',
    detail: String(asset.description),
  })
  return { ok: true }
}

/**
 * Take a piece of equipment off a job.
 *
 * The parts fitted and the checks done STAY — `fk_jcl_asset` and `fk_jci_asset`
 * are ON DELETE SET NULL, so their `asset_id` becomes NULL rather than the rows
 * going. The work happened; what is being withdrawn is the claim about which
 * unit it was done to.
 */
export async function removeJobAsset(
  siteId: number,
  actor: Actor,
  jobId: number,
  assetId: number,
): Promise<AssetActionResult> {
  const job = await siteQueryOne<Row>(siteId, `SELECT id, status FROM job_cards WHERE id = ?`, [
    jobId,
  ])
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its equipment cannot be changed.' }
  }

  const result = await siteExecute(
    siteId,
    `DELETE FROM job_card_assets WHERE job_card_id = ? AND asset_id = ?`,
    [jobId, assetId],
  )
  if (result.affectedRows === 0) {
    return { ok: false, error: 'That equipment is not on this job.' }
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'asset_removed',
    detail: `Equipment #${assetId} removed`,
  })
  return { ok: true }
}

/* ── Service history ──────────────────────────────────────────────────────── */

export type AssetHistoryRow = {
  jobId: number
  documentNumber: string | null
  title: string
  statusName: string
  lifecycle: string
  reportedAt: string | null
  closedAt: string | null
  ownerName: string | null
  /**
   * True when the job was ABOUT this asset, false when it was one of several
   * looked at on the visit (161). "We came out for this" and "we checked it
   * while we were there" are different facts about a warranty.
   */
  isPrimary: boolean
}

/**
 * What has been done to this asset.
 *
 * A query, not a table. See the module header: a history table would be a second
 * copy of the job list and the two would drift the first time a job was cancelled.
 */
export async function assetHistory(
  siteId: number,
  assetId: number,
  limit = 100,
): Promise<AssetHistoryRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    /*
     * Both halves (161): the jobs this asset is the SUBJECT of, and the jobs it
     * was one of several on. A history that showed only the first would tell a
     * technician the unit had never been touched on any multi-unit visit.
     *
     * `is_primary` is carried through because the distinction is real and worth
     * showing: "we came out for this" and "we looked at it while we were there"
     * are different facts about a warranty.
     */
    `SELECT j.id, j.document_number, j.title, j.status, j.reported_at, j.closed_at,
            j.owner_name, s.name AS status_name,
            CASE WHEN j.asset_id = ? THEN 1 ELSE 0 END AS is_primary
       FROM job_cards j
       LEFT JOIN job_statuses s ON s.id = j.status_id
      WHERE j.id IN (${JOB_IDS_FOR_ASSET})
      ORDER BY j.reported_at DESC, j.id DESC
      LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    [assetId, assetId, assetId],
  )
  return rows.map((r) => ({
    jobId: Number(r.id),
    documentNumber: text(r.document_number),
    title: String(r.title),
    statusName: text(r.status_name) ?? '',
    lifecycle: String(r.status),
    reportedAt: dateOnly(r.reported_at),
    closedAt: dateOnly(r.closed_at),
    ownerName: text(r.owner_name),
    isPrimary: Number(r.is_primary) === 1,
  }))
}

/**
 * Roll the service dates forward when a job closes against an asset.
 *
 * Called from setStatus, and TOLERANT: a site without migration 115 has no asset
 * table, and a missing feature must never stop a job being closed.
 *
 * `last_service_on` is set to today and `next_service_on` derived from the type
 * interval. A type with no interval leaves next_service_on alone — on-demand
 * equipment has no next service, and inventing one would fill the due list with
 * work nobody asked for.
 */
export async function recordServiceOnClose(siteId: number, jobId: number): Promise<void> {
  try {
    const enabled = await getSetting(siteId, 'asset_auto_next_service').catch(() => '1')
    if (enabled === '0') return

    await siteExecute(
      siteId,
      /*
       * EVERY asset on the job (161), not only the primary one.
       *
       * Closing a visit that serviced four units must stamp four units. Left as
       * the primary alone, three of them would still be showing as due — and
       * the due list is the screen this whole feature exists to feed, so the
       * failure would be somebody driving out to a unit serviced last week.
       *
       * The subquery names both sources; a job that lists an asset twice (once
       * primary, once in the join table) updates it once, because this is an
       * UPDATE against customer_assets and not a per-row loop.
       */
      `UPDATE customer_assets a
         LEFT JOIN asset_types t ON t.id = a.asset_type_id
          SET a.last_service_on = CURDATE(),
              a.next_service_on = CASE
                WHEN t.service_months IS NULL THEN a.next_service_on
                ELSE DATE_ADD(CURDATE(), INTERVAL t.service_months MONTH)
              END
        WHERE a.id IN (
                SELECT asset_id FROM job_cards WHERE id = ? AND asset_id IS NOT NULL
                UNION
                SELECT asset_id FROM job_card_assets WHERE job_card_id = ?
              )`,
      [jobId, jobId],
    )
  } catch {
    // 115 has not run on this site. Closing the job matters more than the date.
  }
}

export type AssetDrift = {
  /**
   * `status` and `is_active` disagree.
   *
   * Written together by retireAsset/reviveAsset and nowhere else, so a row here
   * means something bypassed them — and verifySequence would then be counting a
   * retired asset number as live, or the reverse.
   */
  statusMismatch: { assetId: number; documentNumber: string | null; isActive: boolean; status: string }[]
  /** An asset with a site belonging to a different customer. */
  addressMismatch: { assetId: number; documentNumber: string | null; description: string }[]
  /** A job whose asset belongs to a different customer than the job does. */
  jobCustomerMismatch: { jobId: number; documentNumber: string | null; assetId: number }[]
  /** Retired equipment still named by an OPEN job. */
  retiredButWorked: { assetId: number; documentNumber: string | null; description: string; jobCount: number }[]
}

/** Drift between the equipment and the work. Reports, never repairs. */
export async function reconcileAssets(siteId: number): Promise<AssetDrift> {
  const [status, address, jobCustomer, retired] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, document_number, is_active, status FROM customer_assets
        WHERE (is_active = 1 AND status <> 'active') OR (is_active = 0 AND status <> 'cancelled')`,
    ),
    /*
     * A site belongs to a customer, so an asset pointing at one that belongs to
     * somebody else means a customer was changed without clearing the site — and
     * the technician would then be sent to the wrong address.
     */
    siteQuery<Row>(
      siteId,
      `SELECT a.id, a.document_number, a.description
         FROM customer_assets a
         JOIN service_addresses sa ON sa.id = a.service_address_id
        WHERE a.customer_id IS NOT NULL AND sa.customer_id <> a.customer_id`,
    ),
    siteQuery<Row>(
      siteId,
      /*
       * A job whose asset belongs to somebody else — checked across BOTH
       * sources (161). Somebody adding the wrong unit to a multi-unit visit
       * makes exactly this mistake, and the secondary case is the likelier one
       * because the picker offers more choices.
       */
      `SELECT j.id, j.document_number, a.id AS asset_id
         FROM job_cards j
         JOIN customer_assets a
           ON a.id = j.asset_id
           OR a.id IN (SELECT ja.asset_id FROM job_card_assets ja WHERE ja.job_card_id = j.id)
        WHERE j.customer_id IS NOT NULL AND a.customer_id IS NOT NULL
          AND j.customer_id <> a.customer_id`,
    ),
    siteQuery<Row>(
      siteId,
      /*
       * OPEN jobs only, so this cannot reuse JOB_COUNT_FOR_ASSET as-is: a
       * retired asset with a closed job behind it is history, not drift.
       *
       * Same OR-over-both-sources shape though, and for the same reason — an
       * asset retired while a job that names it SECONDARILY is still open is
       * exactly as wrong as the primary case, and the multi-unit visit is where
       * somebody is most likely to retire a unit without noticing.
       */
      `SELECT a.id, a.document_number, a.description,
              (SELECT COUNT(*) FROM job_cards j
                WHERE j.status = 'open'
                  AND (j.asset_id = a.id
                       OR EXISTS (SELECT 1 FROM job_card_assets ja
                                   WHERE ja.job_card_id = j.id AND ja.asset_id = a.id))) AS n
         FROM customer_assets a
        WHERE a.is_active = 0
       HAVING n > 0`,
    ),
  ])

  return {
    statusMismatch: status.map((r) => ({
      assetId: Number(r.id),
      documentNumber: text(r.document_number),
      isActive: Number(r.is_active) === 1,
      status: String(r.status),
    })),
    addressMismatch: address.map((r) => ({
      assetId: Number(r.id),
      documentNumber: text(r.document_number),
      description: String(r.description),
    })),
    jobCustomerMismatch: jobCustomer.map((r) => ({
      jobId: Number(r.id),
      documentNumber: text(r.document_number),
      assetId: Number(r.asset_id),
    })),
    retiredButWorked: retired.map((r) => ({
      assetId: Number(r.id),
      documentNumber: text(r.document_number),
      description: String(r.description),
      jobCount: Number(r.n ?? 0),
    })),
  }
}

/** How many pieces of equipment are due a service. For the dashboard. */
export async function assetsDueCount(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM customer_assets
      WHERE is_active = 1 AND next_service_on IS NOT NULL AND next_service_on <= CURDATE()`,
  )
  return Number(row?.n ?? 0)
}
