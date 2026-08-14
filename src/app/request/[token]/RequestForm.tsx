'use client'

import { useState, useTransition } from 'react'
import { Button, Callout, Field, Input, Select, Textarea } from '@/components/ui'
import { submitRequestAction } from './actions'

/**
 * What somebody needs done, and how to reach them.
 *
 * ── SIX FIELDS, TWO OF THEM OPTIONAL ───────────────────────────────────────
 *
 * Name, phone and a one-line summary are required; email, address and detail are
 * not. Every extra required field on a public form is a person who gives up, and
 * a business that can phone somebody back has enough to start.
 *
 * ── THE HONEYPOT ───────────────────────────────────────────────────────────
 *
 * Hidden from people and from screen readers; bots fill it. The server answers a
 * filled one with a fabricated success, so a bot learns nothing from trying.
 * Copied field-for-field from the reservation form.
 */
export default function RequestForm({
  token,
  blurb,
  headlines,
}: {
  token: string
  blurb: string
  headlines: { id: number; name: string }[]
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [address, setAddress] = useState('')
  const [headlineId, setHeadlineId] = useState('')
  // Honeypot — hidden from people, irresistible to naive bots.
  const [website, setWebsite] = useState('')

  const [pending, start] = useTransition()
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    start(async () => {
      const result = await submitRequestAction(token, {
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        title,
        description,
        addressText: address,
        headlineId: headlineId ? Number(headlineId) : null,
        website,
      })
      if (result.ok) setDone(result.reference)
      else setError(result.error)
    })
  }

  if (done !== null) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-ink">Thank you — we have it</h1>
        <p className="mt-2 text-sm text-muted">
          Your reference is <strong className="text-ink">{done}</strong>. Somebody will look at
          it and come back to you.
        </p>
        {/*
         * Deliberately NOT a promise about when. This page cannot know the
         * business's hours or workload, and a made-up "within 24 hours" is a
         * commitment the app has no business making on their behalf.
         */}
      </div>
    )
  }

  const ready = name.trim().length >= 2 && phone.trim().length >= 7 && title.trim().length >= 3

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink">Ask us to do some work</h1>
      {blurb ? <p className="mt-2 text-sm text-muted">{blurb}</p> : null}

      <div className="mt-6 flex flex-col gap-4">
        <Field label="Your name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoComplete="name"
            disabled={pending}
          />
        </Field>

        <Field label="Phone number" hint="So we can call you back.">
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            autoComplete="tel"
            disabled={pending}
          />
        </Field>

        <Field label="Email address" hint="Optional.">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={190}
            autoComplete="email"
            disabled={pending}
          />
        </Field>

        {headlines.length > 0 && (
          <Field label="What kind of work is it?" hint="Optional — pick the closest.">
            <Select
              value={headlineId}
              onChange={(e) => setHeadlineId(e.target.value)}
              disabled={pending}
            >
              <option value="">Not sure</option>
              {headlines.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="What do you need done?" hint="One line is enough.">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={190}
            placeholder="Geyser leaking in the ceiling"
            disabled={pending}
          />
        </Field>

        <Field label="Anything else we should know?" hint="Optional.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={4000}
            disabled={pending}
          />
        </Field>

        <Field label="Where is the work?" hint="Optional — a street address helps.">
          <Textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            maxLength={400}
            autoComplete="street-address"
            disabled={pending}
          />
        </Field>

        {/* Honeypot. Hidden from people and from screen readers; bots fill it. */}
        <input
          data-kit-ok
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />

        {error ? (
          <Callout tone="danger" title="We could not send that">
            {error}
          </Callout>
        ) : null}

        <Button onClick={submit} disabled={pending || !ready}>
          {pending ? 'Sending…' : 'Send the request'}
        </Button>
        {!ready && (
          <p className="text-xs text-muted">
            Your name, a phone number and one line about the work are needed.
          </p>
        )}
      </div>
    </div>
  )
}
