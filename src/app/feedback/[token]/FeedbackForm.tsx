'use client'

import { useState, useTransition } from 'react'
import { Button, Icons, Textarea } from '@/components/ui'
import { submitFeedbackAction } from './actions'

/**
 * One star rating, one optional sentence.
 *
 * ── THE STARS ARE RADIO BUTTONS ────────────────────────────────────────────
 *
 * Not five divs with click handlers. A radio group is what this is — one of five,
 * exactly one chosen — and building it as one means it arrives keyboard-operable
 * and announced by a screen reader for free. The visible stars are labels; the
 * inputs are there, just not painted.
 *
 * The kit has no star-rating component and this is the only screen that wants
 * one, so it is built here rather than added to the kit. The inputs carry
 * data-kit-ok: they are deliberately invisible controls behind their labels,
 * which is not something the shared Radio can express.
 */
export default function FeedbackForm({
  token,
  jobLabel,
  jobTitle,
  existingRating,
  existingComment,
}: {
  token: string
  jobLabel: string
  jobTitle: string
  existingRating: number | null
  existingComment: string | null
}) {
  const [rating, setRating] = useState<number>(existingRating ?? 0)
  const [comment, setComment] = useState(existingComment ?? '')
  const [pending, start] = useTransition()
  const [done, setDone] = useState(existingRating !== null)
  const [error, setError] = useState<string | null>(null)
  // Only for the hover preview. Never what gets submitted.
  const [hovered, setHovered] = useState<number>(0)

  function submit() {
    if (rating < 1) return
    setError(null)
    start(async () => {
      const result = await submitFeedbackAction(token, rating, comment.trim() || null)
      if (result.ok) setDone(true)
      else setError(result.error)
    })
  }

  if (done) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-ink">Thank you</h1>
        <p className="mt-2 text-sm text-muted">
          Your answer has been passed on. {rating <= 3 ? 'Somebody will look at it.' : ''}
        </p>
        {/* Correcting an answer is allowed, and saying so matters: somebody who
            mis-tapped a star should not have to email about it. */}
        <Button variant="secondary" className="mt-4" onClick={() => setDone(false)}>
          Change my answer
        </Button>
      </div>
    )
  }

  const shown = hovered || rating

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink">How did we do?</h1>
      <p className="mt-1 text-sm text-muted">
        {jobLabel}
        {jobTitle ? ` — ${jobTitle}` : ''}
      </p>

      <fieldset className="mt-6">
        <legend className="text-sm text-ink">Your rating</legend>
        <div className="mt-2 flex items-center gap-1" onMouseLeave={() => setHovered(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="cursor-pointer p-1"
              onMouseEnter={() => setHovered(n)}
              title={`${n} out of 5`}
            >
              {/* An invisible radio behind a painted label — the kit's Radio
                  cannot express that, and this is the only screen that wants it. */}
              <input
                data-kit-ok
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                disabled={pending}
                className="sr-only"
              />
              <Icons.Star
                size={32}
                className={n <= shown ? 'text-warning' : 'text-faint'}
                // The painted star is decoration; the radio above carries the
                // meaning, so this must not be announced twice.
                aria-hidden
                fill={n <= shown ? 'currentColor' : 'none'}
              />
              <span className="sr-only">{n} out of 5</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5">
        <label htmlFor="feedback-comment" className="text-sm text-ink">
          Anything you would like to add?
        </label>
        <p className="mb-1.5 text-xs text-muted">Optional. Only the business reads this.</p>
        <Textarea
          id="feedback-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
          maxLength={1000}
          disabled={pending}
        />
      </div>

      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <Button className="mt-5 w-full" onClick={submit} disabled={pending || rating < 1}>
        {pending ? 'Sending…' : 'Send it'}
      </Button>
      {rating < 1 && <p className="mt-2 text-xs text-muted">Choose a rating to send.</p>}
    </div>
  )
}
