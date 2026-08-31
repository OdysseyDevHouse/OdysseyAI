import {
  NAV,
  SUBPAGE_KEYWORDS,
  SUBPAGE_LABELS,
  hubFor,
  type NavSection,
  type SubpageHref,
} from './nav'
import { SETUP_GROUPS } from '@/app/(app)/setup/catalogue'
import { ACCOUNTING_GROUPS } from '@/app/(app)/accounting/catalogue'
import { ONLINE_STORE_GROUPS } from '@/app/(app)/online-store/catalogue'
import { ONLINE_STORE_SETUP_GROUPS } from '@/app/(app)/online-store/settings/catalogue'
import { JOBS_SETUP_GROUPS } from '@/app/(app)/jobs/setup/catalogue'
import { visibleSettings, settingHref } from './settingSearch'
import type { HubIconName } from './hub'
import type { LucideIcon } from 'lucide-react'
/* The shop's own configuration, which is what every one of these rows is —
   as opposed to SlidersHorizontal, which the kit reserves for per-device
   display choices. */
import { Settings as SettingsIcon } from '@/components/ui/icons'

/**
 * Every screen in the app as one flat, searchable list.
 *
 * `filterNav` in nav.ts answers a different question — "which parts of the MENU
 * survive this term", preserving the section/child tree so the sidebar can render
 * it. A global search wants the opposite shape: one ranked list of destinations
 * where a hub's sub-page is a first-class result rather than a reason to keep its
 * hub row. Setup → Tips is what somebody is looking for; "Setup" is not.
 *
 * Derived from NAV and SUBPAGE_LABELS rather than being a third list of screens,
 * so a renamed screen still cannot appear here under its old name.
 */

export type PageHit = {
  /** Where it goes. Unique, so it doubles as the React key. */
  href: string
  /** What the screen is called. */
  label: string
  /** The trail above it — "Setup", "Accounting › Fixed assets". */
  group: string
  /**
   * What the screen DOES, in one line — "Manage your tills and cash registers".
   *
   * The single thing that makes an unfamiliar screen choosable by somebody who
   * has not opened it before, which is exactly the person using a search box.
   * Read from the hub catalogues rather than authored again here: the hubs
   * already carry one line per screen, and a second copy is the drift nav.ts
   * warns about. Absent for a menu item, which has no catalogue entry.
   */
  description?: string
  /**
   * The screen's OWN glyph where a catalogue names one, falling back to its
   * section's. A row of results is then distinguishable by shape rather than
   * being twelve copies of the same cog.
   */
  icon: LucideIcon
  /** Set when `icon` came from a catalogue, so the renderer can resolve it. */
  iconName?: HubIconName
  /** Matched synonyms, shown small so a keyword hit does not look arbitrary. */
  keywords?: string
  /**
   * Planned, with no route yet. Rendered greyed and unclickable for the same
   * reason the sidebar does it: a link that 404s is worse than an obvious gap.
   */
  built: boolean
  /**
   * Set when this hit is a SETTING inside a screen rather than the screen
   * itself — see lib/settingSearch.ts.
   *
   * Carried on the same shape rather than as a parallel result type so a setting
   * inherits the ranking, the grouping and the keyboard walk that already exist.
   * The palette reads it for two things: the anchor to flash on arrival, and the
   * heading these rows are gathered under, since "Sign out after this long
   * untouched" listed among screens reads as a screen with a very odd name.
   */
  setting?: { anchor?: string }
}

/**
 * What every hub screen decides, and the glyph it wears, keyed by route.
 *
 * Flattened from every catalogue at module load. They are plain data with
 * no server-only imports — HubView is itself a client component that reads the
 * same shapes — so this costs the browser the descriptions and nothing else.
 */
const CATALOGUE: Record<string, { description: string; icon: HubIconName; keywords?: string }> =
  Object.fromEntries(
    [
      ...SETUP_GROUPS,
      ...ACCOUNTING_GROUPS,
      ...ONLINE_STORE_GROUPS,
      /* The per-section Setup hubs. Their screens left the general setup
         catalogue when each section grew a Setup row of its own, and the
         palette has to keep reaching them.

         Loyalty is NOT among them any more: its three settings screens are
         menu rows in their own right, so they arrive through NAV below and
         carry their own description and keywords there. A catalogue entry as
         well would be the second front door the nav test forbids. */
      ...ONLINE_STORE_SETUP_GROUPS,
      ...JOBS_SETUP_GROUPS,
    ]
      .flatMap((group) => group.items)
      .map((item) => [
        item.href,
        { description: item.description, icon: item.icon, keywords: item.keywords },
      ]),
  )

/* The reports hub is a list of report TEMPLATES, not a screen catalogue — its
   one dedicated page carries its line here so the search can still explain it. */
CATALOGUE['/reports/stock-intel'] = {
  description: 'True stock aging from movement history, ABC classes, stock turn and sell-through.',
  icon: 'LineChart',
  keywords: 'aging dead stock abc analysis turn sell-through slow movers',
}

/* The cross-store pair, for the same reason: dedicated pages rather than engine
   specs, so the catalogue is the only place they can carry a line. "group" is
   kept as a synonym — it is what this used to be called in the menu. */
CATALOGUE['/reports/multi-store'] = {
  description: 'Today, this month, gross profit and stock on hand for every linked store.',
  icon: 'LayoutGrid',
  keywords: 'multi store group consolidated branches linked stores combined all stores',
}
CATALOGUE['/reports/multi-store-income-statement'] = {
  description: 'One profit and loss across every linked store, a column each, by account code.',
  icon: 'LineChart',
  keywords: 'multi store group consolidated p&l income statement profit branches',
}
CATALOGUE['/reports/multi-store-sales'] = {
  description: 'Turnover per store, day by day or month by month — who is growing and who is sliding.',
  icon: 'BarChart',
  keywords: 'multi store group sales turnover daily monthly trend compare growth branches',
}
CATALOGUE['/reports/multi-store-like-for-like'] = {
  description: 'Growth against the same period last year, counting only stores that traded in both.',
  icon: 'LineChart',
  keywords: 'like for like lfl same store comp sales growth year on year multi store group',
}
CATALOGUE['/reports/multi-store-stock'] = {
  description: 'What each store holds, and where stock should move when one is short and another has surplus.',
  icon: 'Boxes',
  keywords: 'stock on hand rebalance transfer surplus shortage overstock understock multi store group',
}
CATALOGUE['/reports/multi-store-balance-sheet'] = {
  description: 'What the whole group owns and owes at a date, a column per store, by account code.',
  icon: 'Scale',
  keywords: 'consolidated balance sheet assets liabilities equity multi store group branches',
}
CATALOGUE['/reports/multi-store-mix'] = {
  description: 'What sells, how it is paid for, and when the shops are busy — three cuts, every store.',
  icon: 'LayoutGrid',
  keywords: 'department hour trading pattern mix how paid payment cash card busiest peak multi store group',
}
CATALOGUE['/reports/multi-store-transfers'] = {
  description: 'What moved between stores, what is on the road, and what is counted twice.',
  icon: 'Truck',
  keywords: 'store transfers in transit counted twice unsettled stale multi store group',
}

/* The audit trail, for the same reason as the pages above: it is listed in the
   reports hub but is a PAGE rather than an engine spec, so no catalogue carries
   its line. Its ROUTE is still /setup/audit — only where it is listed moved, and
   the setup catalogue no longer names it. */
CATALOGUE['/setup/audit'] = {
  description: 'Every change anyone made, and who signed in when.',
  icon: 'History',
  keywords: 'audit log history who changed sign in login security trail',
}

/**
 * The searchable index for ONE user, built from the sections they can see.
 *
 * Takes the already-filtered `visible` sections rather than reading NAV itself:
 * the sidebar has resolved capabilities once, and a second resolution here is a
 * second thing that can disagree about what somebody may see.
 */
export function buildPageIndex(visible: NavSection[]): PageHit[] {
  const hits: PageHit[] = []
  /* Which hubs this user reached, so their sub-pages are only indexed when the
     hub itself is visible — the hub's capability is the weakest of its tiles, so
     someone who cannot see /setup cannot see any setting below it. */
  const hubs = new Map<string, NavSection>()

  for (const section of visible) {
    if (section.href) {
      hubs.set(section.href, section)
      hits.push({
        href: section.href,
        label: section.label,
        /* A hub is its own group heading, so the trail would read
           "Setup › Setup". Named for what it IS instead. */
        group: section.items?.length ? section.label : 'Sections',
        description: section.description,
        icon: section.icon,
        keywords: section.keywords,
        built: section.built !== false,
      })
    }

    for (const item of section.items ?? []) {
      /* A ROW can be a hub too, since Loyalty, Job cards, Tickets and the
         Online Store each carry their own Setup. Registered under the item's
         own label so a screen below it reads "Setup › …" rather than naming
         the section twice. */
      hubs.set(item.href, { ...section, label: item.label, icon: item.icon })
      hits.push({
        href: item.href,
        label: item.label,
        group: section.label,
        description: item.description,
        icon: item.icon,
        keywords: item.keywords,
        built: item.built !== false,
      })
    }
  }

  /* The screens a hub lists, which the menu itself never names. Without these the
     search finds "Setup" and nothing inside it — fourteen settings screens
     unreachable by name, which is the whole reason this file exists. */
  /* Every menu destination, so a hub that is ALSO a menu row is not indexed
     twice — it was already pushed above, with the section as its group. */
  const menuHrefs = new Set(
    visible.flatMap((s) => [...(s.href ? [s.href] : []), ...(s.items ?? []).map((i) => i.href)]),
  )

  for (const [path, label] of Object.entries(SUBPAGE_LABELS)) {
    if (menuHrefs.has(path)) continue
    const owner = hubFor(path)
    const hub = owner ? hubs.get(owner) : null
    if (!hub) continue

    /* A screen can sit below another named screen — /accounting/assets and
       /accounting/assets/depreciation are both listed — and the deeper one reads
       as "Accounting › Fixed assets" rather than losing the page it belongs to. */
    const parent = Object.keys(SUBPAGE_LABELS)
      .filter((p) => path.startsWith(`${p}/`) && hubFor(p) === owner)
      .sort((a, b) => b.length - a.length)[0]

    const catalogued = CATALOGUE[path]

    hits.push({
      href: path,
      label,
      group: parent
        ? `${hub.label} › ${SUBPAGE_LABELS[parent as SubpageHref]}`
        : hub.label,
      description: catalogued?.description,
      /* The hub's glyph is the fallback, not the choice: a catalogue names one
         per screen, and `iconName` below is how the renderer reaches it. */
      icon: hub.icon,
      iconName: catalogued?.icon,
      /* Both sources of synonyms, DEDUPED by word. SUBPAGE_KEYWORDS covers the
         screens nav.ts knows about and the catalogues carry their own — and for
         most screens the two hold the same string, so a plain join gave Tills
         "terminals registers pos devices" twice over. Harmless to matching, but
         it is the kind of thing that shows up in a debug dump and wastes an hour;
         a Set costs nothing at module load. */
      keywords: [
        ...new Set(
          [SUBPAGE_KEYWORDS[path as SubpageHref], catalogued?.keywords]
            .filter(Boolean)
            .join(' ')
            .split(/\s+/)
            .filter(Boolean),
        ),
      ].join(' '),
      built: true,
    })
  }

  /* The individual SETTINGS inside those screens.
     Added last so a screen still outranks a setting on an equal score — asking
     for "printing" should offer the Printing screen above the one switch on it.
     Gated on the routes already in `hits`, which is this user's own resolved
     list, so a setting never advertises a screen they cannot open. */
  const reachable = new Set(hits.map((hit) => hit.href))
  for (const setting of visibleSettings(reachable)) {
    hits.push({
      href: settingHref(setting),
      label: setting.label,
      /* One heading for all of them. The screen a setting lives on is already
         in `description` below, and grouping by screen instead would print a
         heading per row for the screens that contribute a single setting. */
      group: 'Settings',
      /* What it decides, then where it is. The location matters more here than
         it does for a screen — "Tills" is the surprising half of the answer for
         somebody who has spent ten minutes not finding auto logout. */
      description: `${setting.description} — on ${SUBPAGE_LABELS[setting.href] ?? setting.href}`,
      icon: SettingsIcon,
      /* Deduped by word, exactly as the screens above are. A setting's synonyms
         are written as PHRASES somebody might type — "auto logout", "auto lock",
         "log out", "lock screen" — so shared words are the normal case rather
         than a mistake to be edited out one string at a time. Matching is by
         substring and unaffected either way; this keeps the stored string
         honest, which is what the nav test reads. */
      keywords: [
        ...new Set(setting.keywords.split(/\s+/).filter(Boolean)),
      ].join(' '),
      built: true,
      setting: { anchor: setting.anchor },
    })
  }

  return hits
}

/**
 * How well a page matches, or 0 for not at all.
 *
 * Ranked rather than merely filtered, because an unranked `includes` scan puts
 * "Supplier age analysis" above "Suppliers" for the term "suppl" — the longer
 * string simply appears earlier in the list. The tiers below are ordered by how
 * confident the match is:
 *
 *   5  the whole label, exactly          "tips" → Tips
 *   4  the label starts with the term    "cust" → Customers
 *   3  a word inside the label starts    "analysis" → Supplier age analysis
 *   2  a keyword hit                     "gratuity" → Tips
 *   1  the group, or the description     "rang up a sale" → Tills
 *
 * Anything the label merely contains mid-word ("ips" → Tips) scores 3 as well,
 * because a shop owner typing a fragment of a word still means that word.
 *
 * A KEYWORD OUTRANKS A DESCRIPTION, and that distinction is load-bearing. A
 * keyword is a deliberate synonym — somebody wrote "registers" on Tills meaning
 * "people will search for this word". A description is prose about what the
 * screen does, and the same word can fall inside one by accident: "register"
 * appears in the fixed-asset register's synonyms AND in Tills' description, and
 * scoring the two the same put Fixed assets above Tills on a tie broken
 * alphabetically. Intent beats coincidence.
 */
export function scorePage(hit: PageHit, needle: string): number {
  const label = hit.label.toLowerCase()
  if (label === needle) return 5
  if (label.startsWith(needle)) return 4
  if (label.includes(needle)) return 3
  if (hit.keywords?.toLowerCase().includes(needle)) return 2
  /* The group, so "accounting vat" and "setup users" work — somebody who knows
     where a screen lives types the section before the screen. */
  if (hit.group.toLowerCase().includes(needle)) return 1
  /* And the description, so a screen is findable by what it DOES even when the
     words are in neither its name nor its synonyms. Lowest tier deliberately:
     see the note above on why prose must not outrank an authored synonym. */
  if (hit.description?.toLowerCase().includes(needle)) return 1
  return 0
}

/**
 * The best page matches for a term.
 *
 * Every word must match SOMETHING, so "setup tips" narrows rather than widening
 * to everything either word touches — which is what a space in a search box
 * means to the person typing it.
 */
export function searchPages(index: PageHit[], term: string, limit = 8): PageHit[] {
  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const scored: { hit: PageHit; score: number }[] = []
  for (const hit of index) {
    let total = 0
    for (const word of words) {
      const score = scorePage(hit, word)
      if (score === 0) {
        total = 0
        break
      }
      total += score
    }
    if (total > 0) scored.push({ hit, score: total })
  }

  return scored
    .sort((a, b) => b.score - a.score || a.hit.label.localeCompare(b.hit.label))
    .slice(0, limit)
    .map((s) => s.hit)
}

/** Every page under one heading, for rendering the results grouped. */
export function groupHits<T extends { group: string }>(hits: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const hit of hits) {
    const existing = groups.get(hit.group)
    if (existing) existing.push(hit)
    else groups.set(hit.group, [hit])
  }
  return [...groups]
}
