/**
 * The credit control rules — the pure ones.
 *
 * No database. These are the judgement calls, and what breaks if they slip:
 *
 *   ESCALATION MUST ESCALATE. An account that has had level 2 gets level 3 or
 *   nothing. Sending reminder two twice is how a debtor learns the reminders
 *   are automated and safe to ignore.
 *
 *   A PROMISE STOPS THE CHASE. They said Friday. Chasing on Wednesday tells a
 *   customer their word counts for nothing, and it is the fastest way to turn
 *   a slow payer into an angry one.
 *
 *   GRACE IS REAL. A promise paid on the day is kept, not broken by a run that
 *   happened that morning.
 *
 *   SILENCE IS NEVER THE ANSWER. Every skipped account carries a reason, because
 *   "why was this one not chased" is the whole job of the review screen.
 */

import {
  decideLevel,
  promiseState,
  promiseShortfall,
  reliability,
  riskBand,
  limitUsage,
  renderTemplate,
  daysBetween,
  addDays,
  type DunningLevel,
  type CreditPosition,
} from '../src/lib/creditModel'

let passed = 0
let failed = 0

function check(what: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    passed++
    console.log(`  ok   ${what}`)
  } else {
    failed++
    console.log(`  FAIL ${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function level(step: number, days: number, over: Partial<DunningLevel> = {}): DunningLevel {
  return {
    id: step,
    step,
    name: `Level ${step}`,
    minDaysOverdue: days,
    minAmount: 50,
    subject: 's',
    body: 'b',
    blocksAccount: step >= 3,
    requiresCall: step >= 3,
    isActive: true,
    ...over,
  }
}

const LADDER = [level(1, 7), level(2, 30), level(3, 60)]

function position(over: Partial<CreditPosition> = {}): CreditPosition {
  return {
    overdueAmount: 5000,
    oldestDays: 45,
    currentLevel: 0,
    lastDunnedAt: null,
    pausedUntil: null,
    hasOpenPromise: false,
    isDisputed: false,
    ...over,
  }
}

const OPTS = { asAt: '2026-08-06', minGapDays: 7 }

/* ── Escalation ──────────────────────────────────────────────────────────── */

section('The ladder climbs, and never repeats a rung')

check(
  'a never-chased account 45 days over gets the highest level it qualifies for',
  decideLevel(position(), LADDER, OPTS),
  { chase: true, level: level(2, 30) },
)

check(
  'having had level 2, the same account is not sent level 2 again',
  decideLevel(position({ currentLevel: 2 }), LADDER, OPTS).chase,
  false,
)

check(
  '…and the reason says it is not old enough to climb, not that it is fine',
  decideLevel(position({ currentLevel: 2 }), LADDER, OPTS),
  { chase: false, reason: 'no-level' },
)

check(
  'once it reaches 60 days it climbs to the final demand',
  decideLevel(position({ currentLevel: 2, oldestDays: 60 }), LADDER, OPTS),
  { chase: true, level: level(3, 60) },
)

check(
  'an account at the top of the ladder is left alone',
  decideLevel(position({ currentLevel: 3, oldestDays: 200 }), LADDER, OPTS),
  { chase: false, reason: 'top-of-ladder' },
)

// The one that matters most: an account nobody chased for months should get
// the final demand, not restart at a friendly reminder and take another two
// months to arrive there.
check(
  'a long-ignored account jumps straight to the level it has earned',
  decideLevel(position({ oldestDays: 120, currentLevel: 0 }), LADDER, OPTS),
  { chase: true, level: level(3, 60) },
)

section('The four things that stop a chase')

check(
  'nothing overdue is not chased',
  decideLevel(position({ overdueAmount: 0, oldestDays: 0 }), LADDER, OPTS),
  { chase: false, reason: 'nothing-overdue' },
)

check(
  'an open promise stops it',
  decideLevel(position({ hasOpenPromise: true }), LADDER, OPTS),
  { chase: false, reason: 'promise-open' },
)

check(
  'a dispute stops it',
  decideLevel(position({ isDisputed: true }), LADDER, OPTS),
  { chase: false, reason: 'disputed' },
)

check(
  'a pause stops it while the pause lasts',
  decideLevel(position({ pausedUntil: '2026-08-31' }), LADDER, OPTS),
  { chase: false, reason: 'paused' },
)

check(
  '…and stops stopping it the day after it expires',
  decideLevel(position({ pausedUntil: '2026-08-05' }), LADDER, OPTS).chase,
  true,
)

check(
  'a letter three days ago blocks another one',
  decideLevel(position({ lastDunnedAt: '2026-08-03' }), LADDER, OPTS),
  { chase: false, reason: 'too-soon' },
)

check(
  '…but one eight days ago does not',
  decideLevel(position({ lastDunnedAt: '2026-07-29' }), LADDER, OPTS).chase,
  true,
)

check(
  'a trivial amount is below the threshold, and says so',
  decideLevel(position({ overdueAmount: 12 }), LADDER, OPTS),
  { chase: false, reason: 'below-threshold' },
)

check(
  'an inactive ladder chases nobody',
  decideLevel(position(), LADDER.map((l) => ({ ...l, isActive: false })), OPTS),
  { chase: false, reason: 'no-level' },
)

check(
  'no levels configured at all is a reason, not a crash',
  decideLevel(position(), [], OPTS),
  { chase: false, reason: 'no-level' },
)

/* ── Promises ────────────────────────────────────────────────────────────── */

section('A promise is judged by the calendar and the money')

const promise = {
  status: 'open' as const,
  promisedDate: '2026-08-10',
  promisedAmount: 5000,
  receivedAmount: 0,
  graceDays: 2,
}

check(
  'before the date it is simply open',
  promiseState({ ...promise, asAt: '2026-08-06' }),
  'open',
)

check(
  'on the day it is due, not broken',
  promiseState({ ...promise, asAt: '2026-08-10' }),
  'due-today',
)

check(
  'inside the grace window it is still not broken',
  promiseState({ ...promise, asAt: '2026-08-12' }),
  'due-today',
)

check(
  'past grace, it is broken',
  promiseState({ ...promise, asAt: '2026-08-13' }),
  'broken',
)

check(
  'money arriving settles it whatever the date',
  promiseState({ ...promise, receivedAmount: 5000, asAt: '2026-09-30' }),
  'kept',
)

check(
  'a part payment does NOT settle it',
  promiseState({ ...promise, receivedAmount: 4999, asAt: '2026-08-13' }),
  'broken',
)

check(
  'a promise already settled by hand stays settled',
  promiseState({ ...promise, status: 'kept', asAt: '2026-12-01' }),
  'kept',
)

check('a shortfall is what is left', promiseShortfall(5000, 1500), 3500)
check('an overpayment leaves no shortfall, not a negative one', promiseShortfall(5000, 6000), 0)

section('Reliability is a record, not an opinion')

check('no promises decided yet is not a bad record', reliability({ kept: 0, broken: 0 }), {
  rate: null,
  decided: 0,
})
check('three of four kept', reliability({ kept: 3, broken: 1 }), { rate: 75, decided: 4 })
check('open promises do not count either way', reliability({ kept: 2, broken: 2 }), {
  rate: 50,
  decided: 4,
})

/* ── Risk ────────────────────────────────────────────────────────────────── */

section('Risk names the fact that caused it')

const clean = {
  oldestDays: 0,
  overdueAmount: 0,
  balance: 1000,
  creditLimit: 10000,
  promisesBroken: 0,
  dunningLevel: 0,
}

check('a clean account is good', riskBand(clean), { band: 'good', reason: 'Nothing overdue' })

check('three broken promises is the worst signal there is', riskBand({ ...clean, promisesBroken: 3 }), {
  band: 'bad',
  reason: '3 promises broken',
})

check('90 days is bad', riskBand({ ...clean, oldestDays: 90, overdueAmount: 100 }), {
  band: 'bad',
  reason: '90 days overdue',
})

check('one broken promise is poor', riskBand({ ...clean, promisesBroken: 1 }), {
  band: 'poor',
  reason: '1 promise broken',
})

check(
  'over the limit is poor even when nothing is late',
  riskBand({ ...clean, balance: 12000 }),
  { band: 'poor', reason: 'Over its credit limit' },
)

check('30 days is worth watching', riskBand({ ...clean, oldestDays: 30, overdueAmount: 100 }), {
  band: 'watch',
  reason: '30 days overdue',
})

check('limit usage', limitUsage(5000, 10000), 50)
check('no limit set is not 0%', limitUsage(5000, 0), null)
check('over the limit is not flattened to 100', limitUsage(15000, 10000), 150)

/* ── Templates ───────────────────────────────────────────────────────────── */

section('An unknown token is left visible, not silently blanked')

check(
  'known tokens are substituted',
  renderTemplate('Hi {customer}, you owe {overdue}.', {
    customer: 'Harbour Cafe',
    overdue: 'R 5 000.00',
  }),
  'Hi Harbour Cafe, you owe R 5 000.00.',
)

check(
  'a typo is left as written rather than becoming a hole in the sentence',
  renderTemplate('You owe {ovrdue}.', { overdue: 'R 5 000.00' }),
  'You owe {ovrdue}.',
)

check(
  'a token used twice is replaced twice',
  renderTemplate('{customer}, {customer}', { customer: 'A' }),
  'A, A',
)

/* ── Dates ───────────────────────────────────────────────────────────────── */

section('Dates are calendar days, not instants')

check('days between', daysBetween('2026-08-01', '2026-08-06'), 5)
check('backwards is negative', daysBetween('2026-08-06', '2026-08-01'), -5)
check('across a month end', daysBetween('2026-07-28', '2026-08-04'), 7)
check('add days crosses a month', addDays('2026-08-30', 5), '2026-09-04')
check('add days crosses a year', addDays('2026-12-30', 3), '2027-01-02')
check('a garbage date does not throw', daysBetween('not-a-date', '2026-08-06'), 0)

/* ── Result ──────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(`\n${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('\nAll credit model rules hold.')
