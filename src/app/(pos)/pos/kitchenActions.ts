'use server'

import { actorFor } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { siteExecute } from '@/lib/siteDb'
import { kitchenDelta } from '@/lib/kitchenTicket'
import type { KitchenTicketData } from '@/lib/escpos/slips'

/**
 * Send-to-kitchen, the server half.
 *
 * PRINT THEN MARK, in that order, and the ordering is the design: the server
 * cannot reach a printer on the shop's LAN, so the CLIENT prints (through its
 * local bridge) and only then calls `markKitchenSentAction`. A failed print
 * marks nothing — the retry reprints; a failed mark risks only a duplicate
 * ticket, and a kitchen shrugs at a duplicate where a lost ticket is a lost
 * meal.
 */

export type KitchenTicketResult =
  | { ok: true; ticket: KitchenTicketData; lines: { lineId: number; qty: number }[] }
  | { ok: false; error: string }

export async function kitchenTicketAction(documentId: number): Promise<KitchenTicketResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That bill no longer exists.' }
  if (doc.status !== 'saved') {
    return { ok: false, error: 'Save the table first — only a parked tab can send to the kitchen.' }
  }

  const delta = kitchenDelta(
    doc.lines.map((l) => ({ lineId: l.id, qty: Math.abs(l.qty), kitchenSentQty: l.kitchenSentQty })),
  )
  if (delta.length === 0) return { ok: false, error: 'Nothing new to send — the kitchen has it all.' }

  const byId = new Map(doc.lines.map((l) => [l.id, l]))
  return {
    ok: true,
    ticket: {
      tableLabel: doc.customerName?.trim() || 'Table',
      /* The SENDER, not the bill's original waiter — the runner delivers to
         whoever pressed the key. */
      waiter: actor.userName,
      at: new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }),
      covers: doc.personCount,
      lines: delta.map((d) => {
        const line = byId.get(d.lineId)!
        return {
          qty: d.qty,
          description: line.description,
          notes: line.instructions
            .filter((i) => i.printsOnKitchen)
            .map((i) => (i.qty > 1 ? `${i.qty} × ${i.optionName}` : i.optionName)),
          // The free-text note — "allergy: nuts" MUST reach the kitchen.
          note: line.note,
        }
      }),
    },
    lines: delta,
  }
}

/** Marks what was PRINTED. Incremental and capped, so a double-send cannot overstate. */
export async function markKitchenSentAction(
  documentId: number,
  lines: { lineId: number; qty: number }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  for (const line of lines) {
    if (!(line.qty > 0)) continue
    await siteExecute(
      siteId,
      `UPDATE sales_document_lines
          SET kitchen_sent_qty = LEAST(kitchen_sent_qty + ?, ABS(qty)),
              kitchen_sent_at = NOW()
        WHERE id = ? AND document_id = ?`,
      [line.qty.toFixed(3), line.lineId, documentId],
    )
  }
  return { ok: true }
}
