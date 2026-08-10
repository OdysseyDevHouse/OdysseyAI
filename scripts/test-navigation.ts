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
check('"vat" finds Accounting AND Setup', found('vat'), ['Accounting', 'Setup'])
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
