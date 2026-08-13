'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { remindDueAction } from './actions'

/**
 * Texts everyone whose lay-by is coming due — the nudge that keeps the sweep
 * beside it from ever having work. No confirmation: it sends the reminder the
 * customer signed up for, throttled to once a week per lay-by.
 */
export default function RemindButton({ smsConfigured }: { smsConfigured: boolean }) {
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  if (!smsConfigured) {
    return (
      <Button variant="secondary" disabled title="SMS is not set up — choose a provider under Setup.">
        <Icons.MessageSquare size={15} />
        Text reminders
      </Button>
    )
  }

  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await remindDueAction()
          if (result.ok) {
            toast.success(result.message)
            router.refresh()
          } else {
            toast.error(result.error)
          }
        })
      }
    >
      <Icons.MessageSquare size={15} />
      Text reminders
    </Button>
  )
}
