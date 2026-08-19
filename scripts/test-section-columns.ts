/**
 * The columns block: one level deep, and the caps that keep it there.
 *
 * ── WHAT THIS IS GUARDING ────────────────────────────────────────────────
 *
 * The documented refusal in `page-builder-next.md` was of RECURSIVE containers
 * — a tree of unbounded depth, undraggable, un-diffable and uncappable. This
 * block is the non-recursive version, and every assertion here is about the
 * line between the two. If a column can hold a column, all of that reasoning
 * comes back, and it comes back on a live shop rather than in a review.
 *
 *   npm run test:section-columns
 */
import {
  MAX_SECTIONS,
  describeLayoutChanges,
  flattenSections,
  normaliseSections,
  pageWarnings,
} from '../src/lib/storefrontModel'
import {
  COLUMN_CHILD_KINDS,
  MAX_COLUMN_CHILDREN,
  SECTION_CATALOG,
  SECTION_KINDS,
  kindsFor,
} from '../src/lib/storefront/catalog'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const text = (id: string) => ({ id, kind: 'text', title: '', text: 'x' })
const columns = (children: unknown[][], extra: Record<string, unknown> = {}) => ({
  id: 'c',
  kind: 'columns',
  title: '',
  columnCount: children.length,
  columns: children,
  ...extra,
})

console.log('\n— A column cannot hold a column —')
{
  /*
   * The depth rule, and the whole reason this block is safe to have. Checked
   * BEFORE anything recurses, so there is no counter to get wrong and no
   * payload shape that reaches a third level.
   */
  const nested = normaliseSections([columns([[columns([[text('deep')]])], []])])
  const kept = nested[0]?.columns?.[0] ?? []
  ok('the outer one survives', nested[0]?.kind === 'columns')
  ok('the inner one does not', !kept.some((c) => c.kind === 'columns'), kept.map((c) => c.kind).join(','))
  ok('and takes its contents with it', kept.length === 0, String(kept.length))
  ok('columns is not a legal child kind', !COLUMN_CHILD_KINDS.includes('columns' as never))
}

console.log('\n— A whitelist, not everything-minus-columns —')
{
  const mixed = normaliseSections([
    columns([
      [
        text('ok'),
        { id: 'x1', kind: 'carousel', title: '' },
        { id: 'x2', kind: 'categories', title: '' },
        { id: 'x3', kind: 'hero', title: '' },
      ],
      [],
    ]),
  ])
  const kinds = (mixed[0]?.columns?.[0] ?? []).map((c) => c.kind)
  /*
   * A carousel in a third of a column looks fine in the builder and reads as
   * broken on a phone; a department grid inside a column is a second front
   * page. Same judgement `kindsFor` makes for a product page.
   */
  ok('a plain section is kept', kinds.includes('text'))
  ok('a carousel is refused', !kinds.includes('carousel'))
  ok('a department grid is refused', !kinds.includes('categories'))
  ok('the welcome banner is refused', !kinds.includes('hero'))
  ok('every whitelisted kind is a real kind', COLUMN_CHILD_KINDS.every((k) => SECTION_KINDS.includes(k)))
}

console.log('\n— One budget for the whole page —')
{
  /*
   * MAX_SECTIONS has to bound the PAGE. A per-level cap would admit
   * 20 columns x 3 x 4 = 240 sections and satisfy every check on the way in,
   * which is the failure this block would otherwise introduce.
   */
  const huge = Array.from({ length: MAX_SECTIONS }, (_, i) =>
    columns([
      Array.from({ length: 10 }, (_, j) => text(`a${i}-${j}`)),
      Array.from({ length: 10 }, (_, j) => text(`b${i}-${j}`)),
      Array.from({ length: 10 }, (_, j) => text(`c${i}-${j}`)),
    ]),
  )
  const out = normaliseSections(huge)
  const total = out.reduce(
    (n, s) => n + 1 + (s.columns ?? []).reduce((m, c) => m + c.length, 0),
    0,
  )
  ok('children count against the page cap', total <= MAX_SECTIONS, `${total} of ${MAX_SECTIONS}`)

  const many = normaliseSections([
    columns([Array.from({ length: 12 }, (_, i) => text(`t${i}`)), []]),
  ])
  ok(
    'and one column holds at most its own cap',
    (many[0]?.columns?.[0] ?? []).length === MAX_COLUMN_CHILDREN,
    String((many[0]?.columns?.[0] ?? []).length),
  )
}

console.log('\n— The stored shape agrees with itself —')
{
  /*
   * `columnCount` is authoritative. A stored layout can disagree with itself —
   * somebody set three, filled them, went back to two — and the renderer maps
   * over what is there, so a mismatch would be a column that exists in the data
   * and not on the page.
   */
  const grown = normaliseSections([
    { id: 'c', kind: 'columns', title: '', columnCount: 3, columns: [[], []] },
  ])
  ok('too few columns are padded', grown[0]?.columns?.length === 3, String(grown[0]?.columns?.length))

  const shrunk = normaliseSections([
    { id: 'c', kind: 'columns', title: '', columnCount: 2, columns: [[], [], []] },
  ])
  ok('too many are trimmed', shrunk[0]?.columns?.length === 2, String(shrunk[0]?.columns?.length))

  const junk = normaliseSections([
    { id: 'c', kind: 'columns', title: '', columnCount: 99, columns: 'nope' },
  ])
  ok('an absurd count clamps', junk[0]?.columnCount === 3, String(junk[0]?.columnCount))
  ok('and a non-array becomes empty columns', Array.isArray(junk[0]?.columns), JSON.stringify(junk[0]?.columns))
}

console.log('\n— Ids stay globally unique —')
{
  /*
   * Across columns, not per column. Two sections sharing an id share a React
   * key and a drag handle, and the drag layer, the publish diff and version
   * history all key on it — which is exactly why they keep working on a child
   * without knowing columns exist.
   */
  const dupes = normaliseSections([
    columns([[text('same')], [text('same')]]),
    { ...columns([[text('same')], []]), id: 'c2' },
  ])
  const ids = dupes.flatMap((s) => [s.id, ...(s.columns ?? []).flatMap((c) => c.map((x) => x.id))])
  ok('every id is distinct', new Set(ids).size === ids.length, ids.join(','))
}

console.log('\n— A child is an ordinary section —')
{
  const styled = normaliseSections([
    columns([[{ ...text('t'), background: 'tinted', padding: 'loose', showFrom: '2026-01-01' }], []]),
  ])
  const child = styled[0]?.columns?.[0]?.[0]
  // Its own band, its own schedule. That is what keeps every other feature
  // working on it without being told about columns.
  ok('a child keeps its own band', child?.background === 'tinted', child?.background)
  ok('and its own schedule', child?.showFrom === '2026-01-01', child?.showFrom)
}

console.log('\n— Everything that walks a page walks into columns —')
{
  /*
   * Both of these were WRONG when the block first landed, and both are silent.
   * A publish warning that skips a column lets an undescribed picture onto a
   * shop; a change summary that skips one reports a page as unedited when the
   * owner had just been working inside it.
   */
  const before = normaliseSections([
    columns([[{ id: 'b', kind: 'banner', title: '', imageId: 7, imageAlt: '' }], []]),
  ])
  ok('a warning sees inside a column', pageWarnings(before).length === 1, JSON.stringify(pageWarnings(before)))

  const after = normaliseSections([
    columns([[{ id: 'b', kind: 'banner', title: '', imageId: 7, imageAlt: 'described now' }], []]),
  ])
  const diff = describeLayoutChanges(before, after)
  ok(
    'and the change summary does too',
    diff.some((c) => c.detail?.includes('picture description')),
    JSON.stringify(diff),
  )

  const flat = flattenSections(before)
  ok(
    'flattenSections returns the parent and its children',
    flat.length === 2 && flat[0].kind === 'columns' && flat[1].kind === 'banner',
    flat.map((s) => s.kind).join(','),
  )
}

console.log('\n— Where it may be added —')
{
  ok('offered on the front page', kindsFor('home').includes('columns'))
  ok('offered on a standard page', kindsFor('standard').includes('columns'))
  // A product page's sections sit under one product in a narrow column;
  // splitting that into thirds is a row nobody can read.
  ok('not offered on a product page', !kindsFor('product').includes('columns'))
  ok('the catalog knows the kind', !!SECTION_CATALOG.columns)

  const started = SECTION_CATALOG.columns.defaults({
    slide: () => ({}) as never,
    quote: () => ({}) as never,
  })
  ok('and it starts with two empty columns', JSON.stringify(started.columns) === '[[],[]]')
}

console.log(fails ? `\n${fails} FAILED.` : '\nAll column checks passed.')
process.exit(fails ? 1 : 0)
