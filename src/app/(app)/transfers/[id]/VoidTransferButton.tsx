'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Modal, Textarea, useToast } from '@/components/ui'
import { voidTransferAction } from '../actions'

/**
 * Reversing a transfer.
 *
 * Asks for a reason in a modal rather than a bare confirm, because the reason
 * is stored and is the only thing that later explains why the same goods moved
 * twice. A ConfirmModal would not collect it.
 */
export default function VoidTransferButton({ id, number }: { id: number; number: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    startTransition(async () => {
      const result = await voidTransferAction(id, reason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Transfer voided — the stock went back.')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icons.Reverse size={15} />
        Void
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Void ${number}?`}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit} disabled={pending || !reason.trim()}>
              {pending ? 'Voiding…' : 'Void transfer'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            The stock goes back where it came from. This is refused if the destination no longer
            holds what it received — those goods have already been sold or moved on.
          </p>
          <Field label="Reason" hint="Stored on the transfer, so the double movement is explainable.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={190}
              rows={2}
              placeholder="Sent to the wrong room"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
