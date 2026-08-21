import 'server-only'
import { siteQuery, siteTransaction } from '@/lib/siteDb'
import { supplierDbPrefix, supplierQuery } from '@/lib/site/customerDb'
import { round, toNum } from '@/lib/decimals'

/**
 * Who we buy a product from, and what they call it.
 *
 * `product_suppliers` has been written by the receiving path since purchasing
 * was built — a GRV stamps the supplier's code and the cost it came in at, so
 * the next order goes out with their reference on it. What was missing is the
 * other direction: setting the link up BEFORE the first delivery, which is the
 * only way the first order can carry the right code.
 *
 * ── WHY last_cost IS EDITABLE HERE ───────────────────────────────────────
 *
 * Receiving owns this figure in normal operation and overwrites whatever is
 * here. Letting it be typed is for the day the link is created: a shop loading
 * its supplier list from a price sheet has a real cost and no delivery yet, and
 * making them receive stock to record it would be absurd. Once goods arrive,
 * the receipt wins — which is correct, because that is what was actually paid.
 *
 * ── ONE PREFERRED SUPPLIER ───────────────────────────────────────────────
 *
 * `is_preferred` is enforced as at most one per product rather than by a unique
 * key, because "no preferred supplier" is a legitimate state and a unique index
 * on (product_id, is_preferred) would forbid two non-preferred rows.
 */

type Row = Record<string, unknown>

export type ProductSupplier = {
  productId: number
  supplierId: number
  supplierCode: string | null
  supplierName: string
  supplierAccountCode: string
  /** Their stock code for it — what goes on the order, rarely ours. */
  lastCost: number
  packSize: number
  isPreferred: boolean
}

/** One link as the form submits it. */
export type ProductSupplierInput = {
  supplierId: number
  supplierCode?: string | null
  lastCost?: number
  packSize?: number
  isPreferred?: boolean
}

export type SaveResult = { ok: true } | { ok: false; error: string }

export async function listProductSuppliers(
  siteId: number,
  productId: number,
): Promise<ProductSupplier[]> {
  // product_suppliers stays in the branch (206); the supplier's name may be the
  // group's. So this runs here and names the far side.
  const sdb = await supplierDbPrefix(siteId)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ps.product_id, ps.supplier_id, ps.supplier_code, ps.last_cost,
            ps.pack_size, ps.is_preferred,
            s.name AS supplier_name, s.code AS supplier_account_code
       FROM product_suppliers ps
       JOIN ${sdb}suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = ?
      ORDER BY ps.is_preferred DESC, s.name`,
    [productId],
  )

  return rows.map((r) => ({
    productId: Number(r.product_id),
    supplierId: Number(r.supplier_id),
    supplierCode: (r.supplier_code as string | null) ?? null,
    supplierName: String(r.supplier_name),
    supplierAccountCode: String(r.supplier_account_code),
    lastCost: toNum(r.last_cost),
    packSize: toNum(r.pack_size),
    isPreferred: Number(r.is_preferred) === 1,
  }))
}

/**
 * Replaces the whole set of suppliers for a product.
 *
 * Replace rather than merge, for the same reason the instruction links work
 * that way: the form shows every row, so what comes back IS the intended set,
 * and a supplier the user deleted has to actually go.
 *
 * The delete-then-insert runs in one transaction so a failure halfway cannot
 * leave a product with no suppliers at all.
 */
export async function saveProductSuppliers(
  siteId: number,
  productId: number,
  links: readonly ProductSupplierInput[],
): Promise<SaveResult> {
  const seen = new Set<number>()
  for (const link of links) {
    if (!Number.isFinite(link.supplierId) || link.supplierId <= 0) {
      return { ok: false, error: 'Choose a supplier for every line.' }
    }
    if (seen.has(link.supplierId)) {
      return { ok: false, error: 'The same supplier is listed twice. Combine the lines.' }
    }
    seen.add(link.supplierId)

    if (link.lastCost != null && (!Number.isFinite(link.lastCost) || link.lastCost < 0)) {
      return { ok: false, error: 'A supplier price cannot be negative.' }
    }
    // Zero would make an order line for a whole case deduct nothing, so it is
    // refused here rather than dividing by it later.
    if (link.packSize != null && (!Number.isFinite(link.packSize) || link.packSize <= 0)) {
      return { ok: false, error: 'Pack size must be more than zero.' }
    }
  }

  const preferred = links.filter((l) => l.isPreferred)
  if (preferred.length > 1) {
    return { ok: false, error: 'Only one supplier can be the preferred one.' }
  }

  // Verified in one query rather than per row: a stale form naming a supplier
  // that has since been deleted must fail with a clear message, not an FK error.
  if (links.length > 0) {
    const ids = [...seen]
    // Against the file that actually holds them. Read locally under sharing
    // this finds nothing and every save is refused as "no longer exists" —
    // and the FK that used to catch a genuinely missing supplier is gone (206),
    // so this check IS the integrity now.
    const found = await supplierQuery<Row>(
      siteId,
      `SELECT id FROM suppliers WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    )
    if (found.length !== ids.length) {
      return { ok: false, error: 'One of those suppliers no longer exists.' }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_suppliers WHERE product_id = ?', [productId] as never)

    for (const link of links) {
      await tx.execute(
        `INSERT INTO product_suppliers
           (product_id, supplier_id, supplier_code, last_cost, pack_size, is_preferred)
         VALUES (?,?,?,?,?,?)`,
        [
          productId,
          link.supplierId,
          link.supplierCode?.trim() || null,
          round(link.lastCost ?? 0, 4).toFixed(4),
          round(link.packSize && link.packSize > 0 ? link.packSize : 1, 3).toFixed(3),
          link.isPreferred ? 1 : 0,
        ] as never,
      )
    }
  })

  return { ok: true }
}
