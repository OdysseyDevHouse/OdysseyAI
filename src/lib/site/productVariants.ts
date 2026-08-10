import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'

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

    const inherit = INHERITED.map((c) => `${c} = ?`).join(', ')
    await tx.execute(
      `UPDATE products
          SET parent_id = ?, has_variants = 0,
              axis_1_value = ?, axis_2_value = ?, ${inherit}
        WHERE id = ?`,
      [
        parentId,
        one,
        two,
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
