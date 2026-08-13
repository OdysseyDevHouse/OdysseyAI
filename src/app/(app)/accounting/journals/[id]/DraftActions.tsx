'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ConfirmModal, Icons, useToast } from '@/components/ui'
import { postDraftAction, discardDraftAction } from '../actions'

/**
 * Post or discard a draft — the review a recurring schedule generated it for.
 *
 * Post claims the number, moves the balances and dates the entry on the
 * draft's own journal date. Discard is a real delete: a draft moved nothing,
 * so a tombstone would be a ledger row meaning "nothing happened here".
 */
export function DraftActions({ batchId }: { batchId: number }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [discarding, setDiscarding] = useState(false)

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => setDiscarding(true)}
      >
        <Icons.Trash size={15} />
        Discard
      </Button>
      <Button disabled={pending} onClick={() => run(() => postDraftAction(batchId))}>
        <Icons.Check size={15} />
        Post journal
      </Button>

      <ConfirmModal
        open={discarding}
        onClose={() => setDiscarding(false)}
        title="Discard this draft?"
        tone="danger"
        confirmLabel="Discard"
        onConfirm={() => {
          setDiscarding(false)
          run(async () => {
            const result = await discardDraftAction(batchId)
            if (result.ok) router.push('/accounting/journals')
            return result
          })
        }}
        message="It moved nothing and has no number, so nothing else changes. A recurring schedule will not regenerate it."
      />
    </div>
  )
}
