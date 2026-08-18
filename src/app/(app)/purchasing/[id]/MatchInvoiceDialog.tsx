'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Input, Modal, useToast } from '@/components/ui'
import { matchSupplierInvoiceAction } from '../actions'

/**
 * Writing the supplier's invoice onto a receipt taken on a delivery note.
 *
 * Nothing here posts anything — the liability was raised when the goods were
 * received, and this only changes what that entry is CALLED and when it falls
 * due. The dialog says so, because "record invoice" on a screen full of
 * postings reasonably reads as another posting.
 *
 * The date is optional and deliberately blank rather than pre-filled with
 * today: an invoice dated the 2nd against a delivery on the 28th is a
 * different month to pay, and a date silently defaulted to now would quietly
 * assert the wrong one. Left empty, the receipt keeps the date it has.
 */
export function MatchInvoiceDialog({
  open,
  onClose,
  documentId,
  currentNumber,
  currentDate,
}: {
  open: boolean
  onClose: () => void
  documentId: number
  /** What the creditor ledger calls it now — usually our own GRV number. */
  currentNumber: string | null
  /** The date it is currently on, shown so a change is a visible one. */
  currentDate: string | null
}) {
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  // A fresh open starts empty rather than from the last attempt.
  useEffect(() => {
    if (open) {
      setInvoiceNo('')
      setInvoiceDate('')
    }
  }, [open])

  function save() {
    startTransition(async () => {
      const result = await matchSupplierInvoiceAction(documentId, {
        invoiceNo: invoiceNo.trim(),
        invoiceDate: invoiceDate.trim() || null,
      })
      if (result.ok) {
        toast.success(result.message)
        onClose()
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="Record the supplier's invoice">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          This delivery is on the creditor&rsquo;s account as{' '}
          <span className="numeric text-ink">{currentNumber ?? 'no number'}</span>
          {currentDate && (
            <>
              , dated <span className="numeric text-ink">{currentDate}</span>
            </>
          )}
          . Their statement will quote their own number instead, which is what makes the two
          disagree at month end.
        </p>

        <Field label="Their invoice number">
          <Input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="e.g. BW-88214"
            autoFocus
          />
        </Field>

        <Field
          label="Their invoice date"
          hint="Optional. Setting it re-dates the entry and recalculates when it falls due, off the supplier's terms."
        >
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>

        <p className="text-xs text-muted">
          Nothing is posted and no amount changes — the stock, the VAT and what you owe were all
          recorded when the goods were received.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending || !invoiceNo.trim()} onClick={save}>
            Record it
          </Button>
        </div>
      </div>
    </Modal>
  )
}
