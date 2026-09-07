import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import {
  insertProductTx,
  resolveVat,
  validateProduct,
  type ProductInput,
} from '@/lib/site/products'
import { resolveMasterCode } from '@/lib/site/masterCodes'

/**
 * Product variants — the parent/child grouping and the rules that keep it sane.
 *
 * A variant is an ORDINARY PRODUCT with a parent. It has its own code, barcode,
 * price and stock, and it sells, prices, reports and reconciles exactly as any
 * other product does. That is the whole point of the design: nothing downstream
 * had to learn a new idea (see 070_product_variants.sql for why).
 *
 * A parent is a grouping row. It never sells, never holds stock, and exists so
 * a shopper sees one tile with a size picker instead of five competing tiles.
 *
 * ── EVERY INVARIANT LIVES HERE ───────────────────────────────────────────
 *
 * The schema cannot express "a parent must not be sold" without splitting the
 * table, which would have cost 27 foreign keys. So the rules are enforced in
 * this file, in transactions, and asserted by tests:
 *
 *   1. A parent has has_variants = 1 and parent_id IS NULL.
 *   2. A child has parent_id set and has_variants = 0.
 *   3. NO GRANDCHILDREN — a child may never itself become a parent.
 *   4. A parent's stock_on_hand is always 0.
 *   5. Children inherit department, brand and VAT rates from their parent.
 *   6. (parent_id, axis_1_value, axis_2_value) is unique among live children.
 *
 * Rule 4 has a second line of defence in recordMovement(), which refuses any
 * movement against a parent. That gate is what makes the rest safe: it is the
 * single point every stock change in the application passes through, so a bug
 * anywhere else fails loudly there instead of silently breaking the
 * reconciliation invariant.
 */

type Row = Record<string, unknown>

/** Two axes, deliberately. See the migration for why not three. */
export const MAX_AXES = 2

export type VariantAxis = {
  position: 1 | 2
  label: string
}

export type VariantChild = {
  id: number
  code: string
  description: string
  axis1: string
  axis2: string
  sort: number
  stockOnHand: number
  isArchived: boolean
}

export type VariantGroup = {
  parentId: number
  parentCode: string
  parentDescription: string
  axes: VariantAxis[]
  children: VariantChild[]
}

export class VariantError extends Error {}

/**
 * Every group's axis LABELS, for the till's offline catalog.
 *
 * The till already receives parents and children as ordinary product rows —
 * `has_variants`, `parent_id` and the two axis VALUES ride `TillProduct`. What
 * it cannot get from those rows is what the values are called: 'M' is on the
 * child, 'Size' belongs to the group.
 *
 * Shipped as its own keyed map rather than folded onto each product for the
 * reason the schema gives for keeping labels off `products` in the first place
 * — repeated per child they could disagree, and the picker would have to pick
 * a winner. One row per axis per group, so a shop with 200 groups sends 400
 * short rows, which is noise next to the product feed.
 *
 * Whole every time, never a delta. Renaming an axis does not touch any product
 * row, so a products-only delta would leave a till captioning its picker
 * 'Size' forever after the shop renamed it 'Length' — the same trap
 * `pricesChangedSince` exists to avoid, and cheap enough here to just resend.
 */
export async function allVariantAxes(
  siteId: number,
): Promise<Record<number, VariantAxis[]>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.product_id, a.position, a.label
       FROM product_variant_axes a
       JOIN products p ON p.id = a.product_id
      WHERE p.is_archived = 0
      ORDER BY a.product_id, a.position`,
  )
  const out: Record<number, VariantAxis[]> = {}
  for (const r of rows) {
    const id = Number(r.product_id)
    const axis = { position: Number(r.position) as 1 | 2, label: String(r.label) }
    if (out[id]) out[id].push(axis)
    else out[id] = [axis]
  }
  return out
}

/**
 * The columns a child inherits from its parent.
 *
 * These are the ones that must not disagree within a group. Department decides
 * where the storefront files the whole group, and a breadcrumb cannot point two
 * ways at once. The VAT rates decide what the sale is worth to SARS, and a
 * group whose mediums are zero-rated and larges standard-rated is a mistake
 * being saved, not a choice being made.
 *
 * Price and cost are deliberately NOT here: a large genuinely costs more than a
 * small, and that is the most common reason to have variants at all.
 */
const INHERITED = [
  'department_id',
  'brand_id',
  'purchase_vat_rate_id',
  'selling_vat_rate_id',
] as const

/** True when this product is a parent — i.e. must never be sold or stocked. */
export async function isParent(siteId: number, productId: number): Promise<boolean> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT has_variants FROM products WHERE id = ?',
    [productId],
  )
  return row ? Number(row.has_variants) === 1 : false
}

/**
 * The same question inside someone else's transaction.
 *
 * Separate from isParent() rather than an optional parameter because a caller
 * holding a transaction must not silently fall back to a pooled connection —
 * that would read outside its own uncommitted writes.
 */
export async function isParentTx(tx: PoolConnection, productId: number): Promise<boolean> {
  const [rows] = await tx.query<never>(
    'SELECT has_variants FROM products WHERE id = ?',
    [productId] as never,
  )
  const list = rows as unknown as Row[]
  return list.length > 0 ? Number(list[0].has_variants) === 1 : false
}

/**
 * Where one product sits in the variant scheme: a parent, a child, or neither.
 *
 * One query rather than three, because the product screen needs the answer on
 * every render and two of the three answers are "no".
 */
export type VariantStanding = {
  /** The group, when this product is a parent. */
  group: VariantGroup | null
  /** The parent, when this product is somebody's variant. */
  parent: { id: number; description: string } | null
}

export async function variantStanding(
  siteId: number,
  productId: number,
): Promise<VariantStanding> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT p.has_variants, p.parent_id, parent.description AS parent_description
       FROM products p
       LEFT JOIN products parent ON parent.id = p.parent_id
      WHERE p.id = ?`,
    [productId],
  )
  if (!row) return { group: null, parent: null }

  return {
    group: Number(row.has_variants) === 1 ? await getGroup(siteId, productId) : null,
    parent:
      row.parent_id === null || row.parent_id === undefined
        ? null
        : { id: Number(row.parent_id), description: String(row.parent_description ?? '') },
  }
}

/** The whole group for a parent, or null when the product is not one. */
export async function getGroup(siteId: number, parentId: number): Promise<VariantGroup | null> {
  const parent = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, description, has_variants
       FROM products WHERE id = ?`,
    [parentId],
  )
  if (!parent || Number(parent.has_variants) !== 1) return null

  const [axes, children] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT position, label FROM product_variant_axes
        WHERE product_id = ? ORDER BY position`,
      [parentId],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, code, description, axis_1_value, axis_2_value,
              variant_sort, stock_on_hand, is_archived
         FROM products
        WHERE parent_id = ?
        ORDER BY variant_sort, axis_1_value, axis_2_value`,
      [parentId],
    ),
  ])

  return {
    parentId: Number(parent.id),
    parentCode: String(parent.code),
    parentDescription: String(parent.description),
    axes: axes.map((a) => ({ position: Number(a.position) as 1 | 2, label: String(a.label) })),
    children: children.map(mapChild),
  }
}

function mapChild(r: Row): VariantChild {
  return {
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
    axis1: String(r.axis_1_value ?? ''),
    axis2: String(r.axis_2_value ?? ''),
    sort: Number(r.variant_sort ?? 0),
    stockOnHand: toNum(r.stock_on_hand),
    isArchived: Number(r.is_archived) === 1,
  }
}

/**
 * Turn an ordinary product into a parent, naming its axes.
 *
 * The product must not already sell anything and must not hold stock — see the
 * checks below. It keeps its description, department and images, which is
 * exactly what a group wants to inherit.
 */
export async function makeParent(
  siteId: number,
  productId: number,
  axes: { position: 1 | 2; label: string }[],
): Promise<void> {
  const labelled = axes
    .filter((a) => a.label.trim().length > 0)
    .slice(0, MAX_AXES)
  if (labelled.length === 0) {
    throw new VariantError('Name at least one thing that tells the variants apart, such as Size.')
  }

  await siteTransaction(siteId, async (tx) => {
    const product = await lockProduct(tx, productId)

    if (Number(product.parent_id ?? 0) > 0) {
      // Rule 3. Allowing this would make the picker recursive and give the
      // storefront a tile inside a tile.
      throw new VariantError(
        'This product is already a variant of something else, so it cannot have variants of its own.',
      )
    }
    if (Number(product.has_variants) === 1) {
      throw new VariantError('This product already has variants.')
    }

    /*
     * Stock has to be zero BEFORE the row stops being sellable.
     *
     * A parent is excluded from reconciliation, so any quantity left on it at
     * this moment becomes invisible — Σ movements would no longer equal
     * stock_on_hand and nothing would report the difference. Refusing here
     * makes the person move the stock onto a real variant first, which is what
     * they meant anyway.
     */
    if (Math.abs(toNum(product.stock_on_hand)) > 0.0005) {
      throw new VariantError(
        'Move this product’s stock onto a variant first — a product with variants cannot hold stock itself.',
      )
    }

    await tx.execute('UPDATE products SET has_variants = 1 WHERE id = ?', [productId] as never)
    await tx.execute('DELETE FROM product_variant_axes WHERE product_id = ?', [productId] as never)
    for (const axis of labelled) {
      await tx.execute(
        'INSERT INTO product_variant_axes (product_id, position, label) VALUES (?,?,?)',
        [productId, axis.position, axis.label.trim()] as never,
      )
    }
  })
}

/**
 * Attach an existing product to a parent as one of its variants.
 *
 * The child keeps its own code, barcode, price and stock. Only the inherited
 * columns are overwritten, and only to match the parent — see INHERITED.
 */
export async function attachChild(
  siteId: number,
  parentId: number,
  childId: number,
  axis1: string,
  axis2: string,
): Promise<void> {
  if (parentId === childId) {
    throw new VariantError('A product cannot be a variant of itself.')
  }

  await siteTransaction(siteId, async (tx) => {
    // Locked in id order so two people attaching children to the same parent
    // at once cannot deadlock against each other.
    const [first, second] = parentId < childId ? [parentId, childId] : [childId, parentId]
    const a = await lockProduct(tx, first)
    const b = await lockProduct(tx, second)
    const parent = parentId === first ? a : b
    const child = childId === first ? a : b

    if (Number(parent.has_variants) !== 1) {
      throw new VariantError('That product does not have variants.')
    }
    if (Number(child.has_variants) === 1) {
      // Rule 3, from the other direction.
      throw new VariantError(
        'That product has variants of its own, so it cannot become a variant.',
      )
    }
    const existing = Number(child.parent_id ?? 0)
    if (existing > 0 && existing !== parentId) {
      throw new VariantError('That product is already a variant of another product.')
    }

    const one = axis1.trim()
    const two = axis2.trim()
    if (!one && !two) {
      throw new VariantError('Say which variant this is, such as “Medium”.')
    }

    // Rule 6. Two children both called Medium make a picker where one option
    // is unreachable, and the shopper cannot tell which they bought.
    const clash = await siteQueryOneTx(
      tx,
      `SELECT id FROM products
        WHERE parent_id = ? AND axis_1_value = ? AND axis_2_value = ? AND id <> ?`,
      [parentId, one, two, childId],
    )
    if (clash) {
      throw new VariantError('There is already a variant with that combination.')
    }

    /*
     * A POSITION, assigned at the end of the group.
     *
     * Without this every child kept `variant_sort` at its default 0, and both
     * pickers — the storefront's and the till's — fell through to their
     * alphabetical tiebreak. That sorts S, M, L, XL to L, M, S, XL, which is
     * the exact nonsense this column exists to prevent (see 070). The bug was
     * invisible for as long as nothing read the column: `setVariantOrder` was
     * the only writer, so a group showed a sensible order only if somebody had
     * been to the back office and dragged the sizes by hand.
     *
     * Attachment order is the right default because it is the order the
     * shopkeeper typed them in, and a person adding sizes to a shirt types
     * them small to large. Getting it wrong costs a drag; having no order at
     * all cost every group in the file.
     *
     * MAX + 1 rather than a count: a group that has had a child detached has a
     * gap, and counting would reuse a position that is still taken.
     */
    const last = await siteQueryOneTx(
      tx,
      `SELECT COALESCE(MAX(variant_sort), 0) AS top FROM products
        WHERE parent_id = ? AND id <> ?`,
      [parentId, childId],
    )
    const position = Number(last?.top ?? 0) + 1

    const inherit = INHERITED.map((c) => `${c} = ?`).join(', ')
    await tx.execute(
      `UPDATE products
          SET parent_id = ?, has_variants = 0,
              axis_1_value = ?, axis_2_value = ?, variant_sort = ?, ${inherit}
        WHERE id = ?`,
      [
        parentId,
        one,
        two,
        position,
        ...INHERITED.map((c) => parent[c] ?? null),
        childId,
      ] as never,
    )
  })
}

/**
 * Detach a child, leaving it a perfectly ordinary standalone product.
 *
 * Its stock, price and history are untouched — it was always a real product,
 * which is the property that makes this safe to undo.
 */
export async function detachChild(siteId: number, childId: number): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await lockProduct(tx, childId)
    await tx.execute(
      `UPDATE products
          SET parent_id = NULL, axis_1_value = '', axis_2_value = '', variant_sort = 0
        WHERE id = ?`,
      [childId] as never,
    )
  })
}

/**
 * Stop a product being a parent.
 *
 * Refused while it still has children, matching the FK's ON DELETE RESTRICT:
 * silently orphaning them would leave rows carrying axis values that point at
 * nothing.
 */
export async function unmakeParent(siteId: number, parentId: number): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await lockProduct(tx, parentId)
    const child = await siteQueryOneTx(
      tx,
      'SELECT id FROM products WHERE parent_id = ? LIMIT 1',
      [parentId],
    )
    if (child) {
      throw new VariantError(
        'Detach the variants first — this product still has variants pointing at it.',
      )
    }
    await tx.execute('DELETE FROM product_variant_axes WHERE product_id = ?', [parentId] as never)
    await tx.execute('UPDATE products SET has_variants = 0 WHERE id = ?', [parentId] as never)
  })
}

/** Reorder the pickers. Sizes are not alphabetical. */
export async function setVariantOrder(
  siteId: number,
  parentId: number,
  orderedChildIds: number[],
): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    for (const [index, childId] of orderedChildIds.entries()) {
      await tx.execute(
        'UPDATE products SET variant_sort = ? WHERE id = ? AND parent_id = ?',
        [(index + 1) * 10, childId, parentId] as never,
      )
    }
  })
}

/**
 * Push a parent's inherited columns down onto its children.
 *
 * Called after the parent is edited, in the SAME transaction, so a group can
 * never be caught half-updated with the storefront filing two siblings in
 * different departments.
 */
export async function cascadeInherited(tx: PoolConnection, parentId: number): Promise<void> {
  const sets = INHERITED.map((c) => `child.${c} = parent.${c}`).join(', ')
  await tx.execute(
    `UPDATE products child
       JOIN products parent ON parent.id = child.parent_id
        SET ${sets}
      WHERE child.parent_id = ?`,
    [parentId] as never,
  )
}

/** Row lock, so two concurrent edits to one group serialise rather than race. */
async function lockProduct(tx: PoolConnection, productId: number): Promise<Row> {
  const [rows] = await tx.query<never>(
    `SELECT id, parent_id, has_variants, stock_on_hand,
            ${INHERITED.join(', ')}
       FROM products WHERE id = ? FOR UPDATE`,
    [productId] as never,
  )
  const list = rows as unknown as Row[]
  if (list.length === 0) throw new VariantError('That product no longer exists.')
  return list[0]
}

async function siteQueryOneTx(
  tx: PoolConnection,
  sql: string,
  params: unknown[],
): Promise<Row | null> {
  const [rows] = await tx.query<never>(sql, params as never)
  const list = rows as unknown as Row[]
  return list.length > 0 ? list[0] : null
}

/* ──────────────────────────────────────────────────────────────────────────
 * THE GRID — creating a whole size × colour range in one go.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why this exists at all.
 *
 * attachChild() takes a product that ALREADY EXISTS, which is the right shape
 * for "I already sell the small, now group it with the medium". It is the
 * wrong shape for the common case: a shop that has just bought a shoe in five
 * sizes and three colours has fifteen products that do not exist yet, and the
 * panel made them create all fifteen by hand and then attach all fifteen by
 * hand — thirty trips through a form to describe one shoe.
 *
 * So this does the whole job at once: name the parent, list the sizes, list
 * the colours, and every combination is created and attached.
 *
 * ── WHY IT IS ONE TRANSACTION ────────────────────────────────────────────
 *
 * Fifteen products of which eleven were created is worse than none: the person
 * cannot tell which four are missing without comparing the grid to the list by
 * eye, and re-running the wizard would refuse every code that did save. The
 * refer wizard learned this first (see insertProductTx's note) and this uses
 * the same machinery for the same reason.
 *
 * ── WHY IT DOES NOT CALL attachChild ─────────────────────────────────────
 *
 * attachChild opens its own transaction, so fifteen of them cannot be made
 * atomic by nesting. The variant columns are written directly in the
 * transaction below instead, which is safe HERE and would not be in general:
 * every child is a row this function just inserted, so the checks attachChild
 * makes against an existing product — is it already someone's variant, does it
 * have variants of its own, does it hold stock — are all answered by
 * construction. What attachChild enforces that this must still enforce is rule
 * 6, one combination per group, and the SELECT below covers it against the
 * children a group already has.
 */

export type GridRow = {
  axis1: string
  axis2: string
  code: string
  description: string
  barcode: string
  costExcl: number
  sellIncl: number
}

export type CreateGridInput = {
  /** The product that becomes (or already is) the parent. */
  parentId: number
  /** Axis labels — 'Size', 'Colour'. Ignored when the group already exists. */
  axisLabels: string[]
  rows: GridRow[]
  /** Which price structure `sellIncl` lands in. Null skips price writing. */
  priceStructureId: number | null
}

export type CreateGridResult = { ok: true; created: number } | { ok: false; error: string }

/**
 * Create every combination in one transaction.
 *
 * Reads first, writes second — resolving codes, checking them for clashes and
 * resolving VAT all happen before the transaction opens, so a grid refused for
 * a duplicate code is refused before a single row is written. Same order
 * createReferRange uses.
 */
export async function createVariantGrid(
  siteId: number,
  input: CreateGridInput,
  audit?: { source: 'editor' | 'import'; userName: string },
): Promise<CreateGridResult> {
  if (input.rows.length === 0) {
    return { ok: false, error: 'There are no variants to create.' }
  }

  const parent = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, description, has_variants, parent_id, stock_on_hand,
            ${INHERITED.join(', ')}
       FROM products WHERE id = ?`,
    [input.parentId],
  )
  if (!parent) return { ok: false, error: 'That product no longer exists.' }

  /*
   * The same refusals makeParent makes, made HERE so they are reported before
   * fifteen codes are resolved and burned out of the auto-number sequence.
   * makeParent's own checks still run inside the transaction below — this is
   * the courtesy, that is the guarantee.
   */
  if (Number(parent.parent_id ?? 0) > 0) {
    return {
      ok: false,
      error:
        'This product is already a variant of something else, so it cannot have variants of its own.',
    }
  }
  const alreadyGroup = Number(parent.has_variants) === 1
  if (!alreadyGroup && Math.abs(toNum(parent.stock_on_hand)) > 0.0005) {
    return {
      ok: false,
      error:
        'Move this product’s stock onto a variant first — a product with variants cannot hold stock itself.',
    }
  }

  const labels = input.axisLabels
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_AXES)
  if (!alreadyGroup && labels.length === 0) {
    return {
      ok: false,
      error: 'Name at least one thing that tells the variants apart, such as Size.',
    }
  }

  /* ── Every read, before anything is written ─────────────────────────── */

  // Combinations already in the group. Adding brown to a shoe that already has
  // black and white must not re-create the black ones (rule 6).
  const existing = await siteQuery<Row>(
    siteId,
    'SELECT axis_1_value, axis_2_value FROM products WHERE parent_id = ?',
    [input.parentId],
  )
  const taken = new Set(
    existing.map((r) => `${String(r.axis_1_value ?? '')} ${String(r.axis_2_value ?? '')}`),
  )

  const prepared: Array<{ row: GridRow; code: string; input: ProductInput }> = []
  const seenCodes = new Set<string>()

  for (const row of input.rows) {
    const axis1 = row.axis1.trim()
    const axis2 = row.axis2.trim()
    if (!axis1 && !axis2) {
      return { ok: false, error: 'Say which variant this is, such as “Medium”.' }
    }
    if (taken.has(`${axis1} ${axis2}`)) {
      return {
        ok: false,
        error: `There is already a variant for ${[axis1, axis2].filter(Boolean).join(' / ')}.`,
      }
    }

    const code = await resolveMasterCode(siteId, 'product', row.code)
    if (!code) {
      return { ok: false, error: `${describeRow(row)} needs a product code.` }
    }
    if (seenCodes.has(code.toLowerCase())) {
      return { ok: false, error: `Product code “${code}” is on more than one variant.` }
    }
    seenCodes.add(code.toLowerCase())

    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM products WHERE code = ? LIMIT 1',
      [code],
    )
    if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

    /*
     * The child inherits exactly what INHERITED says it must and nothing else.
     * Price and cost come from the grid — a size 12 genuinely costs more than
     * a size 6, and that is the most common reason to have variants at all.
     */
    const productInput: ProductInput = {
      code,
      description: row.description.trim(),
      barcode: row.barcode?.trim() || null,
      lastCost: row.costExcl,
      departmentId: (parent.department_id as number | null) ?? null,
      brandId: (parent.brand_id as number | null) ?? null,
      purchaseVatRateId: (parent.purchase_vat_rate_id as number | null) ?? undefined,
      sellingVatRateId: (parent.selling_vat_rate_id as number | null) ?? undefined,
      prices:
        input.priceStructureId === null ? undefined : { [input.priceStructureId]: row.sellIncl },
    }

    const invalid = validateProduct(productInput)
    if (invalid) return { ok: false, error: `${describeRow(row)}: ${invalid}` }

    prepared.push({ row, code, input: productInput })
  }

  // Duplicate barcodes, for the reason createReferRange gives: products.barcode
  // has no unique index, so a clash would not fail — the till would just ring
  // up whichever product was created first.
  const barcodes = prepared.map((p) => p.input.barcode ?? '').filter(Boolean)
  const doubled = barcodes.find((b, i) => barcodes.indexOf(b) !== i)
  if (doubled) {
    return { ok: false, error: `Barcode ${doubled} is on more than one variant.` }
  }
  if (barcodes.length > 0) {
    const clashes = await siteQuery<Row>(
      siteId,
      `SELECT code, barcode FROM products WHERE barcode IN (${barcodes.map(() => '?').join(',')})`,
      barcodes,
    )
    if (clashes.length > 0) {
      return {
        ok: false,
        error: `Barcode ${String(clashes[0].barcode)} is already on product ${String(
          clashes[0].code,
        )}.`,
      }
    }
  }

  const vat = await resolveVat(siteId, {
    code: '',
    description: '',
    purchaseVatRateId: (parent.purchase_vat_rate_id as number | null) ?? undefined,
    sellingVatRateId: (parent.selling_vat_rate_id as number | null) ?? undefined,
  })

  /* ── One transaction ────────────────────────────────────────────────── */

  try {
    const created = await siteTransaction(siteId, async (tx) => {
      const locked = await lockProduct(tx, input.parentId)

      /*
       * Re-checked under the lock, not merely re-stated. Everything above ran
       * outside the transaction, so between then and now someone else could
       * have made this product a variant or sold stock onto it. These are the
       * refusals that count; the ones at the top are the early message.
       */
      if (Number(locked.parent_id ?? 0) > 0) {
        throw new VariantError(
          'This product is already a variant of something else, so it cannot have variants of its own.',
        )
      }

      if (Number(locked.has_variants) !== 1) {
        if (Math.abs(toNum(locked.stock_on_hand)) > 0.0005) {
          throw new VariantError(
            'Move this product’s stock onto a variant first — a product with variants cannot hold stock itself.',
          )
        }
        await tx.execute('UPDATE products SET has_variants = 1 WHERE id = ?', [
          input.parentId,
        ] as never)
        await tx.execute('DELETE FROM product_variant_axes WHERE product_id = ?', [
          input.parentId,
        ] as never)
        for (const [index, label] of labels.entries()) {
          await tx.execute(
            'INSERT INTO product_variant_axes (product_id, position, label) VALUES (?,?,?)',
            [input.parentId, index + 1, label] as never,
          )
        }
      }

      /*
       * Positions continue from the end of the group, so adding brown to a shoe
       * that already has black and white appends rather than interleaving — and
       * MAX + 1 rather than a count, because a group that has had a child
       * detached has a gap and counting would reuse a position still in use.
       */
      const last = await siteQueryOneTx(
        tx,
        'SELECT COALESCE(MAX(variant_sort), 0) AS top FROM products WHERE parent_id = ?',
        [input.parentId],
      )
      let sort = Number(last?.top ?? 0) / 10

      for (const ready of prepared) {
        const childId = await insertProductTx(tx, { ...ready.input, code: ready.code }, vat, audit)
        sort += 1
        await tx.execute(
          `UPDATE products
              SET parent_id = ?, has_variants = 0,
                  axis_1_value = ?, axis_2_value = ?, variant_sort = ?
            WHERE id = ?`,
          [
            input.parentId,
            ready.row.axis1.trim(),
            ready.row.axis2.trim(),
            Math.round(sort * 10),
            childId,
          ] as never,
        )
      }

      return prepared.length
    })

    return { ok: true, created }
  } catch (error) {
    if (error instanceof VariantError) return { ok: false, error: error.message }
    throw error
  }
}

/** "Size 10 / Brown", for an error that points at a row of the grid. */
function describeRow(row: GridRow): string {
  return [row.axis1.trim(), row.axis2.trim()].filter(Boolean).join(' / ') || 'This variant'
}
