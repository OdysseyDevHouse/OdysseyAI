'use client'

import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { Button, Callout, Field, Icons, Input, Select, Textarea } from '@/components/ui'
import type { DaySlots } from '@/lib/site/reservations'
import { bookTableAction, type BookResult } from './actions'

/**
 * The public booking form.
 *
 * ── TIME IS PICKED FROM SERVER-GENERATED SLOTS, NEVER TYPED ───────────────
 *
 * A free-text time box invites a guest to ask for 03:00 on a Monday and then be
 * told no. The whole point of computing slots on the server is that everything
 * on offer is genuinely bookable.
 *
 * ── ONE SCREEN, NO STEPS ──────────────────────────────────────────────────
 *
 * A booking form that paginates loses the person standing outside the
 * restaurant on their phone. Five fields, one button.
 */
export default function ReserveForm({
  token,
  storeName,
  blurb,
  autoConfirm,
  maxPartySize,
  days,
}: {
  token: string
  storeName: string
  blurb: string
  autoConfirm: boolean
  maxPartySize: number
  days: DaySlots[]
}) {
  const [pending, startSubmit] = useTransition()
  const [done, setDone] = useState<Extract<BookResult, { ok: true }> | null>(null)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [partySize, setPartySize] = useState('2')
  const [date, setDate] = useState(days[0]?.date ?? '')
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  // Honeypot — hidden from people, irresistible to naive bots.
  const [website, setWebsite] = useState('')

  const times = useMemo(() => days.find((d) => d.date === date)?.times ?? [], [days, date])

  /**
   * Changing the day must clear a time that day does not offer, or the guest
   * submits Tuesday's 21:00 against a Wednesday that closes at 20:00 — and gets
   * a refusal for something the form appeared to allow.
   */
  function pickDate(next: string) {
    setDate(next)
    const available = days.find((d) => d.date === next)?.times ?? []
    setTime((t) => (available.includes(t) ? t : ''))
  }

  const canSubmit =
    name.trim().length >= 2 &&
    phone.replace(/\D/g, '').length >= 7 &&
    Number(partySize) >= 1 &&
    !!date &&
    !!time &&
    !pending

  function submit() {
    setError('')
    startSubmit(async () => {
      const result = await bookTableAction(token, {
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        partySize: Number(partySize) || 0,
        date,
        time,
        customerNote: note,
        website,
      })
      if (result.ok) setDone(result)
      else setError(result.error)
    })
  }

  if (done) {
    return (
      <Shell name={storeName}>
        <div role="status">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
              <Icons.Check size={20} />
            </span>
            <h1 className="text-xl font-semibold text-ink">
              {done.confirmed ? 'Your table is booked' : 'Request received'}
            </h1>
          </div>

          <p className="mt-4 text-sm text-ink-2">
            {done.confirmed ? (
              <>
                We have booked your table for <strong className="text-ink">{done.when}</strong>.
                We look forward to seeing you.
              </>
            ) : (
              <>
                Thanks — we have sent your request for{' '}
                <strong className="text-ink">{done.when}</strong> to {storeName}. They will
                confirm it shortly.
              </>
            )}
          </p>

          <div className="mt-4 rounded-card border border-border bg-surface-2 px-4 py-3">
            <p className="text-xs text-muted">Your reference</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">{done.reference}</p>
          </div>

          {email.trim() ? (
            <p className="mt-4 text-sm text-muted">
              We have sent the details to {email.trim()}.
            </p>
          ) : null}
        </div>
      </Shell>
    )
  }

  return (
    <Shell name={storeName}>
      <h1 className="text-2xl font-semibold text-ink">Book a table</h1>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted">
        {blurb || 'Tell us when you would like to come and we will set a table for you.'}
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Field label="Your name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            autoComplete="name"
            maxLength={120}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact number">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="082 123 4567"
              inputMode="tel"
              autoComplete="tel"
              maxLength={50}
            />
          </Field>
          <Field label="How many people">
            <Select value={partySize} onChange={(e) => setPartySize(e.target.value)}>
              {Array.from({ length: maxPartySize }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {i === 0 ? '1 person' : `${i + 1} people`}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Day">
            <Select value={date} onChange={(e) => pickDate(e.target.value)}>
              {days.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time">
            <Select value={time} onChange={(e) => setTime(e.target.value)}>
              <option value="">Choose a time</option>
              {times.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Email" hint="Optional — we will send your confirmation here.">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            type="email"
            autoComplete="email"
            maxLength={190}
          />
        </Field>

        <Field
          label="Anything we should know"
          hint="Optional — a birthday, a high chair, a wheelchair, an allergy."
        >
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
          />
        </Field>

        {/* Honeypot. Hidden from people and from screen readers; bots fill it. */}
        <input
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
          <Callout tone="danger" title="We could not take that booking">
            {error}
          </Callout>
        ) : null}

        <Button onClick={submit} disabled={!canSubmit}>
          {pending ? 'Sending…' : autoConfirm ? 'Book my table' : 'Request a table'}
        </Button>

        {!autoConfirm ? (
          <p className="text-center text-xs text-muted">
            Your booking is a request until {storeName} confirms it.
          </p>
        ) : null}
      </div>
    </Shell>
  )
}

/**
 * The page's own chrome.
 *
 * This route sits outside the (app) group, so it has no sidebar and no
 * PageHeader — a guest is not a user of the back office. It still uses the kit
 * and the tokens, so the shop's booking page looks like the shop's software.
 */
function Shell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-lg rounded-card border border-border bg-surface p-6 shadow-card">
        <p className="mb-1 text-sm text-muted">{name}</p>
        {children}
      </div>
    </main>
  )
}
