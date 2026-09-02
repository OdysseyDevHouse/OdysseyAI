'use client'

import { useState } from 'react'
import { Button, Card, Callout, Field, Input, Icons } from '@/components/ui'
import { redeemUnlockAction } from './leaseActions'

/**
 * The screen a machine shows when it has been offline too long.
 *
 * ── THIS SCREEN CANNOT ASSUME A NETWORK ─────────────────────────────────────
 *
 * It is, by definition, rendered on a machine that has not reached us in a
 * week. So everything it needs was computed server-side before it rendered —
 * the challenge, the device number, how long the silence has been — and the
 * only action it offers works entirely offline: type in a code read over the
 * telephone.
 *
 * "Try again" is still worth offering first. The commonest reason a machine is
 * here is a line that came back up an hour ago and nothing has re-checked
 * since, and that costs one round trip to resolve.
 *
 * ── WHY IT EXPLAINS ITSELF AT LENGTH ────────────────────────────────────────
 *
 * The person reading it is usually a cashier at 07:00 with a queue forming, not
 * the owner who knows about the subscription. Telling them only "not licensed"
 * makes it their emergency. Telling them what happened, that the shop's data is
 * safe, and exactly what to do next makes it a phone call.
 */

export type LeaseLockProps = {
  daysSilent: number
  licenceStatus: string
  challenge: string | null
  deviceSerial: string | null
  /**
   * WHY this machine stopped, which decides which of two conversations the
   * reader is about to have.
   *
   *   'device-licence'  this till's own licence is retired, unpaid or past its
   *                     date — known for certain, from the machine's own copy,
   *                     judged against today. The remedy is to renew it.
   *   'lease-expired'   the licence may be perfectly fine; the machine has not
   *                     been able to CONFIRM it for a week. The remedy is
   *                     usually a network cable.
   *
   * Optional so a caller that predates the distinction still renders the
   * staleness message it always did.
   */
  reason?: 'device-licence' | 'lease-expired'
  /** Which refusal, when `reason` is 'device-licence'. */
  deviceReason?: 'inactive' | 'unpaid' | 'expired'
}

/**
 * What stopped this machine, in a sentence a cashier can act on.
 *
 * ── TWO FAMILIES OF ANSWER, AND MIXING THEM SENDS PEOPLE TO THE WRONG PLACE ─
 *
 * A device whose licence has lapsed is a CERTAINTY — the machine holds the
 * status, the paid flag and the date, and judged them against today. Telling
 * that reader "this machine has not been able to reach us for 3 days" would
 * send them to check a router that is working perfectly, when the answer is
 * that the till needs renewing.
 *
 * A machine that is merely out of contact is the opposite: nothing is known to
 * be wrong, and the honest sentence says so.
 */
function explainDevice(
  deviceReason: 'inactive' | 'unpaid' | 'expired' | undefined,
): { headline: string; detail: string } {
  switch (deviceReason) {
    case 'inactive':
      return {
        headline: 'This machine has been retired',
        detail:
          'It has been marked as retired or returned in the control panel, so it can no longer ' +
          'be used to trade. Nothing on it has been lost.',
      }
    case 'expired':
      return {
        headline: 'This till’s licence has run out',
        detail:
          'The evaluation period for this machine has ended. Renewing it will bring this till ' +
          'straight back — the shop’s data is untouched.',
      }
    case 'unpaid':
    default:
      return {
        headline: 'This till is not licensed',
        detail:
          'This machine is not on a paid licence and has no evaluation period left. Nothing on ' +
          'it has been lost.',
      }
  }
}

/** What the last successful check said, in a sentence a cashier can act on. */
function explain(status: string, daysSilent: number): { headline: string; detail: string } {
  const silence =
    daysSilent >= 1
      ? `This machine has not been able to reach us for ${daysSilent} ${daysSilent === 1 ? 'day' : 'days'}.`
      : 'This machine has not been able to reach us.'

  switch (status) {
    case 'unpaid':
    case 'expired':
      return {
        headline: 'This subscription needs attention',
        detail: `${silence} The last time it did, the subscription for this machine had lapsed.`,
      }
    case 'inactive':
      return {
        headline: 'This machine has been retired',
        detail: `${silence} The last time it did, this machine had been marked as retired in the back office.`,
      }
    case 'unregistered':
      return {
        headline: 'This machine is not registered',
        detail: `${silence} The last time it did, this machine was not linked to a licence.`,
      }
    default:
      return {
        headline: 'This machine needs to check in',
        detail: `${silence} It can keep trading for a week on its own, and that week has passed.`,
      }
  }
}

export default function LeaseLockScreen({
  daysSilent,
  licenceStatus,
  challenge,
  deviceSerial,
  reason,
  deviceReason,
}: LeaseLockProps) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* A known device refusal is the more specific answer and wins. Falling back
     to the staleness wording keeps every existing caller — and any lock reached
     before the device facts were recorded — rendering what it always did. */
  const { headline, detail } =
    reason === 'device-licence'
      ? explainDevice(deviceReason)
      : explain(licenceStatus, daysSilent)

  async function submit() {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await redeemUnlockAction(code)
      if (result.ok) {
        /* A full reload, deliberately: the lock is decided server-side on every
           request, so the only honest way to show it has lifted is to ask
           again from scratch. */
        window.location.reload()
        return
      }
      setError(result.error)
    } catch {
      setError('That code could not be checked. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <Card className="w-full max-w-xl">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-warning-soft text-warning-ink">
              <Icons.StatusWarning size={24} />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">{headline}</h1>
              <p className="mt-1 text-sm text-muted">{detail}</p>
            </div>
          </div>

          {/* The first thing anyone should try, and the first thing they should
              be reassured about. */}
          <Callout tone="brand">
            Nothing has been lost. Every sale, customer and stock figure is still
            on this machine, and trading resumes the moment it checks in.
          </Callout>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="touch" onClick={() => window.location.reload()}>
              <Icons.Refresh size={18} />
              Try again
            </Button>
          </div>

          <div className="border-t border-border pt-5">
            <h2 className="text-sm font-semibold text-ink">No internet? Unlock over the phone</h2>
            <p className="mt-1 text-sm text-muted">
              Call support and read them the code below. They will give you one back.
            </p>

            {challenge ? (
              <div className="mt-3 rounded-control border border-border bg-surface-2 px-4 py-3">
                <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                  Read this to support
                </span>
                {/* select-all because the commonest thing done with it is a
                    copy into a chat window when the phone is engaged. */}
                <code className="numeric mt-1 block select-all text-xl font-semibold tracking-[0.2em] text-ink">
                  {challenge}
                </code>
              </div>
            ) : (
              <Callout tone="warning" className="mt-3">
                This machine cannot generate an unlock code. Support will need the
                device number below to register it again.
              </Callout>
            )}

            {challenge && (
              <div className="mt-4 flex flex-col gap-3">
                <Field label="Code from support">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submit()
                    }}
                    placeholder="ACD-EFG-HJK"
                    autoComplete="off"
                    spellCheck={false}
                    className="numeric text-lg tracking-[0.15em] uppercase"
                  />
                </Field>

                {error && <Callout tone="danger">{error}</Callout>}

                <div>
                  <Button
                    variant="primary"
                    size="touch"
                    onClick={() => void submit()}
                    disabled={busy || code.trim().length === 0}
                  >
                    {busy ? 'Checking…' : 'Unlock this machine'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {deviceSerial && (
            <div className="rounded-control border border-border bg-surface-2 px-4 py-3">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Device number
              </span>
              <code className="mt-1 block select-all break-all text-[13px] text-ink">
                {deviceSerial}
              </code>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
