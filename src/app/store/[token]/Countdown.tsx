'use client'

import { useEffect, useState } from 'react'
import { wallClockNow } from '@/lib/storefrontModel'

/**
 * A ticking clock — "sale ends in 4:12:07".
 *
 * ── WHY THE FIRST PAINT SHOWS NOTHING ────────────────────────────────────
 *
 * The server renders this at one instant and the browser hydrates at another,
 * so a countdown that computed a value during render would produce two
 * different numbers and React would report a hydration mismatch — on every
 * load, on the shop's busiest page.
 *
 * So the digits start null and are filled by an effect, which only ever runs
 * in the browser. The frame, the heading and the words are all rendered on the
 * server as usual; only the four numbers wait a tick. That is invisible in
 * practice and it is the one arrangement that cannot mismatch.
 *
 * ── WALL CLOCK, NOT UTC ──────────────────────────────────────────────────
 *
 * The deadline is 'YYYY-MM-DDTHH:mm' in the SHOP's local time — the same text
 * the specials engine compares, for the same reason (see 057). A shopper in
 * another timezone sees the time remaining until the shop's 5pm, which is what
 * "the sale ends at five" means.
 */

/** Whole seconds between now and the deadline, or 0 once it has passed. */
function secondsLeft(endsAt: string): number {
  // Both sides parsed the same way, so the offset each carries cancels and
  // what is left is the true difference. Parsing as UTC on both sides is
  // deliberate: it is arithmetic on two labels, not a moment in time.
  const end = new Date(`${endsAt}:00Z`).getTime()
  const now = new Date(`${wallClockNow()}:00Z`).getTime()
  if (!Number.isFinite(end) || !Number.isFinite(now)) return 0
  // `wallClockNow` is minute-resolution, so seconds are added back from the
  // real clock — otherwise the display would jump a whole minute at a time.
  const secondsIntoMinute = new Date().getSeconds()
  return Math.max(0, Math.floor((end - now) / 1000) - secondsIntoMinute)
}

type Parts = { days: number; hours: number; minutes: number; seconds: number }

function split(total: number): Parts {
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}

export default function Countdown({
  endsAt,
  heading,
  bodyText,
  finishedText,
}: {
  endsAt: string
  heading: string
  bodyText: string
  /** What to say once it has passed. Empty renders nothing at all. */
  finishedText: string
}) {
  const [left, setLeft] = useState<number | null>(null)

  useEffect(() => {
    setLeft(secondsLeft(endsAt))
    const timer = setInterval(() => setLeft(secondsLeft(endsAt)), 1000)
    return () => clearInterval(timer)
  }, [endsAt])

  // Finished, and the owner wrote nothing for that case: draw nothing rather
  // than a frame around 00:00:00. `sectionIsEmpty` agrees, so the shop skips
  // the section entirely — this is the belt to that braces.
  if (left === 0 && !finishedText.trim()) return null

  const parts = left === null ? null : split(left)
  const done = left === 0

  return (
    <div
      className="rounded-card px-6 py-8 text-center"
      /* A tint of the shop's own colour, mixed rather than a token — the value
         is the store's data, hex-validated before it is ever stored. Same
         treatment the hero uses, so a countdown reads as part of the shop. */
      style={{ background: 'color-mix(in srgb, var(--color-brand) 10%, transparent)' }}
    >
      {heading && <p className="text-lg font-semibold text-ink @sm:text-xl">{heading}</p>}
      {bodyText && !done && <p className="mt-1 text-sm text-ink-2">{bodyText}</p>}

      {done ? (
        <p className="mt-2 text-base font-medium text-ink">{finishedText}</p>
      ) : (
        <div className="mt-4 flex items-start justify-center gap-3 @sm:gap-5">
          {/*
            aria-hidden on the digits, with a sentence for a screen reader
            below. A live region ticking every second would interrupt a reader
            constantly, and "4 days, 12 hours" said once is the useful part.
          */}
          <Unit value={parts?.days} label="days" />
          <Unit value={parts?.hours} label="hours" />
          <Unit value={parts?.minutes} label="mins" />
          <Unit value={parts?.seconds} label="secs" />
        </div>
      )}

      {!done && parts && (
        <p className="sr-only">
          {parts.days} days, {parts.hours} hours and {parts.minutes} minutes remaining.
        </p>
      )}
    </div>
  )
}

function Unit({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div aria-hidden className="min-w-14">
      {/*
        tabular-nums so the digits do not jostle as they change — without it
        every second visibly re-lays-out the whole row.

        A non-breaking-space placeholder before the first tick, rather than a
        zero: showing "00" for an instant and then the real number reads as a
        glitch, while an empty slot of the right height reads as loading.
      */}
      <span className="block text-2xl font-semibold tabular-nums text-ink @sm:text-3xl">
        {value === undefined ? ' ' : String(value).padStart(2, '0')}
      </span>
      <span className="mt-0.5 block text-xs uppercase tracking-wide text-muted">{label}</span>
    </div>
  )
}
