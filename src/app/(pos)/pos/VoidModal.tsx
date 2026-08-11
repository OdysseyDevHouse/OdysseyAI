'use client'

import { useEffect, useState } from 'react'
import { Button, Callout, Icons, Modal, ReasonPicker, type PickableReason } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

/**
 * Reversing the sale that was just taken.
 *
 * ── WHY THIS IS THE ONLY VOID THE TILL OFFERS ─────────────────────────────
 *
 * `voidDocument` refuses anything but a SAME-DAY finalised sale, and says why: a
 * prior day has been banked, and voiding into it would change a figure somebody
 * has already signed off. Yesterday's mistake is a credit note, not a void.
 *
 * So the till offers void where it is almost always the right answer and always
 * permitted — from the receipt, on the sale in front of the cashier, seconds
 * after it posted. Anything older goes through the back office, which has the
 * sales list, the credit-note path and a manager already looking at it.
 *
 * ── WHY A REASON IS REQUIRED ──────────────────────────────────────────────
 *
 * Because the engine requires one, and because a void is the one till action that
 * moves stock back onto the shelf and money off a debtor's card. "Voided" with no
 * reason is a row nobody can account for later; the reason is what makes a pattern
 * of them visible.
 *
 * ── WHY IT IS A CODE AND NOT FREE TEXT ────────────────────────────────────
 *
 * It used to be a typed sentence, which meant "wrong item", "Wrong Item" and
 * "wrng itm" were three different reasons and no report could add them up. The
 * question the field exists to answer — what are we losing to voids, and why —
 * could not be answered by the thing recording the answer. Now the shop's own
 * list is picked from, and the typed note survives as the detail beside it.
 */
export function VoidModal({
  open,
  documentNumber,
  total,
  reasons,
  busy,
  onClose,
  onVoid,
}: {
  open: boolean
  documentNumber: string
  total: number
  /** The site's void reasons, active ones only. */
  reasons: PickableReason[]
  busy: boolean
  onClose: () => void
  onVoid: (reason: { reasonId: number; note: string | null }) => void
}) {
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  // Cleared each time it opens: the last void's reason must not be sitting there
  // ready to be submitted for a different sale.
  useEffect(() => {
    if (open) {
      setReasonId(null)
      setNote('')
    }
  }, [open])

  const ready = reasonId !== null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Void this sale?"
      size="sm"
      /* A stray tap on the backdrop must not dismiss a half-typed reason for
         something the cashier has decided to reverse. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="danger"
            size="touch-lg"
            className="flex-1 justify-center"
            disabled={!ready || busy}
            onClick={() => reasonId !== null && onVoid({ reasonId, note: note.trim() || null })}
          >
            <Icons.Trash size={20} />
            {busy ? 'Voiding…' : 'Void the sale'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-card border border-border bg-surface-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="selectable numeric text-lg font-bold text-ink">{documentNumber}</span>
            <span className="numeric text-lg font-bold text-ink">{formatMoney(total)}</span>
          </div>
        </div>

        {/* Says exactly what will happen, in the order it happens. A cashier
            about to reverse real money should not have to infer the consequences
            from the word "void". */}
        <Callout tone="warning">
          The stock goes back on the shelf and the payment is reversed. The sale
          keeps its number — a voided invoice stays on the books as voided, which
          is what makes the gap in the numbering explainable.
        </Callout>

        <ReasonPicker
          reasons={reasons}
          value={reasonId}
          note={note}
          onChange={setReasonId}
          onNoteChange={setNote}
          label="Why is this being voided?"
          hint="Recorded against the sale, and what a void report groups by."
          disabled={busy}
        />
      </div>
    </Modal>
  )
}
