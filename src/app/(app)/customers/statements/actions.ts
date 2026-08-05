'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSite } from '@/lib/auth'
import {
  createRun,
  processRun,
  retryFailed,
  deleteRun,
  type CreateRunInput,
} from '@/lib/site/statementRuns'
import { customerIdsMatching, type CustomerListOptions } from '@/lib/site/customers'

export type RunResult = { ok: true; runId: number; message: string } | { ok: false; error: string }

/**
 * Queues a run and starts it.
 *
 * The send is DELIBERATELY not awaited. Two hundred statements take minutes;
 * holding the request open for them would time out the connection with no way
 * to know which ones went. The run is created first — so the screen has
 * something real to poll — and the worker is left to get on with it.
 */
export async function startRunAction(input: CreateRunInput): Promise<RunResult> {
  const site = await requireSite()
  const { actor } = await requireActor()

  const created = await createRun(site.id, actor, input)
  if (!created.ok) return { ok: false, error: created.error }

  // Detached on purpose. Failures land on the individual items, which is where
  // the screen reads them from — an unhandled rejection here would tell nobody
  // anything.
  void processRun(site.id, site.displayName, site.vatNumber, created.runId).catch(() => {})

  revalidatePath('/customers/statements')
  return {
    ok: true,
    runId: created.runId,
    message:
      created.queued === 0
        ? 'Nothing to send — every account was skipped.'
        : `Sending ${created.queued} statement${created.queued === 1 ? '' : 's'}.`,
  }
}

/** Queues every account matching the current filter, not just the page. */
export async function startRunForFilterAction(
  filter: CustomerListOptions,
  period: { from: string; to: string; format?: 'open-item' | 'activity' },
): Promise<RunResult> {
  const site = await requireSite()
  const ids = await customerIdsMatching(site.id, filter)
  if (ids.length === 0) return { ok: false, error: 'No accounts match that filter.' }

  return startRunAction({
    customerIds: ids,
    periodFrom: period.from,
    periodTo: period.to,
    format: period.format,
  })
}

export async function retryRunAction(runId: number): Promise<RunResult> {
  const site = await requireSite()

  const { requeued } = await retryFailed(site.id, runId)
  if (requeued === 0) return { ok: false, error: 'Nothing failed on that run.' }

  void processRun(site.id, site.displayName, site.vatNumber, runId).catch(() => {})

  revalidatePath('/customers/statements')
  revalidatePath(`/customers/statements/${runId}`)
  return { ok: true, runId, message: `Retrying ${requeued}.` }
}

export async function deleteRunAction(
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId, actor } = await requireActor()
  const result = await deleteRun(siteId, actor, runId)
  if (!result.ok) return result

  revalidatePath('/customers/statements')
  return { ok: true }
}
