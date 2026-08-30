'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui'
import { payInvoiceAction } from '../actions'

/**
 * Pay one invoice.
 *
 * ── IT MINTS THE LINK ON PRESS, NOT ON RENDER ──────────────────────────────
 *
 * A payment intent is a claim on money and its token lasts a day. Creating one
 * per invoice every time this list renders would leave a trail of intents nobody
 * used, so the intent is made when somebody actually decides to pay.
 */
export default function PayButton({
  token,
  documentId,
}: {
  token: string
  documentId: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function pay() {
    setError(null)
    start(async () => {
      const result = await payInvoiceAction(token, documentId)
      if (result.ok) router.push(result.url)
      else setError(result.error)
    })
  }

  return (
    <>
      {/* Secondary, not primary. This renders once per open invoice, so on a
          statement with eleven of them a primary variant put eleven competing
          "loudest things" on one screen — which is the same as none. The row
          the customer wants is found by its number and its amount; the button
          only has to be reachable once they are looking at it. */}
      <Button size="sm" variant="secondary" onClick={pay} disabled={pending}>
        {pending ? 'One moment…' : 'Pay it'}
      </Button>
      {error && (
        <span className="w-full text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </>
  )
}
