/**
 * Bulk repricing arithmetic.
 *
 * Pure functions, no database — this is the file that has to be right, because
 * a rounding error here is applied to every price in the shop at once and looks
 * completely plausible on the way through.
 *
 *   npm run test:repricing
 */
import { applyRule, applyEnding, applyRounding } from '../src/lib/repricing'
import { removeVat, addVat, markupPercent, gpPercent } from '../src/lib/pricing'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const near = (a: number, b: number, tol = 0.0001) => Math.abs(a - b) < tol

const VAT = 15

/* ── Endings ─────────────────────────────────────────────────────────────── */

// The three directions differ only for a value BETWEEN two endings. 14.32 sits
// between 13.99 and 14.99, and is nearer the lower one — so 'nearest' and 'up'
// genuinely disagree here, which is the whole reason this is a setting.
ok("up:      14.32 → 14.99", applyEnding(14.32, 99, 'up') === 14.99, String(applyEnding(14.32, 99, 'up')))
ok("down:    14.32 → 13.99", applyEnding(14.32, 99, 'down') === 13.99, String(applyEnding(14.32, 99, 'down')))
ok("nearest: 14.32 → 13.99", applyEnding(14.32, 99, 'nearest') === 13.99, String(applyEnding(14.32, 99, 'nearest')))
ok("nearest: 14.72 → 14.99", applyEnding(14.72, 99, 'nearest') === 14.99, String(applyEnding(14.72, 99, 'nearest')))

ok('up never lands below its input', applyEnding(15.1, 99, 'up') === 15.99, String(applyEnding(15.1, 99, 'up')))
ok('down never lands above its input', applyEnding(15.6, 99, 'down') === 14.99, String(applyEnding(15.6, 99, 'down')))
ok('up defaults when no direction is given', applyEnding(14.32, 99) === applyEnding(14.32, 99, 'up'))

ok('a .00 ending gives whole rand', applyEnding(14.62, 0, 'up') === 15, String(applyEnding(14.62, 0, 'up')))
ok('a .95 ending rounds up', applyEnding(20.4, 95, 'up') === 20.95, String(applyEnding(20.4, 95, 'up')))
ok('a .95 ending rounds down', applyEnding(20.4, 95, 'down') === 19.95, String(applyEnding(20.4, 95, 'down')))

// A price already sitting exactly on the ending must never move, in any
// direction — otherwise re-running the same rule walks every price up a rand.
for (const dir of ['up', 'down', 'nearest'] as const) {
  ok(`${dir}: 14.99 already on the ending stays put`, applyEnding(14.99, 99, dir) === 14.99, String(applyEnding(14.99, 99, dir)))
}
ok('idempotent: applying twice equals applying once', applyEnding(applyEnding(14.32, 99, 'up'), 99, 'up') === applyEnding(14.32, 99, 'up'))

// Bounds: up is never below the input, down never above, and neither is ever
// more than a rand away. Swept across a full rand of inputs.
let bad = 0
for (let c = 0; c < 100; c++) {
  const v = round(14 + c / 100, 2)
  const up = applyEnding(v, 99, 'up')
  const down = applyEnding(v, 99, 'down')
  if (up < v - 0.0001) bad++
  if (down > v + 0.0001) bad++
  if (Math.abs(up - v) > 1.0001 || Math.abs(down - v) > 1.0001) bad++
}
ok('up stays at-or-above and down at-or-below, within a rand', bad === 0, `${bad} violations`)
// Below the ending itself there is no lower rand to sit on.
ok('0.40 with a .99 ending does not go negative', applyEnding(0.4, 99) === 0.99, String(applyEnding(0.4, 99)))

ok('nearest 0.05 rounds 14.32 to 14.30', near(applyRounding(14.32, { kind: 'nearest', step: 0.05 }), 14.3))
ok('nearest 1 rounds 14.62 to 15', near(applyRounding(14.62, { kind: 'nearest', step: 1 }), 15))
ok('a zero step does not divide by zero', Number.isFinite(applyRounding(14.32, { kind: 'nearest', step: 0 })))
ok('none leaves the value alone', applyRounding(14.3271, { kind: 'none' }) === 14.3271)

/* ── Markup and GP ───────────────────────────────────────────────────────── */

// A 40% markup on R100 cost is R140 excl, R161 incl.
const m = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('40% markup on R100 gives R161 incl', m.ok && near(m.priceIncl, 161), m.ok ? String(m.priceIncl) : m.reason)
ok('and R140 excl', m.ok && near(m.priceExcl, 140), m.ok ? String(m.priceExcl) : '')

// The round trip that matters: the stored inclusive price must yield back the
// markup that was asked for.
if (m.ok) {
  const backExcl = removeVat(m.priceIncl, VAT)
  ok('markup round-trips out of the inclusive price', near(markupPercent(100, backExcl), 40, 0.01), String(markupPercent(100, backExcl)))
}

// A 25% GP on R75 cost is R100 excl — profit is a quarter of the SELL.
const g = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'gp', percent: 25 }, rounding: { kind: 'none' } },
  { costExcl: 75, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('25% GP on R75 cost gives R100 excl', g.ok && near(g.priceExcl, 100), g.ok ? String(g.priceExcl) : g.reason)
if (g.ok) {
  ok('GP round-trips', near(gpPercent(75, removeVat(g.priceIncl, VAT)), 25, 0.01))
}

// The classic confusion, pinned down: 100% markup === 50% GP.
const m100 = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 100 }, rounding: { kind: 'none' } },
  { costExcl: 50, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
const g50 = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'gp', percent: 50 }, rounding: { kind: 'none' } },
  { costExcl: 50, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok(
  '100% markup equals 50% GP',
  m100.ok && g50.ok && near(m100.priceIncl, g50.priceIncl),
  m100.ok && g50.ok ? `${m100.priceIncl} vs ${g50.priceIncl}` : '',
)

const impossible = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'gp', percent: 100 }, rounding: { kind: 'none' } },
  { costExcl: 50, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('a 100% GP is refused, not infinite', !impossible.ok, impossible.ok ? String(impossible.priceIncl) : impossible.reason)

/* ── Pricing off another structure ───────────────────────────────────────── */

// 10% off a R230 retail price is R207.
const adj = applyRule(
  {
    source: { kind: 'structure', structureId: 1 },
    method: { kind: 'adjust', percent: -10 },
    rounding: { kind: 'none' },
    floorAtCost: false,
  },
  { costExcl: 100, sourceIncl: 230, sellingVatPercent: VAT, currentIncl: null },
)
ok('-10% off R230 gives R207', adj.ok && near(adj.priceIncl, 207), adj.ok ? String(adj.priceIncl) : adj.reason)

// Markup off a structure is meaningless and must not silently mean cost.
const wrong = applyRule(
  {
    source: { kind: 'structure', structureId: 1 },
    method: { kind: 'markup', percent: 40 },
    rounding: { kind: 'none' },
  },
  { costExcl: 100, sourceIncl: 230, sellingVatPercent: VAT, currentIncl: null },
)
ok('markup against a structure is refused', !wrong.ok, wrong.ok ? 'ALLOWED' : wrong.reason)

/* ── The VAT trap ────────────────────────────────────────────────────────── */

// Rounding must land on the INCLUSIVE price. If a .99 ending were applied to
// the exclusive figure and VAT added after, the shelf price would be 17.24.
const ending = applyRule(
  {
    source: { kind: 'cost' },
    method: { kind: 'markup', percent: 30 },
    rounding: { kind: 'ending', cents: 99, direction: 'up' },
  },
  { costExcl: 11.5, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('a .99 ending lands on the shelf price', ending.ok && String(ending.priceIncl).endsWith('.99'), ending.ok ? String(ending.priceIncl) : ending.reason)
ok('and the exclusive figure is whatever it needs to be', ending.ok && !near(ending.priceExcl, round(ending.priceExcl, 0)))

/* ── Guards ──────────────────────────────────────────────────────────────── */

const noCost = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 0, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('a product with no cost is skipped, not priced at zero', !noCost.ok, noCost.ok ? String(noCost.priceIncl) : noCost.reason)

const noSource = applyRule(
  {
    source: { kind: 'structure', structureId: 2 },
    method: { kind: 'adjust', percent: -10 },
    rounding: { kind: 'none' },
  },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('a missing source price is skipped', !noSource.ok, noSource.ok ? '' : noSource.reason)

// The floor exists for the case where the arithmetic lands under cost. Half of
// a R200 retail price is R100 incl, against a cost of R100 excl (R115 incl) —
// unambiguously a loss.
const underCost = applyRule(
  {
    source: { kind: 'structure', structureId: 1 },
    method: { kind: 'adjust', percent: -50 },
    rounding: { kind: 'none' },
  },
  { costExcl: 100, sourceIncl: 200, sellingVatPercent: VAT, currentIncl: null },
)
ok(
  'a price landing under cost is refused by default',
  !underCost.ok,
  underCost.ok ? String(underCost.priceIncl) : underCost.reason,
)

const allowedBelow = applyRule(
  {
    source: { kind: 'structure', structureId: 1 },
    method: { kind: 'adjust', percent: -50 },
    rounding: { kind: 'none' },
    floorAtCost: false,
  },
  { costExcl: 100, sourceIncl: 200, sellingVatPercent: VAT, currentIncl: null },
)
ok('...but allowed when the floor is turned off', allowedBelow.ok, allowedBelow.ok ? String(allowedBelow.priceIncl) : allowedBelow.reason)

const negative = applyRule(
  {
    source: { kind: 'structure', structureId: 1 },
    method: { kind: 'adjust', percent: -150 },
    rounding: { kind: 'none' },
    floorAtCost: false,
  },
  { costExcl: 10, sourceIncl: 100, sellingVatPercent: VAT, currentIncl: null },
)
ok('an adjustment past -100% is refused', !negative.ok, negative.ok ? String(negative.priceIncl) : negative.reason)

/* ── changed flag ────────────────────────────────────────────────────────── */

const same = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: VAT, currentIncl: 161 },
)
ok('a price already at the target is not counted as changing', same.ok && !same.changed)

const diff = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: VAT, currentIncl: 150 },
)
ok('a different price is counted as changing', diff.ok && diff.changed)

const fresh = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: VAT, currentIncl: null },
)
ok('a product with no price yet counts as changing', fresh.ok && fresh.changed)

/* ── Zero-VAT products ───────────────────────────────────────────────────── */

const zeroVat = applyRule(
  { source: { kind: 'cost' }, method: { kind: 'markup', percent: 40 }, rounding: { kind: 'none' } },
  { costExcl: 100, sourceIncl: null, sellingVatPercent: 0, currentIncl: null },
)
ok('a zero-rated product prices at the exclusive figure', zeroVat.ok && near(zeroVat.priceIncl, 140), zeroVat.ok ? String(zeroVat.priceIncl) : zeroVat.reason)
ok('and incl equals excl there', zeroVat.ok && near(zeroVat.priceIncl, zeroVat.priceExcl))

console.log(fails === 0 ? '\nAll passed.' : `\n${fails} FAILED.`)
process.exit(fails === 0 ? 0 : 1)
