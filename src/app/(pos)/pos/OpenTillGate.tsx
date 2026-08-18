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
  unclaimed,
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
   *
   * ── WHY NULL GETS ITS OWN SCREEN RATHER THAN AN ERROR ─────────────────
   *
   * Because the error it produces is unactionable. `openShift` answers "Choose
   * a till." — accurate, and useless at a counter: there is nothing on this
   * screen to choose, and the place a till IS chosen is Setup › Tills in the
   * BACK OFFICE, which is not where the person reading it is standing.
   *
   * What that left was a screen inviting somebody to count a drawer and type a
   * figure, which then refused the figure for a reason they could not act on
   * and could not see coming. The float is asked for FIRST and the blocking
   * fact is revealed LAST — exactly backwards.
   *
   * So an unclaimed machine is told before the pad rather than after the tap.
   */
  terminalId: number | null
  /** The till's code, or null when this machine has claimed none. */
  terminalLabel: string | null
  /**
   * Whether this machine has been checked and matches no till.
   *
   * DISTINCT from `terminalId === null`, which is also true for the tick before
   * the browser has read its own device id — showing the warning on that would
   * flash it on every load, at a counter, on the one screen a customer can see
   * from across the room.
   */
  unclaimed: boolean
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
      <div className="w-full max-w-[620px] shrink-0 rounded-card border border-border bg-surface shadow-card">
        {/* The banner carries the whole message at a glance, for the person
            standing three feet back wondering why the till looks different. */}
        <div className="flex flex-col items-center gap-3 border-b border-border px-8 pb-6 pt-8 text-center">
          {/* A disc, not a rounded square. The glyph is the screen's crest —
              the one thing read from across the counter — and a circle reads as
              an emblem where a squircle reads as another button to press. */}
          <span className="flex h-[70px] w-[70px] items-center justify-center rounded-pill bg-brand-soft text-brand">
            <Icons.Store size={34} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-ink">This till is closed</h1>
            {/* The operator's own name in brand, not ink. Standing at a shared
                machine the first thing to confirm is WHO the till thinks you
                are — a float counted in under someone else's sign-in is their
                variance at cash-up, not yours. Colour makes that one word
                findable at a glance instead of buried in a grey sentence. */}
            <p className="mt-1 text-sm text-muted">
              Good day, <span className="font-semibold text-brand">{operatorName}</span>.{' '}
              {/* An unclaimed machine is NOT asked to count anything. The
                  instruction below is the screen's whole invitation, and
                  leaving it above a callout that says the opposite is how a
                  cashier ends up counting a drawer twice before believing the
                  warning. */}
              {mode === 'terminal' && unclaimed
                ? 'This machine needs to be linked to a till before it can open one.'
                : mode === 'user'
                  ? 'Count your float in to start your shift.'
                  : `Count the drawer in to open ${
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
          ) : mode === 'terminal' && unclaimed ? (
            /* BEFORE the pad, not after a rejected tap — see the note on
               `terminalId`. Named as a machine that has not been set up rather
               than as a mistake the cashier made, because it is neither their
               doing nor theirs to fix: claiming a till is a back-office job. */
            <Callout tone="warning" title="This machine is not set up as a till yet">
              <p>
                A shift belongs to a till, and this machine has not been linked to one — so
                there is no drawer to count the float into.
              </p>
              {/* The exact route and the exact button label, checked against
                  LicencesPanel.tsx rather than written from memory. Claiming
                  moved out of the Tills card and into Till licences — a message
                  naming the old place would send somebody to a card that no
                  longer does this, which is worse than naming nowhere. */}
              <p className="mt-2">
                Someone with back-office access can link it under{' '}
                <b className="font-semibold">Setup › Tills</b>, in the{' '}
                <b className="font-semibold">Till licences</b> card — press{' '}
                <b className="font-semibold">Use this machine</b> and pick which till this
                is. Come back here afterwards and the float pad will be waiting.
              </p>
            </Callout>
          ) : (
            <>
              {/* WHOSE FLOAT THIS IS. The single line that makes the two modes
                  behave differently in a cashier's head rather than only in the
                  database. */}
              {/* A callout rather than a loose line of muted text. Whose float
                  this is decides who wears the variance at cash-up, which is
                  the one thing on this screen a cashier can get wrong without
                  noticing — and grey centred prose is exactly what a person
                  skims past on the way to the keypad. */}
              <Callout tone="brand" className="mb-5">
                {mode === 'user'
                  ? 'This shift is yours, not the till’s — your float travels with you across whatever tills you work.'
                  : 'This float belongs to the till. Everyone who trades on it today shares this drawer and this figure.'}
              </Callout>

              {/* Full width, not a 300px block in the middle of the card. The
                  pad is the only thing to hit on this screen, so the keys take
                  the room rather than leaving a margin either side of them. */}
              <div className="mx-auto flex w-full flex-col gap-3">
                <NumPadDisplay
                  label="Opening float"
                  layout="inline"
                  placeholder="0.00"
                  value={float}
                  tone={error ? 'danger' : 'default'}
                />
                <NumPad size="lg" value={float} onChange={setFloat} />
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
                  /* touch-lg, the size reserved for the keys that END something
                     — Pay, Close. Opening the till is that same kind of act:
                     it is the only button on the screen and it commits a figure
                     the whole day's reconciliation rests on. */
                  size="touch-lg"
                  disabled={pending}
                  onClick={open}
                  className="relative w-full"
                >
                  {pending
                    ? 'Opening…'
                    : `Open the till with ${formatMoney(amount)}`}
                  {/* Absolute, so the label stays optically centred on the
                      button rather than being shunted left by the glyph. The
                      chevron says this goes somewhere — it opens the till and
                      moves to the sale screen, and on a touch screen that is
                      worth signalling before the tap, not after. */}
                  {!pending && (
                    <Icons.ChevronRight
                      size={22}
                      className="pointer-events-none absolute right-5"
                      aria-hidden
                    />
                  )}
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
