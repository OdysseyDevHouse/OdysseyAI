'use client'

import { useState, useTransition } from 'react'
import { Button, Field, Input, Textarea } from '@/components/ui'
import { submitReviewAction } from '../../actions'

/**
 * Writing a review.
 *
 * ── COLLAPSED BY DEFAULT ─────────────────────────────────────────────────
 *
 * Most people reading a product page are deciding whether to buy it, not
 * writing about one they already own. An open form pushes the thing they came
 * for off the screen.
 *
 * ── IT SAYS WHAT HAPPENS NEXT, TWICE ─────────────────────────────────────
 *
 * Before submitting and after. A review that vanishes on send looks broken,
 * and the shopper writes it again — which is how a moderation queue fills up
 * with duplicates of the same review.
 */

export default function ReviewForm({ token, productId }: { token: string; productId: number }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, start] = useTransition()
  const [error, setError] = useState('')

  const [rating, setRating] = useState(5)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [website, setWebsite] = useState('')

  if (done) {
    return (
      <div className="mt-4 rounded-card border border-border bg-surface p-4">
        <p className="text-sm font-medium text-ink">Thanks — your review has been sent.</p>
        <p className="mt-1 text-sm text-muted">
          The shop checks reviews before they appear, so it may take a little while to show up.
        </p>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="mt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Write a review
        </Button>
      </div>
    )
  }

  function send() {
    setError('')
    if (!body.trim()) {
      setError('Please write a few words about the product.')
      return
    }
    start(async () => {
      const result = await submitReviewAction(token, {
        productId,
        rating,
        title,
        body,
        authorName,
        orderNumber,
        website,
      })
      if (result.ok) setDone(true)
      else setError(result.error)
    })
  }

  return (
    <div className="mt-4 rounded-card border border-border bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Write a review</p>

      <div className="mt-3">
        <span className="mb-1 block text-sm font-medium text-ink">Your rating</span>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
              aria-pressed={n <= rating}
              onClick={() => setRating(n)}
              /* Not a kit Button: this is a bare 22px star glyph acting as a
                 radio, and every Button variant would draw a box around it. */
              data-kit-ok
              className="text-[22px] leading-none text-warning transition"
              style={{ opacity: n <= rating ? 1 : 0.3 }}
            >
              ★
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Title (optional)">
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Your name">
          <Input
            value={authorName}
            maxLength={80}
            placeholder="Shown with your review"
            onChange={(e) => setAuthorName(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Your review">
            <Textarea
              rows={4}
              maxLength={1000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Order number (optional)" hint="Helps the shop see you bought it">
          <Input
            value={orderNumber}
            maxLength={30}
            placeholder="WEB-00123"
            onChange={(e) => setOrderNumber(e.target.value)}
          />
        </Field>
      </div>

      {/* A field only a script fills in — a form-filling bot sets every input
          it finds, including this one, and anything that arrives with it
          filled is discarded server-side.

          type="hidden" rather than a visually-hidden text box: it keeps the
          field out of the accessibility tree entirely, so a screen-reader user
          is never asked to fill in something that would silently bin their
          review. Not a kit Input for the same reason — a label and focus ring
          would defeat the point. */}
      <input
        data-kit-ok
        type="hidden"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
      />

      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <p className="mt-3 text-xs text-muted">The shop checks reviews before they appear.</p>

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={send} disabled={busy}>
          {busy ? 'Sending…' : 'Send review'}
        </Button>
        {/* Collapses without clearing what was typed — a mis-tap on Cancel
            must not throw away a paragraph someone just wrote. */}
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
