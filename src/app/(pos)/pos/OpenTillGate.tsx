'use client'

import { useState, useTransition } from 'react'
import { Button, Callout, Icons, NumPad, NumPadDisplay, numPadValue, useToast } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { tillOpenShiftAction } from './shiftActions'

/**
 * The till is not open for business yet.
 *
 * ── WHY A GATE AND NOT A MODAL ────────────────────────────────────────────
 *
 * A shift is not a setting somebody adjusts while trading — it is the thing
 * that makes trading legitimate. Every sale rung up before one is open banks
 * into no reconciliation: it is a real invoice, in a real drawer, that no
 * cash-up will ever account for. A dismissible dialog over a working till
 * invites exactly that, because the fastest way past a dialog is Escape and
 * the sale underneath is right there.
 *
 * So this stands IN FRONT of the sale, the way TableGate does — you open the
 * till or you do not use it. The cost of being firm here is one deliberate tap
 * at the start of a day; the cost of being lenient is a drawer nobody can
 * reconcile at the end of one.
 *
 * ── THE TWO MODES SAY DIFFERENT THINGS ────────────────────────────────────
 *
 * 'user' — the shift belongs to the PERSON. Everyone signing in counts their
 *   own float, and the gate says so, because a cashier who thinks they are
 *   opening the shop will hand the float figure to whoever asks for it first.
 *
 * 'terminal' — the shift belongs to the TILL. Whoever opens it sets the float
 *   for everybody who trades on this machine afterwards, and that is worth
 *   stating plainly: the person typing is committing a number on behalf of
 *   colleagues who will never see this screen.
 *
 * In terminal mode a second cashier signing in mid-day never reaches here at
 * all — the till is already open, so they go straight to the sale. This screen
 * is only ever the first person of the day.
 */
export default function OpenTillGate({
  mode,
  operatorName,
  terminalId,
  terminalLabel,
  canCashup,
  online,
  onOpened,
  onExit,
}: {
  mode: 'terminal' | 'user'
  operatorName: string
  /**
   * The till this machine has claimed. REQUIRED in terminal mode — `openShift`
   * refuses without it, which is the right answer: a till-owned shift with no
   * till is a drawer nobody can name at cash-up.
   */
  terminalId: number | null
  /** The till's code, or null when this machine has claimed none. */
  terminalLabel: string | null
  /** Whether this operator holds `sales.cashup`. Without it they can only wait. */
  canCashup: boolean
  /** A shift lives on the server; offline the gate explains rather than pretends. */
  online: boolean
  /** Fires with the new shift's id so the shell can stash it and open the till. */
  onOpened: (shiftId: number) => void
  /** Back to the PIN pad — the way out for whoever cannot open it themselves. */
  onExit: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [float, setFloat] = useState('')
  const [error, setError] = useState<string | null>(null)

  function open() {
    setError(null)
    startTransition(async () => {
      const result = await tillOpenShiftAction(terminalId, numPadValue(float))
      if (!result.ok) {
        // Under the pad, not only in a toast: a toast leaves the screen while
        // the figure that caused it is still on it.
        setError(result.error)
        return
      }
      toast.success('The till is open. Have a good shift.')
      onOpened(result.shiftId)
    })
  }

  const amount = numPadValue(float)

  return (
    // SCROLLS, and that is not decoration. The card runs to about 830px with the
    // pad on it, and a 1366×768 till — the commonest machine this ships to — has
    // barely 700px under the status bar. Without `overflow-y-auto` here the flex
    // column crushes the card instead of letting it overflow, and the one button
    // on the screen ends up below the fold on the exact hardware it is for.
    /* `px-4 pb-4`, no top: TillStatusBar carries its own py-4. This screen
       CENTRES its card, so a p-4 here did not merely stack — the leftover
       space was dealt out above the card too, and the gap under the chips
       grew with the window height. */
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 pb-4">
      {/* ONE CARD, CENTRED. Nothing else on the canvas — this screen has exactly
          one job, and a till chrome'd like the sale screen invites someone to go
          looking for the sale screen's controls.

          `shrink-0` so the card keeps its natural height and the pane above
          scrolls to it, rather than the card compressing to fit and squashing
          the pad's keys into unhittable slivers. */}
      <div className="w-full max-w-[520px] shrink-0 rounded-card border border-border bg-surface shadow-card">
        {/* The banner carries the whole message at a glance, for the person
            standing three feet back wondering why the till looks different. */}
        <div className="flex flex-col items-center gap-3 border-b border-border px-8 pb-6 pt-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-card bg-brand-soft text-brand">
            <Icons.Store size={28} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-ink">This till is closed</h1>
            <p className="mt-1 text-sm text-muted">
              {mode === 'user'
                ? `Good day, ${operatorName}. Count your float in to start your shift.`
                : `Good day, ${operatorName}. Count the drawer in to open ${
                    terminalLabel ? `${terminalLabel} ` : 'this till '
                  }for the day.`}
            </p>
          </div>
        </div>

        <div className="px-8 py-6">
          {!online ? (
            /* A shift is a server record. Saying so beats a float typed into a
               screen that cannot store it. */
            <Callout tone="warning" title="Opening the till needs the connection">
              This till cannot reach the server, and a shift is opened there. Try again once
              the line is back — nothing is lost by waiting.
            </Callout>
          ) : !canCashup ? (
            /* The one person who cannot proceed. Told what to do, not just refused. */
            <Callout tone="warning" title="You cannot open the till yourself">
              Opening a till needs the cash-up right. Ask a manager to open it under their
              own PIN — once it is open you can sign in and trade on it.
            </Callout>
          ) : (
            <>
              {/* WHOSE FLOAT THIS IS. The single line that makes the two modes
                  behave differently in a cashier's head rather than only in the
                  database. */}
              <p className="mb-4 text-center text-sm text-muted">
                {mode === 'user'
                  ? 'This shift is yours, not the till’s — your float travels with you across whatever tills you work.'
                  : 'This float belongs to the till. Everyone who trades on it today shares this drawer and this figure.'}
              </p>

              <div className="mx-auto w-full max-w-[300px]">
                <NumPadDisplay
                  label="Opening float"
                  value={float}
                  tone={error ? 'danger' : 'default'}
                />
                <NumPad value={float} onChange={setFloat} />
              </div>

              {/* COUNT IT, DO NOT ASSUME IT. Said here rather than in a tooltip
                  because a float that is wrong at the start makes every variance
                  for the rest of the day wrong in the same direction, and by
                  cash-up nobody can tell which end it came from. */}
              <p className="mt-4 text-center text-xs text-muted">
                Count the notes and coins that are physically in the drawer.
              </p>

              {error && (
                <div className="mt-4">
                  <Callout tone="danger" title="Could not open the till">
                    {error}
                  </Callout>
                </div>
              )}

              <div className="mt-6 flex flex-col gap-2">
                <Button
                  variant="success"
                  size="touch"
                  disabled={pending}
                  onClick={open}
                  className="w-full"
                >
                  {pending
                    ? 'Opening…'
                    : `Open the till with ${formatMoney(amount)}`}
                </Button>
                {/* ZERO IS A REAL ANSWER, not a mistake to be blocked. A shop
                    that keeps no float trades from an empty drawer, and refusing
                    that would leave them unable to open at all. The button states
                    the figure instead, so opening on nothing is a thing somebody
                    read before they tapped. */}
                {amount === 0 && (
                  <p className="text-center text-xs text-muted">
                    No float? That is fine — the drawer simply starts empty.
                  </p>
                )}
              </div>
            </>
          )}

          {/* The way back to the PIN pad, quiet and last. The manager path when
              the person standing here cannot open it, and the way out when
              somebody signed in at the wrong machine. */}
          <div className="mt-6 flex justify-center border-t border-border pt-5">
            <Button variant="ghost" size="sm" disabled={pending} onClick={onExit}>
              <Icons.LogOut size={15} />
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
