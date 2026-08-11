'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Button,
  ConfirmModal,
  Icons,
  ReasonPicker,
  useToast,
  type PickableReason,
} from '@/components/ui'
import { voidSaleAction, recordPrintAction, creditWholeSaleAction } from '../actions'

/**
 * Cancel, credit and print, on a posted document.
 *
 * There is no Edit here, deliberately. A finalised invoice is a record of what
 * was issued — the customer may be holding a copy of it — so a mistake is
 * corrected by cancelling it (same day) or crediting it (later), never by
 * changing what it says.
 */
export default function DocumentActions({
  documentId,
  documentNumber,
  voidable,
  isVoid,
  creditable,
  voidReasons,
  returnReasons,
  voidBlockedReason,
  creditBlockedReason,
}: {
  documentId: number
  documentNumber: string | null
  voidable: boolean
  isVoid: boolean
  /** The site's two reason lists, active entries only. */
  voidReasons: PickableReason[]
  returnReasons: PickableReason[]
  /** Finalised, has something left to credit, and the role is allowed. */
  creditable: boolean
  /**
   * Why the action is unavailable, or null to hide the button entirely.
   *
   * The distinction matters: "your role cannot do this" is worth showing as a
   * disabled button, because it is a permission the user can go and get. "This
   * is a quote, not an invoice" is not — a Cancel button on a quote would just
   * be noise.
   */
  voidBlockedReason?: string | null
  creditBlockedReason?: string | null
}) {
  const [voiding, setVoiding] = useState(false)
  const [crediting, setCrediting] = useState(false)
  const [voidReasonId, setVoidReasonId] = useState<number | null>(null)
  const [voidNote, setVoidNote] = useState('')
  const [creditReasonId, setCreditReasonId] = useState<number | null>(null)
  const [creditNote, setCreditNote] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function doCredit() {
    if (creditReasonId === null) {
      toast.error('Choose a reason for the credit.')
      return
    }
    startTransition(async () => {
      const result = await creditWholeSaleAction(documentId, {
        reasonId: creditReasonId,
        note: creditNote.trim() || null,
      })
      if (result.ok) {
        toast.success(`${result.documentNumber} raised. The stock is back on hand.`)
        setCrediting(false)
        setCreditReasonId(null)
        setCreditNote('')
        router.push(`/sales/${result.documentId}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  function print() {
    startTransition(async () => {
      await recordPrintAction(documentId)
      window.print()
      router.refresh()
    })
  }

  function doVoid() {
    if (voidReasonId === null) {
      toast.error('Choose a reason for the cancellation.')
      return
    }
    startTransition(async () => {
      const result = await voidSaleAction(documentId, {
        reasonId: voidReasonId,
        note: voidNote.trim() || null,
      })
      if (result.ok) {
        toast.success(`${documentNumber} cancelled. The stock has been returned.`)
        setVoiding(false)
        setVoidReasonId(null)
        setVoidNote('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      {/* Print is the screen's one primary: on a posted document it is the
          only action most visits are for — cancel and credit are exceptions. */}
      {documentNumber && (
        <Button variant="primary" onClick={print} disabled={pending}>
          <Icons.Printer size={15} />
          Print
        </Button>
      )}

      {/*
        Shown disabled with the reason rather than hidden. A button that simply
        is not there teaches nothing: someone whose role lacks the permission
        concludes the feature is broken, or blames the date. The tooltip turns
        "why can't I do this?" into a one-second answer.
      */}
      {/*
        Two credit paths, and the ordering is the point. Everything coming back
        is by far the common case, so it is one button and one confirm. Picking
        lines and quantities is the exception, so it is a link off the confirm
        rather than the default a cashier has to wade through.
      */}
      {!isVoid &&
        (creditable ? (
          <Button variant="ghost" onClick={() => setCrediting(true)} disabled={pending}>
            <Icons.Reverse size={15} />
            Credit sale
          </Button>
        ) : (
          creditBlockedReason && (
            <Button variant="ghost" disabled title={creditBlockedReason}>
              <Icons.Reverse size={15} />
              Credit sale
            </Button>
          )
        ))}

      {!isVoid &&
        (voidable ? (
          <Button variant="danger-ghost" onClick={() => setVoiding(true)} disabled={pending}>
            <Icons.Ban size={15} />
            Cancel sale
          </Button>
        ) : (
          voidBlockedReason && (
            <Button variant="danger-ghost" disabled title={voidBlockedReason}>
              <Icons.Ban size={15} />
              Cancel sale
            </Button>
          )
        ))}

      <ConfirmModal
        open={crediting}
        onClose={() => setCrediting(false)}
        onConfirm={doCredit}
        title={`Credit ${documentNumber}?`}
        confirmLabel="Credit the whole sale"
        tone="primary"
        busy={pending}
        message={
          <div className="flex flex-col gap-3">
            <p>
              Everything still outstanding on this sale is credited back: the stock returns to the
              shelf and, on an account sale, the customer&apos;s balance drops. The original invoice
              stays exactly as it is — this raises a separate document against it.
            </p>
            <ReasonPicker
              reasons={returnReasons}
              value={creditReasonId}
              note={creditNote}
              onChange={setCreditReasonId}
              onNoteChange={setCreditNote}
              label="Why is it coming back?"
              hint="Recorded on the credit and in the audit trail, and what a returns report groups by."
              disabled={pending}
            />
            <p className="text-xs text-muted">
              Only some of it coming back?{' '}
              <Link href={`/sales/${documentId}/credit`} className="text-brand hover:underline">
                Choose lines and quantities instead
              </Link>
              .
            </p>
          </div>
        }
      />

      <ConfirmModal
        open={voiding}
        onClose={() => setVoiding(false)}
        onConfirm={doVoid}
        title={`Cancel ${documentNumber}?`}
        /* "Yes, cancel it" rather than "Cancel the sale": the dismiss button
           beside it also says Cancel, and two buttons reading Cancel on one
           dialog is exactly the moment someone clicks the wrong one. */
        confirmLabel="Yes, cancel it"
        cancelLabel="Keep the sale"
        busy={pending}
        message={
          <div className="flex flex-col gap-3">
            <p>
              The stock goes back and the sale stops counting toward today&apos;s takings. The
              document keeps its number, so the sequence stays complete and the cancellation is on
              record.
            </p>
            <p className="text-xs text-muted">
              Only possible on the day the sale was rung up. After that, credit it instead —
              cancelling would change a day that has already been banked.
            </p>
            <ReasonPicker
              reasons={voidReasons}
              value={voidReasonId}
              note={voidNote}
              onChange={setVoidReasonId}
              onNoteChange={setVoidNote}
              label="Why is it being cancelled?"
              hint="Recorded against the document, and what a void report groups by."
              disabled={pending}
            />
          </div>
        }
      />
    </div>
  )
}
