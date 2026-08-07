'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal, Field, Input, useToast } from '@/components/ui'
import { reverseJournalAction } from '../../accounts/actions'

/**
 * Reverses a manual journal by posting its mirror.
 *
 * Never an edit or a delete — the original stays exactly as posted and the
 * correction sits beside it, linked. The trail must show what happened AND what
 * was done about it, which is the same rule the sub-ledgers follow.
 */
export function ReverseButton({
  id,
  journalNumber,
}: {
  id: number
  journalNumber: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)

  const reasonError =
    touched && !reason.trim() ? 'Give a reason — it stays on the record.' : undefined

  return (
    <>
      <Button
        variant="danger-ghost"
        onClick={() => {
          setReason('')
          setTouched(false)
          setOpen(true)
        }}
      >
        Reverse
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Reverse this journal">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            A mirror entry is posted, dated today, undoing {journalNumber ?? 'this journal'}. The
            original stays exactly as it was — both remain visible.
          </p>
          <Field label="Why is it being reversed?" error={reasonError}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Posted to the wrong account"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await reverseJournalAction(id, reason.trim())
                  if (result.ok) {
                    toast.success(result.message)
                    setOpen(false)
                    router.refresh()
                  } else {
                    toast.error(result.error)
                  }
                })
              }
            >
              Reverse
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
