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
const OPEN_PAGES = new Set(['src/app/(app)/not-allowed/page.tsx'])

/**
 * API routes that are deliberately unauthenticated, each for a documented
 * reason. Listed explicitly so adding a new open route is a decision somebody
 * makes rather than an omission nobody notices.
 */
const OPEN_ROUTES = new Set([
  'src/app/api/health/route.ts', // Electron's startup probe, before any session
  'src/app/api/auth/signout/route.ts', // signing out cannot require being signed in
  'src/app/api/payments/payfast/[token]/route.ts', // PayFast's server-to-server callback
  'src/app/store-images/[token]/[imageId]/route.ts',
  'src/app/api/store-images/[token]/[imageId]/route.ts', // public storefront asset
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

  const used = new Set<string>()
  for (const f of everything) {
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
