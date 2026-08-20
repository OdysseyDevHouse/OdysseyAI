import 'server-only'
import { cache } from 'react'
import { queryOne } from '../db'
import { MASTER, type SitePurpose } from '../siteDb'

/**
 * Which database an OPEN TAB lives in.
 *
 * ── THE WHOLE OF THE ROUTING ──────────────────────────────────────────────
 *
 * `siteQuery` and friends already take a `purpose`, defaulting to MASTER. So
 * routing a tab to the in-store box is not a new mechanism — it is choosing a
 * different purpose for a small, named set of calls. This module is where that
 * choice is made, and it is deliberately the ONLY place: a second decision
 * somewhere else is how a tab comes to be written to one database and read from
 * another.
 *
 * ── WHAT ROUTES, AND WHAT MUST NOT ────────────────────────────────────────
 *
 * ONLY the open tab: pos_tables, and the `saved` sales_documents row a table
 * points at, with its lines. That is what the box holds.
 *
 * Everything else keeps reaching the cloud, and the list of what "everything
 * else" means is long and important: stock, the ledger, loyalty, serials,
 * tips, shifts, customers, products, pricing, the audit trail. The box has no
 * tables for any of it — see sql/box/001_spool.sql, which is seven tables.
 *
 * This is the opposite of what LOCAL mode does. A local install sets
 * SITE_DB_HOST_OVERRIDE and every site query silently follows it to 127.0.0.1.
 * Hybrid must never do that: it would send the whole shop to a box that has
 * three of its tables.
 *
 * ── AND WHY FINALISING IS NOT ON THIS LIST ────────────────────────────────
 *
 * `finaliseDocument` reaches into ~20 modules and writes stock, tenders,
 * serials and audit. It runs in the CLOUD when the sale arrives, exactly as it
 * already does for an offline till (see lib/site/offlineSync.ts — "there is no
 * second posting path"). The box captures the finalised sale into its outbox
 * and pushes it; it never posts.
 *
 * So a tab's life is: opened on the box, edited on the box, and then handed to
 * the cloud, which is the first moment any of the shop's other tables move.
 */

/** The control panel's name for the in-store box's database record. */
export const HYBRID: SitePurpose = 'hybrid'

/**
 * Is this site's tab data on an in-store box?
 *
 * Memoised per request with cache(), like entitlementsForSite: a page, an
 * action and a component may all ask within one render and must get the same
 * answer. The memo dies with the request, so a site switched in the control
 * panel takes effect on the next one.
 *
 * ── IT FAILS TOWARDS THE CLOUD ────────────────────────────────────────────
 *
 * A control-database blip returns false, and false means "use the cloud" — the
 * behaviour every site had before this existed. The alternative would be to
 * route tabs at a box that may not be configured, which turns a brief blip into
 * a till that cannot open a table.
 */
export const tabsAreLocal = cache(async (siteId: number): Promise<boolean> => {
  try {
    const row = await queryOne<{ connection_type: string }>(
      'SELECT connection_type FROM cp2_sites WHERE id = ? LIMIT 1',
      [siteId],
    )
    return row?.connection_type === 'hybrid'
  } catch {
    return false
  }
})

/**
 * The purpose to read and write a tab with.
 *
 * Every tab call passes this instead of taking siteQuery's default. A call that
 * forgets goes to the cloud — which is safe (the cloud has every table) but
 * wrong (the box is what the ten tills share), and it shows up as a table that
 * one till can see and another cannot.
 */
export async function tabPurpose(siteId: number): Promise<SitePurpose> {
  return (await tabsAreLocal(siteId)) ? HYBRID : MASTER
}

/**
 * Whether the box is reachable right now.
 *
 * Distinct from `tabsAreLocal`, and the difference is the fallback rule in the
 * plan: a site can be hybrid (configured) while its box is unreachable (cable
 * out, machine off, wrong host in the control panel). The till must then trade
 * cash-and-carry rather than refuse — a cabling mistake must not become a shop
 * that cannot take money.
 *
 * Deliberately NOT memoised with the same lifetime as tabsAreLocal: whether a
 * box answers is a fact about right now, and a request that starts with the box
 * up should not keep believing that for its whole life if it goes down midway.
 * It is still memoised per request, because asking twice in one render would
 * double the latency for no new information.
 */
export const boxIsReachable = cache(async (siteId: number): Promise<boolean> => {
  if (!(await tabsAreLocal(siteId))) return false
  try {
    const { siteQueryOne } = await import('../siteDb')
    const row = await siteQueryOne<{ site_id: number }>(
      siteId,
      'SELECT site_id FROM box_identity WHERE id = 1 LIMIT 1',
      [],
      HYBRID,
    )
    /* An identity row that names a DIFFERENT site is worse than no box at all:
       it would serve this till somebody else's tabs while looking correct. Treat
       it as unreachable, which sends the till to its own local fallback rather
       than into another shop's floor. */
    return row?.site_id === siteId
  } catch {
    return false
  }
})

/**
 * Where a tab should actually be read and written, accounting for a box that
 * is not answering.
 *
 *   'box'   — the box is configured and reachable. It is the ONLY truth; the
 *             device does not write tabs locally at all.
 *   'cloud' — an ordinary cloud site.
 *   'none'  — configured for a box that cannot be reached. There is no shared
 *             tab available; the till falls back to its own device-local
 *             baskets, which are marked local and recalled where they were
 *             taken. They never migrate to the box: uploading them would invent
 *             bills for baskets that may be abandoned, and then need
 *             reconciling against tabs the same till opened online — two
 *             sources for "what is open here".
 */
export type TabLocation = 'box' | 'cloud' | 'none'

export async function tabLocation(siteId: number): Promise<TabLocation> {
  if (!(await tabsAreLocal(siteId))) return 'cloud'
  return (await boxIsReachable(siteId)) ? 'box' : 'none'
}
