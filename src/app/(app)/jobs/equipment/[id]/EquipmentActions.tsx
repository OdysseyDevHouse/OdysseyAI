'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ConfirmModal,
  Field,
  Input,
  Modal,
  useToast,
} from '@/components/ui'
import { retireAssetAction, reviveAssetAction, deleteAssetAction } from '../../actions'

/**
 * Retire, revive, delete.
 *
 * ── WHY RETIRE IS THE PROMINENT ONE ────────────────────────────────────────
 *
 * Deleting is refused the moment a job has named the unit, because that work IS its
 * history — the FK is RESTRICT and the action explains itself. So the delete button
 * only appears while nothing has been done to it, and retiring is what everybody
 * else needs. Offering a delete that almost always fails would teach people to
 * ignore the refusal.
 *
 * ── A REASON IS REQUIRED ───────────────────────────────────────────────────
 *
 * Scrapped, replaced, sold on, moved out of contract — these lead to different
 * conversations a year later, and "retired" alone answers none of them.
 */
export default function EquipmentActions({
  assetId,
  isActive,
  jobCount,
  description,
}: {
  assetId: number
  isActive: boolean
  jobCount: number
  description: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [retiring, setRetiring] = useState(false)
  const [reason, setReason] = useState('')
  const [deleting, setDeleting] = useState(false)

  function retire() {
    start(async () => {
      const result = await retireAssetAction(assetId, reason)
      if (result.ok) {
        toast.success('Retired. Its history stays on file.')
        setRetiring(false)
        setReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function revive() {
    start(async () => {
      const result = await reviveAssetAction(assetId)
      if (result.ok) {
        toast.success('Back in use.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove() {
    start(async () => {
      const result = await deleteAssetAction(assetId)
      if (result.ok) {
        toast.success('Deleted.')
        router.push('/jobs/equipment')
      } else {
        toast.error(result.error)
        setDeleting(false)
      }
    })
  }

  return (
    <>
      {isActive ? (
        <Button variant="secondary" onClick={() => setRetiring(true)} disabled={pending}>
          Retire
        </Button>
      ) : (
        <Button variant="secondary" onClick={revive} disabled={pending}>
          Put back in use
        </Button>
      )}

      {/* Only while nothing has been done to it. See the header. */}
      {jobCount === 0 && (
        <Button variant="danger-ghost" onClick={() => setDeleting(true)} disabled={pending}>
          Delete
        </Button>
      )}

      <Modal
        open={retiring}
        onClose={() => setRetiring(false)}
        title={`Retire ${description}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRetiring(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={retire} disabled={pending || !reason.trim()}>
              {pending ? 'Saving…' : 'Retire it'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            It stops appearing when choosing equipment for a job, and drops off the service-due list.
            Everything already recorded against it stays exactly as it is.
          </p>
          <Field
            label="Why"
            hint="Scrapped, replaced, sold on, out of contract — these lead to different conversations later."
          >
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Scrapped — compressor failed, beyond economic repair"
              maxLength={190}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={remove}
        title={`Delete ${description}?`}
        message="Nothing has been done to this unit yet, so there is no history to lose. If any work had been recorded against it the delete would be refused and retiring would be the answer instead."
        confirmLabel="Delete it"
        busy={pending}
      />
    </>
  )
}
