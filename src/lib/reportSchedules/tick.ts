import 'server-only'
import {
  claimRun,
  finishRun,
  listActiveSchedules,
  recordLastRun,
  reclaimStaleRuns,
  type ReportSchedule,
} from '../site/reportSchedules'
import { lastDueAt } from './due'
import { runAndSend, type SendOutcome } from './send'

/**
 * One pass over a site's schedules.
 *
 * ── HOW AN OCCURRENCE IS DECIDED ─────────────────────────────────────────────
 *
 * For each active rule the tick computes the most recent scheduled instant at
 * or before now (see ./due.ts) and tries to CLAIM it in the run ledger. The
 * ledger's UNIQUE(schedule_id, due_at) key means the claim succeeds exactly
 * once per occurrence, so:
 *
 *   · running the tick twice in a minute sends nothing twice;
 *   · a missed tick is picked up by the next one rather than lost;
 *   · a second app instance later is a deployment change, not a rewrite.
 *
 * ── THE STALENESS WINDOW ─────────────────────────────────────────────────────
 *
 * An occurrence older than the window is claimed and SKIPPED rather than sent.
 * A cash-up report for a week ago landing in someone's inbox this morning is
 * worse than not arriving: it looks current, and someone acts on it. Burning
 * the claim also stops it being retried forever.
 */

/** How late an occurrence may be and still be worth sending. */
const MAX_LATENESS_HOURS = 12

export type TickResult = {
  considered: number
  claimed: number
  sent: number
  skipped: number
  failed: number
  details: { schedule: string; outcome: SendOutcome['status']; reason?: string }[]
}

export async function tickSite(siteId: number, now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = {
    considered: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  // A process that died mid-send leaves a claim nobody will ever finish, and
  // the rule silently stops. Clearing those first is what makes the ledger
  // self-healing rather than a trap.
  await reclaimStaleRuns(siteId)

  const schedules = await listActiveSchedules(siteId)
  result.considered = schedules.length

  for (const schedule of schedules) {
    const due = lastDueAt(schedule, now)
    if (!due) continue

    const runId = await claimRun(siteId, schedule.id, due)
    // Someone already has this occurrence — either another instance, or this
    // same tick a minute ago. Nothing to do.
    if (runId === null) continue

    result.claimed++

    const outcome = await runOne(siteId, schedule, runId, due, now)
    if (outcome.status === 'sent') result.sent++
    else if (outcome.status === 'skipped') result.skipped++
    else result.failed++

    result.details.push({
      schedule: schedule.name,
      outcome: outcome.status,
      ...(outcome.status === 'skipped'
        ? { reason: outcome.reason }
        : outcome.status === 'failed'
          ? { reason: outcome.error }
          : {}),
    })
  }

  return result
}

async function runOne(
  siteId: number,
  schedule: ReportSchedule,
  runId: number,
  due: Date,
  now: Date,
): Promise<SendOutcome> {
  const lateHours = (now.getTime() - due.getTime()) / 3_600_000
  if (lateHours > MAX_LATENESS_HOURS) {
    const outcome: SendOutcome = {
      status: 'skipped',
      reason: `Too late to send — the ${formatDue(due)} report was ${Math.round(lateHours)} hours overdue.`,
    }
    await finishRun(siteId, runId, { status: 'skipped', errorText: outcome.reason })
    await recordLastRun(siteId, schedule.id, 'skipped', outcome.reason)
    return outcome
  }

  try {
    return await runAndSend(siteId, schedule, runId, due)
  } catch (e) {
    // A throw here would abandon the claim and wedge the rule, so it is caught
    // and recorded as a failure the next tick can see.
    const error = e instanceof Error ? e.message : 'The send failed unexpectedly.'
    await finishRun(siteId, runId, { status: 'failed', errorText: error })
    await recordLastRun(siteId, schedule.id, 'failed', error)
    return { status: 'failed', error }
  }
}

function formatDue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
