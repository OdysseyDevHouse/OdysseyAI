'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ConfirmModal, Icons, useToast } from '@/components/ui'
import { expireStaleAction } from './actions'

/**
 * Sweeps lay-bys nobody came back for.
 *
 * Confirmed, but gently: expiring spends nothing and refunds nothing. It marks
 * the lay-by so it stops holding stock and stops appearing as active — the
 * customer's money is still theirs and still owed back, which is what the
 * confirmation says out loud.
 */
export default function ExpireButton() {
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run() {
    startTransition(async () => {
      const result = await expireStaleAction()
      if (result.ok) {
        toast.success(result.message)
        setConfirming(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setConfirming(true)} disabled={pending}>
        <Icons.Clock size={15} />
        Sweep expired
      </Button>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={run}
        title="Sweep expired lay-bys?"
        confirmLabel="Sweep them"
        tone="primary"
        busy={pending}
        message="Lay-bys more than 30 days past their due date are marked expired, so they stop holding stock. No money moves — what each customer paid is still theirs, and each one still has to be cancelled properly to refund it."
      />
    </>
  )
}
