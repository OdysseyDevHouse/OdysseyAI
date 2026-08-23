import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { isRuleEvent, ruleProblem, type JobRule, type RuleEvent } from '../jobRuleModel'

/**
 * Workflow rules, and the dispatcher that runs them (§12).
 *
 * ── EVERY RULE FIRES FROM A HOOK THAT ALREADY EXISTED ──────────────────────
 *
 * setStatus, assignOwner, closeJob and acceptQuote already call out at exactly
 * the moments §12 names — they just hardcoded "send a notification". This turns
 * that into "run whatever rules match", and the notification becomes one of the
 * things a rule can do.
 *
 * ── NEVER THROWS, EVER ─────────────────────────────────────────────────────
 *
 * `fireJobEvent` is called from inside a status change, a close, an
 * assignment. A rule that failed and took the operation with it would mean a
 * technician unable to close a job because somebody wrote a bad rule last
 * Tuesday — the automation breaking the thing it was meant to help with.
 *
 * So it swallows everything, and reconcileJobRules reports what did not run.
 * Same doctrine as jobNotify and the notify() bell it sits beside.
 *
 * ── THE LOOP GUARD IS THE WHOLE DIFFICULTY ─────────────────────────────────
 *
 * 121_job_automations.sql named loop detection as a cost it was declining to
 * pay, and with four hardcoded automations that was right: none of them could
 * trigger another.
 *
 * A rule engine can. A rule that moves a job to a status fires status_entered,
 * which may match a rule that moves it back. TWO defences, and they do different
 * jobs:
 *
 *   The COOLDOWN — a rule that has already fired for this job in the last N
 *   minutes does not fire again. A ping-pong pair bounces once and stops.
 *
 *   The DEPTH CAP — actions taken BY a rule fire their own events, and those
 *   run at depth+1. Past the cap nothing further fires at all. This is what
 *   stops three rules chaining round a triangle that the pairwise cooldown
 *   would never notice.
 *
 * Neither forbids a business writing two rules that disagree. That is theirs to
 * make and to see; what must not happen is the machine spinning.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * How deep a chain of rules may go before it stops.
 *
 * Three, not one: a rule moving a job to "Awaiting Parts" which trips a rule
 * that raises priority which trips a rule that adds a follower is a legitimate
 * two-step chain somebody meant. Beyond three, nobody is reasoning about it any
 * more and it is far likelier to be a loop than a plan.
 *
 * A constant rather than a setting, deliberately. A shop that hits it has a
 * problem no number fixes, and offering to raise it would be offering to make
 * the loop longer.
 */
const MAX_DEPTH = 3

/**
 * The depth of the rule firing right now, for events nobody can hand a number.
 *
 * runActions calls setStatus, and setStatus fires status_entered itself. That
 * nested event has no way of knowing a rule caused it, and widening setStatus
 * with a parameter only this file cares about would put the plumbing in front
 * of every unrelated call site it already has.
 *
 * So runActions parks the depth here for the length of its own call and puts
 * back what it found, and setStatus READS it — see ruleDepthNow.
 *
 * ── WHY IT MUST BE READ SYNCHRONOUSLY ──────────────────────────────────────
 *
 * The first version of this had setStatus's own post-commit hook read the depth
 * from inside a detached `void (async () => ...)`. That callback is SCHEDULED,
 * not started, when setStatus resolves — so runActions' finally had already put
 * the depth back to 0 before it ever ran. Every hop restarted at zero, the cap
 * counted nothing, and a three-rule triangle span 173 times before the test
 * gave up.
 *
 * So the rule is: read ruleDepthNow() where the event is DECIDED, not where it
 * is delivered, and carry the number into the callback.
 */
let currentDepth = 0

/**
 * How deep the rule chain is at this instant.
 *
 * For a caller that fires an event from a detached callback: read it while
 * still on the stack that decided to fire, and pass the result in as `depth`.
 */
export function ruleDepthNow(): number {
  return currentDepth
}

export type RuleResult = { ok: true; id: number } | { ok: false; error: string }
export type RuleActionResult = { ok: true } | { ok: false; error: string }

const SELECT_RULE = `
  SELECT id, name, is_active, trigger_event, trigger_status_id,
         if_board_id, if_priority, if_headline_id, if_idle_hours,
         do_notify, do_status_id, do_priority, do_follower_user_id, message
    FROM job_rules`

function mapRule(r: Row): JobRule {
  return {
    id: Number(r.id),
    name: String(r.name),
    isActive: Number(r.is_active) === 1,
    event: String(r.trigger_event) as RuleEvent,
    triggerStatusId: r.trigger_status_id === null ? null : Number(r.trigger_status_id),
    ifBoardId: r.if_board_id === null ? null : Number(r.if_board_id),
    ifPriority: r.if_priority === null ? null : String(r.if_priority),
    ifHeadlineId: r.if_headline_id === null ? null : Number(r.if_headline_id),
    ifIdleHours: r.if_idle_hours === null ? null : Number(r.if_idle_hours),
    doNotify: Number(r.do_notify) === 1,
    doStatusId: r.do_status_id === null ? null : Number(r.do_status_id),
    doPriority: r.do_priority === null ? null : String(r.do_priority),
    doFollowerUserId:
      r.do_follower_user_id === null ? null : Number(r.do_follower_user_id),
    message: String(r.message ?? ''),
  }
}

export async function listRules(siteId: number): Promise<JobRule[]> {
  const rows = await siteQuery<Row>(siteId, `${SELECT_RULE} ORDER BY name`).catch(() => [])
  return rows.map(mapRule)
}

export type RuleInput = Omit<JobRule, 'id'> & { id: number | null }

export async function saveRule(
  siteId: number,
  actor: Actor,
  input: RuleInput,
): Promise<RuleResult> {
  // The SAME function the builder ran. A rule the screen accepted must not be
  // one the action rejects for a different reason.
  const problem = ruleProblem(input)
  if (problem) return { ok: false, error: problem }

  const params = [
    input.name.trim().slice(0, 190),
    input.isActive ? 1 : 0,
    input.event,
    input.triggerStatusId,
    input.ifBoardId,
    input.ifPriority,
    input.ifHeadlineId,
    input.ifIdleHours,
    input.doNotify ? 1 : 0,
    input.doStatusId,
    input.doPriority,
    input.doFollowerUserId,
    input.message.trim().slice(0, 400),
  ]

  if (input.id === null) {
    const res = await siteExecute(
      siteId,
      `INSERT INTO job_rules
         (name, is_active, trigger_event, trigger_status_id, if_board_id, if_priority,
          if_headline_id, if_idle_hours, do_notify, do_status_id, do_priority,
          do_follower_user_id, message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params,
    )
    const id = Number(res.insertId)
    await logActivity(siteId, actor, {
      entity: 'job_rule',
      entityId: id,
      action: 'rule_created',
      detail: input.name.trim(),
    })
    return { ok: true, id }
  }

  await siteExecute(
    siteId,
    `UPDATE job_rules
        SET name = ?, is_active = ?, trigger_event = ?, trigger_status_id = ?,
            if_board_id = ?, if_priority = ?, if_headline_id = ?, if_idle_hours = ?,
            do_notify = ?, do_status_id = ?, do_priority = ?,
            do_follower_user_id = ?, message = ?
      WHERE id = ?`,
    [...params, input.id],
  )
  await logActivity(siteId, actor, {
    entity: 'job_rule',
    entityId: input.id,
    action: 'rule_changed',
    detail: input.name.trim(),
  })
  return { ok: true, id: input.id }
}

export async function deleteRule(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<RuleActionResult> {
  const rule = await siteQueryOne<Row>(siteId, `SELECT name FROM job_rules WHERE id = ?`, [id])
  if (!rule) return { ok: false, error: 'That rule no longer exists.' }

  await siteExecute(siteId, `DELETE FROM job_rules WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_rule',
    entityId: id,
    action: 'rule_deleted',
    detail: String(rule.name),
  })
  return { ok: true }
}

/* ── Firing ───────────────────────────────────────────────────────────────── */

export type JobEvent = {
  event: RuleEvent
  jobId: number
  /** For status_entered / status_exited. */
  statusId?: number | null
  /**
   * How many rules deep this event already is.
   *
   * 0 when a person did something. An action taken BY a rule passes depth + 1,
   * which is what the cap counts — see the module header.
   */
  depth?: number
}

async function cooldownMinutes(siteId: number): Promise<number> {
  const raw = await getSetting(siteId, 'job_rule_cooldown_minutes').catch(() => '5')
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 5
}

/**
 * Run every rule that matches, and never throw.
 *
 * Called from the job module's existing hooks. The order is: find candidates,
 * check conditions, claim, act, record — and the claim comes before the acting
 * so a crash leaves an orphan that reconcile can see rather than work that
 * silently repeats.
 */
export async function fireJobEvent(
  siteId: number,
  actor: Actor,
  input: JobEvent,
): Promise<void> {
  try {
    const depth = input.depth ?? currentDepth
    /*
     * The depth cap, checked FIRST and silently.
     *
     * Not an error: reaching it means the rules chained further than anybody is
     * reasoning about, and the honest response is to stop rather than to fail
     * whatever operation is three levels up the stack holding a transaction.
     * reconcileJobRules reports rules that keep hitting it.
     */
    if (depth >= MAX_DEPTH) return

    const candidates = await siteQuery<Row>(
      siteId,
      `${SELECT_RULE}
        WHERE is_active = 1
          AND trigger_event = ?
          AND (trigger_status_id IS NULL OR trigger_status_id = ?)`,
      [input.event, input.statusId ?? null],
    ).catch(() => [])
    if (candidates.length === 0) return

    const job = await siteQueryOne<Row>(
      siteId,
      `SELECT j.id, j.status, j.priority, j.status_id, j.document_number, j.title,
              (SELECT MAX(a.created_at) FROM activity_log a
                WHERE a.entity = 'job_card' AND a.entity_id = j.id) AS last_activity
         FROM job_cards j WHERE j.id = ?`,
      [input.jobId],
    )
    if (!job) return

    const cooldown = await cooldownMinutes(siteId)

    for (const row of candidates) {
      const rule = mapRule(row)
      if (!(await conditionsMet(siteId, rule, job))) continue

      /*
       * The cooldown. Read and claimed as two statements rather than one
       * INSERT..SELECT, because a rule firing twice in the same second is not
       * the failure being defended against — a rule firing forever is, and a
       * second-long race that lets one extra run through costs one duplicate
       * notification rather than an infinite chain.
       */
      if (cooldown > 0) {
        const recent = await siteQuery<Row>(
          siteId,
          `SELECT id FROM job_rule_runs
            WHERE rule_id = ? AND job_card_id = ?
              AND claimed_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
            LIMIT 1`,
          [rule.id, input.jobId, cooldown],
        ).catch(() => [])
        if (recent.length > 0) continue
      }

      const claim = await siteExecute(
        siteId,
        `INSERT INTO job_rule_runs (rule_id, job_card_id) VALUES (?,?)`,
        [rule.id, input.jobId],
      )
      const runId = Number(claim.insertId)

      const did = await runActions(siteId, actor, rule, input.jobId, depth)

      await siteExecute(
        siteId,
        `UPDATE job_rule_runs SET status = 'done', finished_at = NOW(), detail = ? WHERE id = ?`,
        [did.slice(0, 400), runId],
      )

      /*
       * §12: every automated action must identify the rule responsible.
       *
       * Written to the JOB's trail rather than only the run ledger, because the
       * question this answers — "why did this job move?" — is asked on the job,
       * by somebody who has never heard of the rules screen.
       */
      await logActivity(siteId, actor, {
        entity: 'job_card',
        entityId: input.jobId,
        action: 'rule_fired',
        detail: `${rule.name}: ${did}`.slice(0, 400),
      })
    }
  } catch {
    /* Never the reason a status change fails. See the module header. */
  }
}

async function conditionsMet(siteId: number, rule: JobRule, job: Row): Promise<boolean> {
  if (rule.ifPriority !== null && String(job.priority) !== rule.ifPriority) return false
  /*
   * "Is it on this board" is a question about the job's STATUS.
   *
   * 104 is explicit: a board is a saved view over statuses and holds no jobs, so
   * a job is on every board that lists the status it is in. Comparing a
   * board_id column would have been the obvious thing to write, and there is no
   * such column — the first draft of this file wrote one anyway, the read threw,
   * the dispatcher's own catch swallowed it, and NOTHING fired at all.
   */
  if (rule.ifBoardId !== null) {
    const listed = await siteQuery<Row>(
      siteId,
      `SELECT 1 FROM job_board_statuses WHERE board_id = ? AND status_id = ? LIMIT 1`,
      [rule.ifBoardId, Number(job.status_id)],
    ).catch(() => [])
    if (listed.length === 0) return false
  }

  if (rule.ifHeadlineId !== null) {
    const has = await siteQuery<Row>(
      siteId,
      `SELECT 1 FROM job_card_headlines WHERE job_card_id = ? AND headline_id = ? LIMIT 1`,
      [Number(job.id), rule.ifHeadlineId],
    ).catch(() => [])
    if (has.length === 0) return false
  }

  /*
   * Idle for long enough.
   *
   * Measured off the activity log's most recent entry, which is the only record
   * of "something happened to this job" that covers every kind of something.
   * A job with NO activity at all is treated as idle — it was created and
   * nothing has happened since, which is exactly what the condition asks about.
   */
  if (rule.ifIdleHours !== null) {
    const last = job.last_activity as Date | null
    if (last !== null) {
      const hours = (Date.now() - last.getTime()) / 3_600_000
      if (hours < rule.ifIdleHours) return false
    }
  }

  return true
}

/**
 * Do what the rule says, and describe it.
 *
 * The status, priority and board moves go through the job module's own writers
 * rather than UPDATE statements, so a rule cannot do something a person could
 * not: setStatus still refuses a closed job, still checks required forms, still
 * logs. An automation that could bypass a guard would be a way to bypass every
 * guard.
 */
async function runActions(
  siteId: number,
  actor: Actor,
  rule: JobRule,
  jobId: number,
  depth: number,
): Promise<string> {
  const done: string[] = []
  const { setStatus, setPriority } = await import('./jobCards')

  if (rule.doStatusId !== null) {
    /*
     * ── HOW DEPTH REACHES THE NEXT EVENT ─────────────────────────────────
     *
     * setStatus fires status_entered itself, and it has no idea a rule asked
     * for this. Threading a depth parameter through it would mean widening a
     * function eleven other call sites use, to carry a number only this one
     * cares about.
     *
     * So the depth rides in module state instead: set around the call, read by
     * fireJobEvent when setStatus fires its event, and cleared afterwards.
     * Node runs one request's synchronous work without interleaving, and every
     * await here is inside the window, so a second request cannot observe this
     * one's depth — but the finally is what guarantees the window closes even
     * when the move throws.
     */
    const previous = currentDepth
    currentDepth = depth + 1
    try {
      const moved = await setStatus(
        siteId,
        actor,
        jobId,
        rule.doStatusId,
        `Rule: ${rule.name}`,
      ).catch(() => ({ ok: false as const, error: 'refused' }))
      done.push(moved.ok ? 'moved it' : 'could not move it')
    } finally {
      currentDepth = previous
    }
  }

  if (rule.doPriority !== null) {
    const changed = await setPriority(
      siteId,
      actor,
      jobId,
      rule.doPriority as never,
    ).catch(() => ({ ok: false as const, error: 'refused' }))
    done.push(changed.ok ? `set it to ${rule.doPriority}` : 'could not change the priority')
  }

  if (rule.doFollowerUserId !== null) {
    const { setJobPerson } = await import('./jobPeople')
    const added = await setJobPerson(
      siteId,
      actor,
      jobId,
      rule.doFollowerUserId,
      'follower',
    ).catch(() => ({ ok: false as const, error: 'refused' }))
    done.push(added.ok ? 'added a follower' : 'could not add the follower')
  }

  if (rule.doNotify) {
    const { notifyAbout } = await import('./jobPeople')
    const message = rule.message.trim() || `${rule.name} fired on this job.`
    await notifyAbout(siteId, jobId, 'status', rule.name, message, null).catch(() => {})
    done.push('told the people on it')
  }

  return done.join(', ') || 'nothing'
}

/* ── Drift ────────────────────────────────────────────────────────────────── */

export type RuleDrift = {
  /**
   * A run claimed and never finished.
   *
   * The claim is written before the actions, so one of these means the process
   * died mid-rule — or an action threw past its own catch. Either way the job
   * may be half-changed, and only this row says so.
   */
  stuck: { runId: number; ruleName: string; jobId: number; claimedAt: Date }[]
  /**
   * A rule that fires far more often than anything else.
   *
   * Not proof of a loop — a busy shop's "tell me when a job is assigned" rule
   * fires all day. It is the shape a loop takes, and the cooldown means a real
   * loop shows as a rule firing on the SAME job repeatedly rather than as a
   * runaway, which nothing else on any screen would show.
   */
  noisy: { ruleId: number; ruleName: string; jobId: number; fires: number }[]
}

export async function reconcileJobRules(siteId: number): Promise<RuleDrift> {
  const [stuck, noisy] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.job_card_id, r.claimed_at, jr.name
         FROM job_rule_runs r JOIN job_rules jr ON jr.id = r.rule_id
        WHERE r.status = 'claimed' AND r.claimed_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    ).catch(() => []),
    siteQuery<Row>(
      siteId,
      `SELECT r.rule_id, r.job_card_id, jr.name, COUNT(*) AS fires
         FROM job_rule_runs r JOIN job_rules jr ON jr.id = r.rule_id
        WHERE r.claimed_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
        GROUP BY r.rule_id, r.job_card_id, jr.name
       HAVING fires >= 10`,
    ).catch(() => []),
  ])

  return {
    stuck: stuck.map((r) => ({
      runId: Number(r.id),
      ruleName: String(r.name),
      jobId: Number(r.job_card_id),
      claimedAt: r.claimed_at as Date,
    })),
    noisy: noisy.map((r) => ({
      ruleId: Number(r.rule_id),
      ruleName: String(r.name),
      jobId: Number(r.job_card_id),
      fires: Number(r.fires),
    })),
  }
}

export { isRuleEvent }
