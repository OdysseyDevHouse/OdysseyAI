/**
 * The system-settings shell — that every tab has a panel, and that nothing
 * still points at a setup screen its settings have left.
 *
 *   npx tsx scripts/test-settings-tabs.ts
 *
 * No --conditions=react-server and no --env-file, for the same reason as
 * test-setting-search: this reads source files and pure data, never the
 * database, and the react-server condition resolves a lucide-react without
 * createContext that the nav's icons import at module load.
 *
 * ── WHAT ROTS HERE ────────────────────────────────────────────────────────
 *
 * /settings is a SHELL: its tabs are panels on one route rather than routes of
 * their own. That buys a settings screen with no page loads between tabs, and
 * it costs the two guarantees the router would otherwise give for free.
 *
 *   · A TAB WITH NO PANEL. The catalogue lists a category, `PANELS` has no
 *     entry for its key, and the tab opens on an apology. Nothing about that is
 *     a compile error — the lookup is by string — so it is checked here.
 *
 *   · A SETTING THAT MOVED BUT LEFT ITS SIGNPOSTS. Every setting arriving in
 *     /settings comes OUT of a /setup screen that is then deleted. Anything
 *     still naming that route — a hub tile, a SUBPAGE_LABELS entry, a
 *     revalidatePath — is a link to a 404 or a cache invalidation that silently
 *     stops working. The router will not say so, because a deleted route is not
 *     a compile error anywhere that references it as a string.
 *
 * The second is the one worth having: a moved setting is a nine-item job in
 * this codebase, and the references are scattered across nav, catalogues,
 * onboarding and server actions.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_CATEGORIES } from '../src/app/(app)/settings/catalogue'

const ROOT = join(import.meta.dirname, '..')
const APP = join(ROOT, 'src', 'app', '(app)')

let failures = 0

function check(what: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : `  (${detail})`}`)
}

/* ── 1. every tab has a panel ─────────────────────────────────────────────── */

/**
 * The keys `PANELS` maps, read from the shell's source.
 *
 * Read as TEXT rather than imported, because SettingsHome is a client component
 * whose import graph pulls in the whole UI kit and every panel — none of which
 * this check needs, and some of which will not resolve outside a bundler.
 */
const shell = readFileSync(join(APP, 'settings', 'SettingsHome.tsx'), 'utf8')
/* `[\s\S]*?` rather than `[^=]*` across the type annotation: the declared type
   is `Record<string, () => ReactElement>`, whose arrow contains the very `=`
   an [^=] class stops at — so the stricter-looking pattern matched nothing. */
const panelsBlock = shell.match(/const PANELS[\s\S]*?=\s*\{([\s\S]*?)^\}/m)?.[1] ?? ''
const panelKeys = new Set(
  [...panelsBlock.matchAll(/^\s*([A-Za-z0-9_'"-]+)\s*:/gm)].map((m) => m[1].replace(/['"]/g, '')),
)

check('the shell declares a PANELS map', panelsBlock !== '', 'no `const PANELS = { … }` found')

for (const category of SETTINGS_CATEGORIES) {
  check(`tab has a panel: ${category.key}`, panelKeys.has(category.key), 'no entry in PANELS')
}

for (const key of panelKeys) {
  check(
    `panel has a tab: ${key}`,
    SETTINGS_CATEGORIES.some((c) => c.key === key),
    'in PANELS but not in the catalogue — an unreachable panel',
  )
}

/* ── 2. the catalogue is well formed ──────────────────────────────────────── */

const keys = SETTINGS_CATEGORIES.map((c) => c.key)
check('every tab key is unique', new Set(keys).size === keys.length, keys.join(', '))
check(
  'every tab carries both lines',
  SETTINGS_CATEGORIES.every((c) => c.label && c.blurb && c.description && c.keywords),
  'a blank label, blurb, description or keywords',
)

/* ── 3. nothing still points at a setup screen that has moved ─────────────── */

/**
 * The /setup routes that used to hold settings now living in /settings.
 *
 * Add a line here as each screen is retired. The check is the point of the
 * list: a route in this table must be gone from disk AND unreferenced, which
 * together are what "moved" means as opposed to "copied".
 */
const RETIRED: Record<string, string> = {
  '/setup/purchasing': 'Purchasing and cost',
  '/setup/tips': 'Hospitality',
  '/setup/cashup': 'Cash up',
  '/setup/stock-takes': 'Stock takes',
  '/setup/stock-tracking': 'Stock tracking',
  '/setup/reservations': 'Online bookings',
  '/setup/api': 'System',
  /* NOT '/setup/terminals'. That was a PARTIAL move: seven behaviour panels
     went to the Till tab and the screen itself stays, still listing the
     registers and their licences. A route only belongs in this table when its
     page is gone. */
}

/** Every source file, so a stale reference cannot hide in one not thought of. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      sources(path, found)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

const files = sources(join(ROOT, 'src'))

for (const [route, tab] of Object.entries(RETIRED)) {
  check(
    `route is gone from disk: ${route}`,
    !existsSync(join(APP, route.replace(/^\//, ''), 'page.tsx')),
    `page.tsx still exists — the settings were copied to "${tab}", not moved`,
  )

  const referrers = files.filter((file) => {
    /* Comments stripped FIRST. A retired route is normally left named in a
       comment where it used to be declared — that breadcrumb is how the next
       person finds where a setting went, and failing the suite over it would
       teach people to delete the one thing making the move legible. Only live
       code counts as a reference. */
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    return code.includes(`'${route}'`) || code.includes(`"${route}"`)
  })

  check(
    `nothing references it: ${route}`,
    referrers.length === 0,
    referrers.map((f) => f.replace(ROOT + '\\', '').replace(ROOT + '/', '')).join(', '),
  )
}

console.log(
  failures === 0
    ? `\nAll good — ${SETTINGS_CATEGORIES.length} tab(s), ${Object.keys(RETIRED).length} retired route(s).`
    : `\n${failures} check(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
