'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule, actorForModuleOrThrow } from '@/lib/auth'
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
  /** Whether the lot was READ off the pack, or inferred by expiry date (234). */
  observed: boolean
}

export async function batchTraceAction(
  batchId: number,
): Promise<{ ok: true; batch: Batch; events: BatchTraceEvent[] } | { ok: false; error: string }> {
  const ctx = await actorForModuleOrThrow('inventory_advanced', 'stock.view')
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
  reasonId: number | null,
  note: string,
): Promise<{ ok: true; documentNumber: string } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx

  const trace = await batchTrace(ctx.siteId, batchId)
  if (!trace) return { ok: false, error: 'That lot no longer exists.' }
  const { batch } = trace
  if (batch.qtyRemaining <= 0) {
    return { ok: false, error: 'The lot has nothing left to write off.' }
  }
  /*
   * The reason CODE and the free-text note answer different questions, and the
   * adjustment needs both: the code is what "how much did we lose to recalls
   * last quarter" totals, the note is what the person reading that line wants
   * next. Refusing here rather than letting validateAdjustment refuse keeps the
   * message pointed at the field the drawer actually shows.
   */
  if (!reasonId) return { ok: false, error: 'Choose a reason for the write-off.' }
  if (!note.trim()) {
    return { ok: false, error: 'Add the details — a notice or claim number the reason cannot carry.' }
  }

  const posted = await postNewAdjustment(ctx.siteId, ctx.actor, {
    locationId: batch.locationId,
    reasonId,
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
