'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { newInvoiceAction } from './actions'

/**
 * Starts a blank invoice and goes straight into it.
 *
 * A button rather than a link, because the editor needs a document id to hang
 * lines off — the row has to exist before the screen opens.
 */
export default function NewInvoiceButton() {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await newInvoiceAction()
          if (!result.ok) {
            toast.error(result.error)
            return
          }
          router.push(`/invoicing/${result.documentId}`)
        })
      }
    >
      <Icons.Plus size={15} />
      {pending ? 'Starting…' : 'New invoice'}
    </Button>
  )
}
