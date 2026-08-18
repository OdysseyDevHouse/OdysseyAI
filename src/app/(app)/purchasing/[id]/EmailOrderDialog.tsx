'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Input, Modal, Textarea, useToast } from '@/components/ui'
import { emailPurchaseOrderAction } from '../actions'

/**
 * Sending a purchase order to the supplier.
 *
 * The sales-side twin of EmailInvoiceDialog, and deliberately the same shape:
 * an editable address, an optional covering note, and the last send shown so a
 * second copy is a decision rather than an accident. Somebody who has emailed
 * an invoice this morning should not have to learn a second dialog.
 *
 * The address is editable rather than pinned to the supplier record for the
 * same reason it is on the sales side — "send it to their branch, not head
 * office" is an ordinary Tuesday, not an edge case worth a detour through the
 * supplier screen.
 */
export function EmailOrderDialog({
  open,
  onClose,
  documentId,
  documentNumber,
  defaultTo,
  lastSentNote,
}: {
  open: boolean
  onClose: () => void
  documentId: number
  documentNumber: string | null
  /** The supplier's address, when the record has one. */
  defaultTo: string
  /** "PO000123 to x@y · Ruth · 2026-08-18", or null if never sent. */
  lastSentNote: string | null
}) {
  const [to, setTo] = useState(defaultTo)
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  // A fresh open starts from the supplier's address, not the last edit.
  useEffect(() => {
    if (open) setTo(defaultTo)
  }, [open, defaultTo])

  function sendIt() {
    startTransition(async () => {
      const result = await emailPurchaseOrderAction(documentId, {
        to: to.trim(),
        message: message.trim() || undefined,
      })
      if (result.ok) {
        toast.success(result.message)
        setMessage('')
        onClose()
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={`Email ${documentNumber ?? 'this order'}`}>
      <div className="space-y-4">
        {lastSentNote && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
            Last sent: {lastSentNote}
          </p>
        )}

        <Field
          label="To"
          hint={
            defaultTo
              ? undefined
              : 'No email on the supplier — add one on their record, or type an address here.'
          }
        >
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="orders@supplier.co.za"
          />
        </Field>

        <Field label="Message" hint="Optional — appears above the order.">
          <Textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Please deliver Friday morning."
          />
        </Field>

        <p className="text-xs text-muted">
          The order is laid out in the email itself, using the same stationery it prints on.
          Nothing about the order changes — this only sends a copy.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending || !to.trim()} onClick={sendIt}>
            Send
          </Button>
        </div>
      </div>
    </Modal>
  )
}
