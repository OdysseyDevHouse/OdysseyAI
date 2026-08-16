'use client'

import { useEffect, useState } from 'react'
import { Badge, Button, Icons, Modal, ReasonPicker, type PickableReason } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { VoidType } from '@/lib/site/posVoids'

/**
 * Asking why something is coming off a sale that has not been finalised.
 *
 * ── THIS IS A VOID, NOT A CANCEL ──────────────────────────────────────────
 *
 * `VoidModal` is the other one: it reverses a FINALISED sale, puts stock back
 * and takes money off a card. This modal never touches money, because nothing
 * has been taken yet — the sale is still on the screen in front of the cashier.
 * The two are deliberately separate components with different words on them, so
 * that a cashier is never asked "void this sale?" in the two cases where it
 * would mean two different things.
 *
 * ── WHY THE KIND IS ON THE FACE OF IT ─────────────────────────────────────
 *
 * The heading names what is being voided — one item, a whole line, or the sale
 * — because the minus key and the Void key can produce the SAME visible result.
 * A minus press on a single-unit line removes that line, so without the label a
 * cashier taking one unit off a pack of six and a cashier removing the pack
 * entirely see an identical prompt for two very different acts. It is also the
 * distinction the report is grouped by, so the person answering for it later
 * ought to have seen it at the time.
 */

/** The heading, the badge and the verb, per kind. */
const COPY: Record<VoidType, { title: string; badge: string; verb: string }> = {
  item: {
    title: 'Void this item?',
    badge: 'Item void',
    verb: 'Void the item',
  },
  line: {
    title: 'Void this line?',
    badge: 'Line void',
    verb: 'Void the line',
  },
  sale: {
    title: 'Void this sale?',
    badge: 'Sale void',
    verb: 'Void the sale',
  },
}

export function VoidReasonModal({
  open,
  voidType,
  description,
  qty,
  valueIncl,
  reasons,
  busy = false,
  onClose,
  onConfirm,
}: {
  open: boolean
  /** Which of the three the cashier is doing. Decides every word shown. */
  voidType: VoidType
  /** What is going: the line description, or "4 lines" for a whole sale. */
  description: string
  qty: number
  /** What it was worth, VAT in. Shown so the size of the act is visible. */
  valueIncl: number
  /** The site's void reasons, active only — already on the page for offline. */
  reasons: PickableReason[]
  busy?: boolean
  onClose: () => void
  onConfirm: (reason: { reasonId: number; note: string | null }) => void
}) {
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  // Cleared each time it opens: the last void's reason must not be sitting
  // there ready to be submitted for a different line.
  useEffect(() => {
    if (open) {
      setReasonId(null)
      setNote('')
    }
  }, [open])

  const copy = COPY[voidType]
  const ready = reasonId !== null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      size="sm"
      /* A stray tap on the backdrop must not throw away the line the cashier is
         still deciding about, nor submit a half-picked reason. */
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
            onClick={() => reasonId !== null && onConfirm({ reasonId, note: note.trim() || null })}
          >
            <Icons.Trash size={20} />
            {copy.verb}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* What is going, and what it was worth. The badge repeats the kind
            beside it, because the heading scrolls out of view on a short till
            screen once the reason list opens. */}
        <div className="rounded-card border border-border bg-surface-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-semibold text-ink">{description}</span>
            <span className="numeric shrink-0 font-bold text-ink">{formatMoney(valueIncl)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <Badge tone="danger">{copy.badge}</Badge>
            <span className="numeric text-sm text-muted">
              {formatQty(qty)} {voidType === 'sale' ? '' : '×'}
            </span>
          </div>
        </div>

        <ReasonPicker
          reasons={reasons}
          value={reasonId}
          note={note}
          onChange={setReasonId}
          onNoteChange={setNote}
          label="Why is this coming off?"
          hint="Recorded against the till, and what a void report groups by."
          disabled={busy}
        />
      </div>
    </Modal>
  )
}

/** Trailing zeros off a till quantity: "2" rather than "2.000". */
function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)))
}
