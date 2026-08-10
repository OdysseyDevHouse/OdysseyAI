// The navigation rules, checked without a browser or a database.
//
//   npm run test:navigation
//
// Setup is one menu entry pointing at a hub, and the fourteen screens the hub
// lists are NOT in NAV. That arrangement has three failure modes that compile
// perfectly and only show up in a browser:
//
//   1. a setup screen renders with no breadcrumb, so there is no way back to
//      the hub but the browser's own button;
//   2. the sidebar search, which promises "pages, reports, settings", stops
//      finding any setting, because none of them is a menu entry any more;
//   3. a name drifts — the tile says one thing and the trail above it another.
//
// All three are pure functions of NAV and SUBPAGE_LABELS, so they are cheap to
// assert here and expensive to notice by hand.
//
// ── WHY lucide-react IS STUBBED BEFORE nav.ts IS IMPORTED ─────────────────
//
// nav.ts hangs an icon COMPONENT off every entry, so importing it pulls in
// lucide-react, which calls React.createContext at module scope. pre-publish
// runs every test with `--conditions=react-server`, where that resolves to the
// server build with no createContext — so the import dies with
// "react.createContext is not a function" before a single assertion runs, even
// though nothing here touches an icon.
//
// The stub is registered through Module._load rather than a loader hook so it
// applies to the CJS graph tsx produces, and nav.ts is reached with a DYNAMIC
// import below — a static `import` is hoisted above every statement, so the
// stub would be installed after the thing it is meant to intercept had already
// loaded. Only the icon VALUES are faked; every rule under test is a function
// of labels, hrefs and capabilities.
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const Mod = nodeRequire('node:module') as { _load: (...a: unknown[]) => unknown }
const realLoad = Mod._load
Mod._load = function (request: unknown, ...rest: unknown[]) {
  if (request === 'lucide-react') {
    // Any property is a valid "icon"; nav only ever stores the reference.
    return new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) })
  }
  return realLoad.call(this, request, ...rest)
}

// require, not `await import`: tsx emits CJS here, where top-level await is a
// build error — and the require lands after the stub above either way.
const {
  NAV,
  SUBPAGE_LABELS,
  SUBPAGE_KEYWORDS,
  breadcrumbFor,
  filterNav,
  hubFor,
  navFor,
  subpageMatches,
} = nodeRequire('../src/lib/nav') as typeof import('../src/lib/nav')

/* The global search palette's index. Same stub, same reasoning — it hangs the
   section's icon off every hit and nothing here touches one. */
const { buildPageIndex, searchPages, scorePage } = nodeRequire(
  '../src/lib/pageSearch',
) as typeof import('../src/lib/pageSearch')

let failures = 0

function check(what: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}\n         got  ${g}\n         want ${w}`)
}

console.log('\nSetup is one link, not a group')
const setup = NAV.find((s) => s.label === 'Setup')
check('the section exists', !!setup, true)
check('it is a destination', setup?.href, '/setup')
check('it has no children', setup?.items, undefined)

console.log('\nBreadcrumbs reach screens the menu does not list')
const crumbs = (p: string) => breadcrumbFor(p)?.crumbs.map((c) => c.label)
check('/setup', crumbs('/setup'), ['Setup'])
check('/setup/terminals', crumbs('/setup/terminals'), ['Setup', 'Tills'])
check('/setup/tender-types', crumbs('/setup/tender-types'), ['Setup', 'Tender types'])
check('the first crumb links back to the hub', breadcrumbFor('/setup/terminals')?.crumbs[0].href, '/setup')

check('/accounting/vat', crumbs('/accounting/vat'), ['Accounting', 'VAT return'])
check('/online-store/orders', crumbs('/online-store/orders'), ['Online Store', 'Orders'])
/* A hub screen whose ROUTE lives elsewhere still belongs to the hub that lists
   it — a prefix scan would file this under Sales and never reach Accounting. */
check('/sales/offline', crumbs('/sales/offline'), ['Accounting', 'Offline sales'])
check('/cashbook', crumbs('/cashbook'), ['Accounting', 'Cashbook'])
check('/staff/pay-rules', crumbs('/staff/pay-rules'), ['Setup', 'Pay rules'])
// A screen below a hub screen keeps the page it belongs to in the middle.
check('/accounting/assets/depreciation', crumbs('/accounting/assets/depreciation'), [
  'Accounting',
  'Fixed assets',
  'Depreciation',
])

// Every screen a hub can link to must resolve, or it renders with no trail.
const unnamed = Object.keys(SUBPAGE_LABELS).filter((href) => (crumbs(href) ?? []).length < 2)
check('every hub screen resolves a trail', unnamed, [])

/* The first crumb must link back to the hub, or somebody who arrived from a
   tile has no way back to the others but the browser's own button. */
const noWayBack = Object.keys(SUBPAGE_LABELS).filter(
  (href) => breadcrumbFor(href)?.crumbs[0].href !== hubFor(href),
)
check('every hub screen links back to its hub', noWayBack, [])

console.log('\nThe sidebar search still finds settings')
const found = (term: string) => filterNav(term).map((s) => s.label)
check('"tender" finds Setup', found('tender'), ['Setup'])
check('"reconcil" finds Setup', found('reconcil'), ['Setup'])
/* Sales is in here because "reserVATions" contains the term. The search matches
   on substring, which is what makes "reconcil" reach "Reconciliation" — so this
   is the same rule working, not a bug to special-case away. Left as a plain
   expectation rather than adding word-boundary matching: a shop owner typing
   three letters wants more results, not fewer. */
check('"vat" finds Accounting AND Setup', found('vat'), ['Sales', 'Accounting', 'Setup'])
/* The regression a hub is most likely to cause: twenty-four rows became two
   links, so a search that used to hit a menu entry must still reach the hub. */
check('"cashbook" finds Accounting', found('cashbook'), ['Accounting'])
check('"journals" finds Accounting', found('journals'), ['Accounting'])
check('"discount" finds Online Store', found('discount'), ['Online Store'])
check('"page builder" finds Online Store', found('page builder'), ['Online Store'])
check('"punch" finds Setup', found('punch'), ['Setup'])
check('"pay rules" finds Setup', found('pay rules'), ['Setup'])
// Reports keeps its shortcuts findable by name without listing them as rows.
check('"build a report" finds Reports', found('build a report'), ['Reports'])
check('a miss finds nothing', found('zzzzz'), [])
check('the match is scoped to the subtree', subpageMatches('/reports', 'tender'), false)
check('an empty term matches nothing', subpageMatches('/setup', '   '), false)

console.log('\nSynonyms reach screens the menu does not name')
// The screen is called "Tills". Somebody looking for it types "terminal".
check('"terminal" finds Setup', found('terminal'), ['Setup'])
check('"register" finds Setup', found('register'), ['Setup'])
check('"permissions" finds Setup', found('permissions'), ['Setup'])
check('a synonym is still scoped to its subtree', subpageMatches('/reports', 'terminal'), false)
// Every synonym must name a screen that exists, or it silently matches nothing.
const strayKeywords = Object.keys(SUBPAGE_KEYWORDS).filter((h) => !(h in SUBPAGE_LABELS))
check('every synonym key is a real screen', strayKeywords, [])

// ── THE GLOBAL SEARCH PALETTE ─────────────────────────────────────────────
//
// filterNav above answers "which parts of the MENU survive this term" and can
// only ever name a menu row — which is why every settings assertion above expects
// the string "Setup" rather than the screen somebody was actually looking for.
// The palette indexes screens instead, so the same searches must now land on the
// SCREEN. That is the whole point of it, and it is the thing most likely to
// regress silently: a hub sub-page dropping out of the index still compiles, and
// the menu above it goes on looking perfectly correct.

console.log('\nThe global search finds screens, not just their hub')
const everything = navFor(() => true)
const index = buildPageIndex(everything)
const hits = (term: string) => searchPages(index, term).map((h) => h.label)
const top = (term: string) => hits(term)[0]

/* The settings searches from further up this file, which used to be able to
   answer nothing better than "Setup". */
check('"tender" finds the screen itself', top('tender'), 'Tender types')
check('"reconcil" finds Reconciliation', top('reconcil'), 'Reconciliation')
check('"journals" finds Journals', top('journals'), 'Journals')
check('"cashbook" finds Cashbook', top('cashbook'), 'Cashbook')
check('"punch" finds Punch cards', top('punch'), 'Punch cards')
check('"pay rules" finds Pay rules', top('pay rules'), 'Pay rules')
check('"discount codes" finds the screen', top('discount codes'), 'Discount codes')

/* A synonym must reach the screen it describes, not merely its hub — the screen
   is called "Tills" and a shop owner types "terminal". */
check('"terminal" finds Tills', top('terminal'), 'Tills')
/* "register" is a DELIBERATE synonym on two screens — the till register and the
   fixed-asset register — so both are correct answers and the test asserts that
   Tills is among them rather than first. Pinning an order here would be pinning
   an alphabetical tie-break, which is not a rule worth defending. */
check('"register" reaches Tills', hits('register').includes('Tills'), true)
check('"permissions" finds Roles', top('permissions'), 'Roles & permissions')
check('"gratuity" finds Tips', top('gratuity'), 'Tips')

/* Ranking, not just filtering. An exact label beats a longer string that merely
   contains the term, and a prefix beats a mid-word hit — without which "suppl"
   puts "Supplier age analysis" above "Suppliers" purely because it is longer. */
check('an exact label wins', top('tips'), 'Tips')
check('a prefix beats a longer containing match', top('suppliers'), 'Suppliers')
check('"customers" finds the list first', top('customers'), 'Customers')

/* Every word must match something, so a space narrows rather than widens. */
check('"setup tips" narrows to one screen', hits('setup tips'), ['Tips'])
check('a miss finds nothing', hits('zzzzz'), [])
check('an empty term finds nothing', hits('   '), [])

/* The index must actually cover the app: every screen a hub lists has to be in
   it, or the palette silently cannot reach a whole hub's worth of settings. This
   is the assertion that fails the day somebody adds a screen to SUBPAGE_LABELS
   and the search quietly does not find it. */
const indexed = new Set(index.map((h) => h.href))
const missing = Object.keys(SUBPAGE_LABELS).filter((href) => !indexed.has(href))
check('every hub screen is in the index', missing, [])

const missingItems = allNavItems().filter((href) => !indexed.has(href))
check('every menu item is in the index', missingItems, [])

/* One entry per destination. A duplicate renders the same screen twice in the
   palette and makes the keyboard cursor land on it twice on the way past. */
const indexSeen = new Set<string>()
const indexDupes = index
  .map((h) => h.href)
  .filter((href) => (indexSeen.has(href) ? true : (indexSeen.add(href), false)))
check('no screen is indexed twice', [...new Set(indexDupes)], [])

/* ── Descriptions ───────────────────────────────────────────────────────────
   The line under a result is what makes an unfamiliar screen choosable, so a
   screen without one renders as a bare name in a list of explained ones. The
   hub screens read theirs from their catalogue; menu items carry it in NAV. */
const described = (term: string) => searchPages(index, term)[0]?.description ?? null
check('a hub screen describes itself', described('tender types'), 'How sales are paid for. Some stores have four, some have ten.')
check('a menu item describes itself too', described('timesheets'), 'Hours worked, and approving them for pay')
check('and so does a hub link', described('accounting'), 'The books — ledgers, VAT, expenses and the bank')

/* Searchable, not just displayed: "rang up" is in the Tills description and in
   neither its label nor its synonyms. */
check('a description is searchable', top('rang up'), 'Tills')

/*
 * A keyword must outrank a description.
 *
 * A keyword is a deliberate synonym — somebody wrote "gratuity" on Tips meaning
 * "people will search for this". A description is prose about what the screen
 * does, and the same word can fall inside one by coincidence. Scoring the two
 * alike decides such a collision on an alphabetical tie-break rather than on
 * intent, which is how "register" — a real synonym on BOTH the till register and
 * the fixed-asset register — put Fixed assets above Tills.
 *
 * Asserted on the tiers themselves rather than on a pair of screens, because
 * every word that collides today is a legitimate synonym on both sides; the rule
 * is what needs defending, not one ranking that happens to demonstrate it.
 */
const tips = index.find((h) => h.href === '/setup/tips')!
const tills = index.find((h) => h.href === '/setup/terminals')!
check('a synonym scores above prose', scorePage(tips, 'gratuity') > scorePage(tills, 'rang up'), true)
check('and prose still scores at all', scorePage(tills, 'rang up') > 0, true)

/* Synonyms come from two places — nav.ts and the catalogues — and most screens
   have the same string in both. Joined without deduping, Tills carried
   "terminals registers pos devices" twice. */
const doubledKeywords = index
  .filter((h) => {
    const words = (h.keywords ?? '').split(/\s+/).filter(Boolean)
    return words.length !== new Set(words).size
  })
  .map((h) => h.href)
check('no screen carries a synonym twice', doubledKeywords, [])

/* Every screen in the index needs one. This is the check that fails the day a
   screen is added to NAV or a catalogue without the line that explains it. */
const undescribed = index
  .filter((h) => h.built && !h.description)
  .map((h) => h.href)
  .sort()
check('every screen has a description', undescribed, [])

/* A catalogue names an icon per screen so a list of settings is not twelve
   identical cogs. An unresolvable name renders nothing at all. */
const { HUB_ICONS } = nodeRequire('../src/components/ui/hubIcons') as {
  HUB_ICONS: Record<string, unknown>
}
const strayIcons = index
  .filter((h) => h.iconName && !HUB_ICONS[h.iconName])
  .map((h) => h.iconName)
check('every catalogue icon resolves to a glyph', [...new Set(strayIcons)], [])

/* Capabilities gate the index exactly as they gate the menu, because it is built
   from the already-filtered sections. Someone who cannot open the setup hub must
   not be able to find a setting by name — the palette would otherwise be a way
   to enumerate screens around a permission. */
const setupOnly = buildPageIndex(navFor((c) => c === 'sales.view'))
const reachable = new Set(setupOnly.map((h) => h.href))
check('a setting is not indexed without its hub', reachable.has('/setup/users'), false)
check('nor is another section’s screen', reachable.has('/customers'), false)
check('but the granted one is', reachable.has('/sales'), true)

function allNavItems(): string[] {
  return NAV.flatMap((s) => (s.items ?? []).map((i) => i.href))
}

console.log('\nCapabilities gate the entry')
const shows = (granted: string[]) =>
  navFor((c) => granted.includes(c)).some((s) => s.label === 'Setup')
check('setup.view is enough', shows(['setup.view']), true)
check('an unrelated capability is not', shows(['sales.view']), false)

// ── STRUCTURAL RULES ──────────────────────────────────────────────────────
//
// The rules above test the Setup arrangement specifically. These hold for the
// whole tree, and they are what makes REGROUPING safe: a section can be renamed
// or its children moved, and these still say whether the result is coherent.

const allItems = NAV.flatMap((s) => s.items ?? [])
const sectionHrefs = NAV.filter((s) => s.href).map((s) => s.href!)

console.log('\nThe tree is structurally sound')

/* A duplicate href breaks the sidebar's longest-href-wins highlight in a way
   that is invisible until somebody lands on the page and two rows light up. */
const seen = new Set<string>()
const duplicates = allItems
  .map((i) => i.href)
  .filter((href) => (seen.has(href) ? true : (seen.add(href), false)))
check('every item href is unique', [...new Set(duplicates)], [])

/* The mechanical form of "two front doors that could disagree": a screen named
   in the menu AND listed by a hub has two entries that can drift apart. */
const bothPlaces = Object.keys(SUBPAGE_LABELS).filter((href) =>
  allItems.some((i) => i.href === href),
)
check('no screen is both a menu item and a hub subpage', bothPlaces, [])

/* Every hub subpage must resolve to a hub that exists, or its breadcrumb comes
   out empty and the screen has no way back to the hub that sent them there.
   Uses hubFor rather than a prefix test, because a hub groups by the question
   somebody arrives with and not by URL: /cashbook is an accounting screen. */
const orphanedSubpages = Object.keys(SUBPAGE_LABELS).filter((href) => {
  const owner = hubFor(href)
  return !owner || !sectionHrefs.includes(owner)
})
check('every hub subpage resolves to a real hub', orphanedSubpages, [])

/* Longest-href-wins is only well defined if a section that is itself a link has
   no children — otherwise the row is both a destination and a disclosure. */
const ambiguous = NAV.filter((s) => s.href && s.items?.length).map((s) => s.label)
check('no section is both a link and a group', ambiguous, [])

/* The menu and the trail must agree about where somebody is.
 *
 * A hub screen whose URL sits beneath a MENU item — /staff/pay-rules under
 * "People", /cashbook under nothing but /sales/offline under "Documents" — is
 * the case that broke: the sidebar highlighted the section by prefix while the
 * breadcrumb above it named the hub. Both now resolve ownership through hubFor,
 * so the check is that the two answers match for every hub screen.
 *
 * `sectionOwning` is the prefix rule the sidebar used to apply alone; if it
 * finds a section and hubFor names a different one, hubFor must win. This fails
 * the day somebody adds such a screen and forgets its SUBPAGE_OWNER entry.
 */
const sectionOwning = (href: string) =>
  NAV.find((s) => (s.items ?? []).some((i) => href === i.href || href.startsWith(`${i.href}/`)))

const disagreements = Object.keys(SUBPAGE_LABELS)
  .filter((href) => {
    const byPrefix = sectionOwning(href)
    if (!byPrefix) return false
    const crumb = breadcrumbFor(href)?.crumbs[0].label
    return crumb !== undefined && crumb !== byPrefix.label && hubFor(href) === null
  })
check('the menu and the trail agree on every hub screen', disagreements, [])

/* And the positive form: every screen whose route sits under another section
   must declare its owner, or the highlight falls back to the prefix. */
const undeclared = Object.keys(SUBPAGE_LABELS).filter(
  (href) => sectionOwning(href) && hubFor(href) === null,
)
check('every hub screen under a menu item declares its hub', undeclared, [])

// ── ROUTE COVERAGE ────────────────────────────────────────────────────────
//
// Every page that exists should be reachable from the menu or a hub. Without
// this, a screen can be built, guarded and shipped with nothing linking to it —
// which is exactly how the seven orphans this plan had to find by hand appeared.
//
// Uses node:fs only, so the lucide stub above is unaffected. Required rather
// than imported for the same reason nav.ts is: a static import is hoisted above
// every statement in the file, including the stub these tests depend on.
const { readdirSync, statSync } = nodeRequire('node:fs') as typeof import('node:fs')
const { join } = nodeRequire('node:path') as typeof import('node:path')

const APP_DIR = join(__dirname, '..', 'src', 'app', '(app)')

/** Every URL under (app) that a person could type, ignoring dynamic segments. */
function routesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'page.tsx') {
      out.push(prefix || '/')
      continue
    }
    if (!statSync(full).isDirectory()) continue
    // A [id] segment is a detail route, reached from its list rather than linked.
    if (entry.startsWith('[')) continue
    // A (group) contributes nothing to the URL.
    const next = entry.startsWith('(') ? prefix : `${prefix}/${entry}`
    out.push(...routesUnder(full, next))
  }
  return out
}

/**
 * Routes that are deliberately not in the menu, each with the reason.
 *
 * An entry here is a DECISION, not a backlog. Adding one should be as
 * uncomfortable as it sounds — the default is that a page people can reach is a
 * page something links to.
 */
const UNLINKED: Record<string, string> = {
  '/not-allowed': 'the redirect target for a failed capability check',
  '/purchasing/receive': 'an action reached from a purchase order, not a destination',
  '/customers/new': 'reached from the customer list',
  '/suppliers/new': 'reached from the supplier list',
  '/products/new': 'reached from the product list',
  '/departments/new': 'reached from the department list',
  '/instructions/new': 'reached from the instruction list',
  '/transfers/new': 'reached from the transfer list',
  '/stock-takes/new': 'reached from the stock take list',
  '/manufacturing/new': 'reached from the manufacturing list',
  '/expenses/new': 'reached from the expense list',
  '/cashbook/new': 'reached from the cashbook list',
  '/sales/contracts/new': 'reached from the contract list',
  '/purchasing/new': 'reached from the purchase order list',
  '/accounting/assets/new': 'reached from the asset list',
  /* The reports hub leads with these three and is the entry point people are
     meant to learn, so listing them in the menu beside it put three shortcuts
     to a hub next to the hub. The sidebar search still finds them by name,
     through the Reports section's own keywords. */
  '/reports/builder': 'the reports hub leads with it',
  '/reports/ask': 'the reports hub leads with it',
  '/reports/schedules': 'the reports hub leads with it',
  '/commission/rules': 'configuration reached from the commission periods screen',
}

console.log('\nEvery page is reachable')
const linked = new Set<string>([...sectionHrefs, ...allItems.map((i) => i.href), ...Object.keys(SUBPAGE_LABELS)])
const unreachable = routesUnder(APP_DIR)
  .filter((r) => !linked.has(r))
  .filter((r) => !(r in UNLINKED))
  .sort()
check('no page is reachable by URL but linked from nowhere', unreachable, [])

/* An allowlist entry for a page that no longer exists is stale, and a stale
   allowlist is how the check above quietly stops covering things. */
const existing = new Set(routesUnder(APP_DIR))
const staleAllowlist = Object.keys(UNLINKED).filter((r) => !existing.has(r)).sort()
check('the allowlist has no stale entries', staleAllowlist, [])

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nALL PASS\n')
process.exit(failures ? 1 : 0)
