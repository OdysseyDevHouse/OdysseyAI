import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { effectiveCost } from '../pricing'
import { applyRule, toEndingDirection, type RepriceRule } from '../repricing'
import { getCostBasis } from './lookups'
import { getSetting } from './settings'

/**
 * Bulk repricing — filling a price type across the catalogue.
 *
 * Adding a "Wholesale" price type leaves every product with no price under it.
 * Setting 40 000 of them by hand is not a plan, so this fills them from a rule:
 * cost plus a markup, or a percentage off Retail.
 *
 * PREVIEW AND APPLY RUN THE SAME CODE. `planReprice` builds the full list of
 * changes and `applyReprice` writes a plan it is handed back. A preview that
 * re-derives its numbers separately from the write is a preview that lies the
 * first time the two drift, and this one moves every shelf price in the shop.
 */

type Row = RowDataPacket & Record<string, unknown>

export type RepriceScope = {
  /** The price type being filled. */
  targetStructureId: number
  departmentIds?: number[]
  brandIds?: number[]
  /** Archived products are excluded unless this is on. */
  includeArchived?: boolean
  /** Only products with no price yet under the target — the first-fill case. */
  onlyMissing?: boolean
}

export type RepriceChange = {
  productId: number
  code: string
  description: string
  costExcl: number
  currentIncl: number | null
  newIncl: number
  changed: boolean
}

export type RepriceSkip = {
  productId: number
  code: string
  description: string
  reason: string
}

export type RepricePlan = {
  changes: RepriceChange[]
  skips: RepriceSkip[]
  /** Every product the scope matched, whether it produced a change or not. */
  considered: number
}

/**
 * Builds the list of new prices without writing anything.
 *
 * Deliberately unbounded: the caller shows a sample, but the plan itself must
 * cover the whole scope or the count under the Apply button would be a guess.
 */
export async function planReprice(
  siteId: number,
  scope: RepriceScope,
  rule: RepriceRule,
): Promise<RepricePlan> {
  const basis = await getCostBasis(siteId)

  // A rule that names no direction takes the site's. Resolved ONCE here rather
  // than per product, and folded into the rule so the preview and the write
  // cannot disagree about it.
  const effectiveRule: RepriceRule =
    rule.rounding.kind === 'ending' && rule.rounding.direction === undefined
      ? {
          ...rule,
          rounding: {
            ...rule.rounding,
            direction: toEndingDirection(await getSetting(siteId, 'price_ending_direction')),
          },
        }
      : rule

  // Seeded with a true predicate: every other clause is conditional, and
  // "include archived, no filters" would otherwise leave a bare WHERE.
  const where: string[] = ['1 = 1']
  const params: unknown[] = []

  if (!scope.includeArchived) where.push('p.is_archived = 0')

  if (scope.departmentIds?.length) {
    where.push(`p.department_id IN (${scope.departmentIds.map(() => '?').join(',')})`)
    params.push(...scope.departmentIds)
  }
  if (scope.brandIds?.length) {
    where.push(`p.brand_id IN (${scope.brandIds.map(() => '?').join(',')})`)
    params.push(...scope.brandIds)
  }

  // No product_type is excluded here. A 'service' or 'refer' line still has a
  // selling price, and the ones with no cost fall out on their own as skips
  // with a reason — which is more honest than a filter that hides them.

  const sourceStructureId =
    effectiveRule.source.kind === 'structure' ? effectiveRule.source.structureId : null

  // The target price and the source price are both correlated subqueries rather
  // than joins: a LEFT JOIN to product_prices twice needs two aliases and still
  // multiplies rows if either side ever gains a duplicate. This cannot.
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.average_cost, p.last_cost,
            COALESCE(v.rate, 0) AS vat_rate,
            (SELECT pp.selling_price_incl FROM product_prices pp
              WHERE pp.product_id = p.id AND pp.price_structure_id = ?) AS current_incl
            ${
              sourceStructureId
                ? `, (SELECT pp2.selling_price_incl FROM product_prices pp2
                       WHERE pp2.product_id = p.id AND pp2.price_structure_id = ?) AS source_incl`
                : ', NULL AS source_incl'
            }
       FROM products p
       LEFT JOIN vat_rates v ON v.id = p.selling_vat_rate_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.description ASC`,
    sourceStructureId
      ? [scope.targetStructureId, sourceStructureId, ...params]
      : [scope.targetStructureId, ...params],
  )

  const changes: RepriceChange[] = []
  const skips: RepriceSkip[] = []

  for (const r of rows) {
    const currentIncl = r.current_incl === null ? null : toNum(r.current_incl)

    // "Only products without a price yet" — the first-fill case, where the
    // point is to leave hand-set prices exactly as they are.
    if (scope.onlyMissing && currentIncl !== null) continue

    const costExcl = effectiveCost(toNum(r.average_cost), toNum(r.last_cost), basis)
    const outcome = applyRule(effectiveRule, {
      costExcl,
      sourceIncl: r.source_incl === null ? null : toNum(r.source_incl),
      sellingVatPercent: toNum(r.vat_rate),
      currentIncl,
    })

    if (!outcome.ok) {
      skips.push({
        productId: Number(r.id),
        code: String(r.code),
        description: String(r.description),
        reason: outcome.reason,
      })
      continue
    }

    changes.push({
      productId: Number(r.id),
      code: String(r.code),
      description: String(r.description),
      costExcl,
      currentIncl,
      newIncl: outcome.priceIncl,
      changed: outcome.changed,
    })
  }

  return { changes, skips, considered: rows.length }
}

export type ApplyResult = { ok: true; written: number } | { ok: false; error: string }

/** One price, going in. */
export type PriceRow = { productId: number; priceStructureId: number; priceIncl: number }

/** Who moved a price, and through which door — the history row's two facts. */
export type PriceAudit = {
  /**
   * `grv` is a price the buyer set while receiving a delivery (193): the
   * supplier's cost changed, so the shelf price was changed with it, and the
   * receipt is the document that decided it. `sourceDocId` is that GRV.
   */
  source: 'editor' | 'import' | 'reprice' | 'schedule' | 'revert' | 'fanout' | 'grv'
  sourceDocId?: number | null
  userName: string
}

/**
 * How a price is written. The one definition of it.
 *
 * Takes a transaction rather than opening one, because both callers have
 * something else that must live or die with the write — the bulk reprice has
 * the rest of its plan, and a scheduled change has its own status stamp and
 * audit row. A helper that committed on its own could leave either half-done.
 *
 * Batched because a 40 000-row catalogue is one statement per product
 * otherwise, and the MySQL round-trips are what turn seconds into minutes.
 * Rows spanning several price types are fine: the structure is per row.
 *
 * ── EVERY WRITE LEAVES HISTORY (144) ──────────────────────────────────────
 *
 * The old figure is read before the upsert and a product_price_history row is
 * written per GENUINE change — a write restating the same price records
 * nothing, so a seeded reprice cannot manufacture forty thousand identical
 * rows. This being the one definition of a price write is exactly what makes
 * the history complete: editor, import, reprice, schedule, revert and fanout
 * all pass through here, each naming itself.
 */
export async function writePriceRows(
  tx: PoolConnection,
  rows: readonly PriceRow[],
  audit: PriceAudit,
): Promise<void> {
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)

    // The BEFORE picture, read inside the same transaction as the write.
    const pairFilter = slice.map(() => '(product_id = ? AND price_structure_id = ?)').join(' OR ')
    const pairParams: unknown[] = []
    for (const r of slice) pairParams.push(r.productId, r.priceStructureId)
    const [beforeRows] = await tx.query(
      `SELECT product_id, price_structure_id, selling_price_incl
         FROM product_prices WHERE ${pairFilter}`,
      pairParams as never,
    )
    const before = new Map<string, number>()
    for (const b of beforeRows as { product_id: number; price_structure_id: number; selling_price_incl: unknown }[]) {
      before.set(`${b.product_id}:${b.price_structure_id}`, Number(b.selling_price_incl))
    }

    const values = slice.map(() => '(?, ?, ?)').join(',')
    const params: unknown[] = []
    for (const r of slice) {
      params.push(r.productId, r.priceStructureId, r.priceIncl.toFixed(4))
    }
    await tx.execute(
      `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
            VALUES ${values}
       ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
      params as never,
    )

    const changed = slice.filter((r) => {
      const old = before.get(`${r.productId}:${r.priceStructureId}`)
      return old === undefined || Math.abs(old - r.priceIncl) > 0.00005
    })
    if (changed.length > 0) {
      const hv = changed.map(() => '(?,?,?,?,?,?,?)').join(',')
      const hp: unknown[] = []
      for (const r of changed) {
        const old = before.get(`${r.productId}:${r.priceStructureId}`)
        hp.push(
          r.productId,
          r.priceStructureId,
          old === undefined ? null : old.toFixed(4),
          r.priceIncl.toFixed(4),
          audit.source,
          audit.sourceDocId ?? null,
          audit.userName.slice(0, 120),
        )
      }
      await tx.execute(
        `INSERT INTO product_price_history
           (product_id, price_structure_id, old_price_incl, new_price_incl, source, source_doc_id, user_name)
         VALUES ${hv}`,
        hp as never,
      )
    }
  }
}

/** A price row's DELETION, on the record — a schedule revert of a first fill. */
export async function recordPriceRemoval(
  tx: PoolConnection,
  rows: readonly { productId: number; priceStructureId: number; oldPriceIncl: number }[],
  audit: PriceAudit,
): Promise<void> {
  if (rows.length === 0) return
  const values = rows.map(() => '(?,?,?,NULL,?,?,?)').join(',')
  const params: unknown[] = []
  for (const r of rows) {
    params.push(
      r.productId,
      r.priceStructureId,
      r.oldPriceIncl.toFixed(4),
      audit.source,
      audit.sourceDocId ?? null,
      audit.userName.slice(0, 120),
    )
  }
  await tx.execute(
    `INSERT INTO product_price_history
       (product_id, price_structure_id, old_price_incl, new_price_incl, source, source_doc_id, user_name)
     VALUES ${values}`,
    params as never,
  )
}

/**
 * Writes a plan.
 *
 * One transaction: a half-applied reprice is worse than none, because nothing
 * on the screen would tell you where it stopped.
 */
export async function applyReprice(
  siteId: number,
  targetStructureId: number,
  changes: RepriceChange[],
  /** Who ran it, for the history. Defaulted so old callers keep compiling. */
  userName = '',
): Promise<ApplyResult> {
  const toWrite = changes.filter((c) => c.changed)
  if (toWrite.length === 0) return { ok: true, written: 0 }

  try {
    await siteTransaction(siteId, async (tx) => {
      await writePriceRows(
        tx,
        toWrite.map((c) => ({
          productId: c.productId,
          priceStructureId: targetStructureId,
          priceIncl: c.newIncl,
        })),
        { source: 'reprice', userName },
      )
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The reprice could not be saved.' }
  }

  return { ok: true, written: toWrite.length }
}
