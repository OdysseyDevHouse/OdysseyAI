'use client'

import { useEffect, useState } from 'react'
import { Clock } from './icons'

/**
 * The chips that make up a counter's status strip.
 *
 * ── WHY THESE LIVE IN THE KIT ─────────────────────────────────────────────
 *
 * Two windows now show the same strip — the till and the invoicing counter —
 * and they must not drift. The row states the same four facts in both (who is
 * signed in, which machine, what time, is the work through), so a second copy
 * of the recipe would be a second place for the height, the radius and the
 * shadow to diverge, on rows a user sees side by side on the same shop floor.
 *
 * 46px, NOT `h-touch` (56px). These are status first and controls second — the
 * row is read far more often than it is tapped — so a header should not spend a
 * full till-key's height on chrome above the work. It stays above the 44px touch
 * minimum, which is what keeps the tappable ones honest at this size.
 *
 * `shadow-card` on every one: where the chips ARE the header, each has to lift
 * off the canvas on its own or they read as flat labels printed on the
 * background rather than as the controls several of them are.
 */
export const CHIP_BASE =
  'inline-flex h-[46px] shrink-0 items-center gap-2 rounded-control border px-3.5 text-sm font-medium shadow-card'

/** The neutral chip — a fact, not a control. */
export function StatusChip({ children }: { children: React.ReactNode }) {
  return <span className={`${CHIP_BASE} border-border bg-surface text-ink-2`}>{children}</span>
}

/**
 * The way out, at chip height.
 *
 * `data-kit-ok` at the call site: this has to sit in the chip row at chip
 * height, and a kit Button carries its own height and padding scale that would
 * leave the one control in the row standing proud of the rest.
 */
export const LOGOUT_CHIP = `${CHIP_BASE} border-border bg-surface text-ink-2 hover:border-danger/40 hover:bg-danger-soft hover:text-danger-ink`

/** "Tiaan Bryson Smith" → "TS". First and last initial, never the middle. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

/** Initials in a tinted square, then the name. */
export function OperatorChip({ name }: { name: string }) {
  return (
    <StatusChip>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-brand-soft text-[11px] font-bold text-brand">
        {initials(name)}
      </span>
      <b className="font-semibold text-ink">{name}</b>
    </StatusChip>
  )
}

/**
 * The wall clock.
 *
 * Rendered empty on the server and filled after mount. A time formatted on the
 * server is the SERVER's time in the server's locale, which on a hosted app is
 * neither the shop's hour nor the shop's format — and rendering one only to
 * replace it a moment later is a hydration mismatch besides.
 */
export function ClockChip() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    // Ticking every second would re-render the whole bar sixty times a minute
    // for a display that shows minutes. Fifteen seconds keeps it honest enough.
    const timer = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <StatusChip>
      <Clock size={16} className="text-muted" />
      {/* The DATE as well as the time. A counter runs past midnight and somebody
          reading "00:14" has no way to tell which day's takings they are about
          to cash up — which is the one question a clock here is for. */}
      <span className="numeric">
        {now ? (
          <>
            {now.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
            {' · '}
            {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </>
        ) : (
          '--:--'
        )}
      </span>
    </StatusChip>
  )
}
