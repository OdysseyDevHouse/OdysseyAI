import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round } from '../decimals'
import {
  insertProductTx,
  resolveVat,
  validateProduct,
  type ProductInput,
} from './products'
import { resolveMasterCode } from './masterCodes'
import type { ReferMethod } from './productComposition'

/**
 * Building a whole pack range in one go — single, six-pack, case.
 *
 * A refer code is never set up alone. A shop that sells beer sells it three
 * ways, and doing that through the product form means creating three products
 * by hand and then linking them one at a time, remembering which way round the
 * factor goes. This is that job as one screen.
 *
 * ── PACK SIZES ARE ABSOLUTE, FACTORS ARE RELATIVE ────────────────────────
 *
 * The wizard asks for pack sizes the way a person thinks about them — 1, 6,
 * 12 — all counted in the base unit. The chain stores each factor against its
 * IMMEDIATE target (see 103_refer_methods.sql), so a 12 sitting above a 6 is
 * stored as factor 2, not 12. This module is where that conversion happens,
 * and it is the only place it should ever happen.
 *
 *   sizes  1 ← 6 ← 12
 *   links      6/1=6   12/6=2
 *
 * A size that does not divide the one below it cleanly has no whole-number
 * factor, and under normal refers there is no way to break the pack open. So
 * it is refused here rather than saved as a fraction nobody can count.
 *
 * ── WHY ONE TRANSACTION ──────────────────────────────────────────────────
 *
 * createProduct() opens its own transaction, so three of them cannot be made
 * atomic by nesting. A range that half-created — two products, one link, and
 * an error — would leave the shop with a six-pack referring to nothing and no
 * obvious way to tell that from a deliberate setup. insertProductTx() exists
 * for this: every row and every link lands together or none of them do.
 */

type Row = RowDataPacket & Record<string, unknown>

/** The most pack sizes one range may carry. */
const MAX_ROWS = 6

export type ReferRangeRow = {
  /**
   * An existing product to use as this rung, or null to create one.
   *
   * The common case is not three new products — it is "I already sell the
   * single, now add a six-pack". Row 1 is then the product the user was
   * already looking at, and only the rungs above it get created.
   */
  productId?: number | null
  description: string
  /** Blank means auto-number, exactly as the product form does. */
  code?: string | null
  barcode?: string | null
  /** In BASE units. 1 for the single, 6 for a six-pack, 24 for a case. */
  packSize: number
  packDescription?: string | null
  costExcl?: number
  /** VAT-inclusive, per active price structure. */
  prices?: Record<number, number>
  supplierCode?: string | null
  /** How many base units are in one of the supplier's cases. */
  supplierPackSize?: number | null
}

export type ReferRangeInput = {
  rows: ReferRangeRow[]
  method: ReferMethod
  supplierId?: number | null
  /**
   * Copied to every row that is being created. Department, brand, VAT and the
   * rest — the family has to agree about these for the same reason a variant
   * family does. See INHERITED in productVariants.ts.
   */
  inherit?: {
    departmentId?: number | null
    brandId?: number | null
    purchaseVatRateId?: number | null
    sellingVatRateId?: number | null
    imagePath?: string | null
    imageIcon?: string | null
    imageColor?: string | null
    visibleInPos?: boolean
  }
}

export type ReferRangeResult =
  | { ok: true; productIds: number[]; created: number }
  | { ok: false; error: string }

/**
 * Validates the shape of a range and works out each rung's factor.
 *
 * Separated from the save so the screen can show the chain — "6-Pack = 6
 * singles" — while it is being typed, using the same arithmetic that will run
 * on the server. A rule enforced in two places drifts; this is the one place.
 */
export function planRange(
  rows: readonly ReferRangeRow[],
): { ok: true; factors: number[] } | { ok: false; error: string } {
  if (rows.length < 2) {
    return { ok: false, error: 'A refer range needs at least two pack sizes.' }
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: `A refer range can have at most ${MAX_ROWS} pack sizes.` }
  }

  for (const [index, row] of rows.entries()) {
    if (!row.description?.trim()) {
      return { ok: false, error: `Line ${index + 1} needs a description.` }
    }
    if (!Number.isFinite(row.packSize) || row.packSize <= 0) {
      return { ok: false, error: `Line ${index + 1} needs a pack size of more than zero.` }
    }
  }

  // Factors are relative to the rung below, so the sizes have to ascend and
  // each has to be a whole multiple of the one under it. 1 → 6 → 10 has no
  // whole factor between 6 and 10, and half a six-pack cannot be broken open.
  const factors: number[] = [0]
  for (let i = 1; i < rows.length; i++) {
    const below = rows[i - 1].packSize
    const here = rows[i].packSize

    if (here <= below) {
      return {
        ok: false,
        error: `Pack sizes must get bigger going down. Line ${i + 1} is ${here}, which is not more than ${below}.`,
      }
    }

    const factor = round(here / below, 3)
    if (Math.abs(factor - Math.round(factor)) > 0.0005) {
      return {
        ok: false,
        error: `${here} is not a whole number of ${below}s, so line ${i + 1} cannot be broken down. Use a pack size that divides evenly.`,
      }
    }
    factors.push(Math.round(factor))
  }

  return { ok: true, factors }
}

/* ── Reading and editing one chain, a rung at a time ──────────────────────
 *
 * The wizard above builds a whole range at once. This half is the other way
 * people work: open the six-pack, add the case above it, then the pallet next
 * month. Same chain, same arithmetic, one rung at a time.
 */

export type ChainRung = {
  productId: number
  code: string
  description: string
  productType: string
  /** How many of the rung BELOW one of these is. 0 at the bottom. */
  factor: number
  /** In base units — 6 for a six-pack of singles, 24 for a case. */
  packSize: number
  method: ReferMethod | null
  stockOnHand: number
  averageCost: number
  /** True for the product whose screen this is. */
  isCurrent: boolean
  /**
   * Other packs that ALSO draw on this rung, which the ladder above does not
   * pass through.
   *
   * The chain is a ladder by intent but the schema only forbids a product
   * having two targets, not a target having two products. A case and a
   * shrink-wrap both pointing at the six-pack is a fork, and the walk up can
   * only follow one branch. Naming the others is the difference between a
   * panel that is incomplete and one that lies — without this the user
   * unlinks a pack they were never shown.
   */
  alsoDrawnOnBy: { productId: number; code: string; description: string; factor: number }[]
}

/**
 * The whole ladder a product sits on, bottom rung first.
 *
 * Walks DOWN to the base following product_refers, then back UP collecting
 * everything that refers to each rung in turn. A product in the middle of a
 * chain therefore sees the same list whichever rung was opened, which is the
 * point: the ladder is one thing, not three screens.
 *
 * Depth-capped like resolveComponents, so a cycle built before the guards
 * existed reports what it can rather than hanging.
 */
export async function referChain(siteId: number, productId: number): Promise<ChainRung[]> {
  const MAX = 8

  // Down to the base.
  let baseId = productId
  for (let i = 0; i < MAX; i++) {
    const row = await siteQueryOne<Row>(
      siteId,
      'SELECT target_id FROM product_refers WHERE product_id = ?',
      [baseId],
    )
    const next = row ? Number(row.target_id) : 0
    if (!next || next === baseId) break
    baseId = next
  }

  // Back up. Ordered by factor so the smallest pack is always the next rung,
  // matching what referBreakdown opens first.
  const ids = [baseId]
  for (let i = 0; i < MAX; i++) {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT product_id FROM product_refers
        WHERE target_id = ? ORDER BY factor ASC, product_id ASC LIMIT 1`,
      [ids[ids.length - 1]],
    )
    const next = row ? Number(row.product_id) : 0
    if (!next || ids.includes(next)) break
    ids.push(next)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.product_type, p.stock_on_hand, p.average_cost,
            f.factor, f.method
       FROM products p
       LEFT JOIN product_refers f ON f.product_id = p.id
      WHERE p.id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))

  // Everything pointing at any rung, so a fork can be named rather than
  // silently dropped by the single-branch walk above.
  const dependants = await siteQuery<Row>(
    siteId,
    `SELECT f.product_id, f.target_id, f.factor, p.code, p.description
       FROM product_refers f
       JOIN products p ON p.id = f.product_id
      WHERE f.target_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )

  // Pack size is the running product of the factors, which is what a person
  // means by "a case of 24" — the stored factor is only 4.
  let packSize = 1
  return ids.map((id, index) => {
    const r = byId.get(id)
    const factor = index === 0 ? 0 : Number(r?.factor ?? 0)
    if (index > 0) packSize = round(packSize * factor, 3)

    const onLadder = ids[index + 1]
    const forks = dependants
      .filter((d) => Number(d.target_id) === id && Number(d.product_id) !== onLadder)
      .map((d) => ({
        productId: Number(d.product_id),
        code: String(d.code ?? ''),
        description: String(d.description ?? ''),
        factor: Number(d.factor ?? 0),
      }))

    return {
      alsoDrawnOnBy: forks,
      productId: id,
      code: String(r?.code ?? ''),
      description: String(r?.description ?? ''),
      productType: String(r?.product_type ?? 'normal'),
      factor,
      packSize,
      method: index === 0 ? null : ((r?.method as ReferMethod) ?? 'subtract'),
      stockOnHand: Number(r?.stock_on_hand ?? 0),
      averageCost: Number(r?.average_cost ?? 0),
      isCurrent: id === productId,
    }
  })
}

export type AddRungInput = {
  /** The rung the new one sits directly on top of. */
  belowId: number
  /** Link this existing product instead of creating one. */
  productId?: number | null
  code?: string | null
  description?: string | null
  barcode?: string | null
  /** In BASE units, the way a person says it: 24 for a case of singles. */
  packSize: number
  packDescription?: string | null
  costExcl?: number
  method: ReferMethod
}

/**
 * Adds one pack size directly above an existing rung.
 *
 * The pack size is given in base units and converted here, because that is the
 * only sane thing to type: a case is "24", not "4 six-packs". Whether it
 * divides evenly is checked for the same reason planRange checks it.
 */
export async function addReferRung(
  siteId: number,
  input: AddRungInput,
): Promise<{ ok: true; productId: number } | { ok: false; error: string }> {
  const chain = await referChain(siteId, input.belowId)
  const below = chain.find((r) => r.productId === input.belowId)
  if (!below) return { ok: false, error: 'That product is no longer there.' }

  const basePack = below.packSize || 1
  if (!Number.isFinite(input.packSize) || input.packSize <= basePack) {
    return {
      ok: false,
      error: `The pack size must be more than ${basePack}, which is what one ${below.description || 'of the one below'} holds.`,
    }
  }

  const factor = round(input.packSize / basePack, 3)
  if (Math.abs(factor - Math.round(factor)) > 0.0005) {
    return {
      ok: false,
      error: `${input.packSize} is not a whole number of ${basePack}s, so it could not be broken down. Use a pack size that divides evenly.`,
    }
  }

  // Linking something that already exists: no product to create, just the link.
  if (input.productId) {
    if (input.productId === input.belowId) {
      return { ok: false, error: 'A product cannot refer to itself.' }
    }
    if (chain.some((r) => r.productId === input.productId)) {
      return { ok: false, error: 'That product is already on this chain.' }
    }

    const existing = await siteQueryOne<Row>(
      siteId,
      'SELECT id, product_type FROM products WHERE id = ?',
      [input.productId],
    )
    if (!existing) return { ok: false, error: 'That product is no longer there.' }

    const alreadyLinked = await siteQueryOne<Row>(
      siteId,
      'SELECT product_id FROM product_refers WHERE product_id = ?',
      [input.productId],
    )
    if (alreadyLinked) {
      return {
        ok: false,
        error: 'That product already refers to something else. Unlink it first.',
      }
    }

    return siteTransaction(siteId, async (tx) => {
      // It has to BE a refer product to carry a link — saveRefer refuses
      // otherwise, and so does the sale path.
      await tx.execute("UPDATE products SET product_type = 'refer', pack_size = ? WHERE id = ?", [
        input.packSize.toFixed(3),
        input.productId,
      ] as never)
      await tx.execute(
        `INSERT INTO product_refers (product_id, target_id, factor, method)
              VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE
           target_id = VALUES(target_id), factor = VALUES(factor), method = VALUES(method)`,
        [input.productId, input.belowId, factor.toFixed(3), input.method] as never,
      )
      await ensureBaseIsStockedTx(tx, chain[0].productId)
      return { ok: true as const, productId: input.productId as number }
    })
  }

  // Otherwise create one.
  const code = await resolveMasterCode(siteId, 'product', input.code)
  if (!code) return { ok: false, error: 'A product code is needed.' }

  const clash = await siteQueryOne<Row>(siteId, 'SELECT id FROM products WHERE code = ? LIMIT 1', [
    code,
  ])
  if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

  const barcode = input.barcode?.trim() || ''
  if (barcode) {
    const taken = await barcodeClashes(siteId, [barcode], [])
    if (taken.size > 0) {
      return { ok: false, error: `Barcode ${barcode} is already on product ${[...taken.values()][0]}.` }
    }
  }

  const description =
    input.description?.trim() || `${chain[0].description} × ${input.packSize}`

  const productInput: ProductInput = {
    code,
    description,
    barcode: barcode || null,
    productType: 'refer',
    packSize: input.packSize,
    packDescription: input.packDescription ?? undefined,
    lastCost: input.costExcl ?? 0,
  }

  const invalid = validateProduct(productInput)
  if (invalid) return { ok: false, error: invalid }

  // Inherited from the rung below, for the reason variants inherit them: a
  // pack in a different department from its own single is always a mistake.
  const inherit = await siteQueryOne<Row>(
    siteId,
    `SELECT department_id, brand_id, purchase_vat_rate_id, selling_vat_rate_id
       FROM products WHERE id = ?`,
    [input.belowId],
  )
  productInput.departmentId = (inherit?.department_id as number) ?? null
  productInput.brandId = (inherit?.brand_id as number) ?? null
  productInput.purchaseVatRateId = (inherit?.purchase_vat_rate_id as number) ?? undefined
  productInput.sellingVatRateId = (inherit?.selling_vat_rate_id as number) ?? undefined

  const vat = await resolveVat(siteId, productInput)

  return siteTransaction(siteId, async (tx) => {
    const id = await insertProductTx(tx, { ...productInput, code }, vat)
    await tx.execute(
      `INSERT INTO product_refers (product_id, target_id, factor, method)
            VALUES (?,?,?,?)`,
      [id, input.belowId, factor.toFixed(3), input.method] as never,
    )
    await ensureBaseIsStockedTx(tx, chain[0].productId)
    return { ok: true as const, productId: id }
  })
}

/**
 * Takes a rung off the chain.
 *
 * Whatever sat above it is re-pointed at whatever sat below, with the factors
 * multiplied together, so removing the six-pack from single ← six ← case
 * leaves single ← case at factor 24. Deleting the link alone would strand the
 * case pointing at nothing.
 */
export async function removeReferRung(
  siteId: number,
  productId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const chain = await referChain(siteId, productId)
  const index = chain.findIndex((r) => r.productId === productId)
  if (index < 0) return { ok: false, error: 'That product is not on this chain.' }
  if (index === 0) {
    return {
      ok: false,
      error: 'The base product is what the chain is counted in. Remove the pack sizes above it first.',
    }
  }

  const above = chain[index + 1]
  const below = chain[index - 1]

  return siteTransaction(siteId, async (tx) => {
    if (above) {
      // The rung above closes the gap, keeping the same number of base units.
      const merged = round(above.factor * chain[index].factor, 3)
      await tx.execute('UPDATE product_refers SET target_id = ?, factor = ? WHERE product_id = ?', [
        below.productId,
        merged.toFixed(3),
        above.productId,
      ] as never)
    }
    await tx.execute('DELETE FROM product_refers WHERE product_id = ?', [productId] as never)
    return { ok: true as const }
  })
}

/**
 * The base of a chain must not be a dangling refer.
 *
 * Same rule createReferRange applies, for the same reason: a refer product
 * with nothing under it is refused by resolveComponents on every sale.
 */
async function ensureBaseIsStockedTx(
  tx: import('mysql2/promise').PoolConnection,
  baseId: number,
): Promise<void> {
  const [rows] = (await tx.execute(
    `SELECT p.product_type, f.product_id AS linked
       FROM products p
       LEFT JOIN product_refers f ON f.product_id = p.id
      WHERE p.id = ? FOR UPDATE`,
    [baseId] as never,
  )) as unknown as [Row[]]
  const base = rows[0]
  if (base && String(base.product_type) === 'refer' && !base.linked) {
    await tx.execute("UPDATE products SET product_type = 'normal' WHERE id = ?", [baseId] as never)
  }
}

/** Products already using any of these barcodes, so the caller can refuse. */
async function barcodeClashes(
  siteId: number,
  barcodes: readonly string[],
  ignoreIds: readonly number[],
): Promise<Map<string, string>> {
  const wanted = barcodes.map((b) => b.trim()).filter(Boolean)
  if (wanted.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT code, barcode FROM products
      WHERE barcode IN (${wanted.map(() => '?').join(',')})
        ${ignoreIds.length ? `AND id NOT IN (${ignoreIds.map(() => '?').join(',')})` : ''}`,
    [...wanted, ...ignoreIds],
  )

  return new Map(rows.map((r) => [String(r.barcode), String(r.code)]))
}

/**
 * Creates the products a range is missing and chains them together.
 *
 * Rows carrying a productId are left alone — they already exist and the user
 * may have set them up carefully. Only the links are written for those.
 */
export async function createReferRange(
  siteId: number,
  input: ReferRangeInput,
): Promise<ReferRangeResult> {
  const plan = planRange(input.rows)
  if (!plan.ok) return { ok: false, error: plan.error }

  /*
   * Everything that READS happens before the transaction opens: resolving
   * auto-numbered codes, checking them for clashes, checking barcodes, and
   * resolving the VAT rates. A range refused for a duplicate code should be
   * refused before a single row is written.
   */
  const existingIds = input.rows.map((r) => r.productId).filter((id): id is number => !!id)

  const barcodes = input.rows.map((r) => r.barcode?.trim() ?? '').filter(Boolean)
  const duplicate = barcodes.find((b, i) => barcodes.indexOf(b) !== i)
  if (duplicate) {
    return { ok: false, error: `Barcode ${duplicate} is on more than one line of this range.` }
  }

  /*
   * products.barcode has no unique index and findByBarcode takes the first
   * match it sees, so a duplicate would not fail loudly — the till would just
   * ring up whichever product was created first. Checked here because nothing
   * below will check it.
   */
  const clashes = await barcodeClashes(siteId, barcodes, existingIds)
  if (clashes.size > 0) {
    const [barcode, code] = [...clashes.entries()][0]
    return { ok: false, error: `Barcode ${barcode} is already on product ${code}.` }
  }

  const prepared: Array<{ row: ReferRangeRow; code: string; input: ProductInput } | null> = []
  const seenCodes = new Set<string>()

  for (const [index, row] of input.rows.entries()) {
    if (row.productId) {
      prepared.push(null)
      continue
    }

    const code = await resolveMasterCode(siteId, 'product', row.code)
    if (!code) {
      return { ok: false, error: `Line ${index + 1} needs a product code.` }
    }
    if (seenCodes.has(code)) {
      return { ok: false, error: `Product code "${code}" is on more than one line of this range.` }
    }
    seenCodes.add(code)

    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM products WHERE code = ? LIMIT 1',
      [code],
    )
    if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

    /*
     * The base rung is an ordinary stocked product; everything above it is a
     * refer. Under subtract pack that is what makes the base the one pile the
     * others draw from, and under normal refers it is simply where the chain
     * stops.
     */
    const productInput: ProductInput = {
      code,
      description: row.description.trim(),
      barcode: row.barcode?.trim() || null,
      productType: index === 0 ? 'normal' : 'refer',
      packSize: row.packSize,
      packDescription: row.packDescription ?? undefined,
      lastCost: row.costExcl ?? 0,
      prices: row.prices,
      departmentId: input.inherit?.departmentId ?? null,
      brandId: input.inherit?.brandId ?? null,
      purchaseVatRateId: input.inherit?.purchaseVatRateId ?? undefined,
      sellingVatRateId: input.inherit?.sellingVatRateId ?? undefined,
      imagePath: input.inherit?.imagePath ?? null,
      imageIcon: input.inherit?.imageIcon ?? null,
      imageColor: input.inherit?.imageColor ?? null,
      visibleInPos: input.inherit?.visibleInPos ?? true,
    }

    const invalid = validateProduct(productInput)
    if (invalid) return { ok: false, error: `Line ${index + 1}: ${invalid}` }

    prepared.push({ row, code, input: productInput })
  }

  const vat = await resolveVat(siteId, {
    code: '',
    description: '',
    purchaseVatRateId: input.inherit?.purchaseVatRateId ?? undefined,
    sellingVatRateId: input.inherit?.sellingVatRateId ?? undefined,
  })

  const method: ReferMethod = input.method === 'normal' ? 'normal' : 'subtract'

  return siteTransaction(siteId, async (tx) => {
    const ids: number[] = []
    let created = 0

    for (const [index, row] of input.rows.entries()) {
      const ready = prepared[index]
      if (!ready) {
        ids.push(row.productId as number)
        continue
      }
      ids.push(await insertProductTx(tx, { ...ready.input, code: ready.code }, vat))
      created++
    }

    /*
     * The base rung must not be a dangling refer.
     *
     * A product that was already type 'refer' — the usual way in, since the
     * wizard hangs off the Refer tab — has nothing below it to point at once
     * it becomes the bottom of a chain. Left as it is, resolveComponents()
     * refuses every sale of it with "no linked product set up yet", and the
     * whole range is unsellable. So the base becomes an ordinary stocked
     * product, which is what the bottom of a chain always is.
     *
     * Only when it has no link of its own: a range built on top of an
     * existing, correctly-linked refer product is a longer chain, not a new
     * bottom, and that link must survive.
     */
    const [baseRow] = (await tx.execute(
      `SELECT p.product_type, f.product_id AS linked
         FROM products p
         LEFT JOIN product_refers f ON f.product_id = p.id
        WHERE p.id = ? FOR UPDATE`,
      [ids[0]] as never,
    )) as unknown as [Row[]]
    const baseProduct = baseRow[0]
    if (baseProduct && String(baseProduct.product_type) === 'refer' && !baseProduct.linked) {
      await tx.execute("UPDATE products SET product_type = 'normal' WHERE id = ?", [
        ids[0],
      ] as never)
    }

    /*
     * The chain, each rung pointing at the one below it. Written directly
     * rather than through saveRefer() because that runs its own queries
     * outside this transaction and re-resolves the chain after every link —
     * which would refuse rung 3 for pointing at a rung 2 that, as far as a
     * separate connection is concerned, does not exist yet.
     *
     * The cycle check saveRefer does is not needed here: a range is built from
     * a fresh list, ascending, so it cannot close a loop.
     */
    for (let i = 1; i < ids.length; i++) {
      await tx.execute(
        `INSERT INTO product_refers (product_id, target_id, factor, method)
              VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE
           target_id = VALUES(target_id), factor = VALUES(factor), method = VALUES(method)`,
        [ids[i], ids[i - 1], plan.factors[i].toFixed(3), method] as never,
      )
    }

    // The supplier's own code and case size, per rung — the buyer orders
    // cases, and a PO that went out with the single's reference on it would be
    // filled wrongly.
    if (input.supplierId) {
      for (const [index, row] of input.rows.entries()) {
        const code = row.supplierCode?.trim()
        const packSize = row.supplierPackSize ?? 0
        if (!code && packSize <= 0) continue

        await tx.execute(
          `INSERT INTO product_suppliers (product_id, supplier_id, supplier_code, last_cost, pack_size)
                VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             supplier_code = COALESCE(VALUES(supplier_code), supplier_code),
             pack_size     = VALUES(pack_size)`,
          [
            ids[index],
            input.supplierId,
            code || null,
            (row.costExcl ?? 0).toFixed(4),
            (packSize > 0 ? packSize : 1).toFixed(3),
          ] as never,
        )
      }
    }

    return { ok: true as const, productIds: ids, created }
  })
}
