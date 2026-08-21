'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { recentSessions, startTraining, stopTraining, trainingSummary } from '@/lib/site/trainingMode'

/**
 * The training mode switch.
 *
 * Guarded on `setup.edit` and nothing weaker. Turning training ON stops the shop
 * trading for real, and turning it OFF deletes rows — neither is something a
 * cashier or a buyer should be able to do from a screen they wandered into. It
 * is the same guard purchasing settings use, for the same reason: the blast
 * radius is the whole site, not one module.
 */

/**
 * The serialised shape the screen renders. Deliberately NOT `TrainingSummary` —
 * that type carries a Date and the watermark manifest, and neither should cross
 * to the client. See the reshaping in page.tsx, which this mirrors.
 */
export type TrainingState = {
  summary: {
    active: boolean
    session: { id: number; startedAt: string; startedName: string | null } | null
    pending: { table: string; rows: number }[]
    pendingTotal: number
  }
  history: {
    id: number
    startedAt: string
    endedAt: string | null
    startedName: string | null
    endedName: string | null
    removedTotal: number
  }[]
}

export type TrainingResult =
  | { ok: true; state: TrainingState; message?: string }
  | { ok: false; error: string }

/**
 * Dates cross to the client as ISO strings, not Date objects.
 *
 * A Date survives the server-action boundary but arrives as a value the client
 * has to re-parse anyway, and the DATETIME columns here are read back through
 * the pool's UTC setting — see the wall-clock note in siteDb. Serialising once,
 * here, keeps the formatting decision on the screen where it belongs.
 */
async function state(siteId: number): Promise<TrainingState> {
  const [summary, history] = await Promise.all([trainingSummary(siteId), recentSessions(siteId)])
  return {
    summary: {
      active: summary.active,
      session: summary.session
        ? {
            id: summary.session.id,
            startedAt: summary.session.startedAt.toISOString(),
            startedName: summary.session.startedName,
          }
        : null,
      pending: summary.pending,
      pendingTotal: summary.pendingTotal,
    },
    history: history.map((h) => ({
      id: h.id,
      startedAt: h.startedAt.toISOString(),
      endedAt: h.endedAt === null ? null : h.endedAt.toISOString(),
      startedName: h.startedName,
      endedName: h.endedName,
      removedTotal: h.removedTotal,
    })),
  }
}

export async function loadTrainingAction(): Promise<TrainingResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return { ok: true, state: await state(ctx.siteId) }
}

export async function startTrainingAction(): Promise<TrainingResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await startTraining(ctx.siteId, ctx.actor)
  if (!result.ok) return result

  revalidateEverything()
  return {
    ok: true,
    state: await state(ctx.siteId),
    message: 'Training mode is on. Everything done from now until you switch it off is removed.',
  }
}

/**
 * Switches training off and purges.
 *
 * `confirmText` is required to match, because this is the one action in Setup
 * that destroys data and cannot be undone. A toggle that deletes forty documents
 * on a single click is a toggle somebody will hit by accident on the way to
 * something else. Typing the word is not security — it is the pause that makes a
 * person read the count above it.
 */
export async function stopTrainingAction(confirmText: string): Promise<TrainingResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  if (confirmText.trim().toUpperCase() !== 'REMOVE') {
    return { ok: false, error: 'Type REMOVE to confirm that the training data should be deleted.' }
  }

  const result = await stopTraining(ctx.siteId, ctx.actor)
  if (!result.ok) return result

  revalidateEverything()

  const removedMessage =
    result.removedTotal === 0
      ? 'Training mode is off. Nothing was created during the session, so nothing was removed.'
      : `Training mode is off. ${result.removedTotal.toLocaleString()} training ${
          result.removedTotal === 1 ? 'record' : 'records'
        } removed.`

  return {
    ok: true,
    state: await state(ctx.siteId),
    // The warning leads when there is one. "Nothing was removed" is the exact
    // sentence a shared customer file produces — the branch's own tables were
    // empty — and on its own it reads as "the session was quiet" rather than
    // "the rows went somewhere this could not reach".
    message: result.warning ? `${result.warning} ${removedMessage}` : removedMessage,
  }
}

/**
 * Both switches change what nearly every cached screen would show — stock
 * levels, sales lists, the ledger, the dashboard. Revalidating the section roots
 * rather than naming thirty routes: the cost of an over-broad revalidate here is
 * one extra render on screens somebody is about to look at anyway, and the cost
 * of missing one is a manager staring at training figures after the data is gone.
 */
function revalidateEverything(): void {
  for (const path of [
    '/setup/training',
    '/', // the dashboard
    '/sales',
    '/products',
    '/purchasing',
    '/accounting',
    '/reports',
    '/pos',
  ]) {
    revalidatePath(path, 'layout')
  }
}
