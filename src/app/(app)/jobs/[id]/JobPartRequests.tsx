'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Textarea,
  TextLink,
  useToast,
  type BadgeTone,
} from '@/components/ui'
import { requestPartAction } from '../actions'
import type { PartRequest, RequestStatus } from '@/lib/site/jobPartRequests'

/**
 * Parts this job is waiting on (§28).
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * A technician who needs something not on the shelf currently gets
 * "BRK-PAD-01 has only 0 in Main Store — cannot move 4" and has nowhere to go.
 * This is the onward path: ask, and somebody who buys decides.
 *
 * ── IT PROMISES NOTHING ────────────────────────────────────────────────────
 *
 * Asking reserves no stock and raises no order — deliberately, and the wording
 * says so. A screen that implied the part was on its way would be lying until a
 * buyer had actually looked at it, and the whole value of this queue is that
 * somebody real makes that decision.
 */

const TONE: Record<RequestStatus, BadgeTone> = {
  requested: 'warning',
  approved: 'brand',
  ordered: 'brand',
  received: 'success',
  cancelled: 'neutral',
}

export default function JobPartRequests({
  jobId,
  jobClosed,
  requests,
  canEdit,
}: {
  jobId: number
  jobClosed: boolean
  requests: PartRequest[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [asking, setAsking] = useState(false)
  const [description, setDescription] = useState('')
  const [qty, setQty] = useState(1)
  const [reason, setReason] = useState('')

  function ask() {
    if (!description.trim()) return
    start(async () => {
      const result = await requestPartAction(jobId, {
        description: description.trim(),
        qty,
        reason: reason.trim() || null,
      })
      if (result.ok) {
        toast.success('Asked for. Somebody who buys will pick it up.')
        setAsking(false)
        setDescription('')
        setQty(1)
        setReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const outstanding = requests.filter(
    (r) => r.status === 'requested' || r.status === 'approved' || r.status === 'ordered',
  )

  return (
    <>
      <Card>
        <CardHeader
          title="Parts asked for"
          description={
            requests.length === 0
              ? 'Nothing asked for. Use this when a part is not on the shelf.'
              : outstanding.length === 0
                ? 'Everything asked for has arrived.'
                : `${outstanding.length} still outstanding. Asking reserves nothing — a buyer decides.`
          }
          action={
            canEdit && !jobClosed ? (
              <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
                <Icons.Plus size={14} />
                Ask for a part
              </Button>
            ) : undefined
          }
        />
        {requests.length > 0 && (
          <CardBody className="space-y-2">
            {requests.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-card border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {r.qty} × {r.description}
                    </span>
                    <Badge tone={TONE[r.status]}>{r.statusLabel}</Badge>
                  </div>
                  {r.reason && <p className="mt-0.5 text-xs text-muted">{r.reason}</p>}
                  <p className="mt-0.5 text-xs text-muted">
                    Asked by {r.requestedByName || 'somebody'}
                    {r.decidedByName ? ` · decided by ${r.decidedByName}` : ''}
                    {r.decidedNote ? ` — ${r.decidedNote}` : ''}
                  </p>
                  {/* The order it landed on, so "where is my part" is one click
                      rather than a walk to the buying office. */}
                  {r.purchaseDocId !== null && (
                    <p className="mt-0.5 text-xs">
                      <TextLink href={`/purchasing/${r.purchaseDocId}`}>
                        {r.purchaseNumber ?? 'On an order'}
                      </TextLink>
                    </p>
                  )}
                </div>
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Ask for a part"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={ask}
              disabled={pending || !description.trim() || qty <= 0}
            >
              {pending ? 'Asking…' : 'Ask for it'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Said plainly, because a screen that implied otherwise would be
              lying until a buyer had looked at it. */}
          <p className="text-sm text-muted">
            This puts the part on the buying queue. It reserves no stock and raises no order —
            somebody who buys decides what happens next.
          </p>

          <Field label="What is needed" hint="A code if you have one, or describe it.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="BRK-PAD-01, or front brake pads"
              autoFocus
            />
          </Field>

          <Field label="How many">
            <NumberInput
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              className="numeric w-24 text-right"
            />
          </Field>

          <Field
            label="Why"
            hint="Optional, and it is what gets this moved up the queue or left."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Customer is waiting, van is out of stock…"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
