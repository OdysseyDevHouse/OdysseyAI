import 'server-only'
import { lastDueAt } from '../reportSchedules/due'
import {
  claimRun,
  deactivateRule,
  finishRun,
  listActiveRules,
  recordLastRun,
  reclaimStaleRuns,
} from '../site/alerts'
import { capabilitiesForRole } from '../site/permissions'
import { can, type Capability } from '../site/permissions'
import { getUser } from '../site/users'
import { deliverAlert } from './deliver'
import { evaluateRule } from './registry'
import type { AlertRule } from './types'

/**
 * One pass over a site's alert rules.
 *
 * ── HOW AN OCCURRENCE IS DECIDED ─────────────────────────────────────────
 *
 * For each active rule the tick computes the most recent scheduled instant at
 * or before now — using reportSchedules' lastDueAt(), imported rather than
 * copied so the two features can never disagree about when "07:00 daily" is —
 * and tries to CLAIM it in the ledger. UNIQUE(rule_id, due_at) means the claim
 * succeeds exactly once per occurrence, so running the tick twice in a minute
 * checks nothing twice, and a missed tick is picked up by the next one.
 *
 * ── THE ORDER OF THE GUARDS IS THE DESIGN ────────────────────────────────
 *
 *   1. staleness — before claiming work nobody wants
 *   2. the claim  — before doing any work at all
 *   3. the owner  — before reading any of the shop's data
 *   4. evaluate   — the check itself
 *   5. deliver    — only if it found something
 *
 * Each step is cheaper than the one after it, and each is a reason NOT to
 * continue. Nothing reads the shop's data until the tick has established that
 * somebody who is allowed to see it asked for this.
 */

/**
 * How late an occurrence may be and still be worth running.
 *
 * A cash-up alert for last Tuesday arriving this morning is worse than not
 * arriving: it reads as current, and somebody acts on a week-old drawer.
 * Claiming it as skipped burns the occurrence so it is not retried forever.
 */
const MAX_LATENESS_HOURS = 12

export type AlertTickResult = {
  considered: number
  claimed: number
  /** Checks that RAN — including the happy "nothing was wrong" ones. */
  fired: number
  skipped: number
  failed: number
  details: { rule: string; outcome: string; reason?: string }[]
}

export async function tickSite(siteId: number, now: Date = new Date()): Promise<AlertTickResult> {
  const result: AlertTickResult = {
    considered: 0,
    claimed: 0,
    fired: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  // A process that died mid-check leaves a claim nobody will finish, and the
  // rule silently stops watching. Clearing those first is what makes the ledger
  // self-healing rather than a trap — and silence is this feature's success
  // state as well as its worst failure, so it cannot be noticed any other way.
  await reclaimStaleRuns(siteId)

  const rules = await listActiveRules(siteId)
  result.considered = rules.length

  // Sequential within a site, deliberately. An automation half draws document
  // numbers from the sequence table, and there is no reason to make a shop's
  // own rules race each other at 07:00.
  for (const rule of rules) {
    const due = lastDueAt(rule, now)
    if (!due) continue

    const runId = await claimRun(siteId, rule.id, due)
    // Someone already has this occurrence — another instance, or this same tick
    // a minute ago. Nothing to do.
    if (runId === null) continue
    result.claimed++

    const outcome = await runOne(siteId, rule, runId, due, now)
    if (outcome.status === 'sent') result.fired++
    else if (outcome.status === 'skipped') result.skipped++
    else result.failed++

    result.details.push({
      rule: rule.name,
      outcome: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
  }

  return result
}

type Outcome = { status: 'sent' | 'skipped' | 'failed'; reason?: string }

async function runOne(
  siteId: number,
  rule: AlertRule,
  runId: number,
  due: Date,
  now: Date,
): Promise<Outcome> {
  const skip = async (reason: string, deactivate = false): Promise<Outcome> => {
    await finishRun(siteId, runId, { status: 'skipped', errorText: reason })
    if (deactivate) await deactivateRule(siteId, rule.id, reason)
    else await recordLastRun(siteId, rule.id, 'skipped', reason)
    return { status: 'skipped', reason }
  }

  /* 1. Too late to be worth running. */
  const lateHours = (now.getTime() - due.getTime()) / 3_600_000
  if (lateHours > MAX_LATENESS_HOURS) {
    return skip(
      `Missed — nothing was running when this was due, and it was ${Math.round(lateHours)} hours overdue.`,
    )
  }

  /* 2. Whose capabilities this answers to. There is no session at 07:00. */
  const owner = rule.ownerUserId === null ? null : await getUser(siteId, rule.ownerUserId)
  if (!owner || !owner.isActive) {
    return skip('The person who created this alert no longer has access, so it was paused.', true)
  }

  const capabilities = await capabilitiesForRole(siteId, owner.roleId)

  // An alert that ACTS is exercising a module's capability unattended, so it
  // answers to the same check the interactive path enforces. A read-only rule
  // needs nothing beyond an owner who is still here: the data it reports on is
  // already going to people the rule names, and a rule nobody may configure
  // cannot be created in the first place.
  const acting = actingCapability(rule)
  if (acting && !can(capabilities, acting)) {
    return skip(
      `${owner.name} no longer has the access this alert needs to act, so it was paused.`,
      true,
    )
  }

  /* 3. Run the check. */
  try {
    const found = await evaluateRule(siteId, rule)

    // A clean bill of health is a SUCCESSFUL run, not a notification. This is
    // the whole difference between an alert and a scheduled report: nothing was
    // wrong, nobody is interrupted, and the ledger records a run of zero so the
    // screen can still prove the rule is alive.
    if (found.itemCount === 0) {
      await finishRun(siteId, runId, { status: 'sent', itemCount: 0 })
      await recordLastRun(siteId, rule.id, 'sent', '')
      return { status: 'sent' }
    }

    /* 4. Tell people. */
    const delivery = await deliverAlert(siteId, rule, found.message)
    const notes = delivery.notes.join(' ').slice(0, 500)

    if (delivery.failed) {
      // Left failed on purpose: the reclaim window retries it. Anything the
      // check CREATED is not created again — a drafted order counts as stock on
      // order the second time round, so the condition has already changed.
      await finishRun(siteId, runId, {
        status: 'failed',
        itemCount: found.itemCount,
        createdDocs: found.createdDocs,
        recipients: delivery.recipients,
        errorText: notes || 'Nothing could be delivered.',
      })
      await recordLastRun(siteId, rule.id, 'failed', notes || 'Nothing could be delivered.')
      return { status: 'failed', reason: notes }
    }

    await finishRun(siteId, runId, {
      status: 'sent',
      itemCount: found.itemCount,
      createdDocs: found.createdDocs,
      recipients: delivery.recipients,
      errorText: notes,
    })
    await recordLastRun(siteId, rule.id, 'sent', notes)
    return { status: 'sent' }
  } catch (e) {
    // A throw here would abandon the claim and wedge the rule, so it is caught
    // and recorded as a failure the next tick can see and retry.
    const error = e instanceof Error ? e.message : 'The check failed unexpectedly.'
    await finishRun(siteId, runId, { status: 'failed', errorText: error })
    await recordLastRun(siteId, rule.id, 'failed', error)
    return { status: 'failed', reason: error }
  }
}

/**
 * The capability a rule needs BEYOND being configurable — or null when it only
 * reads.
 *
 * Exported because the save path checks it too: refusing to store a rule its
 * author could not run beats a rule that pauses itself at 07:00 the next
 * morning, when nobody is watching to find out why.
 */
export function actingCapability(rule: {
  kind: AlertRule['kind']
  config: AlertRule['config']
}): Capability | null {
  if (rule.kind === 'low_stock' && rule.config.createOrders) return 'purchasing.edit'
  return null
}

/**
 * Run one rule immediately — the "Run now" button.
 *
 * Claims an occurrence for the current minute so the ledger stays the single
 * record of every run, and so a double-click (or two people on the screen at
 * once) cannot check and notify twice.
 */
export async function runRuleNow(
  siteId: number,
  rule: AlertRule,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date()
  const due = new Date(now)
  due.setSeconds(0, 0)

  const runId = await claimRun(siteId, rule.id, due)
  if (runId === null) {
    return { ok: false, error: 'This alert just ran — try again in a minute.' }
  }

  const outcome = await runOne(siteId, rule, runId, due, now)
  if (outcome.status === 'sent') return { ok: true }
  return { ok: false, error: outcome.reason || 'The check did not finish.' }
}
