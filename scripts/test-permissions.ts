/**
 * Permission enforcement — is the roles screen telling the truth?
 *
 *   npm run test:permissions
 *
 * A permission system that only filters the menu is worse than none: it LOOKS
 * like it is protecting you. These checks are structural rather than
 * behavioural — they read the route files and assert that every page, server
 * action and API route consults a capability, because the alternative is
 * signing in as forty different roles and typing URLs.
 *
 * The behavioural half — that `can()` returns false and the guard then fires —
 * is covered by test-users-pins.ts.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP = path.join(ROOT, 'src', 'app')

let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

/** Every file under `dir` matching `match`, recursively. */
async function walk(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/')

/** Anything that consults a capability, however it is spelled. */
const GUARD =
  /requireCapability|requireAnyCapability|actorFor|actorForOrThrow|siteIdForCapability|can\(\s*(capabilities|ctx\.capabilities)/

/**
 * Pages that are deliberately open.
 *
 * /not-allowed is where every refused guard redirects TO — guarding it would
 * bounce a user between two pages forever.
 */
const OPEN_PAGES = new Set([
  'src/app/(app)/not-allowed/page.tsx',
  /* Own account only: /security reads and writes the VISITOR'S cp2_user_totp
     row via requireSession, never anybody else's. A capability here would let
     an owner forbid people from protecting their own login — backwards. */
  'src/app/(app)/security/page.tsx',
])

/** Action files that guard with requireSession alone, each for the same
    documented own-account reason as its page above. */
const OPEN_ACTIONS = new Set(['src/app/(app)/security/actions.ts'])

/**
 * API routes that are deliberately unauthenticated, each for a documented
 * reason. Listed explicitly so adding a new open route is a decision somebody
 * makes rather than an omission nobody notices.
 */
const OPEN_ROUTES = new Set([
  'src/app/api/health/route.ts', // Electron's startup probe, before any session
  'src/app/api/auth/signout/route.ts', // signing out cannot require being signed in
  'src/app/api/payments/payfast/[token]/route.ts', // PayFast's server-to-server callback
  // Cron's heartbeat for scheduled reports. There is nobody signed in at 07:00,
  // so it proves itself with REPORT_CRON_SECRET compared by timingSafeEqual,
  // and refuses everything when that is unset. A capability check would be the
  // wrong tool — there is no user to have one.
  'src/app/api/reports/schedules/tick/route.ts',
  // Cron's heartbeat for contract billing. Same reasoning as the reports tick:
  // there is nobody signed in at 05:00, so it proves itself with
  // CONTRACT_CRON_SECRET compared by timingSafeEqual and refuses every request
  // when that is unset. Raising invoices is exactly why it is a shared secret
  // rather than nothing — a biller running wide open would let anyone bill
  // every customer in the system.
  'src/app/api/contracts/tick/route.ts',
  /*
   * Three more cron heartbeats, all on the same reasoning as the two above: a scheduled
   * price change, a stale-basket sweep and a storefront publish each run with nobody
   * signed in, so each proves itself with its own *_CRON_SECRET compared by
   * `timingSafeEqual` and refuses every request when that variable is unset.
   *
   * Listed here rather than the check being loosened. Verified individually before adding
   * — a route in this set is one somebody has read, which is the whole point of the set
   * being explicit.
   */
  'src/app/api/pricing/schedules/tick/route.ts',
  'src/app/api/store/baskets/tick/route.ts',
  // The low-stock digest heartbeat — LOW_STOCK_CRON_SECRET, same reasoning.
  'src/app/api/alerts/tick/route.ts',
  'src/app/api/storefront/publish/route.ts',
  'src/app/store-images/[token]/[imageId]/route.ts',
  'src/app/api/store-images/[token]/[imageId]/route.ts', // public storefront asset
  // The shop's OWN pictures — a front-page banner or the masthead logo — for the
  // public storefront. Listed for the same reason as its product-image sibling
  // above: a shopper has no session and must not need one, so the gate is a signed
  // store token plus `storefrontContext` agreeing the shop is open, not a
  // capability. A closed shop or a bad token both 404, indistinguishably.
  'src/app/api/store-images/[token]/shop/[imageId]/route.ts',
])

async function main() {
  /* ── Pages ─────────────────────────────────────────────────────────── */
  console.log('\npages')
  const pages = (await walk(path.join(APP, '(app)'), (n) => n === 'page.tsx')).map(rel)
  const unguardedPages: string[] = []

  for (const p of pages) {
    if (OPEN_PAGES.has(p)) continue
    const src = await readFile(path.join(ROOT, p), 'utf8')
    if (!GUARD.test(src)) unguardedPages.push(p)
  }

  check(
    `every page checks a capability (${pages.length - unguardedPages.length}/${pages.length})`,
    unguardedPages.length === 0,
    unguardedPages.slice(0, 5).join(', '),
  )

  /* ── Server actions ────────────────────────────────────────────────── */
  //
  // The real boundary. A page guard stops someone LOOKING; the action behind
  // it is a public endpoint any client can call directly, so an unguarded
  // action is reachable no matter what the screen shows.
  console.log('\nserver actions')
  const actionFiles = (await walk(path.join(APP, '(app)'), (n) => n.endsWith('.ts'))).map(rel)
  const unguardedActions: string[] = []
  let actionFileCount = 0

  for (const f of actionFiles) {
    if (OPEN_ACTIONS.has(f)) continue
    const src = await readFile(path.join(ROOT, f), 'utf8')
    if (!src.includes("'use server'")) continue
    actionFileCount++
    // A file-level helper (setup/users, commission) counts — what matters is
    // that a capability is consulted, not which spelling was used.
    if (!GUARD.test(src)) unguardedActions.push(f)
  }

  check(
    `every action file checks a capability (${actionFileCount - unguardedActions.length}/${actionFileCount})`,
    unguardedActions.length === 0,
    unguardedActions.slice(0, 5).join(', '),
  )

  /* ── API routes ────────────────────────────────────────────────────── */
  //
  // Sharpest of the three: api/ is outside the (app) route group, so the
  // layout never runs, and these URLs are directly typeable. An unguarded
  // export route hands over the whole customer base.
  console.log('\napi routes')
  const routes = (await walk(path.join(APP, 'api'), (n) => n === 'route.ts')).map(rel)
  const unguardedRoutes: string[] = []

  for (const r of routes) {
    if (OPEN_ROUTES.has(r)) continue
    const src = await readFile(path.join(ROOT, r), 'utf8')
    if (!GUARD.test(src)) unguardedRoutes.push(r)
  }

  check(
    `every non-public api route checks a capability (${routes.length - OPEN_ROUTES.size - unguardedRoutes.length} of ${routes.length - OPEN_ROUTES.size})`,
    unguardedRoutes.length === 0,
    unguardedRoutes.slice(0, 5).join(', '),
  )

  /* ── The old role must be gone ─────────────────────────────────────── */
  //
  // `cp2_user_sites.site_role` decided permissions before 041. Anything still
  // reading it is enforcing the control panel's three-value role rather than
  // the store's own, which both refuses people who were granted access and
  // admits people who were not.
  console.log('\nno stale role checks')
  const everything = [
    ...(await walk(path.join(APP, '(app)'), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))),
    ...(await walk(path.join(APP, 'api'), (n) => n.endsWith('.ts'))),
  ].map(rel)

  const stale: string[] = []
  for (const f of everything) {
    const src = await readFile(path.join(ROOT, f), 'utf8')
    // Comments explaining the migration are fine; a live comparison is not.
    for (const line of src.split('\n')) {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/(site|ctx\.site)\.role\s*[=!]==/.test(code)) {
        stale.push(`${f}: ${line.trim().slice(0, 70)}`)
        break
      }
    }
  }
  check('nothing decides access from the control-panel role', stale.length === 0, stale.slice(0, 3).join(' | '))

  /* ── Capabilities are real ─────────────────────────────────────────── */
  //
  // A guard naming a capability that does not exist is deny-by-default
  // forever: nobody can be granted it, so the screen is unreachable for
  // everyone including an owner — who passes only because owners bypass.
  console.log('\ncapabilities exist')
  const permissionsSrc = await readFile(
    path.join(ROOT, 'src', 'lib', 'site', 'permissions.ts'),
    'utf8',
  )
  const declared = new Set(
    [...permissionsSrc.matchAll(/\{\s*key:\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]),
  )
  check(`permissions.ts declares capabilities`, declared.size > 20, `${declared.size} found`)

  // Wider than `everything`: a capability can legitimately be enforced deep in
  // a library rather than at the entry point — `sales.edit_finalised` is
  // checked inside salesEdit.ts, because the correction path is reached from
  // several callers and guarding each one would be the easy thing to forget.
  // Scanning only pages/actions/routes reported it as an unenforced gap.
  const guardSites = [
    ...everything,
    ...(await walk(path.join(ROOT, 'src', 'lib'), (n) => n.endsWith('.ts'))).map(rel),
  ]

  const used = new Set<string>()
  for (const f of guardSites) {
    const src = await readFile(path.join(ROOT, f), 'utf8')
    for (const m of src.matchAll(
      /(?:requireCapability|actorFor|actorForOrThrow|siteIdForCapability)\(\s*'([a-z_]+\.[a-z_]+)'/g,
    )) {
      used.add(m[1])
    }
    for (const m of src.matchAll(/can\(\s*(?:ctx\.)?capabilities,\s*'([a-z_]+\.[a-z_]+)'/g)) {
      used.add(m[1])
    }
  }

  const unknown = [...used].filter((c) => !declared.has(c))
  check('every guard names a real capability', unknown.length === 0, unknown.join(', '))

  console.log(`\n${used.size} of ${declared.size} capabilities are enforced somewhere`)
  const unenforced = [...declared].filter((c) => !used.has(c))
  if (unenforced.length) {
    console.log(`not yet enforced: ${unenforced.join(', ')}`)
  }

  /* ── The nav promise ───────────────────────────────────────────────── */
  //
  // Every capability the sidebar filters on must be one the pages actually
  // enforce, or the menu is making a promise the app does not keep.
  console.log('\nnav matches enforcement')
  const navSrc = await readFile(path.join(ROOT, 'src', 'lib', 'nav.ts'), 'utf8')
  const navCaps = new Set(
    [...navSrc.matchAll(/capability:\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]),
  )
  const navUnknown = [...navCaps].filter((c) => !declared.has(c))
  check('every nav capability is declared', navUnknown.length === 0, navUnknown.join(', '))

  /* ── Setup labels ──────────────────────────────────────────────────────
     The Setup hub's tiles take their name from SUBPAGE_LABELS while the sidebar
     takes its own from NAV. Both lists exist on purpose — the hub needs literal
     keys so a tile pointing nowhere is a compile error — so the risk is drift,
     and a screen renamed in one place would be called two different things.

     THE HUB, NOT THE SIDEBAR, IS THE SET TO CHECK AGAINST. Setup used to be a
     sidebar group listing every screen, so "a label with no menu item" meant an
     unreachable screen. It is now one link to /setup, and the catalogue there is
     what makes a screen reachable — so a label whose href is absent from the
     SIDEBAR is normal, while one absent from the CATALOGUE is the real orphan.
     Checking the sidebar reported all fourteen hub screens as dropped.

     Read as SOURCE, not imported, for the same reason the capability scan above
     is: nav.ts pulls in lucide-react, which needs a React runtime this test has
     no business booting. */
  const setupItems = [
    ...navSrc.matchAll(/label:\s*'([^']+)',\s*href:\s*'(\/setup\/[a-z-]+)'/g),
  ].map((m) => ({ label: m[1].replace(/\\'/g, "'"), href: m[2] }))
  const labelBlock = navSrc.match(/export const SUBPAGE_LABELS = \{([\s\S]*?)\n\} as const/)
  const declaredLabels = new Map(
    [...(labelBlock?.[1] ?? '').matchAll(/'(\/setup\/[a-z-]+)':\s*'([^']+)'/g)].map((m) => [
      m[1],
      m[2].replace(/\\'/g, "'"),
    ]),
  )

  check('SUBPAGE_LABELS was found and parsed', declaredLabels.size > 0, `${declaredLabels.size} entries`)
  check(
    'every Setup menu item has a label entry',
    setupItems.every((i) => declaredLabels.has(i.href)),
    setupItems.filter((i) => !declaredLabels.has(i.href)).map((i) => i.href).join(', '),
  )

  const drift = setupItems.filter(
    (i) => declaredLabels.has(i.href) && declaredLabels.get(i.href) !== i.label,
  )
  check(
    'the Setup menu and the Setup hub agree on every screen name',
    drift.length === 0,
    drift.map((i) => `${i.href}: menu "${i.label}" vs hub "${declaredLabels.get(i.href)}"`).join('; '),
  )

  const catalogueSrc = await readFile(
    path.join(ROOT, 'src', 'app', '(app)', 'setup', 'catalogue.ts'),
    'utf8',
  )
  const catalogueHrefs = new Set(
    [...catalogueSrc.matchAll(/href:\s*'(\/setup\/[a-z-]+)'/g)].map((m) => m[1]),
  )
  check('the Setup catalogue was found and parsed', catalogueHrefs.size > 0, `${catalogueHrefs.size} tiles`)

  // Every tile resolves its name through SUBPAGE_LABELS, so a tile with no
  // label entry renders nameless.
  const unnamed = [...catalogueHrefs].filter((href) => !declaredLabels.has(href))
  check('every Setup hub tile has a label entry', unnamed.length === 0, unnamed.join(', '))

  // And the reverse: a label for a screen no longer on the hub is dead weight,
  // and points at a screen nothing links to.
  const orphans = [...declaredLabels.keys()].filter((href) => !catalogueHrefs.has(href))
  check('no label entry points at a screen the hub has dropped', orphans.length === 0, orphans.join(', '))
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
    process.exit(failures ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
