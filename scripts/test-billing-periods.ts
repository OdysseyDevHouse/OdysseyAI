// Billing period arithmetic and plan pricing.
//
// Both are pure, and both are the kind of code that looks obviously right and
// is quietly wrong at a month boundary. The date half decides when a customer
// loses a module they cancelled; the money half decides what the client shows
// and what the server writes — which have to be the same number.
import { periodEnd, nextBillingDate, safeBillingDay } from '../src/lib/billing/period'
import { quoteFor, storeLines, changePreview, type Holding, type PriceBook } from '../src/lib/billing/pricing'
import { multiStoreDiscountRate } from '../src/lib/billing/catalogue'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function main() {
  // ── Billing day 1: the period IS the calendar month ────────────────────
  ok('day 1, mid-month -> month end', periodEnd('2026-08-12', 1) === '2026-08-31', periodEnd('2026-08-12', 1))
  ok('day 1, on the 1st -> month end', periodEnd('2026-08-01', 1) === '2026-08-31', periodEnd('2026-08-01', 1))
  ok('day 1, on the last day -> same day', periodEnd('2026-08-31', 1) === '2026-08-31', periodEnd('2026-08-31', 1))
  ok('day 1, February -> the 28th', periodEnd('2026-02-10', 1) === '2026-02-28', periodEnd('2026-02-10', 1))
  ok('day 1, leap February -> the 29th', periodEnd('2024-02-10', 1) === '2024-02-29', periodEnd('2024-02-10', 1))
  ok('day 1, December -> 31 Dec', periodEnd('2026-12-15', 1) === '2026-12-31', periodEnd('2026-12-15', 1))

  // ── Billing day 15: the period straddles two calendar months ───────────
  // The case most likely to be got wrong, and the one that costs a customer
  // three weeks of a module if it is.
  ok('day 15, before the roll -> the 14th', periodEnd('2026-08-12', 15) === '2026-08-14', periodEnd('2026-08-12', 15))
  ok('day 15, ON the roll -> next month', periodEnd('2026-08-15', 15) === '2026-09-14', periodEnd('2026-08-15', 15))
  ok('day 15, after the roll -> next month', periodEnd('2026-08-20', 15) === '2026-09-14', periodEnd('2026-08-20', 15))
  ok('day 15, Jan into Feb', periodEnd('2026-01-20', 15) === '2026-02-14', periodEnd('2026-01-20', 15))
  ok('day 15, across the year end', periodEnd('2026-12-20', 15) === '2027-01-14', periodEnd('2026-12-20', 15))

  // ── Day 28, the highest allowed ────────────────────────────────────────
  ok('day 28 in February', periodEnd('2026-02-10', 28) === '2026-02-27', periodEnd('2026-02-10', 28))
  ok('day 28 on the roll in February', periodEnd('2026-02-28', 28) === '2026-03-27', periodEnd('2026-02-28', 28))

  // ── Clamping: a billing day that skips a month must be impossible ──────
  // The 31st would have no February, and a downgrade scheduled for a date that
  // never arrives is a module the customer keeps paying for forever.
  ok('31 clamps to 28', safeBillingDay(31) === 28)
  ok('29 clamps to 28', safeBillingDay(29) === 28)
  ok('0 clamps to 1', safeBillingDay(0) === 1)
  ok('negative clamps to 1', safeBillingDay(-5) === 1)
  ok('NaN falls back to 1', safeBillingDay(NaN) === 1)
  ok('day 31 still lands inside February', periodEnd('2026-02-10', 31) === '2026-02-27', periodEnd('2026-02-10', 31))

  // ── The two dates must agree, always ───────────────────────────────────
  let disagree = 0
  let intoThePast = 0
  for (const day of [1, 2, 5, 14, 15, 16, 27, 28]) {
    for (let m = 0; m < 12; m++) {
      for (const dom of [1, 13, 14, 15, 16, 27, 28]) {
        for (const year of [2024, 2026]) {
          const d = new Date(Date.UTC(year, m, dom))
          const iso = d.toISOString().slice(0, 10)

          const end = new Date(`${periodEnd(iso, day)}T00:00:00Z`)
          end.setUTCDate(end.getUTCDate() + 1)
          if (end.toISOString().slice(0, 10) !== nextBillingDate(iso, day)) disagree++

          // A scheduled removal must never be dated before today, or the module
          // would vanish the instant it was cancelled.
          if (periodEnd(iso, day) < iso) intoThePast++
        }
      }
    }
  }
  ok('*** period end + 1 day === next billing date, 1344 combinations ***', disagree === 0, `${disagree} disagreements`)
  ok('*** a downgrade is never scheduled into the past ***', intoThePast === 0, `${intoThePast} in the past`)

  // ── Pricing ────────────────────────────────────────────────────────────
  const book: PriceBook = {
    starter: 399,
    inventory_advanced: 249,
    multi_branch: 249,
    customers: 149,
    loyalty: 149,
    job_cards: 299,
    pos_device: 249,
  }

  const oneStore: Holding[] = [
    { siteId: 1, moduleKey: 'starter', quantity: 1, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'loyalty', quantity: 1, agreedPrice: null, endsOn: null },
  ]

  // ── The first till at each store is included ──────────────────────────
  const q1 = quoteFor(oneStore, { 1: 1 }, book, 15)
  ok('one store, base + loyalty, first till free', q1.subtotal === 399 + 149, String(q1.subtotal))
  ok('a single store gets no discount', q1.discountRate === 0, String(q1.discountRate))
  ok('VAT is added on top of the subtotal', q1.vat === round(q1.subtotal * 0.15), `${q1.vat}`)
  ok('total is subtotal + VAT', q1.total === round(q1.subtotal + q1.vat), String(q1.total))

  const q1b = quoteFor(oneStore, { 1: 3 }, book, 15)
  ok('only tills beyond the first are charged', q1b.subtotal === 399 + 149 + 249 * 2, String(q1b.subtotal))

  // Per-site pricing: the whole point of the per-site decision.
  const twoStores: Holding[] = [
    { siteId: 1, moduleKey: 'starter', quantity: 1, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'loyalty', quantity: 1, agreedPrice: null, endsOn: null },
    { siteId: 2, moduleKey: 'starter', quantity: 1, agreedPrice: null, endsOn: null },
  ]
  // 2 stores: modules 399+149+399, tills (2-1)+(1-1) = 1 x 249. Then 15% off.
  const q2 = quoteFor(twoStores, { 1: 2, 2: 1 }, book, 15)
  ok('a module on one store is billed once', q2.subtotal === 399 + 149 + 399 + 249, String(q2.subtotal))
  ok('two stores discount at 15%', q2.discountRate === 0.15, String(q2.discountRate))
  ok('the discount comes off the subtotal', q2.discountAmount === round(q2.subtotal * 0.15), String(q2.discountAmount))
  ok(
    'VAT is charged on the DISCOUNTED figure, not the gross',
    q2.vat === round((q2.subtotal - q2.discountAmount) * 0.15),
    String(q2.vat),
  )
  ok(
    'total is subtotal less discount plus VAT',
    q2.total === round(q2.subtotal - q2.discountAmount + q2.vat),
    String(q2.total),
  )

  // ── The discount ladder ───────────────────────────────────────────────
  ok('1 store  -> 0%', multiStoreDiscountRate(1) === 0)
  ok('2 stores -> 15%', multiStoreDiscountRate(2) === 0.15)
  ok('3 stores -> 17%', multiStoreDiscountRate(3) === 0.17)
  ok('4 stores -> 19%', multiStoreDiscountRate(4) === 0.19)
  ok('5 stores -> 22%', multiStoreDiscountRate(5) === 0.22)
  ok('12 stores still 22% — the ladder tops out', multiStoreDiscountRate(12) === 0.22)
  ok('0 or negative is treated as one store', multiStoreDiscountRate(0) === 0 && multiStoreDiscountRate(-3) === 0)

  /* The rate follows the ACCOUNT, not how many stores the caller can see. A
     manager with access to 2 of a 5-store group must still be quoted 22%, or
     the screen shows a different price to different people. */
  const q2c = quoteFor(twoStores, { 1: 2, 2: 1 }, book, 15, 5)
  ok('the store count can be overridden for the account', q2c.discountRate === 0.22, String(q2c.discountRate))

  // ── The summary table ─────────────────────────────────────────────────
  const lines = storeLines([1, 2], twoStores, { 1: 2, 2: 1 }, book)
  ok('one row per store', lines.length === 2)
  ok('store 1 modules are its own', lines[0].moduleTotal === 399 + 149, String(lines[0].moduleTotal))
  ok('store 1 has one extra till', lines[0].extraDevices === 1 && lines[0].deviceTotal === 249)
  ok('store 2 has none', lines[1].extraDevices === 0 && lines[1].deviceTotal === 0)
  ok('a store total is modules + devices', lines[0].lineTotal === 399 + 149 + 249, String(lines[0].lineTotal))
  ok(
    'the store rows sum to the subtotal',
    round(lines.reduce((s, l) => s + l.lineTotal, 0)) === q2.subtotal,
    `${lines.reduce((s, l) => s + l.lineTotal, 0)} vs ${q2.subtotal}`,
  )

  // Grandfathering: the agreed rate beats the book, and says so.
  const grandfathered: Holding[] = [
    { siteId: 1, moduleKey: 'starter', quantity: 1, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'loyalty', quantity: 1, agreedPrice: 99, endsOn: null },
  ]
  const q3 = quoteFor(grandfathered, {}, book, 15)
  ok('an agreed price beats the book', q3.subtotal === 399 + 99, String(q3.subtotal))
  ok('and is flagged as grandfathered', q3.lines.some((l) => l.moduleKey === 'loyalty' && l.grandfathered))

  // An agreed price of 0 is a real decision (a module given away), and must not
  // be mistaken for "unset" and silently re-priced at the book rate.
  const freebie: Holding[] = [
    { siteId: 1, moduleKey: 'loyalty', quantity: 1, agreedPrice: 0, endsOn: null },
  ]
  ok('an agreed price of zero is honoured, not overridden', quoteFor(freebie, {}, book, 15).subtotal === 0, String(quoteFor(freebie, {}, book, 15).subtotal))

  // A module with no price row bills zero and is flagged, rather than throwing
  // and taking the whole billing screen down.
  const unpriced: Holding[] = [
    { siteId: 1, moduleKey: 'online_store', quantity: 1, agreedPrice: null, endsOn: null },
  ]
  const q4 = quoteFor(unpriced, {}, book, 15)
  ok('an unpriced module bills 0 rather than throwing', q4.subtotal === 0, String(q4.subtotal))
  ok('and is flagged so it is visibly wrong', q4.lines[0]?.unpriced === true)

  // ── The downgrade asymmetry ────────────────────────────────────────────
  // A module scheduled to end STILL BILLS this period and drops out of the
  // next. Showing one number for both is how a customer is told they were
  // charged for something they cancelled.
  const ending: Holding[] = [
    { siteId: 1, moduleKey: 'starter', quantity: 1, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'loyalty', quantity: 1, agreedPrice: null, endsOn: '2026-08-31' },
  ]
  const q5 = quoteFor(ending, {}, book, 15)
  ok('a module ending still bills this period', q5.subtotal === 399 + 149, String(q5.subtotal))
  ok('and drops out of the next one', q5.nextPeriodSubtotal === 399, String(q5.nextPeriodSubtotal))
  ok('next-period total carries VAT too', q5.nextPeriodTotal === round(399 * 1.15), String(q5.nextPeriodTotal))

  // ── Till licences ──────────────────────────────────────────────────────
  // One store here, so no discount muddies the figure: 3 tills, first included.
  const q6 = quoteFor([], { 1: 3 }, book, 15)
  ok('tills bill per licence beyond the first', q6.subtotal === 249 * 2, String(q6.subtotal))
  const q6b = quoteFor([], { 1: 1 }, book, 15)
  ok('a store with one till adds no line at all', q6b.lines.length === 0, String(q6b.lines.length))

  // ── Rounding: the client and the server must land on the same cent ─────
  // Per-line rounding then summing, never sum-then-round.
  const odd: PriceBook = { a: 33.33, b: 33.33, c: 33.33 }
  const oddHoldings: Holding[] = [
    { siteId: 1, moduleKey: 'a', quantity: 3, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'b', quantity: 3, agreedPrice: null, endsOn: null },
    { siteId: 1, moduleKey: 'c', quantity: 3, agreedPrice: null, endsOn: null },
  ]
  const q7 = quoteFor(oddHoldings, {}, odd, 15)
  ok('lines round before summing', q7.subtotal === round(99.99 * 3), String(q7.subtotal))
  ok('every line total is already rounded', q7.lines.every((l) => l.lineTotal === round(l.lineTotal)))

  // ── The change preview ─────────────────────────────────────────────────
  // Adds and removes stay SEPARATE numbers: one bills today, the other at
  // period end, and netting them would misstate what happens on the card.
  const preview = changePreview(
    oneStore,
    [
      { siteId: 1, moduleKey: 'job_cards' },
      { siteId: 2, moduleKey: 'job_cards' },
    ],
    [{ siteId: 1, moduleKey: 'loyalty' }],
    book,
  )
  ok('adding to two stores costs twice', preview.addedMonthly === 299 * 2, String(preview.addedMonthly))
  ok('removals are reported separately', preview.removedMonthly === 149, String(preview.removedMonthly))

  // Re-adding a module keeps the rate that site already agreed.
  const reAdd = changePreview(grandfathered, [{ siteId: 1, moduleKey: 'loyalty' }], [], book)
  ok('re-adding keeps the grandfathered rate', reAdd.addedMonthly === 99, String(reAdd.addedMonthly))

  console.log(fails ? `\n${fails} failure(s)` : '\nall billing period + pricing checks passed')
  if (fails) process.exitCode = 1
}

main()
