'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
  TextLink,
  useToast,
} from '@/components/ui'
import type { JobRequest, RequestStatus } from '@/lib/site/jobIntake'
import {
  acceptRequestAction,
  rejectRequestAction,
  reopenRequestAction,
  searchJobCustomersAction,
} from '../actions'

/**
 * The queue, and the one screen where a stranger becomes a customer's job.
 *
 * ── ACCEPTING ASKS WHO IT IS FOR, EVERY TIME ───────────────────────────────
 *
 * There is no "create the customer from this" button, and that absence is the
 * feature. Matching "J Smith, 082…" to an account is a judgement — two customers
 * share a surname, a number changes hands — and getting it wrong files somebody
 * work against a stranger's account, where it becomes an invoice.
 *
 * A genuinely new customer is added on the customers screen first. One extra
 * step, once, against a mistake that is expensive and quiet.
 */
export default function RequestsClient({
  requests,
  active,
  publicUrl,
  formEnabled,
}: {
  requests: JobRequest[]
  active: RequestStatus | 'all'
  publicUrl: string | null
  formEnabled: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [accepting, setAccepting] = useState<JobRequest | null>(null)
  const [rejecting, setRejecting] = useState<{ request: JobRequest; spam: boolean } | null>(null)
  const [showUrl, setShowUrl] = useState(false)

  // The customer picker, on the JobForm pattern.
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ id: number; name: string; code: string }[]>([])
  const [chosen, setChosen] = useState<{ id: number; name: string } | null>(null)
  const [title, setTitle] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([])
      return
    }
    let live = true
    // Debounced, as the job form is: this fires per keystroke against a customer
    // file that can be thousands of rows.
    const timer = setTimeout(() => {
      searchJobCustomersAction(query)
        .then((found) => {
          if (live) setMatches(found.map((c) => ({ id: c.id, name: c.name, code: c.code })))
        })
        .catch(() => {
          if (live) setMatches([])
        })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  function openAccept(request: JobRequest) {
    setAccepting(request)
    setTitle(request.title)
    setChosen(null)
    setQuery(request.contactName)
    setMatches([])
  }

  function accept() {
    if (!accepting || !chosen) return
    start(async () => {
      const result = await acceptRequestAction(accepting.id, chosen.id, { title })
      if (result.ok) {
        toast.success('Job raised.')
        setAccepting(null)
        router.push(`/jobs/${result.jobId}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  function reject() {
    if (!rejecting) return
    start(async () => {
      const result = await rejectRequestAction(
        rejecting.request.id,
        rejecting.spam ? 'spam' : 'rejected',
        reason.trim() || null,
      )
      if (result.ok) {
        toast.success(rejecting.spam ? 'Marked as junk.' : 'Turned down.')
        setRejecting(null)
        setReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function reopen(request: JobRequest) {
    start(async () => {
      const result = await reopenRequestAction(request.id)
      if (result.ok) {
        toast.success('Back in the queue.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const TONE: Record<RequestStatus, 'brand' | 'success' | 'neutral' | 'danger'> = {
    new: 'brand',
    accepted: 'success',
    rejected: 'neutral',
    spam: 'danger',
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Requests"
          description={
            formEnabled
              ? 'Anything sent through your public form. Nothing here is a job until you accept it.'
              : 'Nothing new can arrive while the form is switched off.'
          }
          action={
            publicUrl ? (
              <Button variant="secondary" onClick={() => setShowUrl(true)} disabled={pending}>
                <Icons.Link2 size={15} />
                The link to share
              </Button>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          <div className="border-b border-border px-4 py-3">
            <SegmentedControl
              value={active}
              onChange={(v) => router.push(`/jobs/requests?status=${v}`)}
              options={[
                { value: 'new', label: 'Waiting' },
                { value: 'accepted', label: 'Accepted' },
                { value: 'rejected', label: 'Turned down' },
                { value: 'spam', label: 'Junk' },
                { value: 'all', label: 'Everything' },
              ]}
              aria-label="Which requests"
            />
          </div>

          {requests.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Icons.Mail size={22} />}
                title={active === 'new' ? 'Nothing waiting' : 'Nothing here'}
                hint={
                  active === 'new'
                    ? 'Requests sent through your public form land here for somebody to accept or turn down.'
                    : 'Try another tab.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">{r.title}</span>
                        <Badge tone={TONE[r.status]}>
                          {r.status === 'new' ? 'Waiting' : r.status}
                        </Badge>
                        {r.headlineName && <Badge tone="neutral">{r.headlineName}</Badge>}
                      </span>
                      <span className="block text-xs text-muted">
                        {r.reference} · {r.contactName} · {r.contactPhone}
                        {r.contactEmail ? ` · ${r.contactEmail}` : ''} · {r.createdAt}
                      </span>
                      {r.description && (
                        <span className="mt-1 block whitespace-pre-line text-sm text-ink-2">
                          {r.description}
                        </span>
                      )}
                      {r.addressText && (
                        <span className="mt-1 block text-xs text-muted">
                          Address given: {r.addressText}
                        </span>
                      )}
                      {r.status === 'accepted' && r.jobCardId && (
                        <span className="mt-1 block text-xs">
                          <TextLink href={`/jobs/${r.jobCardId}`}>
                            Became job {r.jobCardId}
                          </TextLink>
                          {r.decidedByName ? ` — accepted by ${r.decidedByName}` : ''}
                        </span>
                      )}
                      {(r.status === 'rejected' || r.status === 'spam') && (
                        <span className="mt-1 block text-xs text-muted">
                          {r.decidedByName ? `By ${r.decidedByName}` : ''}
                          {r.decidedReason ? ` — ${r.decidedReason}` : ''}
                        </span>
                      )}
                    </span>

                    <span className="flex shrink-0 items-center gap-2">
                      {r.status === 'new' ? (
                        <>
                          <Button size="sm" onClick={() => openAccept(r)} disabled={pending}>
                            Accept
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setRejecting({ request: r, spam: false })}
                            disabled={pending}
                          >
                            Turn down
                          </Button>
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            onClick={() => setRejecting({ request: r, spam: true })}
                            disabled={pending}
                          >
                            Junk
                          </Button>
                        </>
                      ) : r.status !== 'accepted' ? (
                        // Everybody turns something down by mistake.
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => reopen(r)}
                          disabled={pending}
                        >
                          Put back
                        </Button>
                      ) : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ── Accepting ─────────────────────────────────────────────────────── */}
      <Modal
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title="Raise a job from this request"
        size="sm"
        /* A long form: the default 60vh cap made it read through a letterbox with
           empty desktop above and below. Still a MAX, so a short one stays short. */
        bodyGrows
        footer={
          <>
            <Button variant="secondary" onClick={() => setAccepting(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={accept} disabled={pending || !chosen || !title.trim()}>
              {pending ? 'Raising…' : 'Raise the job'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {accepting && (
            <p className="text-sm text-muted">
              From {accepting.contactName} on {accepting.contactPhone}.
            </p>
          )}

          <Field
            label="Which customer is this for?"
            hint="Somebody who is not on file yet needs adding on the customers screen first."
          >
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setChosen(null)
              }}
              placeholder="Search by name or code"
              disabled={pending}
            />
          </Field>

          {chosen ? (
            <p className="text-sm text-ink">
              <Icons.Check size={15} className="inline text-success" /> {chosen.name}
            </p>
          ) : (
            matches.length > 0 && (
              <ul className="max-h-[26vh] min-h-48 overflow-y-auto rounded-control border border-border">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      // A selection row, not a kit button: full width, two lines,
                      // and it must not look like a call to action.
                      data-kit-ok
                      className="w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-2"
                      onClick={() => setChosen({ id: c.id, name: c.name })}
                    >
                      {c.name}
                      <span className="block text-xs text-muted">{c.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {!chosen && query.trim().length >= 2 && matches.length === 0 && (
            <p className="text-xs text-muted">
              Nobody matches.{' '}
              <TextLink href="/customers/new">Add them as a customer</TextLink>, then come back.
            </p>
          )}

          <Field label="What the job is called" hint="Their words, unless you would rather change them.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={190}
              disabled={pending}
            />
          </Field>

          <p className="text-xs text-muted">
            What they wrote is kept on the job, along with their name and number.
          </p>
        </div>
      </Modal>

      {/* ── Turning one down ──────────────────────────────────────────────── */}
      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={rejecting?.spam ? 'Mark this as junk' : 'Turn this request down'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={reject} disabled={pending}>
              {rejecting?.spam ? 'Mark as junk' : 'Turn it down'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {rejecting?.spam
              ? 'It stays on file so the junk can be counted, and it stops counting against the sender daily limit.'
              : 'Nothing is sent to them — this app does not email a refusal. It can be put back later.'}
          </p>
          <Field label="Why, for the record" hint="Optional, and only ever seen inside the business.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={400}
              disabled={pending}
            />
          </Field>
        </div>
      </Modal>

      {/* ── The public link ───────────────────────────────────────────────── */}
      <ConfirmModal
        open={showUrl}
        onClose={() => setShowUrl(false)}
        onConfirm={() => setShowUrl(false)}
        title="The link to put on your website"
        confirmLabel="Done"
        message={
          publicUrl
            ? `${publicUrl}\n\nAnybody with this can send you a request — it is meant to be public. It does not change, so it can be printed on a van or turned into a QR code.`
            : ''
        }
      />
    </>
  )
}
