// Why a term ranks the way it does in the global search palette.
//
//   npx tsx scripts/probe-page-score.ts register
//
// Prints every page that scores on a term, with the tier and the fields that
// earned it — so a surprising first result can be explained rather than guessed
// at. The lucide stub is the same one test-navigation.ts uses and for the same
// reason: nav.ts hangs an icon component off every entry.
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const Mod = nodeRequire('node:module') as { _load: (...a: unknown[]) => unknown }
const realLoad = Mod._load
Mod._load = function (request: unknown, ...rest: unknown[]) {
  if (request === 'lucide-react') {
    return new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) })
  }
  return realLoad.call(this, request, ...rest)
}

const { navFor } = nodeRequire('../src/lib/nav') as typeof import('../src/lib/nav')
const { buildPageIndex, scorePage, searchPages } = nodeRequire(
  '../src/lib/pageSearch',
) as typeof import('../src/lib/pageSearch')

const term = (process.argv[2] ?? 'register').toLowerCase()
const index = buildPageIndex(navFor(() => true))

console.log(`\nscoring "${term}"\n`)
const scored = index
  .map((hit) => ({ hit, score: scorePage(hit, term) }))
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score || a.hit.label.localeCompare(b.hit.label))

for (const { hit, score } of scored) {
  console.log(`  ${score}  ${hit.label}`)
  console.log(`       group: ${hit.group}`)
  console.log(`       kw:    ${hit.keywords || '—'}`)
  console.log(`       desc:  ${hit.description || '—'}`)
}

console.log('\nranked result:', searchPages(index, term).map((h) => h.label).join(', ') || '(none)')
console.log()
