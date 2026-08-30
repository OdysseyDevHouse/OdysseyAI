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

let warnings = 0

/**
 * A real finding that is not yet a broken promise.
 *
 * Used for the missing anchors below. They are the same CLASS of defect as the
 * bug this file was extended for — a hit that lands on a screen rather than on
 * a setting — but every one of them still opens the right screen, so failing
 * the suite over them would block unrelated work and teach the next person to
 * reach for --force. They are printed every run instead, with a count, so the
 * list cannot quietly grow while nobody is looking.
 */
function warn(what: string, ok: boolean, detail = '') {
  if (!ok) warnings++
  if (!ok) console.log(`WARN  ${what}${detail ? `  (${detail})` : ''}`)
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

/**
 * The same directory, minus the files that are not the screen.
 *
 * `sourceFor` reads everything on purpose — an anchor may be rendered anywhere,
 * so for THAT question a wide net is right. Counting panels is the opposite
 * question and a wide net is wrong: `loading.tsx` mirrors the screen in
 * skeletons, and a modal is a Card somebody has to open rather than one they
 * scan past. Counting either turned a one-panel screen (Users, which is a
 * single table plus its edit dialog) into a four-panel one and warned about a
 * setting nobody could miss.
 */
function panelSourceFor(href: string): string {
  const dir = join(ROOT, 'src', 'app', '(app)', href.replace(/^\//, ''))
  if (!existsSync(dir)) return ''

  let combined = ''
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tsx')) continue
    if (entry === 'loading.tsx' || entry.endsWith('Modal.tsx')) continue
    const path = join(dir, entry)
    if (statSync(path).isFile()) combined += readFileSync(path, 'utf8')
  }
  return combined
}

const sources = new Map<string, string>()
const panelSources = new Map<string, string>()

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

/* ── 2b. a setting on a crowded screen carries an anchor ──────────────────── */

/**
 * The reported bug: "Rounding" pointed at /setup/pricing, and cash rounding is
 * on /setup/numbering. Every check above passed — the route was real, the
 * ranking put it first, the link opened a working screen. Only the destination
 * was wrong, and nothing structural could see it, because "is this setting on
 * this screen" is a question about meaning.
 *
 * What made it undetectable was the MISSING ANCHOR. An anchored entry names an
 * id, §2 above demands that the named screen renders that id, and the two
 * together pin an entry to a specific panel rather than a whole page — so the
 * same mistake made today fails there instead of shipping. Re-pointing the
 * fixed entry back at /setup/pricing was tried, and §2 does now catch it.
 *
 * Hence this: on a screen with several cards, an anchor is not decoration. It
 * is what makes the entry checkable at all, and what stops a hit landing on a
 * screen of ten panels with no clue which one was meant. Screens with a single
 * card are exempt — landing on them IS landing on the setting, which is the
 * rule settingSearch.ts states for omitting an anchor.
 *
 * A word-matching check was tried here first and removed: the index is written
 * in the words somebody TYPES rather than the words on the screen, and screens
 * that render rows from a lib file (roles, from CAPABILITY_GROUPS) carry none
 * of their setting names in their own source. It failed five honest entries and
 * caught nothing this does not.
 */
for (const setting of SETTINGS) {
  if (setting.anchor) continue

  if (!panelSources.has(setting.href)) {
    panelSources.set(setting.href, panelSourceFor(setting.href))
  }
  const source = panelSources.get(setting.href) ?? ''
  if (!source) continue

  /* Cards are the unit a reader scans and the unit SettingAnchor flashes, so
     counting them is the closest cheap measure of "could somebody tell which
     panel was meant". */
  const cards = source.match(/<Card[\s>]/g)?.length ?? 0

  warn(
    `no anchor: "${setting.label}" on ${setting.href}`,
    cards <= 1,
    `${cards} cards on that screen — the hit lands on the page, not the setting`,
  )
}

/* ── 2c. no setting restates the name of its own screen ───────────────────── */

/**
 * "Trading hours" was indexed as a setting on /online-store/trading — a screen
 * whose own name is "Trading hours". The palette therefore offered two rows
 * reading the same words, and because a screen deliberately outranks a setting
 * on an equal score, the one somebody clicked was the screen: the anchored
 * entry could never win, and its flash never fired. Every check in this file
 * passed throughout, and only driving the real palette showed the two rows.
 *
 * The rule it broke is the one settingSearch.ts states at the top — a screen
 * whose whole job is one thing is already findable as a screen, and repeating
 * it here just prints the same row twice under two headings.
 */
for (const setting of SETTINGS) {
  const screen = SUBPAGE_LABELS[setting.href]
  if (!screen) continue

  const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  check(
    `not a restatement of its screen: "${setting.label}"`,
    normalise(setting.label) !== normalise(screen),
    `the screen at ${setting.href} is itself called "${screen}" — two rows, same words, and the screen wins`,
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
  /* Reported: "rounding" returned this row pointing at Price types & VAT, which
     is where it READS as belonging and not where it is built. The link 200s and
     the screen renders, so nothing above catches it — only the destination is
     wrong, and it is wrong in the most convincing way possible. */
  ['rounding', 'Cash rounding'],
  ['round', 'Cash rounding'],
  ['5c', 'Cash rounding'],
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

if (warnings > 0) {
  console.log(
    `${warnings} settings land on a screen rather than on themselves — see the WARN lines above.`,
  )
}
process.exit(failures === 0 ? 0 : 1)
