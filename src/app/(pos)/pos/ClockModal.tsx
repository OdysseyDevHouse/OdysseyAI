'use client'

import { useState, useTransition } from 'react'
import { Modal, Button, PinPad, Icons } from '@/components/ui'
/* The same formatter the back-office clock screen uses. A second one here would
   be a second answer to "what time did they clock in", and the two would
   disagree the first time either was touched. */
import { formatClock } from '@/lib/timeModel'
import { clockAction } from '@/app/(app)/staff/clock/actions'

/**
 * Clocking in and out, at the till.
 *
 * ── WHY THE PIN AND NOT THE SIGNED-IN OPERATOR ────────────────────────────
 *
 * The person clocking on is very often NOT the person signed into the till. A
 * cashier is mid-sale, the next shift arrives, and they clock in on the machine
 * that happens to be free — which is the whole reason a shared terminal has a
 * clock on it at all. Reading the till session would clock the wrong person in
 * and, worse, would do it silently and correctly-looking.
 *
 * So the PIN is the credential here exactly as it is on the back-office clock
 * screen, and for the same reason it is on the till's own sign-in: most floor
 * staff are `pos_only` users with no login at all. `clock()` resolves the PIN to
 * a person and checks THEIR `staff.clock` — the only check that means anything
 * on a machine several people share.
 *
 * ── ONE PAD, ONE ACTION ───────────────────────────────────────────────────
 *
 * The same PIN clocks somebody in if they are out and out if they are in. Not
 * two buttons: at seven in the morning with a queue behind them, asking a person
 * to remember which state they are in produces either a second open entry or a
 * refusal, and both need a manager to unpick. The screen then SAYS which
 * happened, by name and time, because the one thing anybody wants from a clock is
 * confidence that it registered.
 *
 * The key used to navigate to /staff/clock. That took the till off screen — with
 * a basket possibly half-scanned on it — to reach a back-office page whose only
 * relevant feature is this pad.
 */
export function ClockModal({
  open,
  terminalId,
  onClose,
}: {
  open: boolean
  /** Which register this is, recorded against the entry. */
  terminalId: number | null
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    action: 'in' | 'out'
    userName: string
    at: string
  } | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      const outcome = await clockAction(pin, terminalId)
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      setResult({ action: outcome.action, userName: outcome.userName, at: outcome.at })
    })
  }

  /* Reset on the way out rather than on the way in, so the confirmation stays on
     screen for as long as the person is looking at it. Opening again is a fresh
     pad — a dialog that reopened showing the last person's name would be read as
     having clocked THEM. */
  function close() {
    setResult(null)
    setError(null)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Clock in or out"
      description={
        result ? undefined : 'Enter your PIN. The same PIN does whichever you are not.'
      }
      size="sm"
      footer={
        <Button variant={result ? 'primary' : 'secondary'} size="touch" onClick={close}>
          {result ? 'Done' : 'Cancel'}
        </Button>
      }
    >
      {result ? (
        /* ── What just happened ─────────────────────────────────────────────
           The name and the time, large. Somebody clocking on is checking one
           thing: that the machine registered THEM, not the person before. A
           toast behind a closing dialog would not answer that. */
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div
            className={`flex size-14 items-center justify-center rounded-full ${
              result.action === 'in' ? 'bg-success-soft' : 'bg-brand-soft'
            }`}
          >
            {result.action === 'in' ? (
              <Icons.Check size={26} className="text-success-ink" />
            ) : (
              <Icons.Clock size={26} className="text-brand-ink" />
            )}
          </div>
          <div>
            <p className="text-lg font-semibold text-ink">
              {result.userName} clocked {result.action === 'in' ? 'in' : 'out'}
            </p>
            <p className="text-sm text-muted">at {formatClock(result.at)}</p>
          </div>
        </div>
      ) : (
        <div className="flex justify-center py-2">
          {/* The narrow pad: this is a dialog over the till, not the full-screen
              sign-in, and the wide variant is for a pad that owns the viewport. */}
          <PinPad onSubmit={submit} error={error} busy={pending} submitLabel="OK" />
        </div>
      )}
    </Modal>
  )
}
