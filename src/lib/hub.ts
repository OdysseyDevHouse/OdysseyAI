import type { CategoryTone } from '@/components/ui'
import { SUBPAGE_LABELS, type SubpageHref } from '@/lib/nav'

/**
 * The shape every hub shares.
 *
 * A hub is what a section becomes when its screens are too many, too unfamiliar
 * and too rarely opened to work as a flat menu group — Setup was the first, and
 * `src/lib/nav.ts` records why. The menu keeps ONE link; the hub behind it lists
 * the screens grouped by the job they do, each with the line that says what it
 * decides, which is what makes an unfamiliar screen choosable by somebody who
 * has never opened it.
 *
 * Types live here rather than in any one section so the three catalogues cannot
 * drift apart, and so `HubView` has a single thing to render.
 */

/**
 * Icons are NAMED rather than imported as components, because a catalogue is
 * read by a server component and a Lucide component cannot cross the
 * server/client boundary as a prop. `HubView` maps the name back to the glyph on
 * its own side.
 *
 * A closed union rather than `string`: a typo is then a compile error instead of
 * a tile that renders with no icon.
 */
export type HubIconName =
  | 'Wrench'
  /* The ticket board's setup tile (165). Beside Wrench because the two tiles
     answer the same question for two different teams. */
  | 'Ticket'
  | 'Users'
  | 'KeyRound'
  | 'Store'
  | 'Warehouse'
  | 'Percent'
  | 'CreditCard'
  | 'Terminal'
  | 'LayoutGrid'
  | 'Hash'
  | 'Check'
  | 'FileText'
  | 'Package'
  | 'Scale'
  | 'SlidersHorizontal'
  | 'Database'
  | 'Palette'
  | 'Settings'
  | 'ShieldCheck'
  | 'Coins'
  | 'LineChart'
  | 'BarChart'
  | 'Landmark'
  | 'Receipt'
  | 'ListOrdered'
  | 'Lock'
  | 'Reverse'
  | 'CloudOff'
  | 'Mail'
  | 'Truck'
  | 'Clock'
  | 'Repeat'
  | 'Tag'
  | 'MessageSquare'
  | 'ShoppingBag'
  | 'Boxes'
  | 'Bell'
  | 'Gem'
  | 'Stamp'
  | 'History'
  /* Job rules (225). A bolt rather than Repeat, which already means a
     recurring document: a rule does not repeat, it reacts. */
  | 'Zap'
  /* Training mode's tile — a mortarboard, beside the integrity tools it sits
     with in Setup. */
  | 'GraduationCap'

/** A screen as written in a catalogue — no label, the href already implies it. */
export type DeclaredItem<Href extends SubpageHref = SubpageHref> = {
  href: Href
  /** What this screen decides, in one line. */
  description: string
  /** Words someone might search for that are not in the label. */
  keywords?: string
  icon: HubIconName
  /**
   * The tile's own hue. Set per SCREEN rather than inherited from the group, so
   * a row of five is five distinguishable things rather than one colour
   * repeated — the tile then works as an identifier when someone is scanning
   * for the shape they used last time, which is the whole point of having one.
   */
  tone: CategoryTone
  capability: string
  /**
   * The module the shop must have BOUGHT for this tile to exist. Omitted means
   * it is part of the base package.
   *
   * As with the menu, this hides the tile only — the screen behind it guards
   * itself, because a hidden tile is still a URL.
   */
  module?: string
  /**
   * The menu area this tile is switched off WITH under Setup → Menu & modules,
   * without being sold by it. A `MenuArea` from lib/menuAreas.ts.
   *
   * The same distinction `NavSection.menuArea` draws, and needed here for the
   * same reason: the four staff tiles — pay rules, leave types, cost per
   * employee, commission rules — are base-package, so `module` cannot describe
   * them. A shop that has switched the Staff section off should not be left
   * configuring pay rules for a section it cannot see.
   */
  menuArea?: string
  /**
   * A second tile onto the SAME screen, landing on a named part of it.
   *
   * For a screen that is genuinely two jobs behind one route. Price types & VAT
   * is the case this exists for: two tabs that share a save and a page load, but
   * which somebody arrives looking for separately — "set up wholesale pricing"
   * and "change the VAT rate" are different errands, and one tile named for both
   * is a tile named for neither.
   *
   * The anchor is appended to the href as a hash, and the screen decides what to
   * do with it. `#vat-rates` opens the VAT tab; `SettingAnchor` in the layout
   * flashes a matching element. A tile carrying one MUST also carry `label`,
   * since two tiles on one route would otherwise share the route's name.
   *
   * Use sparingly. Two tiles onto one screen is a cost — it is two things to
   * find for one thing to open — and it only pays where the two halves are
   * looked for by different people on different days.
   */
  anchor?: string
  /**
   * Overrides the name from `SUBPAGE_LABELS`.
   *
   * Only for a tile carrying an `anchor`: the route's own label names the whole
   * screen, and the two tiles onto it need names for their halves. Every other
   * tile leaves this unset so that renaming a screen stays one edit in nav.ts.
   */
  label?: string
}

/** A screen as the hub renders it, with its name resolved. */
export type HubItem = Omit<DeclaredItem, 'label'> & { label: string }

export type DeclaredGroup<Href extends SubpageHref = SubpageHref> = {
  label: string
  /** Why these belong together — shown under the group heading. */
  description: string
  tone: CategoryTone
  icon: HubIconName
  items: DeclaredItem<Href>[]
}

export type HubGroup = Omit<DeclaredGroup, 'items'> & { items: HubItem[] }

/**
 * A catalogue with every tile's name filled in from `SUBPAGE_LABELS`.
 *
 * Resolved rather than typed out on each entry so that renaming a screen is one
 * edit in `nav.ts` and the tile, the breadcrumb and the sidebar search all
 * follow. A tile whose href is not in the map cannot be written — the `Href`
 * type parameter makes it a compile error — so the fallback is unreachable and
 * exists only to keep the type honest.
 */
export function resolveGroups<Href extends SubpageHref>(
  declared: DeclaredGroup<Href>[],
): HubGroup[] {
  return declared.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      /* The tile's own label wins, and only an anchored tile sets one — see
         `label` on DeclaredItem. Everything else reads the route's name, so a
         rename stays one edit in nav.ts. */
      label: item.label ?? (SUBPAGE_LABELS as Record<string, string>)[item.href] ?? item.href,
    })),
  }))
}

/**
 * The catalogue as one user sees it.
 *
 * A group disappears once every tile in it is hidden, rather than rendering an
 * empty heading — a "Money & pricing" heading over nothing reads as a broken
 * screen rather than a restricted one.
 *
 * The `capability` on each entry mirrors the guard on the page it points at.
 * That is deliberate duplication: it hides a tile somebody may not open, but it
 * is NOT the boundary. Every one of these pages checks for itself, because a
 * hidden tile is still a URL anyone can type.
 */
export function groupsFor(
  groups: HubGroup[],
  granted: (capability: string) => boolean,
  /**
   * Whether the shop holds a module. Permissive by default, so a hub that has
   * not been taught about modules keeps rendering every tile rather than
   * silently emptying itself.
   */
  holds: (module: string) => boolean = () => true,
  /**
   * Whether the shop has SWITCHED THIS AREA OFF under Setup → Menu & modules.
   * Only `menuArea` consults it — see the note on that field. Permissive by
   * default for the same reason `holds` is.
   */
  menuHidden: (area: string) => boolean = () => false,
): HubGroup[] {
  return groups.flatMap((group) => {
    const items = group.items.filter(
      (item) =>
        granted(item.capability) &&
        (!item.module || holds(item.module)) &&
        (!item.menuArea || !menuHidden(item.menuArea)),
    )
    return items.length ? [{ ...group, items }] : []
  })
}
