'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Icons,
  Modal,
  Textarea,
  TextLink,
  useToast,
  type BadgeTone,
} from '@/components/ui'
import { decideRequestAction } from '../actions'
import type { PartRequest, RequestStatus } from '@/lib/site/jobPartRequests'

/**
 * The buying queue: every part a technician has asked for.
 *
 * ── WHY DECIDING IS A SEPARATE ACT FROM ORDERING ───────────────────────────
 *
 * Approving records that a buyer agreed. Raising the purchase order is done in
 * Purchasing, through saveOrder, unchanged — this screen does not raise one and
 * this module cannot. That boundary is what keeps a single ordering engine, and
 * it is the same reasoning that keeps finaliseDocument() the only posting one.
 *
 * A decline records WHO and WHY, following leave_requests: "no" without a
 * reason sends the technician back to ask again by phone, which is the
 * behaviour this queue exists to end.
 */

const TONE: Record<RequestStatus, BadgeTone> = {
  requested: 'warning',
  approved: 'brand',
  ordered: 'brand',
  received: 'success',
  cancelled: 'neutral',
}

export default function RequestQueue({
  requests,
  canDecide,
}: {
  requests: PartRequest[]
  canDecide: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [deciding, setDeciding] = useState<{ req: PartRequest; to: 'approved' | 'cancelled' } | null>(
    null,
  )
  const [note, setNote] = useState('')

  function decide() {
    if (!deciding) return
    start(async () => {
      const result = await decideRequestAction(deciding.req.id, deciding.to, note.trim() || null)
      if (result.ok) {
        toast.success(deciding.to === 'approved' ? 'Approved.' : 'Declined.')
        setDeciding(null)
        setNote('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  if (requests.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="Nothing on the queue"
            hint="When a technician needs a part that is not on the shelf, it appears here for a decision."
            icon={<Icons.Package size={22} />}
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardBody className="space-y-2">
          {requests.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {r.qty} × {r.description}
                  </span>
                  <Badge tone={TONE[r.status]}>{r.statusLabel}</Badge>
                </div>
                {/* The technician's own words. "Customer is waiting" and "spare
                    for the van" deserve different answers, and only the person
                    asking knows which it is. */}
                {r.reason && <p className="mt-0.5 text-sm text-ink-2">{r.reason}</p>}
                <p className="mt-1 text-xs text-muted">
                  <TextLink href={`/jobs/${r.jobCardId}`}>
                    {r.jobNumber ?? `Job #${r.jobCardId}`}
                  </TextLink>
                  {' · '}
                  {r.jobTitle}
                  {' · asked by '}
                  {r.requestedByName || 'somebody'}
                </p>
                {r.purchaseDocId !== null && (
                  <p className="mt-0.5 text-xs">
                    <TextLink href={`/purchasing/${r.purchaseDocId}`}>
                      {r.purchaseNumber ?? 'On an order'}
                    </TextLink>
                  </p>
                )}
                {r.decidedByName && (
                  <p className="mt-0.5 text-xs text-muted">
                    Decided by {r.decidedByName}
                    {r.decidedNote ? ` — ${r.decidedNote}` : ''}
                  </p>
                )}
              </div>

              {/* Only an undecided request can be decided. One already on an
                  order is settled in Purchasing, not here. */}
              {canDecide && r.status === 'requested' && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setDeciding({ req: r, to: 'approved' })
                      setNote('')
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setDeciding({ req: r, to: 'cancelled' })
                      setNote('')
                    }}
                  >
                    Decline
                  </Button>
                </div>
              )}

              {r.status === 'approved' && (
                <span className="shrink-0 text-xs text-muted">
                  Raise the order in Purchasing.
                </span>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      <Modal
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding?.to === 'approved' ? 'Approve this request' : 'Decline this request'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeciding(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={deciding?.to === 'approved' ? 'primary' : 'danger'}
              onClick={decide}
              disabled={pending}
            >
              {pending ? 'Saving…' : deciding?.to === 'approved' ? 'Approve' : 'Decline'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {deciding?.to === 'approved'
              ? 'This records that you agreed. Raising the purchase order is a separate step, in Purchasing.'
              : 'The technician sees this on the job, so say why — otherwise they will ask again by phone.'}
          </p>
          <Field
            label={deciding?.to === 'approved' ? 'Note' : 'Why not'}
            hint={deciding?.to === 'approved' ? 'Optional.' : 'Optional, but worth writing.'}
          >
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>
    </>
  )
}
