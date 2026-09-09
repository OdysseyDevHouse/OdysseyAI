import {
  LayoutDashboard,
  LineChart,
  ShoppingBag,
  Gem,
  Wrench,
  Ticket,
  type LucideIcon,
} from 'lucide-react'
import type { ModuleKey } from './control/moduleCatalogue'
import type { MenuArea } from './menuAreas'
import { NAV, activeHrefFor, type NavSection } from './nav'

/**
 * The products the menu is split into — one chip on the rail each.
 *
 * ── WHY A SECOND LEVEL ABOVE THE SECTIONS ───────────────────────────────────
 *
 * `NAV` is one list of fourteen sections, which is the right shape for a shop
 * that bought everything and the wrong shape for the person using it: a
 * technician lives in Job cards, a support desk lives in Tickets, and neither
 * has any use for the other twelve. A single rail made all fourteen equally
 * present all day, so the section somebody actually works in was one of a dozen
 * rather than the thing they were looking at.
 *
 * A module is what somebody has OPEN. The rail says which, the panel beside it
 * shows only that one's screens, and every section belonging to the other five
 * products stops competing for the eye.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is not a second definition of the menu. Every destination still comes from
 * `NAV`, so a renamed screen or a new row is still one edit in one place and
 * this file never learns about it. All this decides is which chip a section
 * hangs under.
 *
 * It is also not a pricing list. `module` below says what a shop must have
 * BOUGHT, and it is the same `ModuleKey` billing uses — but Tickets carries none
 * because every shop is entitled to the ticket desk, and Back-office carries
 * none because it is the product itself.
 *
 * ── WHERE SETUP SITS ────────────────────────────────────────────────────────
 *
 * At the bottom of the list, like any other row, because that is where nav.ts
 * already puts it — Tickets and Job cards each name a Setup screen as their last
 * item, and Setup is the last section Back-office is left holding.
 *
 * It was a row PINNED to the foot of the panel, ruled off, on the argument that
 * a screen set once should not sit among the ones opened daily. That bought a
 * separator and cost consistency: Loyalty had no single settings screen, the
 * online store's live on its hub, and Sales has none at all — so three of six
 * modules had a ruled-off footer and three had blank space where one would be.
 * A rule that only applies half the time is not a rule, it is a wobble. The
 * order in nav.ts already says what is daily and what is not.
 */

export type NavModuleKey =
  | 'sales'
  | 'back_office'
  | 'online_store'
  | 'loyalty'
  | 'job_cards'
  | 'tickets'

export type NavModule = {
  key: NavModuleKey
  /**
   * The chip's caption, under its icon.
   *
   * The NAME, wrapped over two lines where it needs them — not an abbreviation.
   * These were three-letter codes (BO, LOY, SHOP, JOB, TKT), which is a memory
   * test somebody re-sits every morning: an abbreviation only helps the person
   * who already knows what it stands for, and the rail is exactly where
   * somebody does not. "Back office" over two lines costs one line of rail and
   * needs no decoding.
   *
   * Kept as its own field rather than reusing `label`, because the two answer
   * different questions: this one has 49px to work in, and "Ticketing" fits
   * where "Tickets" reads as a truncation.
   */
  caption: string
  /** The full name — the chip's flyout heading, and the collapsed tooltip. */
  label: string
  /**
   * What to call this module's one row, when its own name would be the header
   * again.
   *
   * Only the online store needs it: a row reading "Online Store" directly under
   * a header reading ONLINE STORE says nothing, so it reads "Overview". The
   * breadcrumb and the search palette still take the section's real name from
   * nav.ts — this renames the ROW, not the screen.
   */
  renameTo?: string
  /**
   * The word on the brand lockup's subline. Usually `label`; upper-cased and
   * tracked wide by BrandLockup, which is the artwork's own slot for "which of
   * these is it".
   */
  sub: string
  icon: LucideIcon
  /**
   * The colour this module wears, in the three places a colour is needed.
   *
   * References to tokens, never colours — all eighteen live together in
   * globals.css under MODULE COLOURS, so the palette is picked in one place
   * looking at all of it rather than a hex at a time down this list.
   *
   * `rail` is the mark on the chrome: the chip's fill, the rule down the open
   * section, the pip on the current page. The other three are what the module
   * makes of the PAGE — every icon medallion in the kit is `soft` behind `ink`,
   * every LINE (a tab bar's underline, a card's left edge) is `rule`, and any
   * LABEL the colour has to carry — a selected tab — is `text`.
   *
   * Three of them rather than one because a page is white and the rail is
   * near-black, so one value cannot be legible on both — and because a line and
   * a glyph do not want the same weight even on the same surface: `rule` is the
   * light step that matches the marks on the rail, `ink` is dark enough to read
   * inside a medallion, and `text` is the only one of the three that clears AA
   * as words. See MODULE COLOURS in globals.css.
   *
   * Why not one colour for all six, as it was: the rail's amber said "you are
   * here" and nothing else, which is the one thing the rest of the chip —
   * filled, captioned, ruled — was already saying. Six colours say WHERE, and
   * that is an answer the eye can have before it reads anything.
   */
  accent: { rail: string; ink: string; soft: string; rule: string; text: string }
  /**
   * The `NAV` sections this module owns, by label.
   *
   * Omitted means "everything no other module claimed" — which is what
   * Back-office is, and why it is written that way rather than as a list of
   * eight. A section added to `NAV` tomorrow lands there without an edit here,
   * which is the behaviour that stops a new section from silently having no
   * home at all.
   */
  sections?: readonly string[]
  /**
   * What the shop must have BOUGHT for this chip to open.
   *
   * A module it has not bought is still DRAWN, greyed with a padlock and linked
   * to /upgrade — the rail is the one place in the app where showing somebody
   * what they do not have is the point rather than a tease. Contrast
   * `menuArea`: a shop that has switched a section off has said it does not want
   * to see it, and a padlock would be arguing with them.
   */
  module?: ModuleKey
  /** Switched off under Setup → Menu & modules — gone entirely, not locked. */
  menuArea?: MenuArea
}

export const NAV_MODULES: readonly NavModule[] = [
  /*
   * FIRST on the rail, above the back office it was lifted out of.
   *
   * It is the one section of the fourteen that somebody is IN all day — the
   * till, the invoice register, the returns desk — and as a group under
   * Back-office it sat behind a chip alongside stock counts and the VAT return,
   * which are monthly jobs. A shop's own ranking, not the menu's.
   */
  {
    key: 'sales',
    caption: 'Sales',
    label: 'Sales',
    sub: 'Sales',
    icon: LineChart,
    accent: {
      rail: 'var(--color-module-sales)',
      ink: 'var(--color-module-sales-ink)',
      soft: 'var(--color-module-sales-soft)',
      rule: 'var(--color-module-sales-rule)',
      text: 'var(--color-module-sales-text)',
    },
    sections: ['Sales'],
  },
  {
    key: 'back_office',
    caption: 'Back office',
    label: 'Back-office',
    sub: 'Back-office',
    icon: LayoutDashboard,
    accent: {
      rail: 'var(--color-module-back-office)',
      ink: 'var(--color-module-back-office-ink)',
      soft: 'var(--color-module-back-office-soft)',
      rule: 'var(--color-module-back-office-rule)',
      text: 'var(--color-module-back-office-text)',
    },
    /* No `sections`: it is the remainder, deliberately. See the field's note.
       That is also what puts Setup last in its panel — it is the last of the
       sections no other module claimed, in NAV's own order. */
  },
  {
    key: 'loyalty',
    caption: 'Loyalty',
    label: 'Loyalty',
    sub: 'Loyalty',
    icon: Gem,
    accent: {
      rail: 'var(--color-module-loyalty)',
      ink: 'var(--color-module-loyalty-ink)',
      soft: 'var(--color-module-loyalty-soft)',
      rule: 'var(--color-module-loyalty-rule)',
      text: 'var(--color-module-loyalty-text)',
    },
    sections: ['Loyalty'],
    module: 'loyalty',
    menuArea: 'loyalty',
  },
  {
    key: 'online_store',
    caption: 'Online store',
    label: 'Online Store',
    sub: 'Online Store',
    icon: ShoppingBag,
    accent: {
      rail: 'var(--color-module-online-store)',
      ink: 'var(--color-module-online-store-ink)',
      soft: 'var(--color-module-online-store-soft)',
      rule: 'var(--color-module-online-store-rule)',
      text: 'var(--color-module-online-store-text)',
    },
    sections: ['Online Store'],
    renameTo: 'Overview',
    /* One row. Everything this module holds is on the hub at /online-store
       — orders, the catalogue, the page builder, and the four switches that
       decide how the shop runs — and the hub can say what each screen
       DECIDES, which a menu row never can. */
    module: 'online_store',
    menuArea: 'online_store',
  },
  {
    key: 'job_cards',
    caption: 'Job cards',
    label: 'Job Cards',
    sub: 'Job Cards',
    icon: Wrench,
    accent: {
      rail: 'var(--color-module-job-cards)',
      ink: 'var(--color-module-job-cards-ink)',
      soft: 'var(--color-module-job-cards-soft)',
      rule: 'var(--color-module-job-cards-rule)',
      text: 'var(--color-module-job-cards-text)',
    },
    sections: ['Job cards'],
    module: 'job_cards',
    menuArea: 'job_cards',
  },
  {
    key: 'tickets',
    caption: 'Ticketing',
    label: 'Tickets',
    sub: 'Tickets',
    icon: Ticket,
    accent: {
      rail: 'var(--color-module-tickets)',
      ink: 'var(--color-module-tickets-ink)',
      soft: 'var(--color-module-tickets-soft)',
      rule: 'var(--color-module-tickets-rule)',
      text: 'var(--color-module-tickets-text)',
    },
    sections: ['Tickets'],
    /* No `module`. Every shop is entitled to the ticket desk — but a shop that
       has switched Job Cards off has said it does not take work in and track it,
       so the desk goes with it. The same reasoning the Tickets section itself
       records in nav.ts. */
    menuArea: 'job_cards',
  },
] as const

/** The chip a section hangs under. Anything unclaimed is Back-office. */
const OWNER_BY_SECTION: ReadonlyMap<string, NavModuleKey> = new Map(
  NAV_MODULES.flatMap((m) => (m.sections ?? []).map((label) => [label, m.key] as const)),
)

export const DEFAULT_MODULE: NavModuleKey = 'back_office'

/**
 * Which module a section belongs to.
 *
 * Reads the map above rather than the module list, so the lookup is the same
 * cost whether there are five chips or fifty.
 */
export function moduleForSection(label: string): NavModuleKey {
  return OWNER_BY_SECTION.get(label) ?? DEFAULT_MODULE
}

/**
 * Every section label `NAV` currently holds that no module has claimed.
 *
 * Not used by the app — it exists for the test that asserts Back-office is the
 * remainder ON PURPOSE rather than by an omission somebody meant to fix.
 */
export function unclaimedSections(): string[] {
  return NAV.filter((s: NavSection) => !OWNER_BY_SECTION.has(s.label)).map((s) => s.label)
}

/**
 * Which module a PATH belongs to.
 *
 * The sidebar has always derived its own answer this way and still does — but
 * over the rail it has built for this user, because a chip they may not open
 * must not light up. This one runs over the whole of `NAV` instead, and that
 * difference is deliberate: it answers for the colour the PAGE wears, and the
 * page in front of somebody belongs to the module it belongs to whatever their
 * permissions say. The two agree on every path a given user can actually reach.
 *
 * Longest match wins, via the same `activeHrefFor` the sidebar highlights with —
 * shared rather than copied, so a record page (/products/1842) and a setup
 * screen under another hub (/staff/pay-rules) cannot resolve one way for the
 * menu and another for the colour.
 *
 * Anything unmatched — /settings, /upgrade, a 404 — is Back-office, which is
 * where the menu puts everything unclaimed too.
 */
export function moduleForPath(pathname: string): NavModuleKey {
  let best: { href: string; key: NavModuleKey } | null = null

  for (const section of NAV) {
    const hrefs = [
      ...(section.href ? [section.href] : []),
      ...(section.items ?? []).map((i) => i.href),
    ]
    const href = activeHrefFor(pathname, hrefs)
    if (!href) continue
    if (!best || href.length > best.href.length) {
      best = { href, key: moduleForSection(section.label) }
    }
  }

  return best?.key ?? DEFAULT_MODULE
}

/** The module's palette, by key — with Back-office as the fallback. */
export function accentForModule(key: NavModuleKey): NavModule['accent'] {
  const found = NAV_MODULES.find((m) => m.key === key)
  return (found ?? NAV_MODULES.find((m) => m.key === DEFAULT_MODULE)!).accent
}
