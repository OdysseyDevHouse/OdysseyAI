'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, actorForOrThrow } from '@/lib/auth'
import { batchTrace, type Batch } from '@/lib/site/batches'
import { postNewAdjustment } from '@/lib/site/stockAdjustments'

export type BatchTraceEvent = {
  action: string
  qty: number
  source: string
  documentId: number | null
  documentNumber: string | null
  userName: string
  note: string | null
  at: Date
}

export async function batchTraceAction(
  batchId: number,
): Promise<{ ok: true; batch: Batch; events: BatchTraceEvent[] } | { ok: false; error: string }> {
  const ctx = await actorForOrThrow('stock.view')
  const trace = await batchTrace(ctx.siteId, batchId)
  if (!trace) return { ok: false, error: 'That lot no longer exists.' }
  return { ok: true, ...trace }
}

/**
 * The recall write-off: one lot, off the shelf, through an ordinary posted
 * adjustment whose line names the batch — so the movement, the reason and
 * the reversal path are all the ones adjustments already have.
 */
export async function writeOffBatchAction(
  batchId: number,
  note: string,
): Promise<{ ok: true; documentNumber: string } | { ok: false; error: string }> {
  const ctx = await actorFor('stock.adjust')
  if ('ok' in ctx) return ctx

  const trace = await batchTrace(ctx.siteId, batchId)
  if (!trace) return { ok: false, error: 'That lot no longer exists.' }
  const { batch } = trace
  if (batch.qtyRemaining <= 0) {
    return { ok: false, error: 'The lot has nothing left to write off.' }
  }
  if (!note.trim()) return { ok: false, error: 'Say why the lot is being written off.' }

  const posted = await postNewAdjustment(ctx.siteId, ctx.actor, {
    locationId: batch.locationId,
    note: note.trim(),
    lines: [
      {
        productId: batch.productId,
        productCode: batch.productCode,
        description: batch.productDescription,
        qtyChange: -batch.qtyRemaining,
        unitCostExcl: batch.costExcl,
        batchId: batch.id,
        note: `Lot ${batch.batchNo || 'untracked'} — ${note.trim()}`.slice(0, 190),
      },
    ],
  })
  if (!posted.ok) return posted
  revalidatePath('/batches')
  return { ok: true, documentNumber: posted.documentNumber }
}
