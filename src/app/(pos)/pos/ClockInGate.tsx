'use client'

import { useState, useTransition } from 'react'
import { Button, Callout, Icons, PinPad, useToast } from '@/components/ui'
import { clockAction } from '@/app/(app)/staff/clock/actions'

/**
 * This person is not on duty yet.
 *
 * ── WHAT THIS GATE IS FOR, AND WHY OpenTillGate CANNOT DO IT ──────────────
 *
 * OpenTillGate asks about the DRAWER: is a shift open on this till. In terminal
 * mode that is answered once a day, by whoever starts it, and every cashier
 * afterwards walks straight past — the drawer is already counted, so there is
 * nothing to ask them.
 *
 * This asks about the PERSON: are YOU on duty. It is the second question, and
 * the shift gate structurally cannot answer it — by the time the second cashier
 * of the day signs in, the shift gate has no opinion left. Hence a second gate
 * rather than another branch inside the first.
 *
 * Only stands when the shop turned `pos_force_clock_in` on. Off by default: a
 * cashier who forgets to clock in cannot sell, and at 07:00 with a queue the
 * person who fixes that is a manager.
 *
 * ── WHY IT TAKES A PIN RATHER THAN A BUTTON ───────────────────────────────
 *
 * Because `clock()` resolves the PIN to a person, and that is the only
 * credential that means anything on a shared machine. A button saying "clock me
 * in" would clock in whoever the till session names, which at a counter is
 * routinely not the person standing there — the exact confusion ClockModal
 * exists to avoid. Same pad, same action, same rule.
 *
 * It is also what makes the gate honest: somebody who cannot produce their own
 * PIN is not on duty, and tapping past would only record a lie.
 */
export default function ClockInGate({
  operatorName,
  terminalId,
  online,
  onClockedIn,
  onExit,
}: {
  /** Who the till thinks is signed in, so a shared machine is unambiguous. */
  operatorName: string
  /** Recorded against the entry, the same as ClockModal does. */
  terminalId: number | null
  /** A time entry is a server record; offline the gate explains rather than lies. */
  online: boolean
  /** Fires once an entry is open, so the shell can re-read and let them trade. */
  onClockedIn: () => void
  /** Back to the PIN pad — for whoever reached this and should not be here. */
  onExit: () => void
}) {
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      const result = await clockAction(pin, terminalId)
      if (!result.ok) {
        // Under the pad rather than only in a toast: a toast leaves the screen
        // while the thing that caused it is still on it.
        setError(result.error)
        return
      }
      /*
       * A PIN that clocked somebody OUT has not opened the till.
       *
       * The same pad does both — that is deliberate in `clock()`, so nobody has
       * to remember which state they are in. But here the two outcomes are not
       * equivalent: clocking out at the gate leaves the person exactly as
       * unable to trade as they were, and reporting "done" would send the shell
       * to a sale screen this gate is still supposed to be covering.
       */
      if (result.action === 'out') {
        setError(
          `${result.userName} was on duty and is now clocked out. Enter the PIN again to clock on.`,
        )
        return
      }
      toast.success(`${result.userName} is on duty. Have a good shift.`)
      onClockedIn()
    })
  }

  return (
    /* Mirrors OpenTillGate exactly — scrolls, centres one card, no till chrome.
       These two screens appear in the same place for related reasons, and a
       cashier meeting them on consecutive mornings should not have to work out
       that they are different kinds of thing. */
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 pb-4">
      <div className="w-full max-w-[620px] shrink-0 rounded-card border border-border bg-surface shadow-card">
        <div className="flex flex-col items-center gap-3 border-b border-border px-8 pb-6 pt-8 text-center">
          <span className="flex h-[70px] w-[70px] items-center justify-center rounded-pill bg-brand-soft text-brand">
            <Icons.Clock size={34} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-ink">Clock on to start</h1>
            <p className="mt-1 text-sm text-muted">
              Good day, <span className="font-semibold text-brand">{operatorName}</span>. This
              shop records hours at the till, so enter your PIN to go on duty.
            </p>
          </div>
        </div>

        {/* CENTRED, and the pad is `wide`.
            Both are load-bearing rather than taste. The default pad is capped at
            max-w-xs — about 320px — and this card is 620px, so a left-aligned
            narrow pad left half the card empty: a big white void beside the keys
            that read as a component that had failed to load. The till's own
            sign-in (PosGate) already uses `wide` for exactly this reason, and
            these two screens are the same kind of thing — a full-screen gate
            owning the counter display, not a pad inside a dialog. */}
        <div className="flex flex-col items-center px-8 py-6">
          {!online ? (
            /* A time entry is a server record. Saying so beats a PIN typed into
               a screen that cannot store the result. */
            <Callout tone="warning" title="Clocking on needs the connection">
              This till cannot reach the server, and hours are recorded there. Try again once
              the line is back — nothing is lost by waiting.
            </Callout>
          ) : (
            /* `error` goes to the pad rather than a Callout beside it: PinPad
               shows it in the place the digits were just typed, and clears it
               on the next keypress. */
            <PinPad wide onSubmit={submit} error={error} busy={pending} />
          )}

          <div className="flex justify-center pt-6">
            <Button variant="ghost" onClick={onExit} disabled={pending}>
              <Icons.ChevronLeft size={15} />
              Back to sign in
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
