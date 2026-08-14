'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Icons,
  Modal,
  SignaturePad,
  useToast,
} from '@/components/ui'
import { signJobAction, unsignJobAction } from '../actions'
import type { JobSignoff, SignoffParty, SignoffRule } from '@/lib/site/jobSignoff'

/**
 * Who has signed this job off, and who still has to.
 *
 * ── WHY IT SITS ON THE CHECKS TAB ──────────────────────────────────────────
 *
 * Because that is where the pad already is. A signature captured here and a
 * signature captured against a checklist item are the same act with the same
 * component; putting the two on different tabs would teach people they are
 * different things.
 *
 * ── WHY BOTH PARTIES SHOW EVEN WHEN ONLY ONE IS REQUIRED ───────────────────
 *
 * A technician signature is worth recording whether or not the site demands it,
 * and hiding the row until somebody changes a setting means nobody discovers it
 * exists. The RULE only decides what blocks closing; it does not decide what may
 * be recorded.
 */

const PARTY_LABEL: Record<SignoffParty, string> = {
  customer: 'Customer',
  technician: 'Technician',
}

const PARTY_HINT: Record<SignoffParty, string> = {
  customer: 'Signed by whoever accepted the work on site.',
  technician: 'Signed by whoever carried the work out.',
}

/** A stored wall-clock stamp as a person reads it. */
function readable(stamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp)
  if (!match) return stamp
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [, year, month, day, hour, minute] = match
  return `${Number(day)} ${months[Number(month) - 1] ?? month} ${year}, ${hour}:${minute}`
}

export default function JobSignoffCard({
  jobId,
  jobClosed,
  canEdit,
  signoff,
  rule,
  signatureStatement,
}: {
  jobId: number
  jobClosed: boolean
  canEdit: boolean
  signoff: JobSignoff
  rule: SignoffRule
  signatureStatement: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  // Which party's pad is open. One at a time, for the same reason JobChecks
  // allows one: two pads on screen is two people signing at once, which is not
  // a thing that happens.
  const [signing, setSigning] = useState<SignoffParty | null>(null)
  const [viewing, setViewing] = useState<SignoffParty | null>(null)

  function capture(party: SignoffParty, png: Blob, name: string) {
    const form = new FormData()
    form.set('file', new File([png], `signoff-${party}-${jobId}.png`, { type: 'image/png' }))
    if (name) form.set('name', name)
    start(async () => {
      const result = await signJobAction(jobId, party, form)
      if (result.ok) {
        toast.success('Signed.')
        setSigning(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function withdraw(party: SignoffParty) {
    start(async () => {
      const result = await unsignJobAction(jobId, party)
      if (result.ok) {
        toast.success(`${PARTY_LABEL[party]} signature withdrawn.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const parties: SignoffParty[] = ['customer', 'technician']
  // What the site actually demands before this job can close. 'none' says so
  // rather than leaving the card silent about whether any of this is required.
  const required = (party: SignoffParty) =>
    rule === 'both' || (rule === 'customer' && party === 'customer')

  const outstanding = parties.filter((p) => required(p) && signoff[p] === null)

  return (
    <>
      <Card>
        <CardHeader
          title="Sign-off"
          description={
            rule === 'none'
              ? 'Recorded when it happens. This job can close without a signature.'
              : outstanding.length > 0
                ? `Still needed before this job can close: ${outstanding
                    .map((p) => PARTY_LABEL[p].toLowerCase())
                    .join(' and ')}.`
                : 'Everything this job needs has been signed.'
          }
        />
        <CardBody className="space-y-3">
          {parties.map((party) => {
            const mark = signoff[party]
            return (
              <div
                key={party}
                className="flex items-center justify-between gap-3 rounded-card border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{PARTY_LABEL[party]}</span>
                    {mark ? (
                      <Badge tone="success">Signed</Badge>
                    ) : required(party) ? (
                      <Badge tone="warning">Required</Badge>
                    ) : (
                      <Badge tone="neutral">Optional</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {mark
                      ? `${mark.name ?? 'Name not given'} — ${readable(mark.at)}`
                      : PARTY_HINT[party]}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {mark && mark.attachmentId !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setViewing(party)}
                      aria-label={`View ${PARTY_LABEL[party].toLowerCase()} signature`}
                      iconOnly
                    >
                      <Icons.Eye className="size-4" />
                    </Button>
                  )}
                  {canEdit && !jobClosed && (
                    mark ? (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => withdraw(party)}
                      >
                        Withdraw
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => setSigning(party)}>
                        Sign
                      </Button>
                    )
                  )}
                </div>
              </div>
            )
          })}
        </CardBody>
      </Card>

      {/* The pad goes in a modal, as JobChecks does, because the customer is
          handed the device and should see one thing: what they are agreeing to,
          and somewhere to sign. */}
      <Modal
        open={signing !== null}
        onClose={() => setSigning(null)}
        title={signing ? `${PARTY_LABEL[signing]} signature` : 'Signature'}
        size="md"
      >
        {signing && (
          <SignaturePad
            statement={signatureStatement}
            busy={pending}
            onCancel={() => setSigning(null)}
            onCapture={(png, name) => capture(signing, png, name)}
          />
        )}
      </Modal>

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `${PARTY_LABEL[viewing]} signature` : 'Signature'}
        size="md"
      >
        {viewing && signoff[viewing]?.attachmentId !== null && (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a stored
                signature has no known dimensions and next/image wants them. */}
            {/* The entity pair is not decoration: the route checks the document
                belongs to this job before serving a byte. Same URL JobChecks
                uses for evidence. */}
            <img
              src={`/api/attachments/${signoff[viewing]?.attachmentId}?entity=job_card&entityId=${jobId}`}
              alt={`${PARTY_LABEL[viewing]} signature`}
              className="w-full rounded-control border border-border bg-surface"
            />
            <p className="text-xs text-muted">
              {signoff[viewing]?.name ?? 'Name not given'} —{' '}
              {readable(signoff[viewing]?.at ?? '')}
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}
