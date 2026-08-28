'use client'

import { useState, useTransition } from 'react'
import { Card, CardHeader, CardBody, Button, Checkbox, Select, useToast } from '@/components/ui'
import { setReturnToLoginAction, setIdleLogoutAction } from './actions'

/**
 * When the till hands itself back to the PIN pad.
 *
 * ── WHY TWO SETTINGS SHARE ONE PANEL ──────────────────────────────────────
 *
 * They are one question asked at two moments. Both end the operator's session
 * and both return the same screen; they differ only in what triggers it —
 * finishing a transaction, or nobody touching the till for a while. A manager
 * setting up a shared counter wants to decide both at once, and splitting them
 * across two cards would make the second look like a different feature.
 *
 * They are saved SEPARATELY, though, because they can fail separately: the
 * duration goes through a validator that can refuse it, and a single Save that
 * silently wrote one and rejected the other is the ambiguity the cash-up screen
 * already avoids for the same reason.
 *
 * ── WHAT THE COPY HAS TO SAY ──────────────────────────────────────────────
 *
 * That neither is free. Returning to login costs a PIN entry per sale, which at
 * a one-person counter buys nothing. And the timer does NOT run over a basket
 * with lines in it — the most likely misreading of "signs out after 30 seconds"
 * is that it throws away a half-rung sale, which it never does.
 */

/**
 * The durations offered, in seconds. Deliberately not a free number box: these
 * are the ones shops ask for, and a box invites a 5 that makes the till
 * unusable — refused by the validator, but only after somebody has typed it.
 */
const IDLE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Never' },
  { value: 15, label: '15 seconds' },
  { value: 20, label: '20 seconds' },
  { value: 25, label: '25 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 180, label: '3 minutes' },
  { value: 240, label: '4 minutes' },
  { value: 300, label: '5 minutes' },
]

export default function SignOutPanel({
  returnToLogin,
  idleLogoutSeconds,
}: {
  returnToLogin: boolean
  idleLogoutSeconds: number
}) {
  const toast = useToast()
  const [returning, setReturning] = useState(returnToLogin)
  const [idle, setIdle] = useState(idleLogoutSeconds)
  const [pending, startTransition] = useTransition()

  const dirty = returning !== returnToLogin || idle !== idleLogoutSeconds

  function save() {
    startTransition(async () => {
      /* Only what CHANGED. Writing both every time would report "the till will
         stay signed in however long it sits" to somebody who only ticked the
         box above — a true sentence about a setting they did not touch, which
         reads as though the save did something they did not ask for. */
      if (returning !== returnToLogin) {
        const result = await setReturnToLoginAction(returning)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(result.message)
      }

      if (idle !== idleLogoutSeconds) {
        const result = await setIdleLogoutAction(idle)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(result.message)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Signing out of the till"
        description="When the till hands itself back to the PIN pad, so the next sale is rung by whoever is standing there."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          <Checkbox
            label="Return to the PIN pad after every transaction"
            checked={returning}
            onChange={(e) => setReturning(e.target.checked)}
          />

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-ink" htmlFor="idle-logout">
              Sign out after this long untouched
            </label>
            <Select
              id="idle-logout"
              className="w-44"
              value={String(idle)}
              onChange={(e) => setIdle(Number(e.target.value))}
            >
              {IDLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={save} disabled={!dirty || pending}>
              Save
            </Button>
            {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
          </div>
        </div>

        <p className="pt-3 text-sm text-muted">
          Both settle who a sale belongs to. Left off, whoever signed in that morning owns every
          sale until somebody signs out — so a slip printed at four names a cashier who went home
          at noon, and a short drawer has nobody to ask about it. Turned on, each sale is rung
          under the PIN of the person who actually took the money.
        </p>
        <p className="pt-2 text-sm text-muted">
          A till with a sale on screen is never signed out by the timer. A part-rung basket is a
          customer at the counter, so the clock only runs on an empty till and starts again the
          moment the last sale clears. Scanning counts as using the till, so a long delivery
          never trips it.
        </p>
        <p className="pt-2 text-sm text-muted">
          At a counter one person works all day, both of these are cost with no benefit — there
          is only ever one cashier it could have been.
        </p>
      </CardBody>
    </Card>
  )
}
