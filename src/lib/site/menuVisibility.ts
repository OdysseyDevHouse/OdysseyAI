import 'server-only'
import type { ModuleEntitlements } from '../control/modules'
import { AREA_MODULE, areasFor, isHideable, type MenuArea } from '../menuAreas'
import { getSetting, setSetting } from './settings'

/**
 * Which parts of the product this shop wants to SEE — a third question, after
 * "has it been bought" and "may this person use it".
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 *
 * A shop's plan is decided by what it might one day want; its menu is read fifty
 * times a day by somebody who wants none of it. A workshop that does not take
 * bookings still carries Job Cards because the till bundle includes it, and a
 * two-person shop that pays cash still carries the whole Staff section because
 * every shop does. Every one of those rows is a door its staff will never open.
 * Hiding them is not a saving, it is the difference between a menu you scan and
 * a menu you search.
 *
 * The unit is a MENU AREA rather than a module, because "what did you buy" and
 * "what do you not use" are different lists — see lib/menuAreas.ts.
 *
 * ── WHY IT IS SUBTRACTIVE, ALWAYS ───────────────────────────────────────────
 *
 * The stored setting names what to HIDE, and nothing here ever adds. That
 * ordering is the load-bearing part:
 *
 *   - it can never grant. Turning a switch on removes a key from the hide list;
 *     if the shop never bought the module behind that area it stays invisible
 *     regardless, because the ENTITLEMENT is checked separately and first. A
 *     writable site setting can never become a free upgrade.
 *   - it survives a plan change in both directions. A module dropped from the
 *     plan leaves a stale key that means nothing, and a module ADDED next month
 *     arrives visible rather than inheriting a hide somebody set in 2024 for a
 *     feature they had never seen.
 *   - the default is empty, so a shop that never opens the screen sees
 *     everything. A menu that hides things by default is a support call.
 *
 * ── WHERE IT IS NOT APPLIED ─────────────────────────────────────────────────
 *
 * It is a MENU preference, so it filters menus and hubs and stops there. It is
 * deliberately NOT folded into `requireSiteUser().modules`:
 *
 *   - the billing screen must keep showing what is paid for. A shop that hides
 *     Loyalty and forgets must still be able to find the line it is charged for.
 *   - page guards keep asking the entitlement, not this. Hiding a menu row must
 *     not 404 a bookmark or break a link inside a document — somebody who typed
 *     the URL is telling you they want the screen, and the shop is entitled to
 *     it. Nothing here is a security boundary, exactly as the note on NavItem
 *     says of `capability` and `module`.
 */

/** Parsed from the stored CSV, keeping only keys that name a hideable area. */
function parseHidden(raw: string): Set<MenuArea> {
  const out = new Set<MenuArea>()
  for (const part of raw.split(',')) {
    const key = part.trim()
    /* Filtered on the way OUT as well as the way in, so a row written before a
       key was retired — or before `starter` was refused — cannot empty a menu. */
    if (isHideable(key)) out.add(key as MenuArea)
  }
  return out
}

/** What this shop has switched off. The screen and the layout both read it. */
export async function hiddenAreas(siteId: number): Promise<Set<MenuArea>> {
  /* A settings read that throws must not take down the sidebar on every screen
     in the app, and "show everything" is the right guess when the answer is
     unknown: it is what the shop is entitled to. */
  const raw = await getSetting(siteId, 'hidden_modules').catch(() => '')
  return parseHidden(raw)
}

/**
 * The predicate `navFor` and `groupsFor` take: held, and not switched off.
 *
 * Both halves matter and they are asked in this order. A module the shop never
 * bought answers false whatever the setting says, which is what stops this from
 * being a way to grant one.
 */
export async function menuHolder(
  siteId: number,
  entitlements: ModuleEntitlements,
): Promise<(module: string) => boolean> {
  return (await menuFilters(siteId, entitlements)).holds
}

/**
 * Both predicates a menu or hub needs, from ONE settings read.
 *
 * `holds` answers "bought and not switched off" — for anything gated on a
 * module. `menuHidden` answers "switched off" alone — for the base-package
 * sections and tiles that travel with an area, where `holds` cannot help: a
 * shop that never bought Job Cards and one that hid it both make
 * `holds('job_cards')` false, and only the second should lose its ticket desk.
 *
 * Returned together because every caller that needs the second also needs the
 * first, and two calls would be two reads of the same row.
 */
export async function menuFilters(
  siteId: number,
  entitlements: ModuleEntitlements,
): Promise<{
  holds: (module: string) => boolean
  menuHidden: (area: string) => boolean
  hidden: ReadonlySet<MenuArea>
}> {
  const hidden = await hiddenAreas(siteId)
  const held = entitlements.held as ReadonlySet<string>
  return {
    holds: (module: string) => held.has(module) && !hidden.has(module as MenuArea),
    menuHidden: (area: string) => hidden.has(area as MenuArea),
    hidden,
  }
}

/**
 * Writes the hide list from a set of switches.
 *
 * Takes what should be SHOWN, because that is what the screen renders and
 * inverting it at the call site is one more place to get it backwards. Only
 * areas this shop is entitled to are considered: a switch it was never offered
 * must not be able to write a key, and nothing here can hide what was never
 * shown.
 */
export async function setVisibleAreas(
  siteId: number,
  entitlements: ModuleEntitlements,
  shown: readonly MenuArea[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const wanted = new Set(shown)
  const hide = areasFor(entitlements.held as ReadonlySet<string>).filter(
    (area) => !wanted.has(area),
  )

  /*
   * Written in MENU_AREAS order — `areasFor` preserves it — rather than
   * alphabetically. The stored string gets read by people during support, so a
   * stable order means a diff between two sites is about what they hid, not
   * about the sequence a screen happened to send.
   */
  return setSetting(siteId, 'hidden_modules', hide.join(','))
}

/** Areas that are switched off AND sold as a module, as plain module keys. */
export function hiddenModuleKeys(hidden: ReadonlySet<MenuArea>): string[] {
  return [...hidden].flatMap((area) => {
    const module = AREA_MODULE[area]
    return module ? [module] : []
  })
}
