'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ButtonLink, ConfirmModal, Field, Icons, Input, useToast } from '@/components/ui'
import { issueOrderAction, cancelOrderAction, voidReceiptAction } from '../actions'

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
}: {
  documentId: number
  documentNumber: string | null
  status: string
  docType: string
  voidable: boolean
}) {
  const [cancelling, setCancelling] = useState(false)
  const [voiding, setVoiding] = useState(false)
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
      {isOrder && status === 'draft' && (
        <Button variant="primary" onClick={() => run(() => issueOrderAction(documentId))} disabled={pending}>
          <Icons.Send size={15} />
          Issue to supplier
        </Button>
      )}

      {isOrder && status === 'issued' && (
        <ButtonLink href="/purchasing/receive" variant="primary">
          <Icons.PackageOpen size={15} />
          Receive
        </ButtonLink>
      )}

      {isOrder && (status === 'draft' || status === 'issued') && (
        <Button variant="danger-ghost" onClick={() => setCancelling(true)} disabled={pending}>
          <Icons.Close size={15} />
          Cancel
        </Button>
      )}

      {voidable && (
        <Button variant="danger-ghost" onClick={() => setVoiding(true)} disabled={pending}>
          <Icons.Ban size={15} />
          Void
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

      <ConfirmModal
        open={voiding}
        onClose={() => setVoiding(false)}
        onConfirm={() => run(() => voidReceiptAction(documentId, reason))}
        title={`Void ${documentNumber}?`}
        confirmLabel="Void the receipt"
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
