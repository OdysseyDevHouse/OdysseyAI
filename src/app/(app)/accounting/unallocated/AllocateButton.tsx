'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, useToast } from '@/components/ui'
import { autoAllocateAction } from '../actions'

/**
 * Applies one credit against the oldest open invoices.
 *
 * Oldest-first without asking, because that is what a customer paying without a
 * remittance almost always means — and when they DO say which invoices, the
 * allocation is made on their account screen instead, where the choice can be
 * seen. See planAutoAllocation in ledger.ts.
 */
export function AllocateButton({ txnId, disabled }: { txnId: number; disabled?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          const result = await autoAllocateAction(txnId)
          if (result.ok) {
            toast.success(result.message)
            router.refresh()
          } else {
            toast.error(result.error)
          }
        })
      }
    >
      {pending ? 'Applying…' : 'Apply'}
    </Button>
  )
}
