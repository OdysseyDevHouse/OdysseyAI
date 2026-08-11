'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ConfirmModal, Field, Icons, Modal, Textarea, useToast } from '@/components/ui'
import type { AdjustmentStatus } from '@/lib/site/stockAdjustments'
import { cancelAdjustmentAction, deleteAdjustmentAction, postAdjustmentAction } from '../actions'

/**
 * What can still be done to an adjustment.
 *
 * A DRAFT has moved nothing, so it can be posted or thrown away outright. A
 * POSTED one can only be reversed — the stock genuinely changed, and deleting
 * the record would leave a pile whose history does not explain it.
 *
 * The reason is collected in a Modal rather than a ConfirmModal because it is
 * stored, and it is the only thing that later explains why the same goods moved
 * twice. Deleting a draft explains nothing and needs no reason, so that one is
 * a plain confirm.
 */
export default function AdjustmentActions({
  id,
  number,
  status,
}: {
  id: number
  number: string
  status: AdjustmentStatus
}) {
  const [cancelOpen, setCancelOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function post() {
    startTransition(async () => {
      const result = await postAdjustmentAction(id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} posted — the stock has changed.`)
      router.refresh()
    })
  }

  function cancel() {
    startTransition(async () => {
      const result = await cancelAdjustmentAction(id, reason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Adjustment reversed — the stock went back.')
      setCancelOpen(false)
      router.refresh()
    })
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteAdjustmentAction(id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Draft deleted.')
      router.push('/adjustments')
    })
  }

  if (status === 'cancelled') return null

  return (
    <>
      {status === 'draft' ? (
        <>
          <Button variant="ghost" onClick={() => setDeleteOpen(true)} disabled={pending}>
            <Icons.Trash size={15} />
            Delete
          </Button>
          <Button variant="primary" onClick={post} disabled={pending}>
            <Icons.SlidersHorizontal size={15} />
            {pending ? 'Posting…' : 'Post'}
          </Button>
        </>
      ) : (
        <Button variant="secondary" onClick={() => setCancelOpen(true)} disabled={pending}>
          <Icons.Reverse size={15} />
          Reverse
        </Button>
      )}

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Reverse ${number}?`}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={cancel} disabled={pending || !reason.trim()}>
              {pending ? 'Reversing…' : 'Reverse adjustment'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            The opposite movement is written against every line, at the cost the original was
            valued at. Reversing a write-on is refused if the stock is no longer there.
          </p>
          <Field
            label="Reason"
            hint="Stored on the adjustment, so the double movement is explainable."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={190}
              rows={2}
              placeholder="Captured against the wrong location"
            />
          </Field>
        </div>
      </Modal>

      <ConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={remove}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        tone="danger"
        busy={pending}
        message="Nothing has moved, so there is nothing to reverse — the capture is simply thrown away."
      />
    </>
  )
}
