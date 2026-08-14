'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Callout, ConfirmModal, Textarea } from '@/components/ui'
import { portalCommentAction, acceptQuoteAction } from '../../actions'

/**
 * The two things a customer can DO on their own job.
 *
 * One component with a `kind` rather than two files, because both are three
 * lines of state and a transition, and both live inside the same page.
 *
 * ── ACCEPTING A QUOTE ASKS TWICE ───────────────────────────────────────────
 *
 * It is the only action here that commits money, and it cannot be undone from
 * this side. The dialog says what accepting means in the plainest words the
 * screen can manage, because "are you sure" is not information.
 */
export default function PortalJobActions({
  token,
  jobId,
  kind,
  quoteId,
  allowComments,
}: {
  token: string
  jobId: number
  kind: 'comment' | 'quote'
  quoteId?: number
  allowComments: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  function comment() {
    setError(null)
    start(async () => {
      const result = await portalCommentAction(token, jobId, body)
      if (result.ok) {
        setBody('')
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function accept() {
    if (!quoteId) return
    setError(null)
    start(async () => {
      const result = await acceptQuoteAction(token, quoteId)
      if (result.ok) {
        setConfirming(false)
        router.refresh()
      } else {
        setError(result.error)
        setConfirming(false)
      }
    })
  }

  if (kind === 'quote') {
    return (
      <>
        <Button size="sm" onClick={() => setConfirming(true)} disabled={pending}>
          Accept it
        </Button>
        {error && (
          <span className="w-full text-xs text-danger" role="alert">
            {error}
          </span>
        )}
        <ConfirmModal
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={accept}
          title="Accept this quote?"
          confirmLabel="Yes, go ahead"
          busy={pending}
          message="This tells the business to go ahead at the price quoted, and it is recorded with your name and the date. If you want to change anything, speak to them first."
        />
      </>
    )
  }

  if (!allowComments) return null

  return (
    <div className="mt-4">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Ask a question, or tell them something about the job"
        disabled={pending}
      />
      {error && (
        <Callout tone="danger" title="That did not send">
          {error}
        </Callout>
      )}
      <div className="mt-2 flex items-center justify-between gap-3">
        {/* Said plainly, because a customer cannot see who reads this and should
            not have to guess. */}
        <p className="text-xs text-muted">The business will see this on the job.</p>
        <Button size="sm" onClick={comment} disabled={pending || body.trim().length < 2}>
          {pending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
