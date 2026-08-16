/**
 * Where the catalogue pane thinks the cashier is standing — pure, no database.
 *
 *   npx tsx scripts/test-catalog-drill.ts
 *
 * The trail is the one bit of till state a cashier can SEE going wrong: it is
 * printed across the top of the pane as a breadcrumb. The bug these cover was
 * exactly that — tapping one rail department a few times built
 * "Wood-Fired Pizza › Wood-Fired Pizza › Wood-Fired Pizza › …" over three lines,
 * because every DRILL appended regardless of where it came from or what was
 * already there.
 *
 * Value-in value-out, so it runs with no connection.
 */
import { saleReducer, initialSaleState, type SaleState } from '../src/app/(pos)/pos/useSaleState'

const path = (s: SaleState) => (s.catalog.kind === 'departments' ? s.catalog.path : [])

let fails = 0
function ok(label: string, cond: boolean, saw?: unknown) {
  if (cond) {
    console.log('  ok   ' + label)
  } else {
    console.log('  FAIL ' + label + (saw === undefined ? '' : ' -> saw ' + JSON.stringify(saw)))
    fails++
  }
}

console.log('catalogue drill')

/* The reported bug, in its original shape. */
let s: SaleState = initialSaleState
for (let i = 0; i < 5; i++) s = saleReducer(s, { type: 'DRILL', departmentId: 7, root: true })
ok('five rail taps on one department leave a single crumb', path(s).length === 1, path(s))

/* The rail lists top-level departments, so picking one is a change of place
   rather than a step deeper. */
s = saleReducer(s, { type: 'DRILL', departmentId: 9, root: true })
ok('a different rail department replaces the trail', JSON.stringify(path(s)) === '[9]', path(s))

/* Nesting still has to work, or the trail has nothing to show. */
s = saleReducer(s, { type: 'DRILL', departmentId: 90 })
s = saleReducer(s, { type: 'DRILL', departmentId: 91 })
ok('tiles nest', JSON.stringify(path(s)) === '[9,90,91]', path(s))

/* Re-opening the level already on screen cannot change the grid, so it must not
   change the trail either. */
const before = JSON.stringify(path(s))
s = saleReducer(s, { type: 'DRILL', departmentId: 91 })
ok('re-opening the current level is a no-op', JSON.stringify(path(s)) === before, path(s))

/* A rail tap from deep inside collapses the whole trail. */
s = saleReducer(s, { type: 'DRILL', departmentId: 7, root: true })
ok('a rail tap from three deep resets to one', JSON.stringify(path(s)) === '[7]', path(s))

/* What the in-grid Back tile does: straight to the top of the trail, from
   however deep, rather than up one level. */
s = saleReducer(s, { type: 'DRILL', departmentId: 70 })
s = saleReducer(s, { type: 'DRILL', departmentId: 71 })
ok('three deep before Back', path(s).length === 3, path(s))
s = saleReducer(s, { type: 'DRILL_TO', path: [7] })
ok('Back lands on the top department', JSON.stringify(path(s)) === '[7]', path(s))

/* An empty DRILL_TO is the quick keys, not a department with no name. */
s = saleReducer(s, { type: 'DRILL_TO', path: [] })
ok('an empty trail is the quick keys', s.catalog.kind === 'keys', s.catalog.kind)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
