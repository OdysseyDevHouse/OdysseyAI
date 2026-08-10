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
const { NAV, SUBPAGE_LABELS, breadcrumbFor, filterNav, navFor, subpageMatches } =
  nodeRequire('../src/lib/nav') as typeof import('../src/lib/nav')

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

// Every screen the hub can link to must resolve, or it renders with no trail.
const unnamed = Object.keys(SUBPAGE_LABELS).filter((href) => (crumbs(href) ?? []).length !== 2)
check('every setup screen resolves a two-part trail', unnamed, [])

console.log('\nThe sidebar search still finds settings')
const found = (term: string) => filterNav(term).map((s) => s.label)
check('"tender" finds Setup', found('tender'), ['Setup'])
check('"reconcil" finds Setup', found('reconcil'), ['Setup'])
check('"vat" finds Accounting AND Setup', found('vat'), ['Accounting', 'Setup'])
check('a miss finds nothing', found('zzzzz'), [])
check('the match is scoped to the subtree', subpageMatches('/reports', 'tender'), false)
check('an empty term matches nothing', subpageMatches('/setup', '   '), false)

console.log('\nCapabilities gate the entry')
const shows = (granted: string[]) =>
  navFor((c) => granted.includes(c)).some((s) => s.label === 'Setup')
check('setup.view is enough', shows(['setup.view']), true)
check('an unrelated capability is not', shows(['sales.view']), false)

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nALL PASS\n')
process.exit(failures ? 1 : 0)
