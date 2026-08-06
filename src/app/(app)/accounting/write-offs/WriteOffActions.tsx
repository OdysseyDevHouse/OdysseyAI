'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal, Field, Input, useToast } from '@/components/ui'
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
 */
export function WriteOffActions({ id, mode }: { id: number; mode: 'approve' | 'recover' }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

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
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => run(() => recoverWriteOffAction(id))}
      >
        Recovered
      </Button>
    )
  }

  return (
    <>
      <div className="flex gap-1">
        <Button
          variant="danger-ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setReason('')
            setRejecting(true)
          }}
        >
          Reject
        </Button>
        <Button size="sm" disabled={pending} onClick={() => run(() => approveWriteOffAction(id))}>
          Approve
        </Button>
      </div>

      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Reject this write-off">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The request stays on record with your reason attached.
          </p>
          <Field label="Why is it being rejected?">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Still collectable — the customer has agreed terms"
            />
          </Field>
          <div className="flex justify-end gap-2">
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
          </div>
        </div>
      </Modal>
    </>
  )
}
