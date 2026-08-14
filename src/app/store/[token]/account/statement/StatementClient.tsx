'use client'

import { useState, useTransition } from 'react'
import { Button, useToast } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { payInvoiceAction } from '../actions'

/** One open invoice's Pay button — mints the link, then goes to it. */
export function PayInvoiceButton({
  token,
  transactionId,
  amount,
}: {
  token: string
  transactionId: number
  amount: number
}) {
  const toast = useToast()
  const [busy, start] = useTransition()
  const [sent, setSent] = useState(false)

  return (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || sent}
      onClick={() =>
        start(async () => {
          const result = await payInvoiceAction(token, transactionId)
          if (!result.ok) {
            toast.error(result.error)
            return
          }
          setSent(true)
          window.location.assign(result.url)
        })
      }
    >
      {busy || sent ? 'Opening…' : `Pay ${formatMoney(amount)}`}
    </Button>
  )
}
