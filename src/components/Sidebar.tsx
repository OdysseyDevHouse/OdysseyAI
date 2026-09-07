'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  ExternalLink,
} from '@/components/ui/icons'
import { BrandLockup, BrandMark } from '@/components/ui'
import GlobalSearch from '@/components/GlobalSearch'
import SettingAnchor from '@/components/SettingAnchor'
import {
  GETTING_STARTED_HREF,
  hubFor,
  navFor,
  type NavItem,
  type NavSection,
} from '@/lib/nav'
import {
  DEFAULT_MODULE,
  NAV_MODULES,
  moduleForSection,
  type NavModule,
  type NavModuleKey,
} from '@/lib/navModules'
import {
  tillLinkProps,
  invoicingLinkProps,
  opensTill,
  opensInInvoicingWindow,
} from '@/lib/openTill'

const STORAGE_KEY = 'odyssey.sidebar'

/** The older key, which held only the collapsed flag as '1' or '0'. */
const LEGACY_COLLAPSED_KEY = 'odyssey.sidebar.collapsed'

type Stored = { collapsed: boolean; open: string | null }

/**
 * The remembered sidebar state, tolerating the shape that came before it.
 *
 * Anyone who has used the app already has the legacy string key set, and
 * ignoring it would silently expand every sidebar that was deliberately
 * collapsed. Reading both means an existing preference survives the upgrade;
 * the next toggle writes the new shape and the old key stops mattering.
 */
function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>
      return {
        collapsed: parsed.collapsed === true,
        open: typeof parsed.open === 'string' ? parsed.open : null,
      }
    }
    const legacy = window.localStorage.getItem(LEGACY_COLLAPSED_KEY)
    if (legacy !== null) return { collapsed: legacy === '1', open: null }
  } catch {
    // Private mode, blocked storage, or a hand-edited value — defaults are fine.
  }
  return null
}

/**
 * One module as this user sees it: the chip, and the panel behind it.
 *
 * `sections` is already filtered by capability and module, and already promoted
 * (see `panelFor`) — so the panel renders it without asking any further
 * questions.
 */
type RailModule = {
  def: NavModule
  sections: NavSection[]
  /** Where the chip goes. Null only for a locked module, which goes to /upgrade. */
  home: string | null
  /** Bought by somebody else's shop, not this one. Drawn, but shut. */
  locked: boolean
}

/**
 * A menu ITEM redrawn as a section, so a promoted module renders through the
 * same row component as Back-office's groups.
 *
 * See `panelFor` for why promotion happens at all.
 */
function asSection(item: NavItem): NavSection {
  return {
    label: item.label,
    href: item.href,
    icon: item.icon,
    built: item.built,
    capability: item.capability,
    keywords: item.keywords,
    description: item.description,
  }
}

/** Every href a set of sections can reach, for the active-row scan. */
function hrefsOf(sections: NavSection[]): string[] {
  return sections.flatMap((s) => [
    ...(s.href ? [s.href] : []),
    ...(s.items ?? []).map((i) => i.href),
  ])
}

/**
 * The panel behind one chip.
 *
 * ── WHY A LONE GROUP IS PROMOTED ────────────────────────────────────────────
 *
 * Loyalty, Job cards and Tickets are each a single `NAV` section holding all
 * their screens. Rendered as-is, their panel would be one collapsed accordion
 * labelled "Loyalty" underneath a header that already says LOYALTY — a click
 * that asks a question with one answer, on the module somebody opened
 * deliberately. So a module that owns exactly one group shows that group's rows
 * directly. Back-office owns eight sections and keeps them as sections, which is
 * the case accordions exist for.
 *
 * ── AND WHY THE ONLINE STORE IS ONE ROW ─────────────────────────────────────
 *
 * Its section is a single link to a hub, so its panel is a single row: Overview,
 * and the hub takes it from there. That panel briefly listed the hub's own
 * groups as accordions, which put every store screen behind two doors that could
 * disagree about what it was called. One door is better, and the hub is already
 * the better door — it can say what each screen DECIDES, which a menu row never
 * can. `renameTo` is how the row stops reading "Online Store" directly beneath a
 * header that says ONLINE STORE.
 */
function panelFor(def: NavModule, visible: NavSection[]): NavSection[] {
  let sections = visible
    .filter((s) => moduleForSection(s.label) === def.key)
    .map((s) => (def.renameTo ? { ...s, label: def.renameTo } : s))

  /* `def.sections`, not what survived filtering. A back-office user who may
     open only Sales would otherwise have that section promoted and its heading
     dropped — a menu reshaping itself around a permission, which is a different
     thing from a module that IS one section. */
  if (def.sections?.length === 1 && sections.length === 1 && sections[0].items?.length) {
    sections = sections[0].items.map(asSection)
  }

  return sections
}

/**
 * The rail, top to bottom.
 *
 * A module the shop has not BOUGHT is kept and shut — see `module` in
 * navModules.ts. One it has switched off, or has nothing in it may open, is
 * dropped: those are answers the shop or its permissions already gave, and a
 * padlock would be arguing with them.
 */
function buildRail(
  visible: NavSection[],
  bought: Set<string>,
  switchedOff: Set<string>,
  granted: (capability: string) => boolean,
): RailModule[] {
  const rail: RailModule[] = []

  for (const def of NAV_MODULES) {
    if (def.menuArea && switchedOff.has(def.menuArea)) continue

    if (def.module && !bought.has(def.module)) {
      rail.push({ def, sections: [], home: null, locked: true })
      continue
    }

    const sections = panelFor(def, visible)
    if (!sections.length) continue

    /*
     * The first destination the panel offers, so a chip always lands somewhere
     * this person may actually be.
     *
     * A screen that opens in ANOTHER WINDOW is skipped — the till and the
     * invoicing register both do, see lib/openTill.ts. A chip that popped a
     * second window and left the back office where it was would look broken:
     * you press the product you want and the rail does not move. Sales is the
     * module this is written for; its first two rows are exactly those two.
     *
     * Null when a module has nothing that opens here — Sales again, for
     * somebody who may only take payments. Its chip then only SELECTS the
     * module, which is the honest thing for it to do.
     */
    const opensElsewhere = (href: string) => opensTill(href) || opensInInvoicingWindow(href)
    const stays = (href: string | undefined) => !!href && !opensElsewhere(href)
    const home =
      sections.find((s) => stays(s.href) && s.built !== false)?.href ??
      sections.flatMap((s) => s.items ?? []).find((i) => stays(i.href) && i.built !== false)?.href ??
      null

    rail.push({ def, sections, home, locked: false })
  }

  return rail
}

/**
 * The row this page is on.
 *
 * Three rules in order, and the order is what makes it right:
 *
 *  1. An EXACT match on a menu row wins. The online store's screens are rows in
 *     their own panel now, so /online-store/orders must light "Orders" rather
 *     than the hub it also sits under.
 *  2. Failing that, the hub that owns the screen. /staff/pay-rules is a setup
 *     screen that happens to live beneath /staff; a plain prefix scan would
 *     light "Staff" while the breadcrumb above said "Setup › Pay rules" — the
 *     menu and the trail disagreeing about where somebody is.
 *  3. Failing that, the longest prefix — which is what a record page
 *     (/products/1842) and every other child route resolves through.
 */
function activeHrefFor(pathname: string, candidates: string[]): string | null {
  if (candidates.includes(pathname)) return pathname

  const owner = hubFor(pathname)
  if (owner && candidates.includes(owner)) return owner

  let best: string | null = null
  for (const href of candidates) {
    if (!pathname.startsWith(`${href}/`)) continue
    if (!best || href.length > best.length) best = href
  }
  return best
}

/**
 * The section containing this path, so it opens on load.
 *
 * Longest href wins rather than first declared, for the same reason the
 * highlight uses it: /sales sits in Sales and /setup/laybys in Setup, so a
 * first-match scan would open the wrong group for the deeper route.
 */
function sectionForPath(pathname: string, sections: NavSection[]): string | null {
  let best: { label: string; length: number } | null = null

  for (const section of sections) {
    /* Only a GROUP can be the open section. A promoted row and every hub link
       are links in their own right, and treating one as "open" both highlights
       a row that has nothing to disclose and stops the remembered group from
       being restored on the very routes that have no group of their own. */
    if (!section.items?.length) continue
    for (const item of section.items) {
      const href = item.href
      if (pathname !== href && !pathname.startsWith(`${href}/`)) continue
      if (!best || href.length > best.length) best = { label: section.label, length: href.length }
    }
  }

  return best?.label ?? null
}

/**
 * `granted` arrives as a plain array of capability strings rather than the
 * resolved NavSection[], because every section carries an icon COMPONENT and a
 * function cannot be serialised across the server/client boundary. The menu is
 * therefore rebuilt here from the same NAV the server used.
 */
export default function Sidebar({
  granted,
  isOwner,
  modules,
  hiddenAreas = [],
  gettingStartedHidden = false,
}: {
  granted: string[]
  isOwner: boolean
  /**
   * The modules this shop has bought AND not switched off — what the menu should
   * be built from. Plain strings for the same reason `granted` is. Unlike
   * capabilities, an owner does NOT bypass these: owning the shop does not mean
   * having paid for Loyalty.
   */
  modules: string[]
  /**
   * The modules deliberately switched off under Setup → Menu & modules, as
   * opposed to never bought. Only a section marked `menuModule` needs the
   * distinction — see the note on that field in lib/nav.ts.
   */
  hiddenAreas?: string[]
  /**
   * Whether this shop has pressed "Don't show this again" on Getting started.
   *
   * Its own prop rather than a `MenuArea`, because it is not one: those seven
   * are parts of the product a shop either uses or does not, offered as
   * switches on Setup → Menu & modules. This is a screen somebody FINISHES
   * with, hidden from the screen itself and restored from the same place. Put
   * in that list it would read as an eighth feature, and its switch would sit
   * among them long after the shop had forgotten what it was.
   */
  gettingStartedHidden?: boolean
}) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  /* The global search palette. The sidebar owns it because the sidebar has
     already resolved which sections this user may see, and the palette searches
     exactly those — see `visible` below. */
  const [searchOpen, setSearchOpen] = useState(false)

  /* Declared before the open-section state below, which matches paths against
     it: a section this user cannot see must never be the one that opens.

     Keyed on the JOINED capabilities rather than the array: `granted` arrives
     from a server component and is a new array on every render, so depending on
     it directly rebuilt `visible` each time and re-fired every effect that
     watches it. */
  const grantedKey = granted.join(',')
  const modulesKey = modules.join(',')
  const hiddenKey = hiddenAreas.join(',')

  /* The same two rules the menu is built from, as stable callbacks the palette
     and the online-store catalogue both take. Memoised on the joined keys, so
     they change when the person's capabilities or the shop's modules actually
     do and not on every render. */
  const settingsGranted = useMemo(() => {
    const held = new Set(granted)
    return (capability: string) => isOwner || held.has(capability)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantedKey, isOwner])
  const settingsHolds = useMemo(() => {
    const bought = new Set(modules)
    const switchedOff = new Set(hiddenAreas)
    return (module: string) => bought.has(module) && !switchedOff.has(module)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modulesKey, hiddenKey])

  const visible = useMemo(() => {
    const bought = new Set(modules)
    const switchedOff = new Set(hiddenAreas)
    /* The owner bypass applies to CAPABILITIES only. A capability is something
       an owner could grant themselves anyway, so short-circuiting it saves a
       round trip and changes nothing. A module is something they would have to
       BUY, and showing an owner a menu of features their shop does not have
       would be a link to a page that turns them away. */
    const sections = navFor(
      settingsGranted,
      (module) => bought.has(module),
      (module) => switchedOff.has(module),
    )
    /* Filtered here rather than inside navFor: this is one dismissed SCREEN, not
       a menu area, and navFor's three predicates are the vocabulary every other
       caller shares. A fourth argument meaning "except this one row" would be a
       special case in a function whose whole value is that it has none. */
    return gettingStartedHidden
      ? sections.filter((s) => s.href !== GETTING_STARTED_HREF)
      : sections
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modulesKey, hiddenKey, settingsGranted, gettingStartedHidden])

  /* The rail, and the panel behind each chip. */
  const rail = useMemo(
    () =>
      buildRail(visible, new Set(modules), new Set(hiddenAreas), settingsGranted),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, modulesKey, hiddenKey, settingsGranted],
  )

  /**
   * Which row this page is, and therefore which module is open.
   *
   * The module is DERIVED from the path rather than held as state, so the rail
   * cannot end up pointing at one product while the page shows another — which
   * is exactly what happens when a link inside a page crosses modules (a ticket
   * that becomes a job) and only a click on the rail updates the selection.
   */
  const { activeHref, derivedModule } = useMemo(() => {
    let best: { href: string; key: NavModuleKey } | null = null
    for (const entry of rail) {
      const href = activeHrefFor(pathname, hrefsOf(entry.sections))
      if (!href) continue
      if (!best || href.length > best.href.length) best = { href, key: entry.def.key }
    }
    return { activeHref: best?.href ?? null, derivedModule: best?.key ?? DEFAULT_MODULE }
  }, [pathname, rail])

  /**
   * The chip somebody pressed, when the path cannot say.
   *
   * The path is still the authority — see above — and this only fills the gap
   * it leaves: a module whose every screen opens in another window has no path
   * of its own to arrive at, so pressing its chip has to be what opens its
   * panel. Sales is the one, and only for somebody whose Sales rows are all
   * till and invoicing.
   *
   * Cleared on the next navigation, deliberately. A pick that outlived the page
   * it was made on would be the exact failure the derived module exists to
   * prevent — the rail claiming one product while the screen shows another.
   */
  const [picked, setPicked] = useState<NavModuleKey | null>(null)
  useEffect(() => setPicked(null), [pathname])
  const activeModule = picked ?? derivedModule

  const current = rail.find((m) => m.def.key === activeModule) ?? rail[0]

  /**
   * ONE open section, not a set of them.
   *
   * The set accumulated: every route change added its section and nothing ever
   * removed one, so moving through four sections in a session left four open
   * and the menu three screens long. An accordion keeps it to one screen no
   * matter how long somebody has been working.
   */
  const [open, setOpen] = useState<string | null>(() =>
    sectionForPath(pathname, current?.sections ?? []),
  )

  /**
   * The path this sidebar has already settled an open section for.
   *
   * A ref rather than a boolean flag: Strict Mode invokes an effect twice on
   * mount, and a fire-once flag is consumed by the first pass while React
   * discards the state that pass set — so the second pass returns early and the
   * remembered group never comes back. Keyed by path, the second pass reaches
   * the same conclusion as the first, which is what makes it idempotent.
   */
  const settledFor = useRef<string | null>(null)

  // Read the stored preference after mount. Reading it during render would make
  // the server and client markup disagree and blow up hydration.
  useEffect(() => {
    const stored = readStored()
    if (stored?.collapsed) setCollapsed(true)
  }, [])

  /**
   * Which section is open: the one holding this page, or failing that the one
   * left open last time.
   *
   * Both rules live in ONE effect deliberately. Split across two they raced —
   * the restore ran, the route effect ran in the same commit, and which won
   * depended on their order rather than on what either meant. Here the priority
   * is written down: the route wins when it names a section, and the remembered
   * one fills the gap on a route that names none (the dashboard, a hub).
   */
  /* Memoised so the effect below depends on an array that changes when the
     panel does and not on every render. */
  const panelSections = useMemo(() => current?.sections ?? [], [current])

  /*
   * The panel, split into the windows that open BESIDE this one and the rows
   * that replace what is on screen.
   *
   * Only ever finds anything in Sales, whose module flattens its items into
   * top-level sections (see panelFor) — which is what puts the till and the
   * invoicing register here as plain hrefs. Every other panel splits into the
   * whole list and an empty group, and NewTabLinks renders nothing for it.
   *
   * A section with CHILDREN is never lifted, even if one of its children opens
   * away: the button is a single destination, and a group is not one.
   */
  const { newTabItems, panelRows } = useMemo(() => {
    const out: NavItem[] = []
    const rows: NavSection[] = []
    for (const section of panelSections) {
      // `built === false` rows are the "not built yet" placeholders, which stay
      // rows: a dead button is a worse promise than a dimmed line.
      if (section.href && !section.items?.length && section.built !== false && opensInOwnWindow(section.href)) {
        out.push({
          label: section.label,
          href: section.href,
          icon: section.icon,
          built: section.built,
        })
        continue
      }
      rows.push(section)
    }
    return { newTabItems: out, panelRows: rows }
  }, [panelSections])
  useEffect(() => {
    const active = sectionForPath(pathname, panelSections)
    if (active) {
      setOpen(active)
      settledFor.current = pathname
      return
    }
    /* Only on ARRIVAL at such a route, so that closing the group by hand is not
       undone by the next render putting the remembered one back. */
    if (settledFor.current === pathname) return
    settledFor.current = pathname
    const remembered = readStored()?.open
    // A section this user can no longer see is dropped rather than opening nothing.
    if (remembered && panelSections.some((s) => s.label === remembered)) setOpen(remembered)
  }, [pathname, panelSections])

  const persist = (next: Partial<Stored>) => {
    try {
      const current = readStored() ?? { collapsed, open }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...next }))
    } catch {
      // Not worth failing the click over.
    }
  }

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v
      persist({ collapsed: next })
      return next
    })
  }

  /**
   * Ctrl+K — or ⌘K on a Mac — from anywhere in the app.
   *
   * On `window` rather than the sidebar, because the point is that it works while
   * somebody is halfway down a product list with focus in a table. Bound here
   * anyway: the sidebar is rendered once by the layout and already holds the
   * palette's state, so a second component to own one shortcut would be a second
   * thing that can disagree about whether it is open.
   *
   * "/" is deliberately NOT bound. This app is full of text fields, and a shop
   * owner typing a customer's address would open a search palette mid-word.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'k' && event.key !== 'K') return
      if (!event.ctrlKey && !event.metaKey) return
      // Not preventing the browser's own Ctrl+K when a modifier we don't own is
      // also held — Ctrl+Shift+K is a devtools shortcut in several browsers.
      if (event.shiftKey || event.altKey) return
      event.preventDefault()
      setSearchOpen((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggleSection = (label: string) =>
    setOpen((prev) => {
      const next = prev === label ? null : label
      persist({ open: next })
      return next
    })

  const isActive = (href: string) => href === activeHref

  return (
    <div className="relative z-40 flex shrink-0">
      {/*
        ── THE MODULE RAIL ──────────────────────────────────────────────────
        Five chips, and it never changes width or contents. That is its whole
        job: whatever somebody is doing, the way to another product is in the
        same place, and the panel beside it is the only thing that swaps.

        A step darker than the panel — see --color-nav-rail. Two identical
        fills with a rule between them read as one wide menu with a fold in it,
        which is the opposite of what the split is for.
      */}
      <nav
        aria-label="Modules"
        className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-nav-border bg-nav-rail pb-3 pt-4"
      >
        {/*
          The globe lives on the RAIL, the name on the panel beside it.

          They were one lockup, which is what components/ui/BrandLockup exists to
          keep them — but this chrome is two columns and the pair belongs to both
          of them: the mark names the PRODUCT, which never changes, and the rail
          never changes either; the name carries the module on its subline, and
          that is the panel's whole job. Held together, the lockup pushed the
          module name off-centre in a 240px panel and left the rail's head empty.

          Not a link. The rail below it is the navigation, and a logo going to the
          same place as the chip directly under it is a second door onto one room.
        */}
        <BrandMark className="mb-1 h-9" />

        {rail.map((entry) => (
          <Fragment key={entry.def.key}>
            {/* A hairline between chips, not around them.

                Six captions stacked two lines deep run together into a column
                of words, and the eye has to find where one product's name ends
                and the next begins. A rule half the chip's width says it
                without adding a box: short enough to read as a separator rather
                than as an edge, and the same colour as every other rule on the
                rail.

                Before EVERY chip, the first included — above it is the mark,
                which is the one thing on the rail that is not a destination, so
                the line separating it from the six that are is the one doing the
                most work. */}
            <span aria-hidden className="my-1 h-px w-7 bg-nav-border" />
            <ModuleChip
              entry={entry}
              active={entry.def.key === activeModule}
              /* The flyout is the collapsed rail's menu. Expanded, the panel is
                 already showing it and a hover panel over the top of it would be
                 the same list twice. */
              collapsed={collapsed}
              isActive={isActive}
              onPick={() => setPicked(entry.def.key)}
            />
          </Fragment>
        ))}

        {/* Pushed to the foot. When the panel is away this is the only way back
            to it, so it cannot live in the panel's own header. */}
        {/* Only while the panel is away. Open, it has its own header button —
            two controls for one toggle, 200px apart, is two things to wonder
            about rather than one to press. These also stand in for the panel's
            search box, which goes with it. */}
        {/* Stands in for the panel's search box while the panel is away. Drawn
            as a bordered box rather than a bare glyph, so it reads as the FIELD
            it replaces — a plain icon at the foot of a rail of icons is one more
            thing to identify. The way back to the panel is the round button at
            the boundary above, which is there in both states. */}
        {collapsed && (
          <button
            data-kit-ok
            type="button"
            onClick={() => setSearchOpen(true)}
            title="Search everything (Ctrl+K)"
            aria-label="Search everything"
            className="mt-auto flex size-9 items-center justify-center rounded-control border border-nav-border bg-nav-surface-2 text-nav-faint transition hover:border-brand/50 hover:text-nav-ink"
          >
            <Search size={16} />
          </button>
        )}
      </nav>

      {/*
        ── THE HANDLE ───────────────────────────────────────────────────────
        One control, straddling the seam between the rail and the panel, in the
        same place whether the panel is open or shut — so the way back is where
        the way out was. It was an icon button inside the panel's header, which
        could only ever say "hide": once it had, it went with the panel and the
        rail had to grow a second button at its foot to undo it. Two controls
        for one toggle, 500px apart, both drawn as the same glyph.

        Circular, and the only round thing in the chrome. It sits ON a border
        rather than inside a box, and a rounded rectangle centred on a vertical
        rule reads as a fault in the rule.
      */}
      <button
        data-kit-ok
        type="button"
        onClick={toggleCollapsed}
        title={collapsed ? 'Show the menu' : 'Hide the menu'}
        aria-label={collapsed ? 'Show the menu' : 'Hide the menu'}
        aria-expanded={!collapsed}
        className="absolute left-16 top-6 z-50 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border border-nav-border bg-nav-surface-2 text-nav-faint shadow-pop transition hover:border-brand/50 hover:text-nav-ink"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {/*
        ── THE PANEL ────────────────────────────────────────────────────────
        One module's screens, and nothing else. Collapsing takes the whole thing
        away rather than narrowing it to icons: the rail beside it is ALREADY
        the icon-sized answer, and two 64px columns of glyphs is not a saving,
        it is a second menu. Ctrl+K and the rail's own search button cover
        everything the hidden rows reached.
      */}
      {!collapsed && current && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-nav-border bg-nav-surface">
          <div className="shrink-0 px-4 pb-4 pt-4">
            {/* Centred, and the mark is not here — see the rail's head above.
                Set a step larger than it was: with the globe gone the name has
                the panel's whole width, and at the old size it read as a caption
                floating in it rather than as the lockup.

                Two overrides on the shared component rather than a fork of it.
                The wordmark is `text-ink`, near-black in the light theme and so
                invisible on this dark panel. The subline is `text-brand`, which
                is right where it names the COMPANY — here it names the module,
                the one thing in the header that changes as you move down the
                rail, so it takes the rail's amber. Both hooks are the
                component's own; DeviceNotLicensed renders it on a themed page. */}
            <BrandLockup
              sub={current.def.sub}
              size="lg"
              mark={false}
              className="justify-center [&_.wordmark-lockup]:!text-nav-ink [&_.wordmark-subline]:!text-nav-accent"
            />
          </div>

          {/*
            A BUTTON that opens the palette, not a field that filters the menu.

            It looks like an input because that is what it does — you click it and
            type — but it cannot be one: the results are pages AND customers AND
            products, and there is nowhere in a 240px panel to show them. Filtering
            the menu in place could only ever find the menu's own rows, which is why
            searching "gratuity" used to find nothing and searching a customer's name
            found nothing at all. It searches the WHOLE app, not this module — the
            point of a palette is that you do not have to know where a thing lives.

            data-kit-ok: an input-shaped button. Neither a Button variant (all of
            which are controls with their own chrome) nor an Input (which would take
            the keystrokes here instead of in the palette) is this thing.
          */}
          <div className="shrink-0 px-3 pb-3">
            <button
              data-kit-ok
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Search everything (Ctrl+K)"
              aria-label="Search everything"
              className="flex h-control w-full items-center gap-2 rounded-control border border-nav-border bg-nav-surface-2 px-3 text-sm text-nav-faint transition hover:border-brand/50"
            >
              <Search size={15} className="shrink-0" />
              <span className="flex-1 truncate text-left">Search</span>
              {/* The shortcut, shown rather than hidden in a tooltip — it is the
                  fastest way in and nobody discovers it otherwise. */}
              <kbd className="shrink-0 rounded border border-nav-border px-1.5 py-0.5 text-[11px] text-nav-faint">
                Ctrl K
              </kbd>
            </button>
          </div>

          {/* `space-y-1` between rows. They used to stack flush, which was fine
              while a selected row was only tinted text — now that both the open
              section and the current page carry a FILLED block, two touching fills
              ran together into one shape and you could not see where the section
              ended and the page inside it began. */}
          <nav aria-label={current.def.label} className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
            {/* The windows that open BESIDE this one, first and as buttons.
                See NewTabLinks for why they are not rows. */}
            <NewTabLinks items={newTabItems} />
            {panelRows.map((section) => (
              <SectionRow
                key={section.label}
                section={section}
                expanded={open === section.label}
                onToggle={() => toggleSection(section.label)}
                isActive={isActive}
              />
            ))}
          </nav>

        </aside>
      )}

      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        /* The WHOLE menu, not the open module's slice. Somebody who has to know
           which product a screen belongs to before they can search for it has a
           worse search than the one they had before the rail existed. */
        sections={visible}
        /* The /settings tabs cannot be derived from `sections`: that screen
           hangs off the gear in the top bar and has no menu row, so the palette
           needs the raw predicates to decide which of its tabs to index. Same
           two rules the menu itself is built from above — an owner bypasses a
           capability, nobody bypasses a module. */
        granted={settingsGranted}
        holds={settingsHolds}
      />

      {/* The far half of a settings result: scrolls to the panel the palette
          sent somebody to and flashes it. Mounted here rather than in the
          layout because the layout has two branches — desktop and web — and one
          of them would eventually be edited without the other. */}
      <SettingAnchor />
    </div>
  )
}

/**
 * One chip on the rail: a glyph, three letters, and a tooltip.
 *
 * The caption is not decoration. A column of five unlabelled glyphs is a
 * memory test somebody re-sits every morning, and the tooltip only helps the
 * person who already suspected which one it was.
 */
function ModuleChip({
  entry,
  active,
  collapsed,
  isActive,
  onPick,
}: {
  entry: RailModule
  active: boolean
  collapsed: boolean
  isActive: (href: string) => boolean
  onPick: () => void
}) {
  const { def, sections, home, locked } = entry
  const Icon = def.icon

  /* A locked module goes to /upgrade — it is drawn precisely so somebody can
     find out what it is. Everything else goes to its first screen, and a module
     with no screen of its own (see `home` in buildRail) is not a link at all. */
  const href = locked ? '/upgrade' : home

  /* 53px, not the 56 it was. The fill is what marks the selected module, and at
     the full width of the rail's gutter it read as a block rather than as a chip
     — three pixels of air on each side is what turns it back into one. */
  const chipClass = `relative flex size-[53px] flex-col items-center justify-center gap-1 rounded-xl transition ${
          active
            ? /* The amber the rail already uses for "you are here" — the rule on
                 the open section and the pip on the current page are the same
                 colour, so the mark means one thing at all three levels. Not the
                 blue block a section wears: that says which SCREEN, and two loud
                 blues 200px apart read as two selections. */
              'bg-nav-accent/15 text-nav-accent before:absolute before:-left-1 before:top-1/2 before:h-8 before:w-[3px] before:-translate-y-1/2 before:rounded-r before:bg-nav-accent before:content-[""]'
      : locked
        ? 'text-nav-faint opacity-50 hover:opacity-80'
        : 'text-nav-faint hover:bg-nav-surface-2 hover:text-nav-ink'
  }`

  const face = (
    <>
      <Icon size={19} className="shrink-0" />
      {/*
        ONE WORD PER LINE, broken here rather than left to the browser.

        "Back office" fits on one line at 10px — just — and filled the chip
        corner to corner, which reads as text that overflowed rather than as a
        caption. "Online store" is a character longer and wrapped, so the rail
        had one chip set on two lines beside another set on one, at different
        apparent sizes. Splitting on the space makes every multi-word caption
        stack the same way, and the rail keeps one rhythm down its length.

        `leading-[1.15]` holds the pair tight enough to read as one caption
        rather than as two words that happen to be above each other. No
        tracking: at 10px in 49px of rail, the space after each letter is the
        difference between "Ticketing" fitting and not.
      */}
      <span className="w-full px-0.5 text-center text-[10px] font-semibold leading-[1.15]">
        {def.caption.split(' ').map((word) => (
          <span key={word} className="block truncate">
            {word}
          </span>
        ))}
      </span>
      {locked && (
        <Lock size={10} aria-hidden className="absolute right-1.5 top-1.5 text-nav-faint" />
      )}
    </>
  )

  return (
    <div className="group relative">
      {href ? (
        <Link
          href={href}
          onClick={onPick}
          aria-current={active ? 'page' : undefined}
          className={chipClass}
        >
          {face}
        </Link>
      ) : (
        /* No page of its own to arrive at — see `home` in buildRail. Pressing it
           opens the module's panel and nothing else, which is the whole of what
           it can honestly promise.

           data-kit-ok: a rail chip that must render identically to the sibling
           <Link> above, which shares chipClass. A Button variant would give it
           button chrome the link cannot match. */
        <button
          data-kit-ok
          type="button"
          onClick={onPick}
          aria-current={active ? 'page' : undefined}
          className={chipClass}
        >
          {face}
        </button>
      )}

      {collapsed ? (
        /*
         * ── THE COLLAPSED RAIL'S MENU ──────────────────────────────────────
         *
         * Hiding the panel took every destination but six off the screen. This
         * is where they went: hover a chip and its whole module opens beside
         * it, groups flattened to headings so nothing needs a second click.
         *
         * CSS-only — `group-hover`, plus `group-focus-within` so a keyboard
         * reaches it too. A hover panel driven by state needs open/close timers
         * to survive the gap between the chip and the panel, and the timers are
         * what make one stick open over a page somebody is trying to read. The
         * gap is bridged by `pl-3` on the wrapper INSTEAD: it is part of the
         * hover target rather than a hole in it.
         */
        <div className="invisible absolute left-full top-0 z-50 pl-3 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <div className="flex max-h-[80vh] w-60 flex-col overflow-y-auto rounded-card border border-nav-border bg-nav-surface p-1.5 shadow-pop">
            <p className="px-2 pb-1.5 pt-1 text-xs font-semibold text-nav-ink">{def.label}</p>
            {locked ? (
              <p className="px-2 pb-1.5 text-xs leading-snug text-nav-faint">
                Not on your plan. Open it to see what it does.
              </p>
            ) : (
              <FlyoutMenu sections={sections} isActive={isActive} />
            )}
          </div>
        </div>
      ) : (
        (locked || def.caption !== def.label) && (
          /* Drawn rather than left to `title`, because the native tooltip takes a
             second to appear and this one is read in passing. `pointer-events-none`
             so it can never sit between the cursor and the chip under it.

             Only when it has something to add. Now that the chip carries the
             name, a tooltip repeating it is a panel that opens to say what you
             are already looking at — so it is kept for the two cases that
             differ: a locked module, which has the plan to explain, and a
             caption written for the rail rather than for the product
             ("Ticketing" against "Tickets"). */
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-control bg-nav-surface-2 px-2 py-1 text-xs text-nav-ink opacity-0 shadow-pop transition-opacity group-hover:opacity-100"
          >
            {def.label}
            {locked && <span className="ml-1.5 text-nav-faint">· not on your plan</span>}
          </span>
        )
      )}
    </div>
  )
}

/**
 * A module's whole menu, flattened for the collapsed rail's flyout.
 *
 * FLAT, not the accordions the panel uses. An accordion is worth a click when
 * the list is permanent and you are picking a branch to live in; in a hover
 * panel that closes the moment the pointer leaves, a click that only reveals
 * more of the same panel is a click nobody wants to spend. So a group becomes a
 * quiet heading with its rows underneath, and every destination is one press.
 */
function FlyoutMenu({
  sections,
  isActive,
}: {
  sections: NavSection[]
  isActive: (href: string) => boolean
}) {
  return (
    <>
      {sections.map((section) =>
        section.items?.length ? (
          <div key={section.label} className="pt-1">
            {/* A label, not a row: it goes nowhere, so it is set apart from the
                things that do rather than dressed to look like one of them. */}
            <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-nav-faint">
              {section.label}
            </p>
            {section.items.map((item) => (
              <ChildLink key={item.href} item={item} isActive={isActive} />
            ))}
          </div>
        ) : section.href ? (
          <ChildLink
            key={section.href}
            item={{
              label: section.label,
              href: section.href,
              icon: section.icon,
              built: section.built,
            }}
            isActive={isActive}
          />
        ) : null,
      )}
    </>
  )
}

function SectionRow({
  section,
  expanded,
  onToggle,
  isActive,
}: {
  section: NavSection
  expanded: boolean
  onToggle: () => void
  isActive: (href: string) => boolean
}) {
  const Icon = section.icon
  const hasChildren = (section.items?.length ?? 0) > 0
  const selfActive = section.href ? isActive(section.href) : false
  const childActive = (section.items ?? []).some((i) => isActive(i.href))
  const active = selfActive || childActive

  /* The section you are in is a SOLID block, not a tint.

     A 10% wash of the brand reads as "slightly different grey" down a rail of
     thirty rows — on the dark theme it was very nearly invisible. Filling the
     row makes the answer to "where am I?" a single glance rather than a hunt.
     `nav-active` rather than `brand` because white on the brand itself is
     3.55:1, and this row carries its own label; the token is the same blue a
     step darker, measured to carry white at AA. The amber rule pinned to the
     left edge is the second half of that — see --color-nav-accent. */
  const rowClass = `relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
    active
      ? 'bg-nav-active font-medium text-nav-active-ink before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r before:bg-nav-accent before:content-[""]'
      : 'text-nav-muted hover:bg-nav-surface-2 hover:text-nav-ink'
  }`

  // A section that is itself a destination — a hub, or a promoted module row.
  if (section.href) {
    if (section.built === false) {
      return (
        <span
          title="Not built yet"
          aria-disabled
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-nav-muted opacity-45"
        >
          <Icon size={17} className="shrink-0" />
          <span className="truncate">{section.label}</span>
        </span>
      )
    }
    /* Plain href, no query string. The palette links straight to the screen
       somebody picked, so a hub no longer has to be opened pre-filtered as a
       consolation prize for the search not being able to name its contents. */
    return (
      <Link
        href={section.href}
        aria-current={selfActive ? 'page' : undefined}
        /* The till and the invoicing window both open BESIDE the back office
           rather than replacing it — see lib/openTill.ts. Promotion can lift
           either onto a section row, so the same rule has to hold here. */
        {...(opensTill(section.href) ? tillLinkProps : {})}
        {...(opensInInvoicingWindow(section.href) ? invoicingLinkProps : {})}
        className={rowClass}
      >
        <Icon size={17} className="shrink-0" />
        <span className="truncate">{section.label}</span>
      </Link>
    )
  }

  return (
    <div className="relative">
      {/* Deliberately not <Button>: this is a nav row that must render
          identically to the sibling <Link> above, which shares rowClass. A
          Button variant would give it button chrome the link cannot match. */}
      <button
        data-kit-ok
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={rowClass}
      >
        <Icon size={17} className="shrink-0" />
        <span className="flex-1 truncate text-left">{section.label}</span>
        <ChevronDown
          size={15}
          className={`shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>

      {expanded && hasChildren && (
        // The rail echoes the screenshot and makes the nesting readable without
        // indenting the labels off the edge.
        //
        // `mt-1` lifts the whole list off the section row above it, and
        // `space-y-0.5` separates the children from each other — a smaller step
        // than the gap between sections, so the group still reads as one block
        // hanging off its parent rather than as eight loose rows.
        <div className="mt-1 ml-5 space-y-0.5 border-l border-nav-border pl-2">
          {section.items!.map((item) => (
            <ChildLink key={item.href} item={item} isActive={isActive} />
          ))}
        </div>
      )}

      {expanded && !hasChildren && (
        <p className="ml-5 border-l border-nav-border py-1.5 pl-5 text-xs text-nav-muted opacity-60">
          Not built yet
        </p>
      )}
    </div>
  )
}

/**
 * Whether a menu row leaves the back office for a window of its own.
 *
 * Asked of lib/openTill.ts rather than answered by a flag on the nav row,
 * because that file already decides it — it is what hands these links their
 * `target`. A second copy here could disagree with the first, and the failure
 * would be silent: a row promoted into the group that then opened in place,
 * under a heading promising it would not.
 */
function opensInOwnWindow(href: string): boolean {
  return opensTill(href) || opensInInvoicingWindow(href)
}

/**
 * The doors out of the back office, grouped under a heading of their own.
 *
 * ── WHY THEY ARE GROUPED, NOT DECORATED ───────────────────────────────────
 *
 * Every other row in this panel swaps the page you are looking at. These do
 * not: they open a SECOND WINDOW and leave the back office exactly where it
 * was. Drawn among their neighbours with nothing to mark them, that difference
 * was something you could only learn by pressing one — and the surprise lands
 * on the two rows a shop presses most, at the start of a shift.
 *
 * The heading is what says it, once, over both. The rows themselves stay
 * ORDINARY: same padding, same icon size, same muted label and hover as every
 * sibling, because they are the same kind of thing — a place you go — and a
 * filled block would rank them above the rest of the menu rather than merely
 * setting them apart from it. Position and the heading do the separating; the
 * trailing arrow repeats the promise per row for anyone scanning past it.
 *
 * They are ANCHORS — the `target` is what opens the named window, and
 * middle-click and "open in new window" keep working.
 */
function NewTabLinks({ items }: { items: NavItem[] }) {
  if (!items.length) return null

  return (
    <div className="pb-1">
      {/* Same type as the group headings inside a section, so this reads as
          another quiet label on the rail rather than as a banner. */}
      <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-nav-faint">
        Opens in a new tab
      </p>
      {items.map((item) => {
        const ItemIcon = item.icon
        return (
          /* Deliberately not <ButtonLink>, and not the kit at all: this has
             to render identically to the SectionRow links below it, which are
             drawn from the nav-* tokens on the dark rail. Any kit control here
             would be the one row in the panel wearing a different skin. */
          <Link
            data-kit-ok
            key={item.href}
            href={item.href}
            /* Spread LAST so the named target cannot be undone above — the
               whole point of the group is that these open beside, not over. */
            {...(opensTill(item.href) ? tillLinkProps : {})}
            {...(opensInInvoicingWindow(item.href) ? invoicingLinkProps : {})}
            /* The same string SectionRow gives an inactive row. These two are
               never the "current page" — the page never becomes them, it opens
               beside — so there is no active branch to carry. */
            className="relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-nav-muted transition hover:bg-nav-surface-2 hover:text-nav-ink"
          >
            <ItemIcon size={17} className="shrink-0" />
            <span className="truncate">{item.label}</span>
            {/* Pinned to the trailing edge, small and half-lit: it is a
                property of the link, not a second thing to read. */}
            <ExternalLink size={12} className="ml-auto shrink-0 opacity-60" />
          </Link>
        )
      })}
      {/* Closes the group off from the rows below it.

          Now that these wear the ordinary row skin, the heading is doing the
          separating on its own — and a heading only marks where a group STARTS.
          Without this, "Cash-up" reads as the third thing that opens in a new
          tab, which is exactly the promise the heading must not make about a
          row that replaces the page. `mx-3` so it stops short of the rail edges
          and reads as a rule between rows rather than as a panel border. */}
      <div aria-hidden className="mx-3 my-1.5 border-t border-nav-border" />
    </div>
  )
}

/**
 * One child row inside an expanded section.
 */
function ChildLink({
  item,
  isActive,
  onNavigate,
}: {
  item: NavItem
  isActive: (href: string) => boolean
  onNavigate?: () => void
}) {
  const ItemIcon = item.icon
  const itemActive = isActive(item.href)

  if (!item.built) {
    return (
      <span
        title="Not built yet"
        aria-disabled
        className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-nav-muted opacity-45"
      >
        <ItemIcon size={15} className="shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
    )
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={itemActive ? 'page' : undefined}
      /* The till and the invoicing window both open BESIDE the back office
         rather than replacing it — see lib/openTill.ts for why each gets its
         own named target. Spread LAST so it cannot be undone above. */
      {...(opensTill(item.href) ? tillLinkProps : {})}
      {...(opensInInvoicingWindow(item.href) ? invoicingLinkProps : {})}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition ${
        /* The whole row takes a fill, and the label goes white and bold.

           Not the blue block the parent section wears: the section is the
           branch you opened and the child is the page you are on, and two
           identical highlights three rows apart read as two selections rather
           than as one place. A quieter band says "within that, this one".

           White rather than a brand tint, because every sibling is now white —
           a coloured label would make the current row the FAINTEST on the rail,
           which is the opposite of marking it. */
        itemActive
          ? 'bg-nav-child-active font-semibold text-nav-ink'
          : 'text-nav-muted hover:bg-nav-surface-2 hover:text-nav-ink'
      }`}
    >
      <ItemIcon size={15} className="shrink-0" />
      <span className="truncate">{item.label}</span>
      {/* The collapsed rail's flyout draws the till and the invoicing register
          as rows — it is a dense hover list, and the filled buttons the expanded
          panel gives them would not fit it. The arrow carries the promise the
          heading makes up there, so a row that opens a second window is never
          silent about it whichever way the rail is showing. */}
      {opensInOwnWindow(item.href) && !itemActive && (
        <ExternalLink size={12} className="ml-auto shrink-0 opacity-60" />
      )}
      {/* The amber pip, echoing the rule on the open section above it — the
          rail's one non-blue mark, so "you are here" is the same colour at both
          levels. `ml-auto` pins it to the trailing edge of the filled row. */}
      {itemActive && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-nav-accent" />}
    </Link>
  )
}
