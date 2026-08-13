'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Input, Modal, Textarea, useToast } from '@/components/ui'
import { emailInvoiceAction } from './actions'

/**
 * Emailing one document, with a human confirming the address.
 *
 * The address is editable rather than fixed to the account's: "send it to my
 * bookkeeper" is a counter request, not an edge case. A resend is allowed —
 * the last send is shown right here, so a second copy is an informed act, and
 * every send lands in the document's audit trail either way.
 */
export function EmailInvoiceDialog({
  open,
  onClose,
  documentId,
  documentNumber,
  defaultTo,
  lastEmailedNote,
}: {
  open: boolean
  onClose: () => void
  documentId: number
  documentNumber: string | null
  /** The customer's address, when the account has one. */
  defaultTo: string
  /** "INV000123 to x@y — R500.00 · Ruth · 2026-08-01", or null if never sent. */
  lastEmailedNote: string | null
}) {
  const [to, setTo] = useState(defaultTo)
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  // A fresh open starts from the account's address, not the last edit.
  useEffect(() => {
    if (open) setTo(defaultTo)
  }, [open, defaultTo])

  function sendIt() {
    startTransition(async () => {
      const result = await emailInvoiceAction(documentId, {
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
    <Modal open={open} onClose={onClose} title={`Email ${documentNumber ?? 'this document'}`}>
      <div className="space-y-4">
        {lastEmailedNote && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
            Last sent: {lastEmailedNote}
          </p>
        )}

        <Field
          label="To"
          hint={defaultTo ? undefined : 'No email on the account — add one on the customer, or type an address here.'}
        >
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>

        <Field label="Message" hint="Optional — appears above the invoice details.">
          <Textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. As discussed this morning."
          />
        </Field>

        <p className="text-xs text-muted">
          The PDF rides along as an attachment. If anything is still owed and online
          payments are set up, the email carries a pay link for the outstanding amount.
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
