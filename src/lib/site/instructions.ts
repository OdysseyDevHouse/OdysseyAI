import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'

/**
 * Instructions — the questions a till asks when an item is sold.
 *
 * A GROUP is one question ("How would you like your eggs?"), its OPTIONS are
 * the answers, and a product is linked to the groups it should ask.
 *
 * Groups are a shared library, so "Choice of bread" is defined once and
 * attached to every product that needs it. That is the whole point of the
 * design: adding a bread means one edit, not one per sandwich.
 */

export type InstructionOption = {
  id: number
  groupId: number
  name: string
  /** Added to the line price when chosen, INCLUSIVE of VAT. May be negative. */
  priceAdjust: number
  /** Set when choosing this option should deduct a stocked product. */
  productId: number | null
  /** How much of the linked product one choice consumes. */
  quantity: number
  isDefault: boolean
  sortOrder: number
  isActive: boolean
  /** Joined for display; null when unlinked or the product is gone. */
  productCode: string | null
  productDescription: string | null
}

export type InstructionGroup = {
  id: number
  name: string
  prompt: string
  isRequired: boolean
  minChoices: number
  /** 0 means no ceiling. 1 renders as radio buttons, above 1 as checkboxes. */
  maxChoices: number
  sortOrder: number
  isActive: boolean
  /** How many products currently ask this group. */
  productCount: number
  optionCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapGroup(r: Row): InstructionGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    prompt: String(r.prompt ?? ''),
    isRequired: !!r.is_required,
    minChoices: Number(r.min_choices ?? 0),
    maxChoices: Number(r.max_choices ?? 1),
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
    productCount: Number(r.product_count ?? 0),
    optionCount: Number(r.option_count ?? 0),
  }
}

function mapOption(r: Row): InstructionOption {
  return {
    id: Number(r.id),
    groupId: Number(r.group_id),
    name: String(r.name),
    priceAdjust: toNum(r.price_adjust),
    productId: r.product_id === null ? null : Number(r.product_id),
    quantity: toNum(r.quantity),
    isDefault: !!r.is_default,
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
    productCode: (r.product_code as string | null) ?? null,
    productDescription: (r.product_description as string | null) ?? null,
  }
}

const SELECT_GROUP = `
  SELECT g.id, g.name, g.prompt, g.is_required, g.min_choices, g.max_choices,
         g.sort_order, g.is_active,
         (SELECT COUNT(*) FROM product_instruction_groups pig WHERE pig.group_id = g.id) AS product_count,
         (SELECT COUNT(*) FROM instruction_options o WHERE o.group_id = g.id AND o.is_active = 1) AS option_count
    FROM instruction_groups g
`

const SELECT_OPTION = `
  SELECT o.id, o.group_id, o.name, o.price_adjust, o.product_id, o.quantity,
         o.is_default, o.sort_order, o.is_active,
         p.code AS product_code, p.description AS product_description
    FROM instruction_options o
    LEFT JOIN products p ON p.id = o.product_id
`

export async function listGroups(
  siteId: number,
  includeInactive = false,
): Promise<InstructionGroup[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_GROUP}
      ${includeInactive ? '' : 'WHERE g.is_active = 1'}
      ORDER BY g.sort_order ASC, g.name ASC`,
  )
  return rows.map(mapGroup)
}

export async function getGroup(siteId: number, id: number): Promise<InstructionGroup | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_GROUP} WHERE g.id = ? LIMIT 1`, [id])
  return row ? mapGroup(row) : null
}

export async function listOptions(
  siteId: number,
  groupId: number,
  includeInactive = false,
): Promise<InstructionOption[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_OPTION}
      WHERE o.group_id = ? ${includeInactive ? '' : 'AND o.is_active = 1'}
      ORDER BY o.sort_order ASC, o.name ASC`,
    [groupId],
  )
  return rows.map(mapOption)
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type GroupInput = {
  name: string
  prompt?: string
  isRequired?: boolean
  minChoices?: number
  maxChoices?: number
  sortOrder?: number
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Checks a group's own rules before it is written.
 *
 * The choice bounds are validated together because they are only wrong in
 * relation to each other — a minimum above a maximum is a question no cashier
 * can answer, and it would strand the sale at the till rather than here.
 */
export function validateGroup(input: GroupInput): string | null {
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  if ((input.prompt ?? '').length > 190) return 'Prompt must be 190 characters or fewer.'

  const min = input.minChoices ?? 0
  const max = input.maxChoices ?? 1
  if (min < 0) return 'Minimum choices cannot be negative.'
  if (max < 0) return 'Maximum choices cannot be negative.'
  // Zero max means "no ceiling", so it is not a violation of min <= max.
  if (max > 0 && min > max) return 'Minimum choices cannot be above the maximum.'
  return null
}

export async function createGroup(siteId: number, input: GroupInput): Promise<SaveResult> {
  const invalid = validateGroup(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM instruction_groups WHERE name = ? LIMIT 1',
    [name],
  )
  if (clash) return { ok: false, error: `An instruction called "${name}" already exists.` }

  const res = await siteExecute(
    siteId,
    `INSERT INTO instruction_groups
       (name, prompt, is_required, min_choices, max_choices, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [
      name,
      (input.prompt ?? '').trim(),
      input.isRequired ? 1 : 0,
      input.minChoices ?? 0,
      input.maxChoices ?? 1,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateGroup(
  siteId: number,
  id: number,
  input: GroupInput,
): Promise<SaveResult> {
  const invalid = validateGroup(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM instruction_groups WHERE name = ? AND id <> ? LIMIT 1',
    [name, id],
  )
  if (clash) return { ok: false, error: `An instruction called "${name}" already exists.` }

  await siteExecute(
    siteId,
    `UPDATE instruction_groups
        SET name = ?, prompt = ?, is_required = ?, min_choices = ?, max_choices = ?,
            sort_order = ?, is_active = ?
      WHERE id = ?`,
    [
      name,
      (input.prompt ?? '').trim(),
      input.isRequired ? 1 : 0,
      input.minChoices ?? 0,
      input.maxChoices ?? 1,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * Deletes a group and, by cascade, its options and product links.
 *
 * Refused while products still ask it: removing a question that a live product
 * depends on is not something to do as a side effect of a delete button, and
 * the count tells the user exactly what to detach first.
 */
export async function deleteGroup(
  siteId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const used = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM product_instruction_groups WHERE group_id = ?',
    [id],
  )
  const n = Number(used?.n ?? 0)
  if (n > 0) {
    return {
      ok: false,
      error: `${n} product(s) still use this instruction. Remove it from them first, or switch it off instead.`,
    }
  }
  await siteExecute(siteId, 'DELETE FROM instruction_groups WHERE id = ?', [id])
  return { ok: true }
}

export type OptionInput = {
  name: string
  priceAdjust?: number
  productId?: number | null
  quantity?: number
  isDefault?: boolean
  sortOrder?: number
  isActive?: boolean
}

export function validateOption(input: OptionInput): string | null {
  if (!input.name?.trim()) return 'An option name is required.'
  if (input.name.trim().length > 120) return 'Option name must be 120 characters or fewer.'
  // Negative adjustments are legitimate ("no cheese -R2.00"), but a negative
  // quantity would deduct stock backwards.
  if ((input.quantity ?? 1) < 0) return 'Quantity cannot be negative.'
  return null
}

/**
 * Replaces a group's options wholesale.
 *
 * The editor submits the full list, so this is a replace rather than a diff:
 * working out which rows were added, renamed or removed from a set of form
 * fields is guesswork, and a wrong guess silently loses an option. Ids are
 * preserved where they were submitted so an option's identity survives.
 */
export async function replaceOptions(
  siteId: number,
  groupId: number,
  options: (OptionInput & { id?: number })[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const option of options) {
    const invalid = validateOption(option)
    if (invalid) return { ok: false, error: invalid }
  }

  return siteTransaction(siteId, async (tx) => {
    const keep = options.map((o) => o.id).filter((id): id is number => typeof id === 'number')

    if (keep.length) {
      await tx.execute(
        `DELETE FROM instruction_options
          WHERE group_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`,
        [groupId, ...keep] as never,
      )
    } else {
      await tx.execute('DELETE FROM instruction_options WHERE group_id = ?', [groupId] as never)
    }

    for (const [i, option] of options.entries()) {
      const params = [
        option.name.trim(),
        (option.priceAdjust ?? 0).toFixed(4),
        option.productId ?? null,
        (option.quantity ?? 1).toFixed(3),
        option.isDefault ? 1 : 0,
        option.sortOrder ?? i,
        option.isActive === false ? 0 : 1,
      ]

      if (option.id) {
        await tx.execute(
          `UPDATE instruction_options
              SET name = ?, price_adjust = ?, product_id = ?, quantity = ?,
                  is_default = ?, sort_order = ?, is_active = ?
            WHERE id = ? AND group_id = ?`,
          [...params, option.id, groupId] as never,
        )
      } else {
        await tx.execute(
          `INSERT INTO instruction_options
             (group_id, name, price_adjust, product_id, quantity, is_default, sort_order, is_active)
           VALUES (?,?,?,?,?,?,?,?)`,
          [groupId, ...params] as never,
        )
      }
    }

    return { ok: true as const }
  }).catch((err) => ({ ok: false as const, error: (err as Error).message }))
}

/* ── Product links ───────────────────────────────────────────────────────── */

/** The groups a product asks, in the order it asks them. */
export async function groupsForProduct(
  siteId: number,
  productId: number,
): Promise<InstructionGroup[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_GROUP}
       JOIN product_instruction_groups pig ON pig.group_id = g.id
      WHERE pig.product_id = ?
      ORDER BY pig.sort_order ASC, g.name ASC`,
    [productId],
  )
  return rows.map(mapGroup)
}

/**
 * Sets exactly which groups a product asks.
 *
 * Replace rather than merge: the product screen shows every group with a
 * checkbox, so the submitted list is the complete intended state and anything
 * absent was deliberately unticked.
 */
export async function setGroupsForProduct(
  siteId: number,
  productId: number,
  groupIds: number[],
): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_instruction_groups WHERE product_id = ?', [
      productId,
    ] as never)

    for (const [i, groupId] of groupIds.entries()) {
      await tx.execute(
        `INSERT INTO product_instruction_groups (product_id, group_id, sort_order)
         VALUES (?,?,?)`,
        [productId, groupId, i] as never,
      )
    }
  })
}
