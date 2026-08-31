'use client'

import { useState, useTransition } from 'react'
import { Button, Callout, Field, Input } from '@/components/ui'
import { requestLinkAction } from './actions'

/**
 * Ask for a sign-in link.
 *
 * ── THE ANSWER IS THE SAME EITHER WAY ──────────────────────────────────────
 *
 * "If that address is on file, a link is on its way" — whether it was or not.
 * The server behaves identically; this screen must not undo that by saying
 * anything more specific, or the form becomes a way to ask a business who its
 * customers are.
 */
export default function SignInForm({
  token,
  /** What this shop offers, phrased for the blurb — see the page. */
  offers = 'your account',
}: {
  token: string
  offers?: string
}) {
  const [email, setEmail] = useState('')
  const [pending, start] = useTransition()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    start(async () => {
      const result = await requestLinkAction(token, email)
      if (result.ok) setSent(true)
      // Only the refusals that are about the FORM rather than about a person —
      // a malformed address, or the portal being switched off.
      else setError(result.error ?? 'That could not be sent.')
    })
  }

  if (sent) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-ink">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          If <strong className="text-ink">{email}</strong> is the address we have for you, a
          sign-in link is on its way. It works once and lasts half an hour.
        </p>
        <p className="mt-3 text-sm text-muted">
          Nothing arrived? The business may have a different address for you — give them a ring.
        </p>
        <Button variant="secondary" className="mt-4" onClick={() => setSent(false)}>
          Try another address
        </Button>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink">Your account</h1>
      <p className="mt-2 text-sm text-muted">
        See {offers}. Enter the email address the business has for you and we will send you a
        link — there is no password to remember.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Field label="Your email address">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            maxLength={190}
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && email.trim()) submit()
            }}
          />
        </Field>

        {error && (
          <Callout tone="danger" title="We could not do that">
            {error}
          </Callout>
        )}

        <Button onClick={submit} disabled={pending || !email.trim()}>
          {pending ? 'Sending…' : 'Send me a link'}
        </Button>
      </div>
    </div>
  )
}
