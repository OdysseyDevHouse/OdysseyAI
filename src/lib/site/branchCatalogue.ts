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
