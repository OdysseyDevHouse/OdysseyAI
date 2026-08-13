'use client'

import { useEffect, useState } from 'react'
import { Icons } from '@/components/ui'

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
  screenTitle,
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
  /**
   * What the screen under this bar IS — "Tables" on the gate, "Current Sale" on
   * the till. One hardcoded title meant the gate opened under a heading about a
   * sale that did not exist yet.
   */
  screenTitle: string
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
  /** How many lines the basket holds — or null where there IS no basket (the
   *  gate), which hides the pill rather than counting a sale that does not exist. */
  itemCount: number | null
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
  /* NO BORDER, NO SURFACE. The bar sits on the same canvas as the three cards
     below it and is separated from them by the shell's own padding — the chips
     are what carry the edges here, each floating on its own. A full-width bar
     with a rule under it would put a fourth horizontal band on a screen whose
     whole layout is three floating cards. */
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2.5 px-4 pb-3 pt-4">
      {/* WHAT THIS SCREEN IS, then what is on it. The screen's own name rather
          than the shop's: the cashier knows which shop they are standing in, and
          the one thing the top-left of a till should answer is "what am I looking
          at". The count rides beside it as a pill because it changes constantly
          and a number that moves inside a heading makes the heading twitch. */}
      <h1 className="text-[20px] font-extrabold leading-none text-ink">{screenTitle}</h1>
      {itemCount !== null && (
        <span className="rounded-control bg-surface-2 px-2.5 py-1.5 text-[12.5px] font-semibold leading-none text-muted">
          {itemCount === 0 ? '0 items' : `${itemCount} item${itemCount === 1 ? '' : 's'}`}
        </span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2.5">
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
              className={`${CHIP_BASE} border-brand/40 bg-brand-soft font-semibold text-brand hover:bg-brand-soft/70`}
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

        {/* NO NAME, BUT STILL A WAY BACK.
            A quick sale has no table and no tab, so there is nothing to label —
            but the waiter still needs the floor to be one tap away, and making
            them finish or close the sale to reach it is a longer trip than the
            header should ever impose. Neutral rather than brand-tinted: this is
            navigation, not a statement about which bill is on screen. */}
        {!tableLabel && onChangeTable && (
          <button
            type="button"
            data-kit-ok
            onClick={onChangeTable}
            title="Back to the floor"
            className={`${CHIP_BASE} border-border bg-surface text-ink-2 hover:border-brand/40 hover:bg-brand-soft hover:text-brand`}
          >
            <Icons.LayoutGrid size={16} />
            Tables
          </button>
        )}

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
            className={`${CHIP_BASE} border-brand/40 bg-brand-soft text-brand`}
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
        {/* ALWAYS SHOWN, including when everything is through.
            "Nothing is wrong" is itself the answer to the question a cashier asks
            before cashing up, and a chip that only appears when there IS a problem
            cannot be checked — its absence could equally mean the till forgot to
            render it. So the good state is stated, in green, and the bad states
            take the same slot rather than appearing beside it. */}
        <button
          type="button"
          onClick={onShowOutbox}
          title={
            failedSales > 0
              ? `${failedSales} sale${failedSales === 1 ? '' : 's'} could not be sent and need attention. Do not cash up yet.`
              : pendingSales > 0
                ? `${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send. Do not cash up until these are through — the expected figure is wrong until then.`
                : 'Every sale on this till has reached the server.'
          }
          className={`${CHIP_BASE} ${
            failedSales > 0
              ? 'border-danger/40 bg-danger-soft text-danger-ink hover:bg-danger-soft/70'
              : pendingSales > 0
                ? 'border-warning/40 bg-warning-soft text-warning-ink hover:bg-warning-soft/70'
                : 'border-success/40 bg-success-soft text-success-ink hover:bg-success-soft/70'
          }`}
        >
          {failedSales > 0 ? (
            <>
              <Icons.Syncing size={16} />
              {failedSales} stuck
            </>
          ) : pendingSales > 0 ? (
            <>
              <Icons.Syncing size={16} />
              {pendingSales} to send
            </>
          ) : (
            <>
              <Icons.Check size={16} />
              Sales synced
            </>
          )}
        </button>

        {/* A catalog old enough that the shelf edge may disagree with it. */}
        {catalogStale && (
          <span
            title={`Prices were last refreshed about ${Math.floor(catalogAgeHours!)} hour${Math.floor(catalogAgeHours!) === 1 ? '' : 's'} ago. They may not match the shelf.`}
            className={`${CHIP_BASE} border-warning/40 bg-warning-soft text-warning-ink`}
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
            className={`${CHIP_BASE} border-warning/40 bg-warning-soft text-warning-ink`}
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
            <span className={`${CHIP_BASE} border-warning/40 bg-warning-soft text-warning-ink`}>
              <Icons.StatusWarning size={16} />
              No till claimed
            </span>
          )
        )}

        {/* Initials in a tinted square, then the name — the same block the gate
            shows, so "who is signed in" looks identical wherever it is read. */}
        <Chip>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-brand-soft text-[11px] font-bold text-brand">
            {initials(operatorName)}
          </span>
          <b className="font-semibold text-ink">{operatorName}</b>
        </Chip>

        <Clock />

        {/* LOGOUT, not "exit to the back office".
            The gate is where a waiter finishes their shift, so this hands the
            screen back to the PIN pad for the next one rather than dropping a
            member of floor staff into the back office. Whoever genuinely wants
            the back office signs in there from the login screen. */}
        <button type="button" data-kit-ok onClick={onExit} className={LOGOUT_CHIP}>
          <Icons.LogOut size={16} />
          Logout
        </button>
      </div>
    </header>
  )
}

/**
 * One recipe, so a row of these cannot drift into different heights.
 *
 * `shadow-card` on every one: with no bar behind them, the chips ARE the header,
 * and each has to lift off the canvas on its own the way the three panes below do
 * — otherwise they read as flat labels printed on the background rather than as
 * the controls several of them actually are.
 *
 * Exported as a string rather than only as a component because half of these are
 * buttons with their own tint, and a component that took a colour prop would be a
 * second place for the height and radius to drift.
 */
const CHIP_BASE =
  'inline-flex h-touch shrink-0 items-center gap-2 rounded-control border px-3.5 text-sm font-medium shadow-card'

function Chip({ children }: { children: React.ReactNode }) {
  return <span className={`${CHIP_BASE} border-border bg-surface text-ink-2`}>{children}</span>
}

/* data-kit-ok: the way OFF the till has to sit in the chip row at chip height,
   and a kit Button carries its own height and padding scale that would make it
   the one control in the row standing a few pixels proud of the rest. */
const LOGOUT_CHIP = `${CHIP_BASE} border-border bg-surface text-ink-2 hover:border-danger/40 hover:bg-danger-soft hover:text-danger-ink`

/** "Tiaan Bryson Smith" → "TS". First and last initial, never the middle. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
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
      {/* The DATE as well as the time. A till runs past midnight and a cashier
          reading "00:14" has no way to tell which day's takings they are about to
          cash up — which is the one question the clock on a till is for. */}
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
    </Chip>
  )
}
