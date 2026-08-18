'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ButtonLink, ConfirmModal, Field, Icons, Input, useToast } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import { EmailOrderDialog } from './EmailOrderDialog'
import {
  issueOrderAction,
  cancelOrderAction,
  closeOrderShortAction,
  voidReceiptAction,
  deleteDraftReceiptAction,
} from '../actions'

/**
 * What can still be done to a purchase document.
 *
 * A draft can be issued or cancelled. An issued order can be received against
 * or cancelled. A finalised GRV can only be voided, same day — after that the
 * instrument is a supplier return, for the same reason a sale gets a credit
 * note rather than a late void.
 */
export default function PurchaseActions({
  documentId,
  documentNumber,
  status,
  docType,
  voidable,
  returnable = false,
  outstanding = 0,
  received = 0,
  mailConfigured = false,
  supplierEmail = '',
  lastSentNote = null,
}: {
  documentId: number
  documentNumber: string | null
  status: string
  docType: string
  voidable: boolean
  /**
   * Ordered but not yet arrived, summed across the lines. Drives whether
   * closing short is offered at all, and is quoted in the confirmation —
   * "those 3" is a figure someone can check against the delivery note.
   */
  outstanding?: number
  /**
   * How much HAS arrived. An order with nothing received is a cancel, not a
   * close: closing it would leave an issued order claiming a delivery that
   * never started.
   */
  received?: number
  /**
   * Whether SMTP is set up at all. Decided on the server, and the button is
   * hidden rather than disabled without it: one that can only explain why it
   * does not work is worse than no button.
   */
  mailConfigured?: boolean
  /** The supplier's own address, seeding the dialog. '' when they have none. */
  supplierEmail?: string
  /** The last send, so a resend is an informed act. Null if never sent. */
  lastSentNote?: string | null
  /**
   * A finalised GRV with something still left to send back. False once every
   * line has gone, so the button does not lead to a screen that can only say
   * there is nothing to do.
   */
  returnable?: boolean
}) {
  const [cancelling, setCancelling] = useState(false)
  const [closing, setClosing] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success('message' in result && result.message ? result.message : 'Done.')
        setCancelling(false)
        setClosing(false)
        setVoiding(false)
        setReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const isOrder = docType === 'purchase_order'

  return (
    <div className="flex items-center gap-2">
      {/* A draft has been sent to nobody, so it is still fully editable.
          Deliberately not offered once issued: the supplier has our order and
          a number for it, and rewriting it here would leave the two copies
          disagreeing with nothing to say which is right. */}
      {isOrder && status === 'draft' && (
        <ButtonLink href={`/purchasing/${documentId}/edit`} variant="ghost">
          <Icons.Pencil size={15} />
          Edit
        </ButtonLink>
      )}

      {isOrder && status === 'draft' && (
        <Button variant="primary" onClick={() => run(() => issueOrderAction(documentId))} disabled={pending}>
          <Icons.Send size={15} />
          Issue to supplier
        </Button>
      )}

      {/* A part-keyed delivery, picked back up. Nothing has moved, so it opens
          in the receiving screen exactly as it was left. */}
      {docType === 'grv' && status === 'draft' && (
        <ButtonLink href={`/purchasing/receive?draft=${documentId}`} variant="primary">
          <Icons.PackageOpen size={15} />
          Carry on receiving
        </ButtonLink>
      )}

      {docType === 'grv' && status === 'draft' && (
        <Button variant="danger-ghost" onClick={() => setDiscarding(true)} disabled={pending}>
          <Icons.Trash size={15} />
          Discard
        </Button>
      )}

      {/* Carries the order across, so receiving opens with these lines already
          pulled in. Landing on an empty receipt and asking the user to find
          the order again in a dropdown is the same click twice. */}
      {isOrder && status === 'issued' && (
        <ButtonLink href={`/purchasing/receive?order=${documentId}`} variant="primary">
          <Icons.PackageOpen size={15} />
          Receive
        </ButtonLink>
      )}

      {/* An issued order can be sent, and sent again. Not offered on a draft:
          a draft has no number for the supplier to quote back, so the useful
          act there is Issue — which sits right beside it. */}
      {isOrder && status === 'issued' && mailConfigured && (
        <Button variant="ghost" onClick={() => setEmailing(true)} disabled={pending}>
          <Icons.Mail size={15} />
          Email
        </Button>
      )}

      {/* Only where there is something to give up on. An order still fully
          outstanding can simply be cancelled, and one fully received has
          nothing left — offering "close short" on either is offering a button
          that can only explain why it does not apply. */}
      {isOrder && status === 'issued' && outstanding > 0 && received > 0 && (
        <Button variant="ghost" onClick={() => setClosing(true)} disabled={pending}>
          <Icons.Check size={15} />
          Close short
        </Button>
      )}

      {isOrder && (status === 'draft' || status === 'issued') && (
        <Button variant="danger-ghost" onClick={() => setCancelling(true)} disabled={pending}>
          <Icons.Close size={15} />
          Cancel
        </Button>
      )}

      {/* Offered alongside the same-day void, not instead of it: on the day
          itself both are legitimate, and they mean different things to a VAT
          return. Voiding says it never happened; returning says it did and the
          goods are going back. */}
      {returnable && (
        <ButtonLink href={`/purchasing/${documentId}/return`} variant="secondary">
          <Icons.Reverse size={15} />
          Return to supplier
        </ButtonLink>
      )}

      {voidable && (
        <Button variant="danger-ghost" onClick={() => setVoiding(true)} disabled={pending}>
          <Icons.Ban size={15} />
          Cancel receipt
        </Button>
      )}

      <ConfirmModal
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() => run(() => cancelOrderAction(documentId, reason))}
        title={`Cancel ${documentNumber ?? 'this order'}?`}
        confirmLabel="Cancel the order"
        busy={pending}
        message={
          <div className="flex flex-col gap-3">
            <p>
              Nothing has been received, so nothing is reversed. The order is marked cancelled and
              stops appearing as outstanding.
            </p>
            <Field label="Reason">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Ordered in error"
              />
            </Field>
          </div>
        }
      />

      <EmailOrderDialog
        open={emailing}
        onClose={() => setEmailing(false)}
        documentId={documentId}
        documentNumber={documentNumber}
        defaultTo={supplierEmail}
        lastSentNote={lastSentNote}
      />

      <ConfirmModal
        open={closing}
        onClose={() => setClosing(false)}
        onConfirm={() => run(() => closeOrderShortAction(documentId, reason))}
        title={`Close ${documentNumber ?? 'this order'} short?`}
        confirmLabel="Close it"
        cancelLabel="Keep it open"
        busy={pending}
        message={
          <div className="flex flex-col gap-3">
            <p>
              What arrived stays exactly as it is — nothing is reversed and no stock moves. The
              order simply stops asking for the rest.
            </p>
            <p>
              Until it does, those{' '}
              <span className="numeric font-medium text-ink">{formatQty(outstanding)}</span> count
              as stock on its way in, so the reorder suggestions keep buying that much less.
            </p>
            <Field label="Reason">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Supplier discontinued the line"
              />
            </Field>
          </div>
        }
      />

      {/* Deleted rather than marked cancelled, unlike an order: an abandoned
          ORDER is a fact about the supplier relationship worth keeping, while a
          half-keyed delivery that was never posted is just an unfinished form.
          Cancelled shells would only make the purchasing list worse. */}
      <ConfirmModal
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={() =>
          run(async () => {
            const result = await deleteDraftReceiptAction(documentId)
            if (result.ok) router.push('/purchasing')
            return result
          })
        }
        title="Discard this draft?"
        confirmLabel="Discard it"
        cancelLabel="Keep it"
        busy={pending}
        message={
          <p>
            Nothing has been posted, so nothing is reversed — the part-keyed lines are simply
            thrown away. This cannot be undone.
          </p>
        }
      />

      <ConfirmModal
        open={voiding}
        onClose={() => setVoiding(false)}
        onConfirm={() => run(() => voidReceiptAction(documentId, reason))}
        title={`Cancel ${documentNumber}?`}
        confirmLabel="Yes, cancel it"
        cancelLabel="Keep the receipt"
        busy={pending}
        message={
          <div className="flex flex-col gap-3">
            <p>
              Stock goes back out and the supplier&apos;s account is credited. The average cost is
              deliberately not unwound — anything sold since has already moved on, so a costing
              correction is a separate, considered adjustment.
            </p>
            <p className="text-xs text-muted">
              Only possible on the day it was received. After that, raise a supplier return.
            </p>
            <Field label="Reason">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Received against the wrong supplier"
              />
            </Field>
          </div>
        }
      />
    </div>
  )
}
