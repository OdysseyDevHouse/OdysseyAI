'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Modal, Textarea, useToast } from '@/components/ui'
import { unbuildAction } from '../actions'

/**
 * Reversing a build.
 *
 * Asks for a reason in a modal rather than a bare confirm, because the reason
 * is stored and is the only thing that later explains why the same goods moved
 * twice. A ConfirmModal would not collect it.
 */
export default function UnbuildButton({
  id,
  number,
  qty,
  description,
}: {
  id: number
  number: string
  qty: string
  description: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    startTransition(async () => {
      const result = await unbuildAction(id, reason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Unbuilt — the ingredients went back.')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icons.Reverse size={15} />
        Unbuild
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Unbuild ${number}?`}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit} disabled={pending || !reason.trim()}>
              {pending ? 'Unbuilding…' : 'Unbuild'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            The ingredients go back on the shelf and {qty} {description} come off it. This is
            refused if the finished goods are no longer there — they have already sold or moved
            on, and taking them back would leave a pile short.
          </p>
          <p className="text-sm text-muted">
            The original movements stay on record. What the item costs is left alone, the same way
            voiding a receipt does not unwind a cost.
          </p>
          <Field label="Reason" hint="Stored on the build, so the double movement is explainable.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              rows={2}
              placeholder="Dough did not prove"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
