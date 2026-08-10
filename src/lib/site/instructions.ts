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
  /**
   * How many of THIS option one item may carry. 0 means no ceiling, matching
   * the meaning `maxChoices` already has on the group; 1 is a plain tick box.
   *
   * Not to be confused with the group's `maxChoices`, which counts how many
   * DISTINCT options may be picked. Bacon ×3 and cheese ×1 is two choices
   * against that ceiling, not four.
   */
  maxQty: number
  /** The floor once this option is chosen. Does not make it compulsory. */
  minQty: number
  /** The count applied when `isDefault` pre-ticks it. Read as at least 1. */
  defaultQty: number
  /** A picture of the answer. Points at storefront_images; may dangle. */
  imageId: number | null
  /** Whether this answer is repeated on the kitchen ticket. */
  printsOnKitchen: boolean
  /** Whether this answer is repeated on the customer's receipt. */
  printsOnReceipt: boolean
  sortOrder: number
  isActive: boolean
  /** Joined for display; null when unlinked or the product is gone. */
  productCode: string | null
  productDescription: string | null
  /** The groups choosing this option goes on to ask. */
  revealsGroupIds: number[]
}

export type InstructionGroup = {
  id: number
  name: string
  prompt: string
  isRequired: boolean
  minChoices: number
  /** 0 means no ceiling. 1 renders as radio buttons, above 1 as checkboxes. */
  maxChoices: number
  /** A picture for the question itself. Points at storefront_images. */
  imageId: number | null
  sortOrder: number
  isActive: boolean
  /** How many products currently ask this group. */
  productCount: number
  optionCount: number
  /** How many options elsewhere reveal this group. Blocks deletion. */
  revealedByCount: number
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
    imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
    productCount: Number(r.product_count ?? 0),
    optionCount: Number(r.option_count ?? 0),
    revealedByCount: Number(r.revealed_by_count ?? 0),
  }
}

/**
 * `reveals` is passed in rather than joined, because one option may reveal
 * several groups and a join would multiply the option row by them — turning one
 * answer into three and quietly tripling its price adjustment in any caller that
 * summed the rows. They are read once and attached here.
 */
function mapOption(r: Row, reveals: Map<number, number[]>): InstructionOption {
  const id = Number(r.id)
  return {
    id,
    groupId: Number(r.group_id),
    name: String(r.name),
    priceAdjust: toNum(r.price_adjust),
    productId: r.product_id === null ? null : Number(r.product_id),
    quantity: toNum(r.quantity),
    isDefault: !!r.is_default,
    maxQty: Number(r.max_qty ?? 1),
    minQty: Number(r.min_qty ?? 0),
    defaultQty: Number(r.default_qty ?? 0),
    imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
    printsOnKitchen: !!r.prints_on_kitchen,
    printsOnReceipt: !!r.prints_on_receipt,
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
    productCode: (r.product_code as string | null) ?? null,
    productDescription: (r.product_description as string | null) ?? null,
    revealsGroupIds: reveals.get(id) ?? [],
  }
}

const SELECT_GROUP = `
  SELECT g.id, g.name, g.prompt, g.is_required, g.min_choices, g.max_choices,
         g.image_id, g.sort_order, g.is_active,
         (SELECT COUNT(*) FROM product_instruction_groups pig WHERE pig.group_id = g.id) AS product_count,
         (SELECT COUNT(*) FROM instruction_options o WHERE o.group_id = g.id AND o.is_active = 1) AS option_count,
         (SELECT COUNT(*) FROM instruction_option_reveals r WHERE r.group_id = g.id) AS revealed_by_count
    FROM instruction_groups g
`

const SELECT_OPTION = `
  SELECT o.id, o.group_id, o.name, o.price_adjust, o.product_id, o.quantity,
         o.is_default, o.max_qty, o.min_qty, o.default_qty, o.image_id,
         o.prints_on_kitchen, o.prints_on_receipt, o.sort_order, o.is_active,
         p.code AS product_code, p.description AS product_description
    FROM instruction_options o
    LEFT JOIN products p ON p.id = o.product_id
`

/** Which groups each of these options goes on to ask, in order. */
async function revealsFor(siteId: number, optionIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  if (optionIds.length === 0) return map

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT option_id, group_id
       FROM instruction_option_reveals
      WHERE option_id IN (${optionIds.map(() => '?').join(',')})
      ORDER BY option_id ASC, sort_order ASC, group_id ASC`,
    optionIds,
  )

  for (const row of rows) {
    const optionId = Number(row.option_id)
    const list = map.get(optionId)
    if (list) list.push(Number(row.group_id))
    else map.set(optionId, [Number(row.group_id)])
  }
  return map
}

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
  const reveals = await revealsFor(
    siteId,
    rows.map((r) => Number(r.id)),
  )
  return rows.map((r) => mapOption(r, reveals))
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type GroupInput = {
  name: string
  prompt?: string
  isRequired?: boolean
  minChoices?: number
  maxChoices?: number
  imageId?: number | null
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
       (name, prompt, is_required, min_choices, max_choices, image_id, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      name,
      (input.prompt ?? '').trim(),
      input.isRequired ? 1 : 0,
      input.minChoices ?? 0,
      input.maxChoices ?? 1,
      input.imageId ?? null,
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
            image_id = ?, sort_order = ?, is_active = ?
      WHERE id = ?`,
    [
      name,
      (input.prompt ?? '').trim(),
      input.isRequired ? 1 : 0,
      input.minChoices ?? 0,
      input.maxChoices ?? 1,
      input.imageId ?? null,
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
 *
 * Refused for a second reason as well — while any ANSWER elsewhere reveals it.
 * The foreign key would cascade the reveal rows away happily, and the shop would
 * be left with a two-step question that silently became a one-step one: choosing
 * "make it a meal" would stop asking which side, with nothing on any screen to
 * say why. That is the kind of change that gets discovered by a customer.
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

  const revealed = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM instruction_option_reveals WHERE group_id = ?',
    [id],
  )
  const r = Number(revealed?.n ?? 0)
  if (r > 0) {
    return {
      ok: false,
      error: `${r} answer(s) on other instructions go on to ask this one. Stop them asking it first, or switch it off instead.`,
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
  maxQty?: number
  minQty?: number
  defaultQty?: number
  imageId?: number | null
  printsOnKitchen?: boolean
  printsOnReceipt?: boolean
  sortOrder?: number
  isActive?: boolean
  /** The groups choosing this option goes on to ask. */
  revealsGroupIds?: number[]
}

/**
 * A ceiling on the ceiling.
 *
 * `maxQty` faces a cashier as a stepper, and a stepper with no bound is one
 * mis-tap away from charging for sixty rashers of bacon. 99 is far more than any
 * real answer needs and still fits the SMALLINT the column is.
 */
const MAX_OPTION_QTY = 99

export function validateOption(input: OptionInput): string | null {
  if (!input.name?.trim()) return 'An option name is required.'
  if (input.name.trim().length > 120) return 'Option name must be 120 characters or fewer.'
  // Negative adjustments are legitimate ("no cheese -R2.00"), but a negative
  // quantity would deduct stock backwards.
  if ((input.quantity ?? 1) < 0) return 'Quantity cannot be negative.'

  const max = input.maxQty ?? 1
  const min = input.minQty ?? 0
  const def = input.defaultQty ?? 0

  if (max < 0) return `“${input.name.trim()}”: the most you can take cannot be negative.`
  if (min < 0) return `“${input.name.trim()}”: the least you can take cannot be negative.`
  if (def < 0) return `“${input.name.trim()}”: the preselected number cannot be negative.`
  if (max > MAX_OPTION_QTY) {
    return `“${input.name.trim()}”: the most you can take cannot be above ${MAX_OPTION_QTY}.`
  }

  // Zero max means "no ceiling", exactly as it does on the group, so it is not
  // a violation of min <= max.
  if (max > 0 && min > max) {
    return `“${input.name.trim()}”: the least you can take cannot be above the most.`
  }
  if (max > 0 && def > max) {
    return `“${input.name.trim()}”: the preselected number cannot be above the most you can take.`
  }

  return null
}

/**
 * How deep a chain of questions may go.
 *
 * A cashier with a queue cannot navigate a deeper decision tree, and the modal
 * has to render the whole chain on one screen to be usable at all. Three is
 * "burger → make it a meal → which side → which sauce", which is already at the
 * edge of what anybody asks at a counter.
 */
export const MAX_REVEAL_DEPTH = 3

/**
 * Refuses an option linked to a product the till could not actually deduct.
 *
 * A serial-tracked product needs a specific serial number picked at sale time,
 * and a recipe explodes into its own components. Either would have to happen
 * inside the options modal, which is a screen for answering a question about a
 * burger — not a place to run a second sale. Refused here, when someone is
 * configuring it and can choose a different product, rather than at the till
 * with a customer waiting.
 */
async function checkOptionProducts(
  siteId: number,
  options: OptionInput[],
): Promise<string | null> {
  const ids = [
    ...new Set(options.map((o) => o.productId).filter((id): id is number => typeof id === 'number')),
  ]
  if (ids.length === 0) return null

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, description, product_type
       FROM products
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))

  for (const option of options) {
    if (!option.productId) continue
    const product = byId.get(option.productId)
    if (!product) continue

    const type = String(product.product_type ?? 'normal')
    if (type === 'serial') {
      return `“${option.name.trim()}” deducts a serial-tracked product (${String(product.description)}). The till cannot pick a serial number while answering a question, so link it to an ordinary stocked product instead.`
    }
    if (type === 'recipe') {
      return `“${option.name.trim()}” deducts a recipe product (${String(product.description)}). Link it to one of the recipe's ingredients instead, so the till knows what to take off the shelf.`
    }
  }

  return null
}

/**
 * Refuses a set of reveals that would loop, or ask too deep.
 *
 * This runs against the state the save is ABOUT to create, not the state on
 * disk: `pending` overlays what this group's options are being changed to, so
 * closing a loop is caught by the save that closes it rather than by the next
 * unrelated edit.
 *
 * It is not the only guard. `resolveInstructionTree` carries its own visited-set
 * because two people editing two groups at once can each save something this
 * check calls valid and still leave a cycle behind — see the note there.
 */
export async function validateReveals(
  siteId: number,
  groupId: number,
  options: (OptionInput & { id?: number })[],
): Promise<string | null> {
  const pending = options.flatMap((o) => o.revealsGroupIds ?? [])
  if (pending.length === 0) return null

  if (pending.includes(groupId)) {
    return 'An answer cannot go on to ask its own question.'
  }

  // Every reveal on disk, minus this group's own (which `pending` replaces).
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT o.group_id AS from_group, r.group_id AS to_group
       FROM instruction_option_reveals r
       JOIN instruction_options o ON o.id = r.option_id
      WHERE o.group_id <> ?`,
    [groupId],
  )

  const edges = new Map<number, number[]>()
  for (const row of rows) {
    const from = Number(row.from_group)
    const list = edges.get(from)
    if (list) list.push(Number(row.to_group))
    else edges.set(from, [Number(row.to_group)])
  }
  edges.set(groupId, [...new Set(pending)])

  const names = new Map<number, string>()
  const nameOf = async (id: number) => {
    if (!names.size) {
      const all = await siteQuery<Row>(siteId, 'SELECT id, name FROM instruction_groups')
      for (const r of all) names.set(Number(r.id), String(r.name))
    }
    return names.get(id) ?? `#${id}`
  }

  // Walk forward from this group. `path` is the chain that got us here, so a
  // repeat in it is a loop and its length is the depth.
  const walk = async (
    from: number,
    path: number[],
  ): Promise<string | null> => {
    for (const next of edges.get(from) ?? []) {
      if (path.includes(next)) {
        return `“${await nameOf(next)}” would end up asking itself. Questions cannot loop back on themselves.`
      }
      if (path.length + 1 >= MAX_REVEAL_DEPTH) {
        const deeper = edges.get(next) ?? []
        if (deeper.length) {
          return `That would ask ${path.length + 2} questions in a row. A till can follow ${MAX_REVEAL_DEPTH}; ask the rest on the product instead.`
        }
      }
      const found = await walk(next, [...path, next])
      if (found) return found
    }
    return null
  }

  return walk(groupId, [groupId])
}

/**
 * The option columns this module writes, and how each value is prepared.
 *
 * ── WHY A MAP AND NOT A PARAMETER LIST ──────────────────────────────────────
 *
 * The INSERT and the UPDATE used to carry a hand-kept array of seven positional
 * binds, in an order that had to match two SQL statements written out separately
 * a few lines apart. That is survivable at seven. This version writes thirteen,
 * and a positional list of thirteen is a trap: slipping one entry writes the
 * maximum quantity into the picture id, and both are plain integers, so nothing
 * fails — the option simply comes back next week with a picture nobody chose and
 * a ceiling nobody set.
 *
 * Naming each column beside the value that fills it means the two statements are
 * generated from one source and cannot disagree about the order.
 */
const OPTION_COLUMNS: {
  column: string
  value: (option: OptionInput, index: number) => string | number | null
}[] = [
  { column: 'name', value: (o) => o.name.trim() },
  { column: 'price_adjust', value: (o) => (o.priceAdjust ?? 0).toFixed(4) },
  { column: 'product_id', value: (o) => o.productId ?? null },
  { column: 'quantity', value: (o) => (o.quantity ?? 1).toFixed(3) },
  { column: 'is_default', value: (o) => (o.isDefault ? 1 : 0) },
  { column: 'max_qty', value: (o) => o.maxQty ?? 1 },
  { column: 'min_qty', value: (o) => o.minQty ?? 0 },
  // A pre-ticked answer at a count of nothing is not a state anyone means, so it
  // is resolved to one here rather than in every reader.
  {
    column: 'default_qty',
    value: (o) => (o.isDefault ? Math.max(1, o.defaultQty ?? 1) : (o.defaultQty ?? 0)),
  },
  { column: 'image_id', value: (o) => o.imageId ?? null },
  { column: 'prints_on_kitchen', value: (o) => (o.printsOnKitchen === false ? 0 : 1) },
  { column: 'prints_on_receipt', value: (o) => (o.printsOnReceipt === false ? 0 : 1) },
  { column: 'sort_order', value: (o, i) => o.sortOrder ?? i },
  { column: 'is_active', value: (o) => (o.isActive === false ? 0 : 1) },
]

/**
 * Replaces a group's options wholesale.
 *
 * The editor submits the full list, so this is a replace rather than a diff:
 * working out which rows were added, renamed or removed from a set of form
 * fields is guesswork, and a wrong guess silently loses an option. Ids are
 * preserved where they were submitted so an option's identity survives.
 *
 * The groups an answer goes on to ask are replaced the same way and in the same
 * transaction — a half-written reveal would be a question that asks a follow-up
 * on one till and not on another.
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

  const linkable = await checkOptionProducts(siteId, options)
  if (linkable) return { ok: false, error: linkable }

  const reveals = await validateReveals(siteId, groupId, options)
  if (reveals) return { ok: false, error: reveals }

  const columns = OPTION_COLUMNS.map((c) => c.column)

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
      const values = OPTION_COLUMNS.map((c) => c.value(option, i))
      let optionId = option.id ?? 0

      if (option.id) {
        await tx.execute(
          `UPDATE instruction_options
              SET ${columns.map((c) => `${c} = ?`).join(', ')}
            WHERE id = ? AND group_id = ?`,
          [...values, option.id, groupId] as never,
        )
      } else {
        // One placeholder for group_id, then one per named column.
        const placeholders = ['?', ...columns.map(() => '?')].join(',')
        const [res] = await tx.execute(
          `INSERT INTO instruction_options (group_id, ${columns.join(', ')})
           VALUES (${placeholders})`,
          [groupId, ...values] as never,
        )
        optionId = (res as { insertId: number }).insertId
      }

      // Replaced rather than diffed, for the same reason the options are.
      await tx.execute('DELETE FROM instruction_option_reveals WHERE option_id = ?', [
        optionId,
      ] as never)

      for (const [j, revealId] of (option.revealsGroupIds ?? []).entries()) {
        await tx.execute(
          `INSERT INTO instruction_option_reveals (option_id, group_id, sort_order)
           VALUES (?,?,?)`,
          [optionId, revealId, j] as never,
        )
      }
    }

    return { ok: true as const }
  }).catch((err) => ({ ok: false as const, error: (err as Error).message }))
}

/**
 * Sets the order the library itself is listed in.
 *
 * Positions are rewritten 1..n rather than patched, so a library whose
 * sort_order values were all left at the default 0 — which is every library
 * until somebody drags something — comes out consistent rather than keeping a
 * tie that the name-based fallback then breaks arbitrarily.
 *
 * The ids are checked against what exists before anything is written: this
 * arrives from a browser, and a payload naming a group on another site must not
 * renumber it.
 */
export async function setGroupOrder(
  siteId: number,
  orderedIds: number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (orderedIds.length === 0) return { ok: true }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: 'That order lists the same instruction twice.' }
  }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id FROM instruction_groups WHERE id IN (${orderedIds.map(() => '?').join(',')})`,
    orderedIds,
  )
  if (rows.length !== orderedIds.length) {
    return { ok: false, error: 'One of those instructions no longer exists.' }
  }

  await siteTransaction(siteId, async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.execute('UPDATE instruction_groups SET sort_order = ? WHERE id = ?', [
        index + 1,
        id,
      ] as never)
    }
  })

  return { ok: true }
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

/* ── What the till is given ──────────────────────────────────────────────── */

/**
 * One answer, as the till needs it.
 *
 * Deliberately smaller than `InstructionOption`: no product code, no
 * description, no counts. This shape is serialised into the catalogue that every
 * till downloads and keeps offline, and the catalogue route is explicit about
 * not shipping the product file's private half to a device on a counter.
 */
export type TillInstructionOption = {
  id: number
  name: string
  /** Added to the line price when chosen, INCLUSIVE of VAT. May be negative. */
  priceAdjust: number
  /** Set when choosing this deducts a stocked product. */
  productId: number | null
  /** How much of that product ONE of this option consumes. */
  quantity: number
  isDefault: boolean
  maxQty: number
  minQty: number
  defaultQty: number
  imageId: number | null
  printsOnKitchen: boolean
  printsOnReceipt: boolean
  revealsGroupIds: number[]
}

/** One question, as the till needs it. */
export type TillInstructionGroup = {
  id: number
  name: string
  /** What the cashier is asked. Already fallen back to the name when blank. */
  prompt: string
  isRequired: boolean
  minChoices: number
  maxChoices: number
  imageId: number | null
  options: TillInstructionOption[]
}

/**
 * Every question a till may need to ask, and which ones each product starts on.
 *
 * ── WHY THE LIBRARY IS FLAT, AND SHIPPED WHOLE ──────────────────────────────
 *
 * The groups come back as one list and the products as a map of ids into it,
 * rather than each product carrying its own copy of the questions it asks. That
 * is the library's whole point: "Choice of bread" is defined once and attached
 * to forty sandwiches, and inlining it would put forty copies of it in a payload
 * that already carries up to fifty thousand products. The download then grows
 * with the MENU rather than with the product file.
 *
 * ── WHY REVEALED GROUPS ARE NOT NESTED ──────────────────────────────────────
 *
 * A revealed group is in the same flat list, and an option merely names the ids
 * it goes on to ask. The till renders the list in order and hides the ones whose
 * revealing answer is not currently chosen — no recursive component, no
 * recursive state, and a shape that survives being written to disk and read back
 * on a device that has been offline for a week.
 */
export type InstructionLibrary = {
  groups: TillInstructionGroup[]
  /** productId → the ids of the groups it asks first, in order. */
  byProduct: Record<number, number[]>
}

/**
 * Reads the whole active instruction library, ready for the till.
 *
 * ── THE CYCLE GUARD, AND WHY IT IS HERE AS WELL ─────────────────────────────
 *
 * `validateReveals` already refuses to SAVE a loop, so in principle this cannot
 * meet one. In practice two people editing two different groups at the same
 * moment can each save something that check called valid, and leave a loop
 * behind that neither save could see. So the reachable set is walked here too,
 * with a visited-set and a depth cap, against whatever the database actually
 * contains.
 *
 * A group beyond the cap is simply left out. It is not reported and nothing
 * fails: a cashier halfway through a sale with a customer at the counter is the
 * worst possible person to tell about a configuration mistake, and a question
 * that goes missing is survivable in a way that a till which hangs is not.
 */
export async function readInstructionLibrary(siteId: number): Promise<InstructionLibrary> {
  const groupRows = await siteQuery<Row>(
    siteId,
    `SELECT id, name, prompt, is_required, min_choices, max_choices, image_id
       FROM instruction_groups
      WHERE is_active = 1
      ORDER BY sort_order ASC, name ASC`,
  )
  if (groupRows.length === 0) return { groups: [], byProduct: {} }

  const optionRows = await siteQuery<Row>(
    siteId,
    `SELECT o.id, o.group_id, o.name, o.price_adjust, o.product_id, o.quantity,
            o.is_default, o.max_qty, o.min_qty, o.default_qty, o.image_id,
            o.prints_on_kitchen, o.prints_on_receipt
       FROM instruction_options o
       JOIN instruction_groups g ON g.id = o.group_id
      WHERE o.is_active = 1 AND g.is_active = 1
      ORDER BY o.group_id ASC, o.sort_order ASC, o.name ASC`,
  )

  const reveals = await revealsFor(
    siteId,
    optionRows.map((r) => Number(r.id)),
  )

  const byGroup = new Map<number, TillInstructionOption[]>()
  for (const r of optionRows) {
    const id = Number(r.id)
    const option: TillInstructionOption = {
      id,
      name: String(r.name),
      priceAdjust: toNum(r.price_adjust),
      productId: r.product_id === null ? null : Number(r.product_id),
      quantity: toNum(r.quantity),
      isDefault: !!r.is_default,
      maxQty: Number(r.max_qty ?? 1),
      minQty: Number(r.min_qty ?? 0),
      defaultQty: Number(r.default_qty ?? 0),
      imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
      printsOnKitchen: !!r.prints_on_kitchen,
      printsOnReceipt: !!r.prints_on_receipt,
      revealsGroupIds: reveals.get(id) ?? [],
    }
    const ownerId = Number(r.group_id)
    const list = byGroup.get(ownerId)
    if (list) list.push(option)
    else byGroup.set(ownerId, [option])
  }

  const groups = new Map<number, TillInstructionGroup>()
  for (const r of groupRows) {
    const id = Number(r.id)
    groups.set(id, {
      id,
      name: String(r.name),
      // Resolved here rather than at the till, so every screen that shows a
      // prompt shows the same one.
      prompt: String(r.prompt ?? '').trim() || String(r.name),
      isRequired: !!r.is_required,
      minChoices: Number(r.min_choices ?? 0),
      maxChoices: Number(r.max_choices ?? 1),
      imageId: r.image_id === null || r.image_id === undefined ? null : Number(r.image_id),
      options: byGroup.get(id) ?? [],
    })
  }

  const linkRows = await siteQuery<Row>(
    siteId,
    `SELECT pig.product_id, pig.group_id
       FROM product_instruction_groups pig
       JOIN instruction_groups g ON g.id = pig.group_id
      WHERE g.is_active = 1
      ORDER BY pig.product_id ASC, pig.sort_order ASC, g.name ASC`,
  )

  const byProduct: Record<number, number[]> = {}
  for (const r of linkRows) {
    const productId = Number(r.product_id)
    const groupId = Number(r.group_id)
    if (!groups.has(groupId)) continue
    if (byProduct[productId]) byProduct[productId].push(groupId)
    else byProduct[productId] = [groupId]
  }

  // Only groups actually reachable from a product are shipped — a group nobody
  // asks is configuration, not something a till needs to carry offline.
  const reachable = new Set<number>()
  const queue: { id: number; depth: number }[] = []
  for (const ids of Object.values(byProduct)) {
    for (const id of ids) {
      if (reachable.has(id)) continue
      reachable.add(id)
      queue.push({ id, depth: 1 })
    }
  }

  while (queue.length) {
    const { id, depth } = queue.shift()!
    if (depth >= MAX_REVEAL_DEPTH) continue
    for (const option of groups.get(id)?.options ?? []) {
      for (const next of option.revealsGroupIds) {
        // The visited-set is what makes a loop terminate rather than hang.
        if (reachable.has(next) || !groups.has(next)) continue
        reachable.add(next)
        queue.push({ id: next, depth: depth + 1 })
      }
    }
  }

  return {
    groups: [...groups.values()].filter((g) => reachable.has(g.id)),
    byProduct,
  }
}
