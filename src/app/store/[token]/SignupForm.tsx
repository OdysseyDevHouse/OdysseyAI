'use client'

import { useState, useTransition } from 'react'
import { Button, Input } from '@/components/ui'
import { subscribeAction } from './actions'

/**
 * The email sign-up form on a shop page.
 *
 * ── THE TICK BOX IS NOT PRE-TICKED, AND IS NOT OPTIONAL ──────────────────
 *
 * Both deliberate, and both are the point of the section. Consent that was
 * already ticked when the page loaded is not consent — it is an assumption
 * with a checkbox drawn on it — and POPIA turns on being able to show that
 * somebody actively agreed. So the button stays disabled until they tick it,
 * and the exact wording they saw travels with the submission (see 071).
 *
 * ── SUCCESS SAYS THE SAME THING EITHER WAY ───────────────────────────────
 *
 * A first-time sign-up and a repeat both get the thank-you. Telling somebody
 * "you are already subscribed" turns the form into an oracle for who is on the
 * list, which anybody could query one address at a time.
 */
export default function SignupForm({
  token,
  buttonLabel,
  consentText,
  thanksText,
  sourcePage,
}: {
  token: string
  buttonLabel: string
  consentText: string
  thanksText: string
  /** Which page they signed up from, recorded on the row. */
  sourcePage: string
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, startAction] = useTransition()

  if (done) {
    return (
      <p className="text-sm font-medium text-ink" role="status">
        {thanksText || 'Thank you — you are on the list.'}
      </p>
    )
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    startAction(async () => {
      const result = await subscribeAction(token, {
        email,
        name,
        // The wording ON SCREEN, sent with the submission rather than looked
        // up server-side: what matters is what this person actually read, and
        // the section could have been edited between page load and submit.
        consentText,
        sourcePage,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setDone(true)
    })
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-lg flex-col gap-3">
      <div className="flex flex-col gap-2 @sm:flex-row">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name (optional)"
          aria-label="Your name"
          maxLength={120}
        />
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Your email address"
          maxLength={190}
        />
      </div>

      {/* A plain checkbox, not a Switch: this is a form field being submitted
          with the rest, and a switch reads as a setting that takes effect the
          moment it moves. `data-kit-ok` — the kit has no checkbox, and adding
          one for a single consent line beside its own wording would be a
          component with one caller. */}
      <label className="flex items-start gap-2 text-left text-sm text-ink-2">
        <input
          data-kit-ok
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>{consentText}</span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="self-start">
        <Button type="submit" variant="primary" disabled={busy || !agreed || !email.trim()}>
          {busy ? 'Signing you up…' : buttonLabel || 'Sign up'}
        </Button>
      </div>
    </form>
  )
}
