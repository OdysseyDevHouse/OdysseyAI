'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ConfirmModal, Icons, useToast } from '@/components/ui'
import { postRunAction, cancelRunAction, sendRemittancesAction } from '../actions'

/**
 * Posting a run, and sending the advices.
 *
 * Posting is confirmed, because it is the moment money is committed. Sending
 * the remittances is not — the payment has already happened by then, so a
 * second confirmation would only be friction.
 */
export default function RunActions({
  runId,
  status,
  mailReady,
  hasItems,
}: {
  runId: number
  status: 'draft' | 'posted' | 'cancelled'
  mailReady: boolean
  hasItems: boolean
}) {
  const [posting, setPosting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setPosting(false)
        setCancelling(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'draft' && (
        <>
          <Button variant="danger-ghost" onClick={() => setCancelling(true)} disabled={pending}>
            <Icons.Close size={15} />
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => setPosting(true)}
            disabled={pending || !hasItems}
          >
            <Icons.Wallet size={15} />
            Post the payments
          </Button>
        </>
      )}

      {status === 'posted' && (
        <Button
          variant="secondary"
          onClick={() => run(() => sendRemittancesAction(runId))}
          disabled={pending || !mailReady}
          title={mailReady ? undefined : 'Email is not set up.'}
        >
          <Icons.Send size={15} />
          {pending ? 'Sending…' : 'Email the advices'}
        </Button>
      )}

      <ConfirmModal
        open={posting}
        onClose={() => setPosting(false)}
        onConfirm={() => run(() => postRunAction(runId))}
        title="Post these payments?"
        confirmLabel="Post the payments"
        tone="primary"
        busy={pending}
        message="One payment per supplier is written to the ledger and allocated against exactly the invoices listed. This does not move money at the bank — do that separately, using the same reference."
      />

      <ConfirmModal
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() => run(() => cancelRunAction(runId))}
        title="Cancel this run?"
        confirmLabel="Cancel the run"
        busy={pending}
        message="Nothing has been paid, so nothing is reversed. The run is marked cancelled and the invoices stay outstanding."
      />
    </div>
  )
}
