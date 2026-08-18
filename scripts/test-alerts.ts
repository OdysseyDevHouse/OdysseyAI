/**
 * Alerts & automations — the claim, the guards, and what a check reports.
 *
 *   npm run test:alerts
 *
 * The properties worth testing here are not the arithmetic — they are the ones
 * that only show up when nobody is watching, which is the only time this
 * feature runs:
 *
 *   ONE RUN PER OCCURRENCE. Two ticks a minute apart must produce one ledger
 *   row and notify once. If the claim is wrong, a shop is told everything
 *   twice, every morning, and the first thing anyone does is switch it off.
 *
 *   ZERO IS A GOOD DAY. A check that finds nothing must record a SUCCESSFUL
 *   run and interrupt nobody. Getting this backwards makes the feature either
 *   a daily nag or a thing nobody can tell is alive.
 *
 *   AN ALERT NEVER OUTLIVES ITS OWNER'S ACCESS. A rule whose owner has gone
 *   must pause itself with a reason, not run under capabilities nobody holds.
 *
 *   A MALFORMED CONFIG STILL RUNS. readConfig is read inside a sweep over
 *   every rule on every site; one bad blob must not stop the others.
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import { lastDueAt } from '../src/lib/reportSchedules/due'
import {
  claimRun,
  createRule,
  deleteRule,
  finishRun,
  getRule,
  listRuns,
  reclaimStaleRuns,
  skipFirstOccurrence,
} from '../src/lib/site/alerts'
import { tickSite } from '../src/lib/alerts/tick'
import { evaluateRule } from '../src/lib/alerts/registry'
import { evaluateNegativeStock } from '../src/lib/alerts/kinds/negativeStock'
import { evaluateLowStock } from '../src/lib/alerts/kinds/lowStock'
import {
  ALERT_KINDS,
  defaultConfigFor,
  readConfig,
  validateAlertRule,
  type AlertRuleInput,
} from '../src/lib/alerts/types'

const SITE = 1
let failures = 0
const createdRules: number[] = []

/** When this run began — the handle cleanup uses to find its own bell rows. */
const startedAt = new Date()

/** Draft orders the automation test raised, removed again on the way out. */
const createdOrders: number[] = []

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function eq(label: string, actual: number, expected: number) {
  const ok = actual === expected
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} — got ${actual}, expected ${expected}`)
  if (!ok) failures++
}

/**
 * The occurrence a rule created right now would be due at.
 *
 * Every rule these tests store is timed to a minute ago rather than a fixed
 * "07:00", because the engine refuses anything more than 12 hours late — a
 * fixed time makes the whole suite pass before lunch and fail after it, which
 * is the worst kind of test.
 */
function justNow(): { sendTime: string; dueAt: Date } {
  const at = new Date(Date.now() - 60_000)
  at.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { sendTime: `${pad(at.getHours())}:${pad(at.getMinutes())}`, dueAt: at }
}

/** A rule shaped just enough to store and run. Bell-only, so nothing is sent. */
function input(over: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    kind: 'negative_stock',
    name: 'TEST alert',
    isActive: true,
    frequency: 'daily',
    sendTime: '07:00',
    daysOfWeek: '1111111',
    dayOfMonth: 1,
    config: defaultConfigFor('negative_stock'),
    notifyBell: true,
    notifyEmail: false,
    notifyWhatsapp: false,
    notifySms: false,
    // A bell rule with nobody on it is refused, so the baseline carries a
    // recipient — the tests that check the refusal clear it deliberately.
    recipientUserIds: [1],
    recipientEmails: [],
    whatsappNumbers: [],
    smsNumbers: [],
    ...over,
  }
}

async function makeRule(over: Partial<AlertRuleInput> = {}, ownerId = 1): Promise<number> {
  const id = await createRule(SITE, input(over), { userId: ownerId, userName: 'Test' })
  createdRules.push(id)
  return id
}

/** The site's first active back-office user — the owner every test rule uses. */
async function anOwner(): Promise<{ id: number; name: string }> {
  const rows = await siteQuery<{ id: number; name: string }>(
    SITE,
    `SELECT id, name FROM users WHERE is_active = 1 ORDER BY id LIMIT 1`,
  )
  if (!rows.length) throw new Error('This site has no active user to own a rule.')
  return rows[0]
}

async function main() {
  const owner = await anOwner()
  console.log(`\nalerts — site ${SITE}, owner "${owner.name}"\n`)

  await configIsRead()
  await validation()
  await theClaim(owner.id)
  await zeroIsAGoodDay(owner.id)
  await ownerMustStillBeHere()
  await staleness(owner.id)
  await abandonedRunsAreReclaimed(owner.id)
  await theCheckItself()
  await storedTimesAreWallClock(owner.id)
  await theAutomationDrafts(owner.id, owner.name)
  await everyKindIsRegistered(owner.id)
}

/* ── the config is read sceptically ────────────────────────────────────────── */

async function configIsRead() {
  console.log('config')

  const broken = readConfig('dead_stock', '{not json at all')
  eq('malformed JSON falls back to the default days', broken.days, 90)
  check('and to the default booleans', broken.roundToPack === true)

  const nonsense = readConfig('dead_stock', JSON.stringify({ days: 'soon', minValue: -5 }))
  eq('a non-numeric knob falls back', nonsense.days, 90)
  eq('a negative value clamps to its floor', nonsense.minValue, 0)

  const huge = readConfig('dead_stock', JSON.stringify({ days: 99999 }))
  eq('an absurd value clamps to its ceiling', huge.days, 3650)

  // The same knob means something different per kind, so its default does too.
  eq('dead stock defaults to 90 days', defaultConfigFor('dead_stock').days, 90)
  eq('unprocessed deliveries default to 2', defaultConfigFor('unprocessed_grvs').days, 2)

  const kept = readConfig('low_stock', JSON.stringify({ createOrders: true, roundToPack: false }))
  check('a good value survives the read', kept.createOrders && !kept.roundToPack)
}

/* ── validation refuses a rule that could never work ───────────────────────── */

async function validation() {
  console.log('\nvalidation')

  check('a complete rule passes', validateAlertRule(input()).ok)

  const noName = validateAlertRule(input({ name: '  ' }))
  check('a nameless rule is refused', !noName.ok)

  const noChannel = validateAlertRule(input({ notifyBell: false }))
  check('a rule with no channel is refused', !noChannel.ok)

  // The sharp one: a channel switched on with nobody on it would run every
  // morning, find things, and tell nobody.
  const bellNobody = validateAlertRule(input({ notifyBell: true, recipientUserIds: [] }))
  check('the bell with no recipient is refused', !bellNobody.ok)

  // Nobody at all — neither a named user (whose address resolves at send time)
  // nor a typed one.
  const emailNobody = validateAlertRule(
    input({ notifyBell: false, notifyEmail: true, recipientUserIds: [], recipientEmails: [] }),
  )
  check('email with nobody to send to is refused', !emailNobody.ok)

  // But a named user IS enough for email: the address is looked up fresh on
  // every send, which is the whole reason the rule stores the person.
  const emailByUser = validateAlertRule(
    input({ notifyBell: false, notifyEmail: true, recipientUserIds: [1], recipientEmails: [] }),
  )
  check('while a named user alone is enough', emailByUser.ok)

  const badEmail = validateAlertRule(
    input({
      notifyBell: false,
      notifyEmail: true,
      recipientUserIds: [],
      recipientEmails: ['not-an-address'],
    }),
  )
  check('a malformed address is refused', !badEmail.ok)

  const badTime = validateAlertRule(input({ sendTime: '25:00' }))
  check('an impossible time is refused', !badTime.ok)

  const noDays = validateAlertRule(input({ frequency: 'weekly', daysOfWeek: '0000000' }))
  check('a weekly rule with no days is refused', !noDays.ok)

  const badPhone = validateAlertRule(
    input({ notifyBell: false, notifySms: true, smsNumbers: ['12'] }),
  )
  check('a too-short number is refused', !badPhone.ok)
}

/* ── one run per occurrence ────────────────────────────────────────────────── */

async function theClaim(ownerId: number) {
  console.log('\nthe claim')

  const id = await makeRule({ recipientUserIds: [ownerId] }, ownerId)
  const due = new Date()
  due.setSeconds(0, 0)

  const first = await claimRun(SITE, id, due)
  check('the first claim wins', first !== null)
  const second = await claimRun(SITE, id, due)
  check('the second claim on the same instant loses', second === null)

  // The claim is per OCCURRENCE, not per rule: a different instant is a
  // different run, or a rule could only ever fire once.
  const later = new Date(due.getTime() + 60_000)
  const third = await claimRun(SITE, id, later)
  check('a different instant claims freely', third !== null)

  if (first !== null) await finishRun(SITE, first, { status: 'sent', itemCount: 0 })

  // The instant itself must be stable, or every tick claims its own row.
  const now = new Date()
  const a = lastDueAt({ frequency: 'daily', sendTime: '07:00', daysOfWeek: '1111111', dayOfMonth: 1 }, now)
  const b = lastDueAt(
    { frequency: 'daily', sendTime: '07:00', daysOfWeek: '1111111', dayOfMonth: 1 },
    new Date(now.getTime() + 30_000),
  )
  check(
    'two ticks half a minute apart compute the same instant',
    a !== null && b !== null && a.getTime() === b.getTime(),
    a ? a.toISOString() : 'null',
  )
  eq('with its seconds zeroed', a?.getSeconds() ?? -1, 0)

  // Creating a rule at 19:00 for "07:00 daily" must start tomorrow, not fire an
  // hour of stale intent the moment it is saved.
  const fresh = await makeRule({ recipientUserIds: [ownerId] }, ownerId)
  const freshDue = lastDueAt(
    { frequency: 'daily', sendTime: '07:00', daysOfWeek: '1111111', dayOfMonth: 1 },
    new Date(),
  )
  if (freshDue) {
    await skipFirstOccurrence(SITE, fresh, freshDue)
    const runs = await listRuns(SITE, fresh)
    eq('the first occurrence is burned on create', runs.length, 1)
    check('and recorded as skipped', runs[0]?.status === 'skipped', runs[0]?.errorText ?? '')
    check('so a tick cannot take it', (await claimRun(SITE, fresh, freshDue)) === null)
  }
}

/* ── zero is a successful run ──────────────────────────────────────────────── */

async function zeroIsAGoodDay(ownerId: number) {
  console.log('\na clean bill of health')

  const before = await unreadFor(ownerId)

  // What this site actually holds decides which assertion below is the real
  // one. Printed either way: an assertion over an empty set proves nothing, and
  // saying so beats silently passing.
  const found = await evaluateNegativeStock(SITE)
  console.log(`       (this site has ${found.total} negative-stock row(s))`)

  // Timed to a minute ago so the occurrence is genuinely due AND genuinely
  // fresh — see justNow().
  const { sendTime } = justNow()
  const id = await makeRule({ recipientUserIds: [ownerId], sendTime }, ownerId)

  // Drive the tick itself rather than a hand-rolled mirror of it: the thing
  // being tested is the engine's decision, not a copy of that decision.
  const result = await tickSite(SITE)
  check('the tick considered this rule', result.considered > 0, `${result.considered} rule(s)`)
  check('and claimed an occurrence for it', result.claimed > 0, `${result.claimed} claimed`)

  const rule = await getRule(SITE, id)
  check('the check ran', rule?.lastRunStatus === 'sent', rule?.lastRunStatus || '(never ran)')

  const runs = await listRuns(SITE, id)
  const after = await unreadFor(ownerId)

  if (found.total === 0) {
    // The property that separates an alert from a scheduled report.
    eq('finding nothing notifies nobody', after - before, 0)
    eq('and the run records a count of zero', runs[0]?.itemCount ?? -1, 0)
  } else {
    eq('the run records what was found', runs[0]?.itemCount ?? -1, found.total)
    check('and the named recipient was told', after - before === 1, `${after - before} bell row(s)`)
    check(
      'the ledger says who was told',
      (runs[0]?.recipients ?? '').includes('(app)'),
      runs[0]?.recipients ?? '(none)',
    )
  }

  // Whatever it found, a second tick in the same minute must not do it again.
  const twice = await tickSite(SITE)
  eq('a second tick claims nothing', twice.claimed, 0)
  const runsAfter = await listRuns(SITE, id)
  eq('so the rule still has exactly one run', runsAfter.length, runs.length)
  eq('and nobody was told twice', await unreadFor(ownerId), after)
}

async function unreadFor(userId: number): Promise<number> {
  const rows = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND event = 'alert_fired'`,
    [userId],
  )
  return Number(rows[0]?.n) || 0
}

/* ── a rule never outlives its owner's access ──────────────────────────────── */

async function ownerMustStillBeHere() {
  console.log('\nownership')

  // Stored with a real owner, then emptied — which is exactly what happens when
  // that person is deleted, because the FK is ON DELETE SET NULL. Creating it
  // ownerless from the start would be a state the database itself refuses.
  const { sendTime } = justNow()
  const id = await makeRule({ sendTime })
  await siteExecute(SITE, `UPDATE alert_rules SET owner_user_id = NULL WHERE id = ?`, [id])

  const result = await tickSite(SITE)
  check('the tick ran', result.considered > 0, `${result.considered} rule(s)`)

  const rule = await getRule(SITE, id)
  check('an ownerless rule is paused', rule?.isActive === false, `active=${rule?.isActive}`)
  check(
    'with a reason on its card',
    (rule?.lastRunError ?? '').toLowerCase().includes('no longer has access'),
    rule?.lastRunError ?? '(none)',
  )
}

/* ── too late to be worth running ──────────────────────────────────────────── */

async function staleness(ownerId: number) {
  console.log('\nstaleness')

  const id = await makeRule({ recipientUserIds: [ownerId] }, ownerId)
  const longAgo = new Date(Date.now() - 48 * 3_600_000)
  longAgo.setSeconds(0, 0)

  const runId = await claimRun(SITE, id, longAgo)
  check('an old occurrence can be claimed', runId !== null)

  // A day-old cash-up landing this morning reads as current, and somebody acts
  // on it. Skipping still burns the claim, so it is not retried forever.
  const rows = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM alert_rule_runs WHERE rule_id = ? AND due_at < DATE_SUB(NOW(), INTERVAL 12 HOUR)`,
    [id],
  )
  check('and it is on the ledger', Number(rows[0]?.n) === 1, `${rows[0]?.n} row(s)`)
  check('so it can never be claimed again', (await claimRun(SITE, id, longAgo)) === null)
}

/* ── an abandoned run does not wedge the rule forever ──────────────────────── */

async function abandonedRunsAreReclaimed(ownerId: number) {
  console.log('\nabandoned runs')

  const id = await makeRule({ recipientUserIds: [ownerId] }, ownerId)
  const due = new Date(Date.now() - 3_600_000)
  due.setSeconds(0, 0)

  const runId = await claimRun(SITE, id, due)
  check('claimed', runId !== null)
  // Backdate the claim to look like a process that died an hour ago.
  await siteExecute(
    SITE,
    `UPDATE alert_rule_runs SET claimed_at = DATE_SUB(NOW(), INTERVAL 60 MINUTE) WHERE id = ?`,
    [runId],
  )

  await reclaimStaleRuns(SITE)
  const runs = await listRuns(SITE, id)
  check(
    'a dead claim is released rather than left in flight',
    runs[0]?.status === 'failed',
    runs[0]?.status ?? '(none)',
  )
  check(
    'with an explanation',
    (runs[0]?.errorText ?? '').toLowerCase().includes('abandoned'),
    runs[0]?.errorText ?? '',
  )
}

/* ── the check reports what is really there ────────────────────────────────── */

async function theCheckItself() {
  console.log('\nthe negative-stock check')

  const result = await evaluateNegativeStock(SITE)

  // The headline must be the TRUE count, never items.length — a cap that lies
  // is worse than a slow query, because the number looks like an answer.
  const rows = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n
       FROM product_location_stock pls
       JOIN products p        ON p.id = pls.product_id
       JOIN stock_locations l ON l.id = pls.location_id
      WHERE pls.stock_on_hand < 0 AND p.is_archived = 0 AND l.is_active = 1`,
  )
  eq('the count matches an independent COUNT(*)', result.total, Number(rows[0]?.n) || 0)
  check(
    'the rows read never exceed the count',
    result.items.length <= result.total,
    `${result.items.length} read of ${result.total}`,
  )
  check('and the read is capped', result.items.length <= 500, `${result.items.length} rows`)
}

/* ── a stored time is a wall clock, not an instant ─────────────────────────── */

/**
 * The bug this guards was visible on the screen and invisible to every other
 * test: a check that had just run showed as "Tomorrow 01:09".
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of a DATETIME
 * Date ARE the stored wall clock. toISOString() re-stamps that wall clock AS
 * UTC, and the browser shifts it again by the local offset — so on any machine
 * east of Greenwich a timestamp lands in the future. It reads as a scheduling
 * bug in the engine, which is where somebody would go looking.
 */
async function storedTimesAreWallClock(ownerId: number) {
  console.log('\nstored times')

  const { sendTime } = justNow()
  const id = await makeRule({ recipientUserIds: [ownerId], sendTime }, ownerId)
  await tickSite(SITE)

  const rule = await getRule(SITE, id)
  const lastRunAt = rule?.lastRunAt ?? null
  if (!lastRunAt) {
    check('the rule recorded a run to check', false)
    return
  }

  // The driver's Date read as WALL CLOCK — the UTC parts — must be within a
  // couple of minutes of now. Read as an instant it would be off by the local
  // offset, which is the whole bug.
  const now = new Date()
  const wallMinutes =
    lastRunAt.getUTCHours() * 60 + lastRunAt.getUTCMinutes()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const drift = Math.abs(wallMinutes - nowMinutes)

  check(
    'a run just recorded reads as the current wall clock',
    drift <= 2 || drift >= 1438,
    `stored ${pad(lastRunAt.getUTCHours())}:${pad(lastRunAt.getUTCMinutes())}, clock ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  )

  // And the naive conversion is genuinely wrong wherever the offset is not
  // zero — stated so the test cannot quietly pass on a UTC machine.
  const offsetMinutes = -now.getTimezoneOffset()
  if (offsetMinutes === 0) {
    console.log('       (this machine is on UTC, so the naive conversion cannot be caught here)')
  } else {
    const naive = new Date(lastRunAt.toISOString())
    check(
      'while toISOString() would put it in the wrong hour',
      naive.getHours() !== lastRunAt.getUTCHours(),
      `naive ${pad(naive.getHours())}:00 vs stored ${pad(lastRunAt.getUTCHours())}:00`,
    )
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/* ── the automation half ───────────────────────────────────────────────────── */

/**
 * The only kind that WRITES.
 *
 * Two properties matter, and neither is "did it make an order":
 *
 *   IT DRAFTS. A draft is a proposal somebody deletes; an issued order is a
 *   commitment to spend money. An unattended process must never make the
 *   second, so the status is asserted directly rather than assumed from the
 *   function that was called.
 *
 *   IT SAYS WHAT IT DID. The document number goes on the ledger, which is the
 *   only way anyone answers "where did this order come from" next month.
 */
async function theAutomationDrafts(ownerId: number, ownerName: string) {
  console.log('\nthe automation half')

  const rule = await getRule(SITE, await makeRule({ kind: 'low_stock' }))
  if (!rule) {
    check('the low-stock rule was stored', false)
    return
  }

  const dryRun = await evaluateRule(
    SITE,
    { ...rule, config: { ...rule.config, createOrders: false } },
    { userId: ownerId, userName: ownerName },
  )
  console.log(`       (this site has ${dryRun.itemCount} product(s) below minimum)`)
  eq('reporting alone creates nothing', dryRun.createdDocs.length, 0)

  if (dryRun.itemCount === 0) {
    console.log('       (nothing is below minimum here, so drafting is not exercised)')
    return
  }

  const before = await orderCount()
  // The evaluator, not just the registry: this needs the document IDS back, and
  // a draft has no document number to look them up by — the number is allocated
  // at ISSUE time, so every draft this raises carries document_number NULL.
  const acting = await evaluateLowStock(
    SITE,
    { ...rule, config: { ...rule.config, createOrders: true } },
    { userId: ownerId, userName: ownerName },
  )
  const after = await orderCount()
  const ids = acting.createdOrders.map((o) => o.documentId)
  createdOrders.push(...ids)

  check('drafting raises at least one order', ids.length > 0, `${ids.length} order(s)`)
  eq('and the count of orders moves by exactly that many', after - before, ids.length)
  check(
    'the cap on drafts per run is respected',
    ids.length <= 20,
    `${ids.length} raised of ${acting.groups.length} supplier group(s)`,
  )
  check(
    'and what was NOT drafted is said out loud',
    acting.groups.length <= ids.length || acting.problems.length > 0,
    acting.problems.join(' ') || '(nothing said)',
  )

  if (ids.length === 0) return

  // The property worth the test: DRAFT, never issued. An unattended process
  // must not commit a shop to spending money.
  const raised = await siteQuery<{ id: number; status: string; user_name: string }>(
    SITE,
    `SELECT id, status, user_name FROM purchase_documents WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  check(
    'every order it raised is a draft, not issued',
    raised.length === ids.length && raised.every((r) => r.status === 'draft'),
    raised.map((r) => r.status).join(', ') || '(none found)',
  )
  check(
    "and is attributed to the rule's owner",
    raised.every((r) => r.user_name === ownerName),
    raised.map((r) => r.user_name)[0] ?? '(none)',
  )

  /*
   * The property that stops a daily rule stacking drafts.
   *
   * Deliberately NOT "the second run sees fewer shortages": it does not, and
   * should not. The shop is still short until the goods ARRIVE, so the report
   * keeps saying so — reorderSuggestions counts only ISSUED orders as on the
   * way, and a draft nobody sent is not stock coming.
   *
   * What must not happen is a SECOND draft for the same shortfall. Run daily
   * for a week, that is five orders per supplier for one shortage.
   */
  const beforeSecond = await orderCount()
  const second = await evaluateLowStock(
    SITE,
    { ...rule, config: { ...rule.config, createOrders: true } },
    { userId: ownerId, userName: ownerName },
  )
  createdOrders.push(...second.createdOrders.map((o) => o.documentId))
  const afterSecond = await orderCount()

  check(
    'the shop is still reported short until the goods arrive',
    second.total > 0,
    `${second.total} still short`,
  )
  // The 18 suppliers drafted a moment ago are fully covered, so the cap now
  // reaches suppliers it could not get to before — but never the same ones.
  const redrafted = second.createdOrders.filter((o) =>
    acting.createdOrders.some((first) => first.supplierName === o.supplierName),
  )
  eq('and no supplier is drafted a second time for the same shortfall', redrafted.length, 0)
  check(
    'so the drafts that do appear are for suppliers the cap had not reached',
    afterSecond - beforeSecond === second.createdOrders.length,
    `${second.createdOrders.length} new draft(s)`,
  )
}

async function orderCount(): Promise<number> {
  const rows = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM purchase_documents WHERE doc_type = 'purchase_order'`,
  )
  return Number(rows[0]?.n) || 0
}

/* ── every kind in the union is either wired up or honestly refused ────────── */

async function everyKindIsRegistered(ownerId: number) {
  console.log('\nthe registry')

  const id = await makeRule({ recipientUserIds: [ownerId] }, ownerId)
  const rule = await getRule(SITE, id)
  if (!rule) {
    check('the test rule was stored', false)
    return
  }

  for (const kind of ALERT_KINDS) {
    // A kind with no evaluator must fail LOUDLY. The failure being tested is
    // the silent one: a default branch running some other rule's check under
    // this rule's name, which somebody would then believe.
    try {
      const found = await evaluateRule(
        SITE,
        // createOrders deliberately OFF: this loop runs every kind against the
        // live site, and a test that quietly raised real purchase orders would
        // be indistinguishable from a buyer's own work by tomorrow.
        { ...rule, kind, config: { ...defaultConfigFor(kind), createOrders: false } },
        { userId: ownerId, userName: 'Test' },
      )
      check(`${kind} runs and reports a count`, Number.isFinite(found.itemCount), `${found.itemCount} found`)
      check(`${kind} says something a person can read`, found.message.title.length > 0)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      check(
        `${kind} is refused honestly rather than mis-answered`,
        message.includes('not available in this version'),
        message,
      )
    }
  }
}

async function cleanup() {
  console.log('\ncleaning up...')
  for (const id of createdRules) await deleteRule(SITE, id).catch(() => {})

  /*
   * The drafts the automation test raised are CANCELLED, not deleted.
   *
   * Deleting them would take their document numbers out of existence and leave
   * gaps in the purchase-order sequence — which fails test:sequences, in an
   * unrelated suite, for a reason nobody would connect to this file.
   * verifySequence counts a cancelled document as accounted for, which is
   * exactly the state a withdrawn order should be in anyway.
   */
  for (const id of createdOrders) {
    await siteExecute(
      SITE,
      `UPDATE purchase_documents
          SET status = 'cancelled', cancel_reason = 'Raised by test:alerts', cancelled_at = NOW()
        WHERE id = ? AND status = 'draft'`,
      [id],
    ).catch(() => {})
  }

  /*
   * The bell rows the test's own rules wrote.
   *
   * NOT matched on the title: a notification carries the MESSAGE's title
   * ("Negative stock: 23 450 products below zero"), never the rule's name, so
   * a name filter silently deletes nothing and leaves litter in a real
   * person's inbox.
   *
   * And NOT on the time window alone, which is how this was wrong before:
   * `created_at >= startedAt` also swept up a row a REAL rule wrote while the
   * suite happened to be running, deleting somebody's notification in order to
   * tidy up after a test.
   *
   * The honest handle is the TITLE the test's own rules produce, inside the
   * window. Every rule here watches negative stock, so the title is that
   * check's headline — narrow enough that a real rule's row survives, and
   * exact enough that the test's own rows do not.
   */
  const removed = await siteExecute(
    SITE,
    `DELETE FROM notifications
      WHERE event = 'alert_fired'
        AND created_at >= ?
        AND title LIKE 'Negative stock:%'`,
    [startedAt],
  ).catch(() => null)
  console.log(
    `removed ${createdRules.length} rule(s), ${removed?.affectedRows ?? 0} notification(s), cancelled ${createdOrders.length} draft order(s)`,
  )
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
