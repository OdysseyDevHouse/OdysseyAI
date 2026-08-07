/**
 * Commission — bases, marginal tiers, precedence, clawback, locking.
 *
 *   npm run test:commission
 *
 * The arithmetic here decides what people are PAID, so it is tested directly
 * rather than through a screen. Two properties matter more than the rest:
 *
 *   MARGINAL TIERS. Crossing a threshold must re-rate only the slice above it.
 *   A retroactive tier makes R249,999 vs R250,001 worth thousands and turns
 *   the last week of every period into a game.
 *
 *   A LOCKED RUN NEVER MOVES. Once someone has been paid, editing a rule or
 *   correcting a cost must not change what the statement says was paid.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { round } from '../src/lib/decimals'
import {
  createRule,
  updateRule,
  deleteRule,
  listRules,
  rateForSlice,
  ruleForLine,
  defaultPriority,
  type CommissionRule,
} from '../src/lib/site/commission'
import {
  createRun,
  calculateRun,
  lockRun,
  unlockRun,
  getRun,
  runSummary,
  statement,
} from '../src/lib/site/commissionRuns'

const SITE = 1
let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function eq(label: string, actual: number, expected: number, tolerance = 0.005) {
  const ok = Math.abs(actual - expected) <= tolerance
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} — got ${actual}, expected ${expected}`)
  if (!ok) failures++
}

/** A rule shaped just enough for the pure arithmetic helpers. */
function rule(over: Partial<CommissionRule> = {}): CommissionRule {
  return {
    id: 1,
    name: 'Test',
    priority: 100,
    basis: 'gross_profit',
    departmentId: null,
    departmentName: null,
    productId: null,
    productCode: null,
    brandId: null,
    brandName: null,
    supplierId: null,
    supplierName: null,
    userId: null,
    userName: null,
    isExclusion: false,
    ratePct: 0,
    threshold: 0,
    isActive: true,
    tiers: [],
    ...over,
  }
}

const createdRules: number[] = []
const createdRuns: number[] = []

async function main() {
  /* ── Flat rate ─────────────────────────────────────────────────────── */
  console.log('\nflat rate')
  eq('10% of 1000', rateForSlice(rule({ ratePct: 10 }), 0, 1000).amount, 100)
  eq('8.5% of 1240', rateForSlice(rule({ ratePct: 8.5 }), 0, 1240).amount, 105.4)
  eq('0% earns nothing', rateForSlice(rule({ ratePct: 0 }), 0, 1000).amount, 0)

  /* ── Marginal tiers ────────────────────────────────────────────────── */
  //
  // The Sage Pastel worked example, which many users will recognise:
  // bands at 0 @ 5% and 10,000 @ 7.5%; a 16,000 total pays 500 + 450 = 950.
  console.log('\nmarginal tiers')
  const tiered = rule({
    tiers: [
      { fromAmount: 0, ratePct: 5 },
      { fromAmount: 10000, ratePct: 7.5 },
    ],
  })

  eq('entirely in band 1', rateForSlice(tiered, 0, 5000).amount, 250)
  eq('exactly at the boundary', rateForSlice(tiered, 0, 10000).amount, 500)
  eq('straddling the boundary', rateForSlice(tiered, 0, 16000).amount, 500 + 6000 * 0.075)
  eq('starting above the boundary', rateForSlice(tiered, 12000, 1000).amount, 75)

  // The property that makes it marginal rather than retroactive: selling the
  // same total in two goes must pay exactly what selling it in one go pays.
  const inOneGo = rateForSlice(tiered, 0, 16000).amount
  const first = rateForSlice(tiered, 0, 9000).amount
  const second = rateForSlice(tiered, 9000, 7000).amount
  eq('split across two sales pays the same', round(first + second, 2), inOneGo)

  // And the anti-property: it must NOT re-rate what came before.
  const retroactive = 16000 * 0.075
  check(
    'crossing a tier does not re-rate the whole amount',
    inOneGo < retroactive,
    `marginal ${inOneGo} < retroactive ${round(retroactive, 2)}`,
  )

  const threeBand = rule({
    tiers: [
      { fromAmount: 0, ratePct: 2 },
      { fromAmount: 50000, ratePct: 4 },
      { fromAmount: 100000, ratePct: 6 },
    ],
  })
  eq(
    'spanning three bands',
    rateForSlice(threeBand, 0, 120000).amount,
    50000 * 0.02 + 50000 * 0.04 + 20000 * 0.06,
  )

  /* ── Thresholds ────────────────────────────────────────────────────── */
  console.log('\nthresholds')
  const withThreshold = rule({ ratePct: 10, threshold: 5000 })
  eq('nothing below the threshold', rateForSlice(withThreshold, 0, 4000).amount, 0)
  eq('only the excess above it', rateForSlice(withThreshold, 0, 6000).amount, 100)
  eq('fully above it', rateForSlice(withThreshold, 8000, 1000).amount, 100)

  /* ── Clawback ──────────────────────────────────────────────────────── */
  console.log('\nclawback')
  eq('a credit reverses at the flat rate', rateForSlice(rule({ ratePct: 10 }), 5000, -1000).amount, -100)
  check(
    'a credit is negative',
    rateForSlice(rule({ ratePct: 10 }), 5000, -1000).amount < 0,
  )

  /* ── Precedence ────────────────────────────────────────────────────── */
  console.log('\nprecedence')
  const rules: CommissionRule[] = [
    rule({ id: 1, name: 'Product', priority: 10, productId: 500, ratePct: 15 }),
    rule({ id: 2, name: 'Department', priority: 40, departmentId: 7, ratePct: 8 }),
    rule({ id: 3, name: 'Everything', priority: 100, ratePct: 2 }),
  ]
  const line = {
    productId: 500,
    departmentId: 7,
    departmentPath: [7],
    brandId: null,
    supplierIds: [],
    userId: 1,
  }
  check('the most specific rule wins', ruleForLine(rules, line)?.name === 'Product')
  check(
    'department beats the catch-all',
    ruleForLine(rules, { ...line, productId: 999 })?.name === 'Department',
  )
  check(
    'the catch-all still applies',
    ruleForLine(rules, { ...line, productId: 999, departmentId: 99, departmentPath: [99] })?.name ===
      'Everything',
  )
  check('nothing matches when no rule does', ruleForLine([rules[0]], { ...line, productId: 1 }) === null)

  // Priority is explicit, so a broad rule CAN be made to beat a narrow one.
  const overridden = ruleForLine(
    [rule({ id: 9, name: 'Promo', priority: 1, ratePct: 20 }), ...rules],
    line,
  )
  check('an explicit priority beats specificity', overridden?.name === 'Promo')

  check(
    'a parent department covers its children',
    ruleForLine(rules, { ...line, productId: 999, departmentId: 12, departmentPath: [12, 7] })?.name ===
      'Department',
  )

  const excluded = ruleForLine(
    [rule({ id: 8, name: 'Not this', priority: 5, productId: 500, isExclusion: true }), ...rules],
    line,
  )
  check('an exclusion rule earns nothing', excluded === null)

  console.log('\ndefault priority')
  check('product is most specific', defaultPriority({ productId: 1 }) < defaultPriority({ brandId: 1 }))
  check('brand beats department', defaultPriority({ brandId: 1 }) < defaultPriority({ departmentId: 1 }))
  check('an unscoped rule is last', defaultPriority({}) === 100)

  /* ── Persistence and validation ────────────────────────────────────── */
  console.log('\nrules')
  const made = await createRule(SITE, {
    name: 'Test Furniture',
    priority: null,
    basis: 'gross_profit',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: null,
    isExclusion: false,
    ratePct: 8,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  check('a rule can be created', made.ok, made.ok ? '' : made.error)
  if (made.ok) createdRules.push(made.id)

  const badTiers = await createRule(SITE, {
    name: 'Test Bad Tiers',
    priority: null,
    basis: 'turnover',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: null,
    isExclusion: false,
    ratePct: 5,
    threshold: 0,
    isActive: true,
    tiers: [{ fromAmount: 1000, ratePct: 5 }],
  })
  check('tiers must start at 0', !badTiers.ok, badTiers.ok ? '' : badTiers.error)
  if (badTiers.ok) createdRules.push(badTiers.id)

  const badRate = await createRule(SITE, {
    name: 'Test Bad Rate',
    priority: null,
    basis: 'turnover',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: null,
    isExclusion: false,
    ratePct: 150,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  check('a rate above 100% is refused', !badRate.ok)
  if (badRate.ok) createdRules.push(badRate.id)

  if (made.ok) {
    const withTiers = await updateRule(SITE, made.id, {
      name: 'Test Furniture',
      priority: 40,
      basis: 'gross_profit',
      departmentId: null,
      productId: null,
      brandId: null,
      supplierId: null,
      userId: null,
      isExclusion: false,
      ratePct: 8,
      threshold: 0,
      isActive: true,
      tiers: [
        { fromAmount: 0, ratePct: 5 },
        { fromAmount: 10000, ratePct: 7.5 },
      ],
    })
    check('tiers can be added to a rule', withTiers.ok)

    const reloaded = (await listRules(SITE)).find((r) => r.id === made.id)
    check('tiers persist and come back sorted', reloaded?.tiers.length === 2)
    check('the first tier is the 5% band', reloaded?.tiers[0].ratePct === 5)
  }

  /* ── Runs ──────────────────────────────────────────────────────────── */
  console.log('\nruns')
  const run = await createRun(SITE, '2020-01-01', '2020-01-31', 'Test run')
  check('a run can be opened', run.ok, run.ok ? '' : run.error)
  if (!run.ok) throw new Error('cannot continue without a run')
  createdRuns.push(run.id)

  const overlap = await createRun(SITE, '2020-01-15', '2020-02-15', null)
  check('an overlapping run is refused', !overlap.ok, overlap.ok ? '' : overlap.error)
  if (overlap.ok) createdRuns.push(overlap.id)

  const backwards = await createRun(SITE, '2020-03-31', '2020-03-01', null)
  check('a backwards period is refused', !backwards.ok)
  if (backwards.ok) createdRuns.push(backwards.id)

  const calc = await calculateRun(SITE, run.id)
  check('an empty period calculates cleanly', calc.ok, calc.ok ? `${calc.entries} entries` : calc.error)

  const beforeLock = await getRun(SITE, run.id)
  check('calculating stamps calculated_at', !!beforeLock?.calculatedAt)

  const locked = await lockRun(SITE, run.id, { userId: 1, userName: 'Test' })
  check('a calculated run can be locked', locked.ok, locked.ok ? '' : locked.error)

  const afterLock = await getRun(SITE, run.id)
  check('the run reads as locked', afterLock?.status === 'locked')
  check('it records who locked it', afterLock?.lockedByName === 'Test')

  const recalc = await calculateRun(SITE, run.id)
  check(
    'a LOCKED run refuses to recalculate',
    !recalc.ok,
    recalc.ok ? 'IT RECALCULATED — figures can move after payment' : recalc.error,
  )

  const relock = await lockRun(SITE, run.id, { userId: 1, userName: 'Test' })
  check('locking twice is refused', !relock.ok)

  const reopened = await unlockRun(SITE, run.id)
  check('a locked run can be deliberately reopened', reopened.ok)
  check('and then recalculates again', (await calculateRun(SITE, run.id)).ok)

  const emptyRun = await createRun(SITE, '2020-05-01', '2020-05-31', null)
  if (emptyRun.ok) {
    createdRuns.push(emptyRun.id)
    const early = await lockRun(SITE, emptyRun.id, { userId: 1, userName: 'Test' })
    check('an uncalculated run cannot be locked', !early.ok, early.ok ? '' : early.error)
  }

  const summary = await runSummary(SITE, run.id)
  check('a summary can be read', Array.isArray(summary))
  const lines = await statement(SITE, run.id, 1)
  check('a statement can be read', Array.isArray(lines))

  /* ── End to end, against real posted sales ─────────────────────────── */
  //
  // Everything above proves the arithmetic in isolation. This proves the part
  // that isolation cannot: that a real invoice, with a real cost snapshot and
  // a real credit note against it, produces the figures we expect.
  console.log('\nend to end')

  const product = await siteQueryOne<{ id: number; code: string; department_id: number | null }>(
    SITE,
    `SELECT id, code, department_id FROM products WHERE is_archived = 0 LIMIT 1`,
  )
  const user = await siteQueryOne<{ id: number; name: string }>(
    SITE,
    'SELECT id, name FROM users WHERE is_active = 1 ORDER BY id LIMIT 1',
  )
  if (!product || !user) {
    check('a product and a user exist to test with', false)
    return
  }

  // 10% of gross profit, everything in scope, so the expected figure is
  // arithmetic anyone can check by hand.
  const e2eRule = await createRule(SITE, {
    name: 'Test E2E',
    priority: 1,
    basis: 'gross_profit',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: user.id,
    isExclusion: false,
    ratePct: 10,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  if (!e2eRule.ok) {
    check('the end-to-end rule was created', false, e2eRule.error)
    return
  }
  createdRules.push(e2eRule.id)

  const e2eRun = await createRun(SITE, '2019-06-01', '2019-06-30', 'E2E')
  if (!e2eRun.ok) {
    check('the end-to-end run was created', false, e2eRun.error)
    return
  }
  createdRuns.push(e2eRun.id)

  // Posted directly rather than through saveDraft/finalise: this suite is about
  // commission, and driving the whole posting path would make a failure here
  // ambiguous between the two.
  const inv = await siteExecute(
    SITE,
    `INSERT INTO sales_documents
       (doc_type, status, document_number, document_date, user_id, user_name,
        subtotal_excl, vat_total, total_incl)
     VALUES ('invoice','finalised','TESTC0001','2019-06-15',?,?,1000,150,1150)`,
    [user.id, user.name],
  )
  const invLine = await siteExecute(
    SITE,
    `INSERT INTO sales_document_lines
       (document_id, line_number, product_id, product_code, description, department_id,
        sales_rep_user_id, qty, unit_price_incl, vat_rate_pct,
        line_total_incl, line_total_excl, line_vat, unit_cost_excl)
     VALUES (?,1,?,?,'E2E test line',?,?,1,1150,15,1150,1000,150,400)`,
    [inv.insertId, product.id, product.code, product.department_id, user.id],
  )

  const e2e = await calculateRun(SITE, e2eRun.id)
  check('the run calculated', e2e.ok, e2e.ok ? `${e2e.entries} entries` : e2e.error)
  // Profit = 1000 excl - 400 cost = 600. At 10% that is 60.
  if (e2e.ok) eq('10% of a R600 profit', e2e.total, 60)

  const e2eLines = await statement(SITE, e2eRun.id, user.id)
  check('the statement shows the line', e2eLines.length === 1)
  if (e2eLines.length) {
    eq('the base is the profit, not the turnover', e2eLines[0].baseAmount, 600)
    check('the rule name is snapshotted', e2eLines[0].ruleName === 'Test E2E')
  }

  // Turnover instead of profit, on the same sale: 10% of 1000 = 100.
  await updateRule(SITE, e2eRule.id, {
    name: 'Test E2E',
    priority: 1,
    basis: 'turnover',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: user.id,
    isExclusion: false,
    ratePct: 10,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  const turnover = await calculateRun(SITE, e2eRun.id)
  if (turnover.ok) eq('the same sale on a turnover basis', turnover.total, 100)

  check(
    'turnover pays more than profit on a discounted sale',
    (turnover.ok ? turnover.total : 0) > (e2e.ok ? e2e.total : 0),
  )

  // Back to profit, then credit half the sale and confirm the clawback lands
  // on the ORIGINAL rep rather than on whoever raised the credit.
  await updateRule(SITE, e2eRule.id, {
    name: 'Test E2E',
    priority: 1,
    basis: 'gross_profit',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: user.id,
    isExclusion: false,
    ratePct: 10,
    threshold: 0,
    isActive: true,
    tiers: [],
  })

  const cn = await siteExecute(
    SITE,
    `INSERT INTO sales_documents
       (doc_type, status, document_number, document_date, user_id, user_name,
        reverses_id, subtotal_excl, vat_total, total_incl)
     VALUES ('credit_sale','finalised','TESTCN001','2019-06-20',?,?,?,-500,-75,-575)`,
    [user.id, user.name, inv.insertId],
  )
  await siteExecute(
    SITE,
    `INSERT INTO sales_document_lines
       (document_id, line_number, product_id, product_code, description, department_id,
        source_line_id, sales_rep_user_id, qty, unit_price_incl, vat_rate_pct,
        line_total_incl, line_total_excl, line_vat, unit_cost_excl)
     VALUES (?,1,?,?,'E2E credit',?,?,?,-0.5,1150,15,-575,-500,-75,400)`,
    [cn.insertId, product.id, product.code, product.department_id, invLine.insertId, user.id],
  )

  const withCredit = await calculateRun(SITE, e2eRun.id)
  // Invoice profit 600 @ 10% = 60. Credit: -500 revenue less -200 cost
  // (0.5 x 400) = -300 profit, at 10% = -30. Net 30.
  if (withCredit.ok) eq('a credit claws commission back', withCredit.total, 30)

  const afterCredit = await runSummary(SITE, e2eRun.id)
  const row = afterCredit.find((r) => r.userId === user.id)
  check('the clawback is charged to the original rep', !!row, row ? `${row.userName}` : 'no row')
  if (row) {
    eq('earned is shown apart from clawback', row.earned, 60)
    eq('and the clawback is negative', row.clawback, -30)
  }

  // The property the whole design rests on: once locked, nothing moves it.
  await lockRun(SITE, e2eRun.id, { userId: user.id, userName: user.name })
  await updateRule(SITE, e2eRule.id, {
    name: 'Test E2E',
    priority: 1,
    basis: 'gross_profit',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    userId: user.id,
    isExclusion: false,
    ratePct: 99,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  const frozen = await getRun(SITE, e2eRun.id)
  eq('a locked run ignores a rewritten rule', frozen?.totalAmount ?? -1, 30)

  const stale = await statement(SITE, e2eRun.id, user.id)
  check(
    'the statement still names the rate that was paid',
    stale.every((l) => l.ratePct === 10),
    stale.map((l) => l.ratePct).join(', '),
  )

  // Clean up the documents this section posted.
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id IN (?,?)', [
    inv.insertId,
    cn.insertId,
  ])

  /* ── Attribution reaches the calculation ───────────────────────────── */
  //
  // The bug this guards against shipped once: the invoicing screen wrote
  // `sales_rep_id` (a sales_reps id) while the calculation read
  // `sales_rep_user_id` (a users id), so every line attributed through the UI
  // was silently ignored and paid whoever captured the document instead.
  //
  // 047 made commission pay a USER and converted every rep into one. What
  // follows checks the two halves still agree — a line naming someone OTHER
  // than the capturer must pay that someone.
  console.log('\nattribution')

  const other = await siteQueryOne<{ id: number; name: string }>(
    SITE,
    'SELECT id, name FROM users WHERE is_active = 1 AND id <> ? ORDER BY id LIMIT 1',
    [user.id],
  )
  if (!other) {
    check('a second user exists to attribute to', false)
    return
  }

  const attrRule = await createRule(SITE, {
    name: 'Test Attribution',
    priority: 1,
    basis: 'turnover',
    departmentId: null,
    productId: null,
    brandId: null,
    supplierId: null,
    // Deliberately unscoped by user: the rule pays whoever the LINE names.
    userId: null,
    isExclusion: false,
    ratePct: 10,
    threshold: 0,
    isActive: true,
    tiers: [],
  })
  if (!attrRule.ok) {
    check('the attribution rule was created', false, attrRule.error)
    return
  }
  createdRules.push(attrRule.id)

  const attrRun = await createRun(SITE, '2019-07-01', '2019-07-31', 'Attribution')
  if (!attrRun.ok) {
    check('the attribution run was created', false, attrRun.error)
    return
  }
  createdRuns.push(attrRun.id)

  // Captured BY user.id, sold BY other.id — the case that was broken.
  const attrInv = await siteExecute(
    SITE,
    `INSERT INTO sales_documents
       (doc_type, status, document_number, document_date, user_id, user_name,
        subtotal_excl, vat_total, total_incl)
     VALUES ('invoice','finalised','TESTATTR1','2019-07-15',?,?,1000,150,1150)`,
    [user.id, user.name],
  )
  await siteExecute(
    SITE,
    `INSERT INTO sales_document_lines
       (document_id, line_number, product_id, product_code, description, department_id,
        sales_rep_user_id, qty, unit_price_incl, vat_rate_pct,
        line_total_incl, line_total_excl, line_vat, unit_cost_excl)
     VALUES (?,1,?,?,'Attribution test',?,?,1,1150,15,1150,1000,150,400)`,
    [attrInv.insertId, product.id, product.code, product.department_id, other.id],
  )

  const attrCalc = await calculateRun(SITE, attrRun.id)
  check('the attribution run calculated', attrCalc.ok, attrCalc.ok ? '' : attrCalc.error)

  const attrRows = await runSummary(SITE, attrRun.id)
  const paidTo = attrRows.find((r) => r.amount !== 0)

  check(
    'commission goes to the line’s salesperson, not the capturer',
    paidTo?.userId === other.id,
    `paid ${paidTo?.userName ?? 'nobody'} (${paidTo?.userId}), expected ${other.name} (${other.id})`,
  )
  if (paidTo) eq('and it is 10% of the turnover', paidTo.amount, 100)

  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [attrInv.insertId])
}

async function cleanup() {
  console.log('\ncleaning up...')
  for (const id of createdRuns) {
    await siteExecute(SITE, 'DELETE FROM commission_runs WHERE id = ?', [id]).catch(() => {})
  }
  for (const id of createdRules) await deleteRule(SITE, id).catch(() => {})
  console.log(`removed ${createdRuns.length} run(s), ${createdRules.length} rule(s)`)
}

main()
  .then(async () => {
    await cleanup()
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
    process.exit(failures ? 1 : 0)
  })
  .catch(async (error) => {
    await cleanup()
    console.error('\n', error)
    process.exit(1)
  })
