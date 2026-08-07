'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal, Field, Input, Icons, useToast } from '@/components/ui'
import {
  approveWriteOffAction,
  rejectWriteOffAction,
  recoverWriteOffAction,
} from '../actions'

/**
 * Approve, reject or recover.
 *
 * Approval is a single click — the request already carries the reason, and
 * asking for a second one at approval time is friction that gets routed around.
 * Rejection asks why, because the requester needs to know.
 *
 * Icon-only on purpose: these sit on every pending row, and a list of N
 * labelled Approve buttons is N primaries competing with the data.
 */
export function WriteOffActions({
  id,
  mode,
  customerName,
}: {
  id: number
  mode: 'approve' | 'recover'
  /** Read out by the icon-only buttons' labels. */
  customerName?: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)

  const whose = customerName ? `${customerName}'s` : 'this'
  const reasonError =
    touched && !reason.trim() ? 'Give a reason — the requester reads it.' : undefined

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  if (mode === 'recover') {
    return (
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`Mark ${whose} write-off as recovered`}
        disabled={pending}
        onClick={() => run(() => recoverWriteOffAction(id))}
      >
        <Icons.HandCoins size={15} />
      </Button>
    )
  }

  return (
    <>
      <div className="flex gap-1.5">
        <Button
          variant="danger-ghost"
          size="sm"
          iconOnly
          aria-label={`Reject ${whose} write-off request`}
          disabled={pending}
          onClick={() => {
            setReason('')
            setTouched(false)
            setRejecting(true)
          }}
        >
          <Icons.Close size={15} />
        </Button>
        <Button
          variant="success"
          size="sm"
          iconOnly
          aria-label={`Approve ${whose} write-off`}
          disabled={pending}
          onClick={() => run(() => approveWriteOffAction(id))}
        >
          <Icons.Check size={15} />
        </Button>
      </div>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this write-off"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim()}
              onClick={() => {
                run(() => rejectWriteOffAction(id, reason.trim()))
                setRejecting(false)
              }}
            >
              Reject
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The request stays on record with your reason attached.
          </p>
          <Field label="Why is it being rejected?" error={reasonError}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Still collectable — the customer has agreed terms"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
