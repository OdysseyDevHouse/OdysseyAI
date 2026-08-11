'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Modal, Textarea, useToast } from '@/components/ui'
import { cancelDispatchAction, settleDispatchAction } from '../actions'

/**
 * What can still be done to a dispatch this store sent.
 *
 * RECALL, while it is still on the truck: the goods come back off it and into
 * the room they left. Refused once the other store has received them, because
 * at that point the stock is theirs and the answer is a transfer the other way.
 *
 * SETTLE is the repair button, and it is deliberately visible rather than
 * hidden in a maintenance screen. It exists for the one failure a two-database
 * receive can leave: the far end took the goods but this end was not told, so
 * both stores count them. It is idempotent, so pressing it when nothing is
 * wrong simply reports that there was nothing to do.
 */
export default function StoreTransferActions({
  id,
  number,
  peerSiteId,
  peerSiteName,
}: {
  id: number
  number: string
  peerSiteId: number | null
  peerSiteName: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function recall() {
    startTransition(async () => {
      const result = await cancelDispatchAction(id, reason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Dispatch recalled — the stock is back where it came from.')
      setOpen(false)
      router.refresh()
    })
  }

  function settle() {
    if (!peerSiteId) return
    startTransition(async () => {
      const result = await settleDispatchAction(id, peerSiteId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.settled
          ? `Settled — the goods are off this store's books and on ${peerSiteName}'s.`
          : 'Nothing to settle; this dispatch was already closed off.',
      )
      router.refresh()
    })
  }

  return (
    <>
      {peerSiteId && (
        <Button variant="ghost" onClick={settle} disabled={pending}>
          <Icons.Refresh size={15} />
          Check with {peerSiteName}
        </Button>
      )}
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={pending}>
        <Icons.Reverse size={15} />
        Recall
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Recall ${number}?`}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={recall} disabled={pending || !reason.trim()}>
              {pending ? 'Recalling…' : 'Recall dispatch'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            The stock comes out of transit and back into the location it left. This is refused if{' '}
            {peerSiteName} has already received it — at that point the goods are theirs, and they
            have to send them back.
          </p>
          <Field label="Reason" hint="Stored on the dispatch, so the double movement is explainable.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={190}
              rows={2}
              placeholder="Loaded onto the wrong vehicle"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
