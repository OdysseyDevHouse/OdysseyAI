/**
 * The till's reducer and its derived figures — pure, no database, no browser.
 *
 *   npx tsx scripts/test-sale-reducer.ts
 *
 * Two things are worth testing here and they are different. The reducer's job is
 * that a state change is never HALF done — clearing a sale must let go of the
 * customer as well as the lines, and removing a line must let go of the selection
 * that pointed at it. The selectors' job is that a special and a manual discount
 * do not stack.
 */
import { saleReducer, initialSaleState, type SaleState } from '../src/app/(pos)/pos/useSaleState'
import {
  specialsFor,
  totalsFor,
  salePayloadLines,
  childDepartments,
  departmentTrail,
  hasChildren,
} from '../src/app/(pos)/pos/saleSelectors'
import type { TillProduct } from '../src/lib/site/tillSearch'
import type { TillCustomer } from '../src/lib/site/tillCustomers'
import type { Special } from '../src/lib/specialsEngine'
import type { Department } from '../src/app/(pos)/pos/types'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const product = (over: Partial<TillProduct> = {}): TillProduct =>
  ({
    id: 1,
    code: 'COKE500',
    barcode: '6001240100015',
    description: 'Coca-Cola 500ml',
    productType: 'normal',
    departmentId: 3,
    priceIncl: 100,
    vatRatePct: 15,
    costExcl: 50,
    stockOnHand: 100,
    reservedQty: 0,
    availableQty: 100,
    askPriceAtSale: false,
    allowFractions: false,
    maxDiscountPct: 20,
    ...over,
  }) as TillProduct

const customer = { id: 7, code: 'CUST007', name: 'Acme Ltd' } as TillCustomer

/** Run a list of actions from the initial state. */
const run = (...actions: Parameters<typeof saleReducer>[1][]): SaleState =>
  actions.reduce(saleReducer, initialSaleState)

function main() {
  /* ── Adding ──────────────────────────────────────────────────────────── */

  {
    const s = run({ type: 'ADD', product: product() })
    ok('ADD puts a line in the basket', s.lines.length === 1)
    ok('ADD clears the search box', s.query === '')
  }

  {
    // Two of the same item, or two things found by one search, is ordinary — so
    // the results STAY and the cashier does not retype the word they just typed.
    // Only the box is cleared, because a scanner appends and a barcode landing
    // after "milk" resolves to nothing.
    const s = run({ type: 'SHOW_SEARCH', term: 'milk' }, { type: 'ADD', product: product() })
    ok('adding from search KEEPS the results on screen', s.catalog.kind === 'search')
    ok('but the search box is cleared for the next scan', s.query === '')
  }

  {
    // Idempotent, because the debounced effect dispatches this on every
    // keystroke: a new object each time would re-render the whole tile grid
    // while somebody is still typing.
    const first = run({ type: 'SHOW_SEARCH', term: 'milk' })
    const again = saleReducer(first, { type: 'SHOW_SEARCH', term: 'milk' })
    ok('SHOW_SEARCH with the same term returns the SAME state object', first === again)
  }

  {
    // But adding while browsing a department keeps you there — ringing up two
    // things from one aisle is the common case.
    const s = run(
      { type: 'DRILL', departmentId: 3 },
      { type: 'ADD', product: product() },
    )
    ok('adding while BROWSING keeps the department open', s.catalog.kind === 'departments')
  }

  /* ── Selection, and letting go of it ─────────────────────────────────── */

  {
    let s = run({ type: 'ADD', product: product() })
    const key = s.lines[0].key
    s = saleReducer(s, { type: 'SELECT', key })
    ok('SELECT opens a line', s.selectedKey === key)
    s = saleReducer(s, { type: 'SELECT', key })
    ok('SELECT on the open line closes it — the row is a toggle', s.selectedKey === null)
  }

  {
    // The bug this prevents: an action row left open over a line that no longer
    // exists, where + and − then do nothing and the cashier taps harder.
    let s = run({ type: 'ADD', product: product() })
    const key = s.lines[0].key
    s = saleReducer(s, { type: 'SELECT', key })
    s = saleReducer(s, { type: 'STEP', key, delta: -1 })
    ok('stepping the last unit away drops the selection too', s.lines.length === 0 && s.selectedKey === null)
  }

  {
    let s = run({ type: 'ADD', product: product() })
    const key = s.lines[0].key
    s = saleReducer(s, { type: 'SELECT', key })
    s = saleReducer(s, { type: 'REMOVE', key })
    ok('REMOVE drops the selection with the line', s.selectedKey === null)
  }

  {
    // Adding closes the row, or the next + lands on the line the cashier stopped
    // looking at.
    let s = run({ type: 'ADD', product: product() })
    s = saleReducer(s, { type: 'SELECT', key: s.lines[0].key })
    s = saleReducer(s, { type: 'ADD', product: product({ id: 2 }) })
    ok('ADD closes the open action row', s.selectedKey === null)
  }

  /* ── CLEAR is the one that must not be half-done ─────────────────────── */

  {
    let s = run({ type: 'ADD', product: product() })
    s = saleReducer(s, { type: 'SET_CUSTOMER', customer })
    s = saleReducer(s, { type: 'SET_CUSTOMER_NAME', name: 'Walk-in Bob' })
    s = saleReducer(s, { type: 'SELECT', key: s.lines[0].key })
    s = saleReducer(s, { type: 'LOAD', documentId: 99, lines: s.lines })
    s = saleReducer(s, { type: 'CLEAR' })

    // An attached account surviving into the next sale is how a walk-in's goods
    // end up on somebody else's statement.
    ok('CLEAR drops the lines', s.lines.length === 0)
    ok('CLEAR drops the CUSTOMER', s.customer === null)
    ok('CLEAR drops the typed name', s.customerName === '')
    ok('CLEAR drops the draft id', s.documentId === null)
    ok('CLEAR drops the selection', s.selectedKey === null)
  }

  {
    // The catalogue view is the cashier's place in the shop, not part of the
    // sale, so it survives a clear.
    const s = run({ type: 'DRILL', departmentId: 5 }, { type: 'CLEAR' })
    ok('CLEAR keeps you where you were in the catalogue', s.catalog.kind === 'departments')
  }

  /* ── Return mode: the direction the goods are going ──────────────────────
     A mode on the one basket rather than a second basket, because a return is items,
     quantities and prices — structurally a sale. What must never happen is lines
     crossing between the two, in EITHER direction. */

  {
    let s = run({ type: 'SET_RETURNING', returning: true })
    ok('SET_RETURNING turns the mode on', s.returning === true)

    s = saleReducer(s, { type: 'ADD', product: product() })
    ok('a return basket takes lines like any other', s.lines.length === 1)
    /* POSITIVE in the basket. The sign is flipped by createCreditNote, which is the only
       thing that should know the storage convention — a negative here would double-negate
       into a sale. */
    ok('and the qty stays POSITIVE in the basket', s.lines[0].qty > 0, String(s.lines[0].qty))
  }

  {
    /* The bug this pins: leaving a return's lines behind when somebody taps back to Sale
       would ring up the goods just handed in AS A SALE. Same items, same prices, opposite
       direction, and nothing on screen would look wrong. */
    let s = run({ type: 'SET_RETURNING', returning: true }, { type: 'ADD', product: product() })
    s = saleReducer(s, { type: 'SET_RETURNING', returning: false })
    ok('*** leaving return mode CLEARS the basket ***', s.lines.length === 0)
    ok('  and the mode really is off', s.returning === false)
  }

  {
    // And the same on the way in, for the same reason with the sign reversed.
    let s = run({ type: 'ADD', product: product() })
    s = saleReducer(s, { type: 'SET_RETURNING', returning: true })
    ok('entering return mode clears a sale basket too', s.lines.length === 0)
  }

  {
    /*
     * CLEAR must NOT leave return mode.
     *
     * initialSaleState has returning: false, so spreading it — which CLEAR does — would
     * silently drop a cashier back into sale mode when they cleared a mis-keyed return.
     * The next item scanned would be SOLD rather than credited. "Start this basket again"
     * is not "I changed my mind about which way the goods are going".
     */
    let s = run({ type: 'SET_RETURNING', returning: true }, { type: 'ADD', product: product() })
    s = saleReducer(s, { type: 'CLEAR' })
    ok('CLEAR drops the lines but KEEPS return mode', s.lines.length === 0 && s.returning === true)
  }

  {
    // A sale basket is not accidentally in return mode.
    const s = run({ type: 'ADD', product: product() })
    ok('an ordinary basket is not a return', s.returning === false)
  }

  /* ── Customer ────────────────────────────────────────────────────────── */

  {
    const s = run(
      { type: 'SET_CUSTOMER_NAME', name: 'Walk-in Bob' },
      { type: 'SET_CUSTOMER', customer },
    )
    ok(
      'attaching an account clears the typed walk-in name',
      s.customer?.id === 7 && s.customerName === '',
    )
  }

  /* ── Drilling ────────────────────────────────────────────────────────── */

  {
    let s = run({ type: 'DRILL', departmentId: 1 })
    s = saleReducer(s, { type: 'DRILL', departmentId: 2 })
    ok(
      'DRILL pushes onto the path',
      s.catalog.kind === 'departments' && s.catalog.path.join() === '1,2',
      s.catalog.kind === 'departments' ? s.catalog.path.join() : s.catalog.kind,
    )
    s = saleReducer(s, { type: 'DRILL_TO', path: [1] })
    ok(
      'DRILL_TO walks back up',
      s.catalog.kind === 'departments' && s.catalog.path.join() === '1',
    )
    s = saleReducer(s, { type: 'DRILL_TO', path: [] })
    ok('DRILL_TO with an empty path is the top, which is the keys', s.catalog.kind === 'keys')
  }

  /* ── Totals, and the rule that a special does not stack ──────────────── */

  {
    const s = run({ type: 'ADD', product: product({ priceIncl: 100 }) })
    const none = specialsFor(s.lines, [], new Date())
    const totals = totalsFor(s.lines, none)
    ok('one R100 line totals R100', totals.doc.totalIncl === 100, String(totals.doc.totalIncl))
  }

  {
    // 10% special against a 20% manual discount: the BETTER of the two applies,
    // not both. Compounding is how a staff discount during a promotion quietly
    // sells below cost.
    let s = run({ type: 'ADD', product: product({ priceIncl: 100 }) })
    s = saleReducer(s, { type: 'UPDATE', key: s.lines[0].key, changes: { discountPct: 20 } })

    // A REAL Special, built from the exported types rather than guessed at.
    //
    // 'happy_hour' is how this app expresses a percentage off — there is no
    // 'percent' type. An earlier draft of this test invented one, the engine
    // matched nothing, and the stacking assertion below passed while only ever
    // exercising the manual discount. Hence the explicit "the special is found"
    // check: a stacking test that silently stops seeing a special is worse than
    // no test, because it reads as coverage.
    const specials: Special[] = [
      {
        id: 1,
        name: '10% off Coke',
        type: 'happy_hour',
        comboMode: '',
        isActive: true,
        startsAt: '2000-01-01T00:00',
        endsAt: '2099-12-31T23:59',
        dailyStart: '',
        dailyEnd: '',
        daysOfWeek: '1111111',
        discountPct: 10,
        appliesToAll: false,
        triggerQty: 0,
        bundlePriceIncl: 0,
        spendAmountIncl: 0,
        priority: 0,
        items: [{ role: 'scope', productId: 1, departmentId: null, qty: 0, priceIncl: 0 }],
        tiers: [],
      },
    ]
    const withSpecial = specialsFor(s.lines, specials, new Date())
    ok('the special is found for the line', withSpecial[0] !== undefined)

    // 20% manual beats the 10% special, so R80 — never R72, which is both
    // applied and is how a staff discount during a promotion sells below cost.
    ok(
      'the bigger MANUAL discount wins — R80, not R72',
      totalsFor(s.lines, withSpecial).doc.totalIncl === 80,
      String(totalsFor(s.lines, withSpecial).doc.totalIncl),
    )

    // And the other direction, which a one-sided test would miss: drop the
    // manual discount below the special and the SPECIAL must take over.
    const lower = saleReducer(s, {
      type: 'UPDATE',
      key: s.lines[0].key,
      changes: { discountPct: 5 },
    })
    ok(
      'the bigger SPECIAL wins when the manual one is smaller — R90',
      totalsFor(lower.lines, specialsFor(lower.lines, specials, new Date())).doc.totalIncl === 90,
      String(totalsFor(lower.lines, specialsFor(lower.lines, specials, new Date())).doc.totalIncl),
    )
  }

  {
    // A refund line must not complete a deal. It goes into the engine at qty 0
    // so it keeps its index but earns nothing — goods coming back are not a
    // purchase, and a three-for-two completed by a return gives money away.
    let s = run({ type: 'ADD', product: product({ priceIncl: 100 }) })
    s = saleReducer(s, { type: 'UPDATE', key: s.lines[0].key, changes: { qty: -1 } })
    const result = specialsFor(s.lines, [], new Date())
    ok('a refund line still occupies its slot in the specials result', result.length === 1)
    const totals = totalsFor(s.lines, result)
    ok('a refund line totals negative', totals.doc.totalIncl === -100, String(totals.doc.totalIncl))
  }

  {
    // The payload must carry what the SCREEN showed, or the slip in the
    // customer's hand and the posted sale disagree about the price.
    let s = run({ type: 'ADD', product: product({ priceIncl: 100 }) })
    s = saleReducer(s, { type: 'UPDATE', key: s.lines[0].key, changes: { discountPct: 15 } })
    const payload = salePayloadLines(s.lines, specialsFor(s.lines, [], new Date()))
    ok('the payload carries the effective discount', payload[0].discountPct === 15)
    ok('the payload carries the cost, for margin', payload[0].unitCostExcl === 50)
  }

  /* ── The department tree ─────────────────────────────────────────────── */

  {
    const departments: Department[] = [
      { id: 1, parentId: null, name: 'Groceries', sortOrder: 2 },
      { id: 2, parentId: null, name: 'Butchery', sortOrder: 1 },
      { id: 3, parentId: 1, name: 'Tinned', sortOrder: 1 },
      { id: 4, parentId: null, name: 'Bakery', sortOrder: 1 },
    ]

    const top = childDepartments(departments, null)
    // sortOrder first, then name — so a store that arranged its departments gets
    // that arrangement, and one that did not gets alphabetical rather than
    // insertion order, which reads as random.
    ok(
      'top-level departments sort by order then name',
      top.map((d) => d.name).join() === 'Bakery,Butchery,Groceries',
      top.map((d) => d.name).join(),
    )
    ok('children are found by parent', childDepartments(departments, 1)[0].name === 'Tinned')
    ok('a department with children reads as having them', hasChildren(departments, 1))
    ok('a leaf reads as a leaf', !hasChildren(departments, 3))
    ok(
      'the trail names the path for a breadcrumb',
      departmentTrail(departments, [1, 3]).map((d) => d.name).join(' / ') === 'Groceries / Tinned',
    )
    // A path holding an id that has since been deleted must not blow up the
    // breadcrumb — the department could have been removed in the back office
    // while this till had it open.
    ok('an unknown id in the path is skipped', departmentTrail(departments, [1, 999]).length === 1)
  }

  console.log(fails === 0 ? '\nAll reducer checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
