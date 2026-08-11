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
