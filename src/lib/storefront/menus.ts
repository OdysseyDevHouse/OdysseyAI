/**
 * The shop's menu: what an item points at, and how that becomes a link.
 *
 * ── CLIENT-SAFE, BECAUSE BOTH SIDES NEED IT ──────────────────────────────
 *
 * The editor shows an owner what a menu will look like and the chrome renders
 * it. Two implementations of "where does this item go" would disagree on the
 * day somebody added a target kind, and the disagreement would be a dead link
 * in a shop's masthead — which is the failure an owner hears about from a
 * customer rather than noticing.
 *
 * ── A KIND AND A REFERENCE, NEVER A STORED URL ───────────────────────────
 *
 * A department lives at `/c/<id>` behind the shop's signed token, and both
 * halves of that can move. Storing the built path would freeze them into every
 * menu row in every shop, so a routing change becomes a data migration nobody
 * remembers to run. Building it here means one edit moves every menu at once.
 *
 * `url` is the single exception, because an outside link has no id to hold.
 */

import { safeLinkTarget } from '../storefrontModel'

/* ── Where an item can point ──────────────────────────────────────────────── */

/**
 * The things a menu item may link to.
 *
 * A closed list, because each one is a route this build actually has. An item
 * whose kind this build does not know is dropped on read rather than rendered
 * as a link to nowhere — the same stance `normaliseSections` takes for a
 * section kind it cannot draw.
 */
export const MENU_TARGETS = [
  /** The shop's front page. */
  'home',
  /** A department, by id. */
  'department',
  /** One of the shop's own pages, by id. */
  'page',
  /** A single product, by id — for the thing a shop wants pushed. */
  'product',
  /** The search results, empty. */
  'search',
  /** The shopper's saved items. */
  'wishlist',
  /** The gift-card balance checker. */
  'giftcard',
  /** Anywhere else, including off-site. The only kind that stores a URL. */
  'url',
] as const
export type MenuTarget = (typeof MENU_TARGETS)[number]

/** Which targets need an id chosen alongside them. */
export const TARGETS_NEEDING_ID: readonly MenuTarget[] = ['department', 'page', 'product']

export type MenuItem = {
  id: number
  label: string
  targetKind: MenuTarget
  targetId: number | null
  targetUrl: string
  imageId: number | null
  /** Top-level items only. One level deep — see 188. */
  children: MenuItem[]
}

/** The two menus a shop has. Fixed — see 188 on why there is no third. */
export const MENU_SLUGS = ['main', 'footer'] as const
export type MenuSlug = (typeof MENU_SLUGS)[number]

export function safeMenuSlug(value: unknown): MenuSlug {
  const raw = String(value ?? '')
  return (MENU_SLUGS as readonly string[]).includes(raw) ? (raw as MenuSlug) : 'main'
}

export function safeMenuTarget(value: unknown): MenuTarget {
  const raw = String(value ?? '')
  return (MENU_TARGETS as readonly string[]).includes(raw) ? (raw as MenuTarget) : 'url'
}

/* ── Turning one into a link ──────────────────────────────────────────────── */

/**
 * Where this item goes, or null when it goes nowhere.
 *
 * Null rather than '#' or the shop's front page: an item that cannot resolve
 * should not be DRAWN, and returning a plausible href would put a link in a
 * masthead that silently does the wrong thing. A department that was deleted,
 * or a `url` item somebody left blank, both land here.
 *
 * `base` is the shop's own prefix — `/store/<token>` — because every in-shop
 * path hangs off the signed token and nothing here should be assembling that.
 */
export function menuHref(item: Pick<MenuItem, 'targetKind' | 'targetId' | 'targetUrl'>, base: string): string | null {
  switch (item.targetKind) {
    case 'home':
      return base
    case 'search':
      // The catalogue with no term: the home route renders results for `?q=`,
      // and an empty one is "show me everything".
      return `${base}?q=`
    case 'wishlist':
      return `${base}/wishlist`
    case 'giftcard':
      return `${base}/gift-card`
    case 'department':
      return item.targetId ? `${base}/c/${item.targetId}` : null
    case 'product':
      return item.targetId ? `${base}/p/${item.targetId}` : null
    case 'page':
      // A page is linked by SLUG on the shop, but stored by id — the id is what
      // survives a rename. The caller resolves it; see resolveMenu.
      return null
    case 'url':
      /*
       * Through safeLinkTarget, exactly as a banner's link is. This lands in an
       * href in the masthead of a page that takes payments, so a `javascript:`
       * link here would be stored XSS on every page of the shop rather than one
       * section of one page.
       */
      return safeLinkTarget(item.targetUrl) || null
  }
}

/**
 * Would this item draw?
 *
 * An item with no label is not a link a shopper can click, and one whose target
 * has gone is a link to nowhere. Both are dropped rather than rendered, so a
 * deleted department leaves a shorter menu instead of a broken one.
 */
export function menuItemDraws(item: MenuItem, base: string, pageSlugs: Map<number, string>): boolean {
  if (!item.label.trim()) return false
  if (item.targetKind === 'page') return item.targetId !== null && pageSlugs.has(item.targetId)
  return menuHref(item, base) !== null
}

/** How many items one menu may hold, and how many children one item may have. */
export const MAX_MENU_ITEMS = 24
export const MAX_MENU_CHILDREN = 12
