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
  /* `reasonName` rides along for the KITCHEN cancellation docket — a chef reads
     "Customer left", not a reason code. Resolved here from the list already on
     screen rather than re-fetched, and optional so a caller that does not print
     dockets can ignore it. */
  onConfirm: (reason: { reasonId: number; note: string | null; reasonName?: string }) => void
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
      /* Said once, at the top, in the header's own quiet line rather than as a
         warning block in the body. Nothing here is recoverable from the till —
         the line is gone off the screen and the void is written — and a cashier
         should read that before the reasons rather than after choosing one. */
      description="This action cannot be undone."
      /* The kind of act, in the kit's title slot. Danger-soft rather than solid:
         the disc is identifying what this dialog is, and the one solid red thing
         on the panel should be the button that does it. */
      titleMedia={
        <span className="flex size-10 items-center justify-center rounded-pill bg-danger-soft text-danger">
          <Icons.Trash size={20} />
        </span>
      }
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
            onClick={() =>
              reasonId !== null &&
              onConfirm({
                reasonId,
                note: note.trim() || null,
                reasonName: reasons.find((r) => r.id === reasonId)?.name,
              })
            }
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
            screen once the reason list opens.

            Two stacked columns rather than two full-width rows: the thing and
            its label belong together on the left, the two figures line up on the
            right, and the eye reads down one side or the other instead of
            zig-zagging across a box four lines tall.

            No glyph. The fill and the badge already separate this strip from the
            plain-bordered reason keys under it, and a second red disc directly
            below the one in the header was the same mark twice in 100px saying
            nothing the second time. */}
        <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-ink">{description}</span>
            <span className="mt-1 block">
              <Badge tone="danger">{copy.badge}</Badge>
            </span>
          </div>

          <div className="shrink-0 text-right">
            <span className="numeric block font-bold text-ink">{formatMoney(valueIncl)}</span>
            {/* How many, under the money — but only where the left has not
                already said it. A sale void's description IS the count ("2
                lines"), so printing it again here put the same two words twice
                on one strip; the caller builds that string, so the check is on
                the KIND rather than on comparing the two texts. */}
            {voidType !== 'sale' && (
              <span className="numeric mt-0.5 block text-sm text-muted">{formatQty(qty)} ×</span>
            )}
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
          touch
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
