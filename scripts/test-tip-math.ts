/**
 * Tip arithmetic.
 *
 *   npx tsx scripts/test-tip-math.ts
 *
 * Pure — no database, no browser. This is the module the till and the server BOTH use, so
 * an error here appears on a printed slip and in the books simultaneously and agrees with
 * itself while being wrong.
 *
 * The properties worth naming:
 *
 *   · Cash NEVER silently keeps change. An over-tender on a tender that gives change is
 *     change until a person declares otherwise.
 *   · A tender that gives no change and is not set to accept tips REFUSES an over-tender,
 *     rather than keeping it. Silently pocketing a fat-fingered R20 is theft by typo.
 *   · Tier bands are half-open, so a bill landing exactly on a boundary is charged once.
 *   · Only tips whose MONEY is in the drawer count toward the expected drawer.
 */
import {
  splitOverTender,
  declareTip,
  serviceChargeFor,
  overlappingTiers,
  tipsInDrawer,
  type TenderTipRules,
  type ServiceTier,
} from '../src/lib/tipMath'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CASH: TenderTipRules = { allowsChange: true, tipOnOverTender: false, tipInDrawer: true }
const CARD_TIPS: TenderTipRules = { allowsChange: false, tipOnOverTender: true, tipInDrawer: false }
const CARD_STRICT: TenderTipRules = { allowsChange: false, tipOnOverTender: false, tipInDrawer: false }

function main() {
  /* ── 1. Over-tender ─────────────────────────────────────────────────────── */

  {
    const r = splitOverTender(100, 120, CARD_TIPS)
    ok('R120 on a R100 card bill is a R20 tip', r.kind === 'tip' && r.amount === 20, JSON.stringify(r))
  }
  {
    /* THE cash rule. Cash gives change back — a till that decided for itself that R20 was
       a tip would be keeping money nobody offered. */
    const r = splitOverTender(100, 120, CASH)
    ok(
      '*** R120 on a R100 CASH bill is CHANGE, not a tip ***',
      r.kind === 'change' && r.amount === 20,
      JSON.stringify(r),
    )
  }
  {
    /* And the third state, which is neither. Keeping a mis-keyed R20 is theft by typo, so
       a tender that gives no change and does not accept tips must refuse it. */
    const r = splitOverTender(100, 120, CARD_STRICT)
    ok(
      '*** an over-tender on a strict card tender is REFUSED, not kept ***',
      r.kind === 'refuse' && r.amount === 20,
      JSON.stringify(r),
    )
  }
  {
    const exact = splitOverTender(100, 100, CARD_TIPS)
    ok('an exact payment is no tip and no change', exact.kind === 'change' && exact.amount === 0)
  }
  {
    const under = splitOverTender(100, 60, CARD_TIPS)
    ok('an UNDER-payment is never a negative tip', under.amount === 0, JSON.stringify(under))
  }
  {
    /* Half a cent of tolerance, because a percentage or a rounding step can land a
       hair under and a R0.004 "tip" is noise, not money. */
    const noise = splitOverTender(100, 100.004, CARD_TIPS)
    ok('a sub-cent excess is not a tip', noise.amount === 0, JSON.stringify(noise))
  }

  /* ── 2. Declared cash tips ──────────────────────────────────────────────── */

  {
    /* The case that motivated the whole declare screen: R100 on a R50 bill, R10 of the
       R50 is a tip and R40 is change. Nothing can infer that split. */
    const d = declareTip(50, 100, 10)
    ok(
      '*** R100 on R50 with R10 declared is R10 tip and R40 change ***',
      d.tip === 10 && d.change === 40,
      JSON.stringify(d),
    )
  }
  {
    const all = declareTip(50, 100, 50)
    ok('declaring the whole excess leaves no change', all.tip === 50 && all.change === 0)
  }
  {
    const none = declareTip(50, 100, 0)
    ok('declaring nothing leaves it all as change', none.tip === 0 && none.change === 50)
  }
  {
    /* Clamped, not refused. A tip bigger than the excess would hand change back out of the
       shop's own money — a keying error, so the pad shows a smaller figure than was typed
       and the cashier can see it. */
    const over = declareTip(50, 100, 80)
    ok(
      '*** a declared tip larger than the excess is CLAMPED, not obeyed ***',
      over.tip === 50 && over.change === 0,
      JSON.stringify(over),
    )
  }
  {
    const negative = declareTip(50, 100, -10)
    ok('a negative declared tip is zero', negative.tip === 0 && negative.change === 50)
  }
  {
    /* Conservation, which is the property that keeps a drawer balancing:
       tip + change === what was handed over minus what was owed, always. */
    let bad = 0
    for (let owed = 0; owed <= 200; owed += 7) {
      for (let extra = 0; extra <= 100; extra += 3) {
        for (const declared of [0, 1, 5, extra / 2, extra, extra + 50]) {
          const d = declareTip(owed, owed + extra, declared)
          if (Math.abs(d.tip + d.change - extra) > 0.005) bad++
        }
      }
    }
    ok('*** tip + change always equals the excess ***', bad === 0, `${bad} combination(s) failed`)
  }

  /* ── 3. Service-charge tiers ────────────────────────────────────────────── */

  /* A band charges a percentage OR a flat amount, so the fixtures below say which. Two
     builders rather than object literals, so the unused figure is always zero and a test
     can never accidentally assert against a percent a band does not use. */
  const pct = (minTotal: number, maxTotal: number | null, percent: number): ServiceTier => ({
    minTotal, maxTotal, chargeKind: 'percent', percent, amount: 0, isActive: true,
  })
  const flat = (minTotal: number, maxTotal: number | null, amount: number): ServiceTier => ({
    minTotal, maxTotal, chargeKind: 'amount', percent: 0, amount, isActive: true,
  })

  const TIERS: ServiceTier[] = [pct(500, 1000, 10), pct(1000, 1500, 8), pct(1500, null, 5)]

  ok('a R400 bill earns nothing', serviceChargeFor(400, TIERS) === 0)
  ok('a R600 bill earns 10% = R60', serviceChargeFor(600, TIERS) === 60, String(serviceChargeFor(600, TIERS)))
  /* The boundary. min is inclusive and max EXCLUSIVE, so exactly 1000 belongs to the
     SECOND band — 8%, not 10%. Getting this wrong double-charges every bill landing on a
     round number, which is exactly where they cluster. */
  ok(
    '*** exactly R1000 is 8% (the second band), charged once ***',
    serviceChargeFor(1000, TIERS) === 80,
    String(serviceChargeFor(1000, TIERS)),
  )
  ok('R1499 is still 8%', serviceChargeFor(1499, TIERS) === 119.92, String(serviceChargeFor(1499, TIERS)))
  ok('R1500 crosses to 5%', serviceChargeFor(1500, TIERS) === 75, String(serviceChargeFor(1500, TIERS)))
  ok('the open-ended top band has no ceiling', serviceChargeFor(50_000, TIERS) === 2500)
  ok('an inactive tier is ignored', serviceChargeFor(600, [{ ...TIERS[0], isActive: false }]) === 0)
  ok('no tiers means no charge', serviceChargeFor(600, []) === 0)
  ok('a zero bill earns nothing', serviceChargeFor(0, TIERS) === 0)

  {
    /* Every bill gets AT MOST one charge — asserted by construction rather than by
       inspection, because an overlapping band is the one configuration that could
       double-charge and a shop will eventually create one. */
    let doubled = 0
    for (let total = 0; total <= 3000; total += 1) {
      const matches = TIERS.filter(
        (t) => t.isActive && total >= t.minTotal && (t.maxTotal === null || total < t.maxTotal),
      )
      if (matches.length > 1) doubled++
    }
    ok('*** no bill value matches two bands ***', doubled === 0, `${doubled} value(s) matched twice`)
  }

  {
    /* A shop CAN misconfigure them, and then the highest percentage wins — deliberately.
       Charging the higher figure is visible to the customer and gets queried; silently
       charging the lower one hides the misconfiguration for months. */
    const overlapping: ServiceTier[] = [pct(500, 2000, 10), pct(1000, 1500, 12)]
    ok(
      'overlapping bands resolve to the HIGHER percentage',
      serviceChargeFor(1200, overlapping) === 144,
      String(serviceChargeFor(1200, overlapping)),
    )
    ok('and the overlap is reportable', overlappingTiers(overlapping).length === 1)
    ok('while tidy bands report none', overlappingTiers(TIERS).length === 0)
  }

  /* ── 3b. Flat-amount bands ──────────────────────────────────────────────── */

  {
    /* The case a percentage cannot express: a small-order fee. 10% of a R60 order is R6,
       which does not cover the tray it exists to pay for — the shop wants R15 flat. */
    const SMALL: ServiceTier[] = [flat(0, 100, 15)]
    ok('a flat band charges its amount', serviceChargeFor(60, SMALL) === 15, String(serviceChargeFor(60, SMALL)))
    ok('*** and the SAME amount whatever the bill ***', serviceChargeFor(95, SMALL) === 15)
    ok('a bill above the band earns nothing', serviceChargeFor(100, SMALL) === 0)
    ok('a zero bill still earns nothing', serviceChargeFor(0, SMALL) === 0)
    ok('an inactive flat band is ignored', serviceChargeFor(60, [{ ...SMALL[0], isActive: false }]) === 0)

    /* A flat band ignores whatever is in `percent`, and a percentage band ignores
       `amount`. Asserted because the two columns coexist on every row: a band reading the
       wrong one would be silent, and wrong on every bill. */
    ok(
      '*** a flat band ignores a stray percent ***',
      serviceChargeFor(600, [{ ...flat(500, null, 20), percent: 99 }]) === 20,
    )
    ok(
      '*** a percentage band ignores a stray amount ***',
      serviceChargeFor(600, [{ ...pct(500, null, 10), amount: 999 }]) === 60,
    )

    /* The tie-break compares what each band would actually TAKE, not percent against
       amount. On a R600 bill the 10% band takes R60 and the flat band R25, so the
       percentage wins — where comparing 25 > 10 would have picked the flat one. */
    const mixed: ServiceTier[] = [pct(500, null, 10), flat(500, null, 25)]
    ok(
      '*** mixed overlapping bands compare the RESOLVED charge ***',
      serviceChargeFor(600, mixed) === 60,
      String(serviceChargeFor(600, mixed)),
    )
    /* And on a small bill inside the same bands the flat one wins, which is the same rule
       giving the opposite answer — proof it is comparing charges rather than columns. */
    ok(
      'so the flat band wins when it takes more',
      serviceChargeFor(200, [pct(100, null, 5), flat(100, null, 25)]) === 25,
    )
    ok('a negative amount cannot pay the customer', serviceChargeFor(600, [flat(500, null, -50)]) === 0)
  }

  /* ── 4. What the drawer should hold ─────────────────────────────────────── */

  {
    /*
     * The cash-up rule. A cash tip is in the till; a card or account tip is not.
     *
     * Summing ALL tips leaves every card-tipping shift over; summing NONE leaves every
     * cash-tipping shift over. Both are the same bug in opposite directions, which is why
     * the flag is per tender rather than a global setting.
     */
    const expected = tipsInDrawer([
      { amount: 20, tipInDrawer: true },
      { amount: 35, tipInDrawer: false },
      { amount: 10, tipInDrawer: true },
    ])
    ok('*** only tips whose money is in the drawer count toward it ***', expected === 30, String(expected))
    ok('no tips is zero, not NaN', tipsInDrawer([]) === 0)
  }

  console.log(fails === 0 ? '\nAll tip maths checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
