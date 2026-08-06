'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal, Field, Input, Icons, useToast } from '@/components/ui'
import type { ExpenseStatus } from '@/lib/expenseModel'
import { finaliseExpenseAction, voidExpenseAction, deleteDraftAction } from '../actions'

/**
 * Post, void or discard.
 *
 * A draft can be discarded outright — it never existed as far as the books are
 * concerned. A posted expense can only be VOIDED, which reverses what it did
 * and keeps the record, because something that moved money must stay
 * explicable afterwards.
 */
export function ExpenseActions({
  id,
  status,
  documentNumber,
}: {
  id: number
  status: ExpenseStatus
  documentNumber: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')

  function run(
    action: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    goToList = false,
  ) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        if (goToList) router.push('/expenses')
        else router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  if (status === 'void') return null

  return (
    <>
      {status === 'draft' ? (
        <>
          <Button
            variant="danger-ghost"
            disabled={pending}
            onClick={() => {
              if (!window.confirm('Discard this draft? It has posted nothing.')) return
              run(() => deleteDraftAction(id), true)
            }}
          >
            Discard
          </Button>
          <Button disabled={pending} onClick={() => run(() => finaliseExpenseAction(id))}>
            <Icons.Check size={15} />
            Post it
          </Button>
        </>
      ) : (
        <Button
          variant="danger-ghost"
          disabled={pending}
          onClick={() => {
            setReason('')
            setVoiding(true)
          }}
        >
          Void
        </Button>
      )}

      <Modal open={voiding} onClose={() => setVoiding(false)} title="Void this expense">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {documentNumber ?? 'This expense'} will be reversed — the money it moved is put back
            — and the record kept, marked void with your reason.
          </p>
          <Field label="Why is it being voided?">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Captured twice"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setVoiding(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim()}
              onClick={() => {
                run(() => voidExpenseAction(id, reason.trim()))
                setVoiding(false)
              }}
            >
              Void
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
