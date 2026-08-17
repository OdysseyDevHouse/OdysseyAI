'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { newOrderAction } from './actions'

/**
 * Starts a blank sales order and goes straight into it.
 *
 * A button rather than a link, for the same reason invoicing's is: the editor
 * needs a document id to hang lines off, so the row has to exist before the
 * screen opens.
 *
 * ── IT USED TO SEND PEOPLE TO THE TILL ────────────────────────────────────
 *
 * "New order at the till" was a plain link to /pos that handed over nothing —
 * and for most of its life the till could not raise an order at all, so it led
 * nowhere twice over. It briefly opened a till already writing one, which
 * works, but on a shop that serves tables the floor gate stands in front of it:
 * somebody who has just said "new order" was asked "which table?" first.
 *
 * An order is a back-office document, captured on the same editor as an invoice
 * and a quote. The till keeps its own way in — the Save-as-order key turns a
 * basket into one — and neither screen is the poor relation.
 */
export default function NewOrderButton() {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await newOrderAction()
          if (!result.ok) {
            /* Said out loud. The quotes button spent its whole life failing
               silently here, which is indistinguishable from a dead button. */
            toast.error(result.error)
            return
          }
          router.push(`/sales/orders/${result.documentId}`)
        })
      }
    >
      <Icons.Plus size={15} />
      {pending ? 'Starting…' : 'New order'}
    </Button>
  )
}
