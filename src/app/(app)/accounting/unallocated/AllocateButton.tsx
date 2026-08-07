'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { autoAllocateAction } from '../actions'

/**
 * Applies one credit against the oldest open invoices.
 *
 * Oldest-first without asking, because that is what a customer paying without a
 * remittance almost always means — and when they DO say which invoices, the
 * allocation is made on their account screen instead, where the choice can be
 * seen. See planAutoAllocation in ledger.ts.
 */
export function AllocateButton({
  txnId,
  customerName,
  disabled,
}: {
  txnId: number
  /** Read out by the icon-only button's label — "Apply Acme's credit…". */
  customerName?: string
  disabled?: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={
        customerName
          ? `Apply ${customerName}'s credit to their oldest open invoices`
          : 'Apply this credit to the oldest open invoices'
      }
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
      {pending ? <Icons.Spinner size={15} className="animate-spin" /> : <Icons.HandCoins size={15} />}
    </Button>
  )
}
