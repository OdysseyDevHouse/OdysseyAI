/**
 * Contract arithmetic — escalation, scheduling and catch-up.
 *
 *   npm run test:contract-model
 *
 * No database. Everything here is pure, which is the point: the awkward cases —
 * a raise that must NOT apply in the contract's first month, a back-dated
 * invoice that must carry its own period's price, the 31st in February — are
 * each one function call, and a regression in any of them is a customer being
 * billed the wrong amount.
 *
 * The behavioural half — that the tick then actually produces those invoices
 * and posts them — is scripts/test-contracts.ts.
 */
import {
  escalationsDue,
  escalatedPrice,
  escalationsAppliedBy,
  duePeriods,
  nextBillingDate,
  nextEscalation,
  contractState,
  annualValue,
  contractTotal,
} from '../src/lib/contractModel'

let pass = 0
let fail = 0

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

console.log('\n── escalationsDue ──────────────────────────────────────────')

// Your stated case: start 2026-07-01, March escalation.
eq(
  'start Jul 2026, March esc — none by Dec 2026',
  escalationsDue({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01' }, '2026-12-31'),
  [],
)
eq(
  'start Jul 2026, March esc — one by Mar 2027',
  escalationsDue({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01' }, '2027-03-01'),
  ['2027-03-01'],
)
eq(
  'start Jul 2026, March esc — two by Mar 2028',
  escalationsDue({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01' }, '2028-03-15'),
  ['2027-03-01', '2028-03-01'],
)

// Signed IN the escalation month: must not raise immediately.
eq(
  'start Mar 2026, March esc — no raise in first month',
  escalationsDue({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-03-01' }, '2026-12-31'),
  [],
)
eq(
  'start Mar 2026, March esc — first raise Mar 2027',
  escalationsDue({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-03-01' }, '2027-06-30'),
  ['2027-03-01'],
)

// Already-applied ones are excluded.
eq(
  'lastEscalatedFor excludes what was applied',
  escalationsDue(
    { escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01', lastEscalatedFor: '2027-03-01' },
    '2028-06-30',
  ),
  ['2028-03-01'],
)

// Ended contract takes no further raises.
eq(
  'ended before the raise — none',
  escalationsDue(
    { escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01', endsOn: '2027-01-31' },
    '2028-06-30',
  ),
  [],
)

// No escalation configured.
eq(
  'zero pct — none',
  escalationsDue({ escalationPct: 0, escalationMonth: 3, startsOn: '2026-07-01' }, '2030-01-01'),
  [],
)
eq(
  'no month — none',
  escalationsDue({ escalationPct: 8, escalationMonth: null, startsOn: '2026-07-01' }, '2030-01-01'),
  [],
)

// Start month is January, escalation January — the boundary.
eq(
  'start Jan 2026, Jan esc — first raise Jan 2027',
  escalationsDue({ escalationPct: 10, escalationMonth: 1, startsOn: '2026-01-15' }, '2027-01-01'),
  ['2027-01-01'],
)

// Start December, escalation January — only one month apart.
eq(
  'start Dec 2026, Jan esc — raises Jan 2027',
  escalationsDue({ escalationPct: 10, escalationMonth: 1, startsOn: '2026-12-01' }, '2027-01-31'),
  ['2027-01-01'],
)

console.log('\n── escalatedPrice (compounding, rounded each step) ─────────')

eq('1000 @ 8% x0', escalatedPrice(1000, 8, 0), 1000)
eq('1000 @ 8% x1', escalatedPrice(1000, 8, 1), 1080)
eq('1000 @ 8% x2', escalatedPrice(1000, 8, 2), 1166.4)
eq('1000 @ 8% x3', escalatedPrice(1000, 8, 3), 1259.71)
// Rounding at each step, NOT once at the end. 333.33 → 356.66 → 381.63.
// Compounding on the unrounded 356.6631 would give 381.6295 → 381.63 here too,
// but the intermediate 356.66 is what last year's invoice actually said, and
// that is the figure year two must build on.
eq('333.33 @ 7% x1', escalatedPrice(333.33, 7, 1), 356.66)
eq('333.33 @ 7% x2 rounds per step', escalatedPrice(333.33, 7, 2), 381.63)
// Per-step and at-the-end genuinely diverge here: 0.05 → 0.08 → 0.12 → 0.18,
// whereas 0.05 * 1.5³ rounded once is 0.17. Per-step is the correct one —
// each year's price is a real invoice the next year must build on.
eq('0.05 @ 50% x3 per step', escalatedPrice(0.05, 50, 3), 0.18)

console.log('\n── back-dated billing uses the right price ─────────────────')

const terms = { escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01' }
// An invoice for Feb 2027 generated late must NOT carry the March raise.
eq('Feb 2027 invoice — 0 raises', escalationsAppliedBy(terms, '2027-02-01'), 0)
eq('Mar 2027 invoice — 1 raise', escalationsAppliedBy(terms, '2027-03-01'), 1)
eq('Apr 2028 invoice — 2 raises', escalationsAppliedBy(terms, '2028-04-01'), 2)

console.log('\n── duePeriods (catch-up) ───────────────────────────────────')

eq(
  'three missed months produce three periods',
  duePeriods(
    { frequency: 'monthly', billingDay: 1, startsOn: '2026-01-01', lastGeneratedFor: '2026-03-01' },
    '2026-06-15',
  ),
  ['2026-04-01', '2026-05-01', '2026-06-01'],
)
eq(
  'nothing due yet',
  duePeriods(
    { frequency: 'monthly', billingDay: 15, startsOn: '2026-01-15', lastGeneratedFor: '2026-06-15' },
    '2026-06-20',
  ),
  [],
)
eq(
  'first ever run bills the start period',
  duePeriods(
    { frequency: 'monthly', billingDay: 1, startsOn: '2026-01-01', lastGeneratedFor: null },
    '2026-01-05',
  ),
  ['2026-01-01'],
)
eq(
  'quarterly',
  duePeriods(
    { frequency: 'quarterly', billingDay: 1, startsOn: '2026-01-01', lastGeneratedFor: null },
    '2026-08-01',
  ),
  ['2026-01-01', '2026-04-01', '2026-07-01'],
)
eq(
  'stops at ends_on',
  duePeriods(
    {
      frequency: 'monthly', billingDay: 1, startsOn: '2026-01-01',
      endsOn: '2026-03-31', lastGeneratedFor: null,
    },
    '2026-12-01',
  ),
  ['2026-01-01', '2026-02-01', '2026-03-01'],
)

console.log('\n── the 31st in February ────────────────────────────────────')

eq(
  'billing day 31 clamps in Feb',
  duePeriods(
    { frequency: 'monthly', billingDay: 31, startsOn: '2026-01-31', lastGeneratedFor: '2026-01-31' },
    '2026-03-31',
  ),
  ['2026-02-28', '2026-03-31'],
)

console.log('\n── nextBillingDate / state / value ─────────────────────────')

eq(
  'next billing shows the future',
  nextBillingDate(
    { frequency: 'monthly', billingDay: 1, startsOn: '2026-01-01', lastGeneratedFor: '2026-06-01' },
    '2026-06-15',
  ),
  '2026-07-01',
)
eq('draft has no number', contractState({ isActive: true, contractNumber: null, startsOn: '2026-01-01' }, '2026-06-01'), 'draft')
eq('paused', contractState({ isActive: false, contractNumber: 'CON000001', startsOn: '2026-01-01' }, '2026-06-01'), 'paused')
eq('scheduled', contractState({ isActive: true, contractNumber: 'CON000001', startsOn: '2026-09-01' }, '2026-06-01'), 'scheduled')
eq('ended', contractState({ isActive: true, contractNumber: 'CON000001', startsOn: '2026-01-01', endsOn: '2026-05-31' }, '2026-06-01'), 'ended')
eq('active', contractState({ isActive: true, contractNumber: 'CON000001', startsOn: '2026-01-01' }, '2026-06-01'), 'active')

eq('annual value monthly', annualValue(1000, 'monthly'), 12000)
eq('annual value quarterly', annualValue(1000, 'quarterly'), 4000)
eq(
  'contract total',
  contractTotal([
    { description: 'Monitoring', qty: 2, unitPriceIncl: 150.5, vatRatePct: 15 },
    { description: 'Callout', qty: 1, unitPriceIncl: 99.99, vatRatePct: 15 },
  ]),
  400.99,
)

console.log('\n── nextEscalation ──────────────────────────────────────────')
eq(
  'next raise from 1000 @ 8%',
  nextEscalation({ escalationPct: 8, escalationMonth: 3, startsOn: '2026-07-01' }, 1000, '2026-12-01'),
  { on: '2027-03-01', from: 1000, to: 1080 },
)
eq(
  'no escalation configured',
  nextEscalation({ escalationPct: 0, escalationMonth: null, startsOn: '2026-07-01' }, 1000, '2026-12-01'),
  null,
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
