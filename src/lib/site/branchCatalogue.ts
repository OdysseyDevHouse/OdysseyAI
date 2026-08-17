import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'

/**
 * Turning a catalogue's products into a branch's own.
 *
 * ── WHY IDS CANNOT TRAVEL ───────────────────────────────────────────────────
 *
 * A group storefront prices from the primary's product file, but the order is
 * written into the branch's database, where online_order_lines.product_id is a
 * foreign key into that branch's OWN products table. Ids auto-increment
 * independently in every database and say nothing about each other: product 412
 * at head office and product 412 at the branch are unrelated rows.
 *
 * The product CODE is the only identity shared across databases. That is not a
 * choice made here — it is the rule productFanout.ts already works by, and
 * product_share_settings is keyed by code for the same reason.
 *
 * So: everything the shopper sees is resolved by id against the catalogue, and
 * the single translation to branch ids happens once, just before the order is
 * written.
 */

type ProductRow = RowDataPacket & {
  id: number
  code: string
  description: string
  stock_on_hand: string | number | null
}

export type BranchProduct = {
  id: number
  code: string
  description: string
  /** The branch's site-wide figure. Advisory — see stockAcrossBranches. */
  stockOnHand: number
}

/** Codes are matched case-insensitively but compared here in one canonical form. */
const key = (code: string) => code.trim().toUpperCase()

/**
 * The branch's own rows for a set of product codes.
 *
 * One query for the whole basket rather than one per line: a ten-line order
 * would otherwise be ten round trips into another database.
 *
 * A code the branch does not carry is simply absent from the map. Callers must
 * treat that as "this shop does not stock this", which is a real answer for a
 * chain — the Sea Point branch genuinely has a seafood menu Claremont does not.
 */
export async function branchProductsByCode(
  branchSiteId: number,
  codes: readonly string[],
): Promise<Map<string, BranchProduct>> {
  const wanted = [...new Set(codes.map(key).filter(Boolean))]
  if (wanted.length === 0) return new Map()

  const placeholders = wanted.map(() => '?').join(',')
  const rows = await siteQuery<ProductRow>(
    branchSiteId,
    `SELECT id, code, description, stock_on_hand
       FROM products
      WHERE UPPER(code) IN (${placeholders})
        AND is_archived = 0`,
    wanted,
  )

  const out = new Map<string, BranchProduct>()
  for (const r of rows) {
    out.set(key(String(r.code)), {
      id: Number(r.id),
      code: String(r.code),
      description: String(r.description ?? ''),
      stockOnHand: Number(r.stock_on_hand ?? 0),
    })
  }
  return out
}

export type BranchStock = {
  siteId: number
  /** True when that shop has it on the shelf and has not marked it off today. */
  available: boolean
}

/**
 * Which other branches have this product.
 *
 * ── WHY THIS IS ONLY EVER CALLED FROM A PRODUCT PAGE ────────────────────────
 *
 * It opens one database per branch. On a product page that is one round trip's
 * latency for a question a shopper is actually asking; on a 120-tile grid it
 * would be 120 of them, so the grid must never call this. The cap below is the
 * second guard: a forty-branch group fans out to the nearest few, not to forty.
 *
 * Advisory, and deliberately so. It answers "is it worth switching shops",
 * which tolerates being a minute stale — the branch re-checks everything when
 * the order actually arrives. Nothing here decides a price or blocks an order.
 */
export async function stockAcrossBranches(
  branchSiteIds: readonly number[],
  code: string,
  limit = 5,
): Promise<BranchStock[]> {
  const ids = [...new Set(branchSiteIds.filter((id) => Number.isInteger(id) && id > 0))].slice(
    0,
    Math.max(0, limit),
  )
  if (ids.length === 0 || !code.trim()) return []

  const results = await Promise.all(
    ids.map(async (siteId) => {
      try {
        const rows = await siteQuery<ProductRow>(
          siteId,
          `SELECT p.id, p.code, p.description, p.stock_on_hand
             FROM products p
             LEFT JOIN online_product_availability a
               ON a.product_id = p.id AND a.unavailable_until >= CURDATE()
            WHERE UPPER(p.code) = ? AND p.is_archived = 0 AND a.product_id IS NULL
            LIMIT 1`,
          [key(code)],
        )
        const row = rows[0]
        return { siteId, available: !!row && Number(row.stock_on_hand ?? 0) > 0 }
      } catch {
        /*
         * A branch whose database is unreachable is reported as NOT having it,
         * never as having it. Sending a shopper across town to a shop that
         * cannot confirm the stock is worse than staying quiet about it.
         */
        return { siteId, available: false }
      }
    }),
  )

  return results.filter((r) => r.available)
}

export type TranslatedLine<T> = T & { branchProductId: number }

export type TranslationResult<T> =
  | { ok: true; lines: TranslatedLine<T>[] }
  /** Named so the shopper is told WHICH item, not that "something" went wrong. */
  | { ok: false; missing: string[] }

/**
 * Rewrites a priced basket onto the branch's product ids.
 *
 * ── WHY A MISSING CODE REFUSES THE WHOLE ORDER ──────────────────────────────
 *
 * Silently dropping the line is the tempting alternative and it is wrong twice
 * over: the shopper pressed a button showing a total that included it, and the
 * branch would receive an order that is quietly not what was asked for. Refusing
 * by name lets the storefront say "Rondebosch doesn't carry Peri Peri Wings" and
 * offer the two things that actually help — remove it, or go back to the branch
 * that has it.
 */
export function translateToBranch<T extends { code: string; description: string }>(
  lines: readonly T[],
  branchProducts: Map<string, BranchProduct>,
): TranslationResult<T> {
  const missing: string[] = []
  const out: TranslatedLine<T>[] = []

  for (const line of lines) {
    const match = branchProducts.get(key(line.code))
    if (!match) {
      missing.push(line.description || line.code)
      continue
    }
    out.push({ ...line, branchProductId: match.id })
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, lines: out }
}

/**
 * A sentence naming what the branch cannot supply.
 *
 * Lists at most three. A shopper whose basket has gone badly wrong needs to know
 * that and to be offered a way out, not to read a wall of product names.
 */
export function missingAtBranchMessage(missing: readonly string[], branchName: string): string {
  const shown = missing.slice(0, 3).join(', ')
  const rest = missing.length - 3
  const tail = rest > 0 ? `, and ${rest} other item${rest === 1 ? '' : 's'}` : ''
  return `${branchName} doesn't carry ${shown}${tail}. Remove ${missing.length === 1 ? 'it' : 'them'}, or choose a store that has ${missing.length === 1 ? 'it' : 'them'}.`
}
