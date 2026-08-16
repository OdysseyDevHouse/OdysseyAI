/**
 * Line session state and age — pure, no database.
 *
 *   npx tsx scripts/test-line-session.ts
 *
 * These are the badges a waiter reads off a reopened tab: whether a line is
 * untouched, changed, or newly rung, and how long ago it was ordered. Getting
 * `modified` wrong is what makes a kitchen cook the starters twice, so the rules
 * are pinned here rather than left to the screen.
 *
 * Value in, value out, so it runs with no connection.
 */
import {
  baselineOf,
  captureBaseline,
  formatLineAge,
  instructionFingerprint,
  lineSessionState,
  minutesSince,
} from '../src/lib/lineSession'
import { lineFromProduct, type BasketLine } from '../src/lib/basket'
import { salePayloadLines } from '../src/app/(pos)/pos/saleSelectors'
import type { TillProduct } from '../src/lib/site/tillSearch'
import type { ChosenOption } from '../src/lib/instructionRules'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A basket line. Fields not under test get harmless values. */
const line = (over: Partial<BasketLine> = {}): BasketLine =>
  ({
    key: 'r1-10-0',
    productId: 1,
    productCode: 'CAL',
    description: 'Calamari Strips',
    productType: 'normal',
    departmentId: 3,
    qty: 1,
    unitPriceIncl: 125,
    discountPct: 0,
    vatRatePct: 15,
    unitCostExcl: 60,
    maxDiscountPct: 10,
    shelfPriceIncl: 125,
    allowFractions: false,
    instructions: [],
    note: '',
    ...over,
  }) as BasketLine

/** One chosen answer. Only the fields the fingerprint reads are meaningful. */
const option = (optionId: number, qty = 1): ChosenOption =>
  ({
    groupId: 1,
    groupName: 'Sauce',
    optionId,
    optionName: `Option ${optionId}`,
    qty,
    priceAdjustIncl: 0,
    productId: null,
    stockQtyPer: 0,
    printsOnKitchen: true,
    printsOnReceipt: false,
  }) as ChosenOption

function main() {
  /* ── The three states ─────────────────────────────────────────────────── */

  {
    const a = line()
    const baseline = captureBaseline([a])
    ok('a line untouched since the tab opened is unmodified', lineSessionState(a, baseline) === 'unmodified')
  }

  {
    const a = line()
    const baseline = captureBaseline([a])
    const b = { ...a, qty: 2 }
    ok('a changed quantity is modified', lineSessionState(b, baseline) === 'modified')
  }

  {
    const a = line()
    const baseline = captureBaseline([a])
    const fresh = line({ key: 'new-1' })
    ok('a line added after the tab opened is new', lineSessionState(fresh, baseline) === 'new')
  }

  {
    /* The counter-sale case. No baseline at all is different from an empty
       one, and both make every line new — but for different reasons, and the
       null branch is the one a retail till takes on every single sale. */
    ok('with no baseline every line is new', lineSessionState(line(), null) === 'new')
    ok('against an empty baseline a line is new', lineSessionState(line(), {}) === 'new')
  }

  /* ── What counts as a modification ────────────────────────────────────── */

  {
    const a = line()
    const baseline = captureBaseline([a])
    ok(
      'a changed price is modified',
      lineSessionState({ ...a, unitPriceIncl: 130 }, baseline) === 'modified',
    )
    ok(
      'a changed discount is modified',
      lineSessionState({ ...a, discountPct: 10 }, baseline) === 'modified',
    )
    ok(
      'a changed note is modified',
      lineSessionState({ ...a, note: 'no ice' }, baseline) === 'modified',
    )
    ok(
      'an added instruction is modified',
      lineSessionState({ ...a, instructions: [option(7)] }, baseline) === 'modified',
    )
  }

  {
    /* The one that matters for a kitchen: swapping one bacon for two is a
       different plate, and a fingerprint that ignored qty would call it
       unmodified and never re-send it. */
    const a = line({ instructions: [option(7, 1)] })
    const baseline = captureBaseline([a])
    ok(
      'changing an instruction QUANTITY is modified',
      lineSessionState({ ...a, instructions: [option(7, 2)] }, baseline) === 'modified',
    )
  }

  {
    /* And the inverse: the same answers chosen in a different order are the
       same burger. Without the sort this reads as modified and the kitchen
       gets a ticket for a plate nobody changed. */
    const a = line({ instructions: [option(7), option(3)] })
    const baseline = captureBaseline([a])
    ok(
      'the same instructions in a different order are unmodified',
      lineSessionState({ ...a, instructions: [option(3), option(7)] }, baseline) === 'unmodified',
    )
  }

  {
    /* A field the fingerprint deliberately ignores. Re-reading a product's
       ceiling at recall is normal and must not read as the customer changing
       their order. */
    const a = line()
    const baseline = captureBaseline([a])
    ok(
      'a re-read discount ceiling is not a modification',
      lineSessionState({ ...a, maxDiscountPct: 50 }, baseline) === 'unmodified',
    )
  }

  /* ── The baseline is a SNAPSHOT, not a live view ──────────────────────── */

  {
    /* The bug this whole module exists to prevent: a baseline re-taken after
       an edit turns every modification back into "unmodified", and the waiter
       loses the only signal saying what still has to reach the kitchen. */
    const a = line()
    const baseline = captureBaseline([a])
    const edited = { ...a, qty: 4 }
    ok(
      'editing a line does not disturb the baseline it is compared against',
      lineSessionState(edited, baseline) === 'modified' &&
        baseline !== null &&
        baseline[a.key].qty === 1,
    )
  }

  {
    const lines = [line({ key: 'a' }), line({ key: 'b', qty: 3 })]
    const baseline = captureBaseline(lines)
    ok(
      'a baseline holds one entry per line, keyed by line key',
      baseline !== null && Object.keys(baseline).length === 2 && baseline.b.qty === 3,
    )
  }

  {
    const a = line({ qty: 2, unitPriceIncl: 99, discountPct: 5, note: 'hi' })
    const snap = baselineOf(a)
    ok(
      'the snapshot carries the comparable facts and nothing else',
      snap.qty === 2 &&
        snap.unitPriceIncl === 99 &&
        snap.discountPct === 5 &&
        snap.note === 'hi' &&
        Object.keys(snap).length === 5,
    )
  }

  {
    ok('an empty selection fingerprints to the empty string', instructionFingerprint([]) === '')
  }

  /* ── Age ──────────────────────────────────────────────────────────────── */

  {
    const t = 1_700_000_000_000
    ok('a line rung just now is 0 minutes', minutesSince(t, t) === 0)
    ok('fifty seconds is still 0 minutes', minutesSince(t, t + 50_000) === 0)
    ok('sixty seconds is 1 minute', minutesSince(t, t + 60_000) === 1)
    /* Floored, not rounded. At 90s a rounding implementation says 2, which
       claims a minute that has not happened. */
    ok('ninety seconds is 1 minute, not 2', minutesSince(t, t + 90_000) === 1)
    ok('forty minutes reads as forty', minutesSince(t, t + 40 * 60_000) === 40)
  }

  {
    /* Two tills whose clocks disagree by a few seconds share one tab. A
       negative age would print "-1 minutes" on a real screen. */
    const t = 1_700_000_000_000
    ok('a line from a slightly fast till never reads negative', minutesSince(t, t - 5_000) === 0)
  }

  {
    ok('zero is plural', formatLineAge(0) === '0 minutes')
    ok('one is singular', formatLineAge(1) === '1 minute')
    ok('two is plural', formatLineAge(2) === '2 minutes')
    /* Minutes all the way up, deliberately: the number is compared against how
       long a plate SHOULD take, and "95 minutes" alarms in a way "1h 35m"
       does not. */
    ok('long waits stay in minutes', formatLineAge(95) === '95 minutes')
  }

  /* ── The order time has to SURVIVE the trip to storage ────────────────── */

  {
    /* `salePayloadLines` is a whitelist, and its own comment says a field left
       out of it vanishes silently. That is the whole risk for `orderedAt`: a
       table bill rewrites its lines wholesale on every save, so the age is
       preserved only because it makes this round trip. */
    const product = {
      id: 1,
      code: 'CAL',
      description: 'Calamari Strips',
      productType: 'normal',
      departmentId: 3,
      priceIncl: 125,
      vatRatePct: 15,
      costExcl: 60,
      askPriceAtSale: false,
      allowFractions: false,
      maxDiscountPct: 10,
    } as unknown as TillProduct

    const fresh = lineFromProduct(product, 1, 0)
    ok('a freshly rung line is stamped with an order time', typeof fresh.orderedAt === 'number')

    const [payload] = salePayloadLines([fresh], [undefined])
    ok(
      'the order time survives the payload whitelist',
      (payload as { orderedAt?: number }).orderedAt === fresh.orderedAt,
    )

    /* And a line that has none must not invent one — the column stays NULL
       rather than claiming the epoch. */
    const [bare] = salePayloadLines([{ ...fresh, orderedAt: undefined }], [undefined])
    ok(
      'a line with no order time sends no field at all',
      !('orderedAt' in (bare as Record<string, unknown>)),
    )
  }

  console.log(fails === 0 ? '\nAll line-session checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
