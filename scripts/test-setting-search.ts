/**
 * The settings index behind the global search — that it points at real things,
 * and that it actually finds them.
 *
 *   npx tsx scripts/test-setting-search.ts
 *
 * No --conditions=react-server and no --env-file, unlike most suites here: this
 * one reads source files and pure data, never the database — and the react-server
 * condition resolves a lucide-react that has no createContext, which the nav's
 * icons import at module load.
 *
 * `SETTINGS` in src/lib/settingSearch.ts is a HAND-WRITTEN list of the settings
 * inside the setup screens, and hand-written lists rot in two directions. Both
 * are silent, which is why they are checked here rather than left to be noticed:
 *
 *   · A ROUTE goes stale. A screen is renamed or moved, the entry still names
 *     the old path, and the palette offers a result that 404s — worse than not
 *     finding the setting at all, which is the state this feature was built to
 *     fix.
 *
 *   · An ANCHOR goes stale. A panel is refactored and loses its `id`, so the
 *     hit still lands on the right screen but the flash never fires and
 *     somebody is back to reading ten headings. Nothing about that failure is
 *     visible from the code: the search works, the link works, and only the
 *     part that made it worth building is gone. The anchors are checked against
 *     the SOURCE of the screens rather than a rendered page, so this needs no
 *     database, no server and no browser.
 *
 * The search assertions at the end are the actual user-facing promise: the term
 * somebody types has to return the setting they meant, ABOVE the screen it
 * lives on. Those are pinned to the real reported case ("auto logout") plus the
 * phrasings around it, because a ranking change that quietly drops them is the
 * regression that matters here.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS, settingHref } from '../src/lib/settingSearch'
import { SUBPAGE_LABELS } from '../src/lib/nav'
import { buildPageIndex, searchPages } from '../src/lib/pageSearch'
import { NAV } from '../src/lib/nav'

const ROOT = join(import.meta.dirname, '..')

let failures = 0

function check(what: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : `  (${detail})`}`)
}

/* ── 1. every route is a screen that exists ───────────────────────────────── */

for (const setting of SETTINGS) {
  check(
    `route exists: ${setting.href}`,
    setting.href in SUBPAGE_LABELS,
    'not a key of SUBPAGE_LABELS — renamed or moved?',
  )
}

/* ── 2. every anchor is an id some screen actually renders ────────────────── */

/**
 * The source of a route's screen, as one string.
 *
 * A route maps to a directory, and the panel carrying the anchor is usually a
 * SIBLING component rather than page.tsx itself — SignOutPanel.tsx holds
 * `id="idle-logout"`, not the page that renders it. So the whole directory is
 * read and searched, which is what a person would do to answer the same
 * question.
 */
function sourceFor(href: string): string {
  const dir = join(ROOT, 'src', 'app', '(app)', href.replace(/^\//, ''))
  if (!existsSync(dir)) return ''

  let combined = ''
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isFile() && entry.endsWith('.tsx')) {
      combined += readFileSync(path, 'utf8')
    }
  }
  return combined
}

const sources = new Map<string, string>()

for (const setting of SETTINGS) {
  if (!setting.anchor) continue

  if (!sources.has(setting.href)) sources.set(setting.href, sourceFor(setting.href))
  const source = sources.get(setting.href) ?? ''

  check(
    `anchor rendered: ${setting.href}#${setting.anchor}`,
    source.includes(`id="${setting.anchor}"`),
    'no element on that screen carries the id — the flash will never fire',
  )
}

/* ── 3. the terms people type find the settings they mean ─────────────────── */

/* The full index, built as an owner who can see everything — the question here
   is whether the RANKING works, not whether the capability gate does. */
const index = buildPageIndex(NAV)

/**
 * What the palette would show for a term, best first.
 *
 * `searchPages` is the same function the palette calls, so this asserts against
 * the real ranking rather than a re-implementation of it — the mistake the
 * memory note about scratch mirrors of the logic warns against.
 */
function top(term: string, n = 5): string[] {
  return searchPages(index, term, n).map((hit) => hit.label)
}

/* The reported case, in the words it was reported in, plus the phrasings
   somebody reaches for when the first one fails them. */
const IDLE = 'Automatically log out after being idle'
const WANTED: [string, string][] = [
  ['auto logout', IDLE],
  ['automatic logout', IDLE],
  ['auto log out', IDLE],
  ['idle', IDLE],
  ['inactivity', IDLE],
  ['timeout', IDLE],
  ['lock screen', IDLE],
  ['sign out', IDLE],
  /* A few neighbours, so this is a test of the INDEX and not of one lucky row. */
  ['cash drawer', 'Cash drawer kick'],
  ['vat rate', 'VAT rate'],
  ['clock in', 'Force clock in before selling'],
  ['below cost', 'Selling below cost'],
  ['smtp', 'Outgoing email server'],
]

for (const [term, want] of WANTED) {
  const results = top(term)
  check(
    `"${term}" finds "${want}"`,
    results.includes(want),
    `got ${JSON.stringify(results)}`,
  )
}

/* And the sharper promise: for the term that started this, the SETTING must
   outrank the screen it lives on. Finding it somewhere on the list is not the
   same as finding it — a result below "Tills" is one somebody scrolls past. */
const first = top('auto logout')[0]
check(
  '"auto logout" puts the setting first',
  first === IDLE,
  `first result was ${JSON.stringify(first)}`,
)

/* ── 4. a setting's link is the screen plus its anchor ────────────────────── */

for (const setting of SETTINGS) {
  const href = settingHref(setting)
  check(
    `href well formed: ${href}`,
    setting.anchor ? href === `${setting.href}#${setting.anchor}` : href === setting.href,
  )
}

console.log(
  failures === 0
    ? `\nAll good — ${SETTINGS.length} settings indexed.`
    : `\n${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
