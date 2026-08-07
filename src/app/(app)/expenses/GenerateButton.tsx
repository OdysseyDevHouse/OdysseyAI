'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { generateDueAction } from './actions'

/**
 * Raises the drafts for every schedule that is due.
 *
 * Produces DRAFTS, never postings — an amount that changed or a bill that never
 * arrived are things a person must see before money moves. The label says so,
 * because "Generate" on its own reads like it is going to pay something.
 */
export function GenerateButton() {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    // Secondary on purpose: this sits inside a card, and each screen that
    // shows it already has its own primary (Capture expense / New schedule).
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await generateDueAction()
          if (result.ok) {
            toast.success(result.message)
            router.refresh()
          } else {
            toast.error(result.error)
          }
        })
      }
    >
      <Icons.Plus size={15} />
      {pending ? 'Creating…' : 'Create the drafts'}
    </Button>
  )
}
