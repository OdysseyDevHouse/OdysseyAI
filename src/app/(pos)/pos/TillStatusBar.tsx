'use client'

import { useEffect, useState } from 'react'
import { Button, Icons } from '@/components/ui'

/**
 * The strip across the top of the till.
 *
 * Everything here answers a question a cashier asks without wanting to hunt: who
 * am I signed in as, which till is this, what time is it, and how do I get out.
 * Nothing here is part of the sale, which is why none of it sits near the basket.
 *
 * Every chip is the SAME HEIGHT on purpose. They hold a mix of glyphs, digits and
 * text, and a row where each box is sized to its own content reads as a mistake
 * even when nothing is wrong.
 */
export function TillStatusBar({
  siteName,
  operatorName,
  terminalLabel,
  unclaimed,
  offlineReason,
  itemCount,
  onExit,
}: {
  siteName: string
  operatorName: string
  /** The till's code and number, or null when this machine has claimed none. */
  terminalLabel: string | null
  /**
   * This machine has not claimed a terminal.
   *
   * Worth its own warning rather than an absent chip: sales still post, but they
   * number from the SHARED invoice sequence instead of this till's own run. A shop
   * that traded a day before noticing has a day of invoices in the wrong place.
   */
  unclaimed: boolean
  /**
   * Why this machine cannot trade offline, or null when it can.
   *
   * Shown because the alternative is a shop that believes it is covered and finds
   * out otherwise the first time the line drops — with a queue at the counter. The
   * reason is specific ("Offline needs HTTPS or localhost") so whoever can fix it
   * knows what to fix.
   */
  offlineReason: string | null
  itemCount: number
  onExit: () => void
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-ink">{siteName}</h1>
        <p className="truncate text-xs text-muted">
          {itemCount === 0
            ? 'No items'
            : `${itemCount} item${itemCount === 1 ? '' : 's'} on this sale`}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Warning, not danger: the till works — it just will not survive the line
            dropping. `title` carries the specific reason without spending header
            width on a sentence. */}
        {offlineReason && (
          <span
            title={offlineReason}
            className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-warning/40 bg-warning-soft px-3.5 text-sm font-medium text-warning-ink"
          >
            <Icons.Offline size={16} />
            Online only
          </span>
        )}

        {terminalLabel ? (
          <Chip>
            <Icons.Terminal size={16} className="text-muted" />
            {terminalLabel}
          </Chip>
        ) : (
          unclaimed && (
            <span className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-warning/40 bg-warning-soft px-3.5 text-sm font-medium text-warning-ink">
              <Icons.StatusWarning size={16} />
              No till claimed
            </span>
          )
        )}

        <Chip>
          <Icons.Users size={16} className="text-muted" />
          {operatorName}
        </Chip>

        <Clock />

        <Button variant="ghost" size="touch" onClick={onExit}>
          <Icons.LogOut size={18} />
          Exit
        </Button>
      </div>
    </header>
  )
}

/* One recipe, so a row of these cannot drift into different heights. h-touch
   rather than a content height: these sit beside a 56px button. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-border bg-surface-2 px-3.5 text-sm font-medium text-ink-2">
      {children}
    </span>
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
function Clock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    // Ticking every second would re-render the whole bar sixty times a minute for
    // a display that shows minutes. Fifteen seconds keeps it honest enough.
    const timer = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <Chip>
      <Icons.Clock size={16} className="text-muted" />
      <span className="numeric">
        {now
          ? now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : '--:--'}
      </span>
    </Chip>
  )
}
