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
  online,
  pendingSales,
  failedSales,
  catalogAgeHours,
  itemCount,
  onShowOutbox,
  tableLabel,
  onChangeTable,
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
  /**
   * Whether the till can currently reach the server.
   *
   * Shown always, not only when it is false. A cashier who cannot tell the
   * difference between "offline and queueing safely" and "offline and losing sales"
   * will assume the worse one and stop trading, which is the failure this whole
   * feature exists to prevent.
   */
  online: boolean
  /**
   * Sales rung up and not yet delivered to the server.
   *
   * THE figure that must be visible before somebody goes home. Forty sales still in
   * a till at closing time is a discovery for that evening, not for month end — and
   * a cash-up computed without them reports a drawer over by their whole value.
   */
  pendingSales: number
  /** Queued sales a human has to deal with. Distinct from merely pending. */
  failedSales: number
  /** Hours since the catalog last refreshed, or null if it never has. */
  catalogAgeHours: number | null
  itemCount: number
  /** Opens the outbox — the answer to the question the queue chip poses. */
  onShowOutbox: () => void
  /**
   * Which table this basket belongs to, or null on a retail till.
   *
   * In the header because it is the one place on this screen never covered by a dialog,
   * and because a waiter adding to the wrong table's bill is a mistake nobody notices
   * until the party asks to pay.
   */
  tableLabel: string | null
  /** Back to the floor. Undefined in retail, where there is no floor to go back to. */
  onChangeTable?: () => void
  onExit: () => void
}) {
  /* Past a few hours the prices on this till and the prices on the shelf edge may
     genuinely differ, and nothing about the screen would otherwise say so. Four
     hours because that is about the length of a shift's half — long enough that a
     repricing run could have happened and been missed. */
  const catalogStale = catalogAgeHours !== null && catalogAgeHours >= 4
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
        {/* First in the row, because it answers "which bill am I on" — the question a
            waiter asks before any of the others. A BUTTON when there is a floor to go
            back to, so changing table is one tap from wherever they are. */}
        {tableLabel &&
          (onChangeTable ? (
            <button
              type="button"
              data-kit-ok
              onClick={onChangeTable}
              title="Back to the floor"
              className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-brand/40 bg-brand-soft px-3.5 text-sm font-semibold text-brand hover:bg-brand-soft/70"
            >
              <Icons.LayoutGrid size={16} />
              {tableLabel}
            </button>
          ) : (
            <Chip>
              <Icons.LayoutGrid size={16} className="text-muted" />
              {tableLabel}
            </Chip>
          ))}

        {/*
         * OFFLINE, and trading.
         *
         * Deliberately calm — brand, not danger. Being offline is a state this till
         * is designed for, and a red alarm would tell a cashier to stop serving
         * customers, which is precisely the wrong instruction and the exact thing the
         * offline work exists to avoid. It says what is true: still selling, and the
         * sales are being kept.
         */}
        {!online && (
          <span
            title="This till has no connection. Sales are being kept on the till and will send themselves when it comes back."
            className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-brand/40 bg-brand-soft px-3.5 text-sm font-medium text-brand"
          >
            <Icons.Offline size={16} />
            Offline
          </span>
        )}

        {/*
         * The queue.
         *
         * Shown whenever anything is waiting, online or off — a till that reconnected
         * but has not finished flushing is exactly when somebody is most likely to
         * cash up too early. Danger once something has failed, because that one needs
         * a person rather than patience.
         */}
        {(pendingSales > 0 || failedSales > 0) && (
          /* A BUTTON, not a chip. The count is the question ("can I cash up?") and the
             outbox is the answer, so the thing displaying the number is the thing that
             opens the list — a cashier should not have to find it elsewhere. */
          <button
            type="button"
            onClick={onShowOutbox}
            title={
              failedSales > 0
                ? `${failedSales} sale${failedSales === 1 ? '' : 's'} could not be sent and need attention. Do not cash up yet.`
                : `${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send. Do not cash up until these are through — the expected figure is wrong until then.`
            }
            className={
              failedSales > 0
                ? 'inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-danger/40 bg-danger-soft px-3.5 text-sm font-medium text-danger-ink hover:bg-danger-soft/70'
                : 'inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-warning/40 bg-warning-soft px-3.5 text-sm font-medium text-warning-ink hover:bg-warning-soft/70'
            }
          >
            <Icons.Syncing size={16} />
            {failedSales > 0 ? `${failedSales} stuck` : `${pendingSales} to send`}
          </button>
        )}

        {/* A catalog old enough that the shelf edge may disagree with it. */}
        {catalogStale && (
          <span
            title={`Prices were last refreshed about ${Math.floor(catalogAgeHours!)} hour${Math.floor(catalogAgeHours!) === 1 ? '' : 's'} ago. They may not match the shelf.`}
            className="inline-flex h-touch shrink-0 items-center gap-2 rounded-control border border-warning/40 bg-warning-soft px-3.5 text-sm font-medium text-warning-ink"
          >
            <Icons.Clock size={16} />
            Prices {Math.floor(catalogAgeHours!)}h old
          </span>
        )}

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
