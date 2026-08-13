'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, PinPad, Button, Icons, Callout } from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { posUnlockAction } from './actions'

/**
 * "The till needs to sign in again."
 *
 * Deliberately says almost nothing. It is a public URL, so every fact it could
 * display — the shop's name, who works here, how many sales are queued — is a fact
 * handed to whoever opens it. A PIN pad and one sentence is the whole screen.
 *
 * The one thing it does show is WHY, because a cashier who arrives at 07:00 to a
 * PIN prompt they have never seen before needs to know this is routine and their
 * own PIN will clear it.
 */
export default function UnlockScreen() {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  // Browser-only, so it resolves after mount. Until it does, the pad is shown but
  // submitting would send an empty device id — which the action refuses anyway.
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => setDevice(deviceId()), [])

  function submit(pin: string) {
    setError(null)
    if (!device) {
      setError('This browser has no device identity yet. Reload the page.')
      return
    }
    startTransition(async () => {
      const result = await posUnlockAction(device, pin)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // Straight back to the till. The cookies are set, so proxy.ts lets it through
      // and the outbox can start flushing.
      router.replace('/pos')
      router.refresh()
    })
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-5 px-6 py-8">
          <div className="text-center">
            {/* Round, tinted, warning-toned: this is a state to clear rather than a
                failure. The same idiom as the till's own gate, one step louder. */}
            <div
              data-kit-ok
              className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-warning-soft"
            >
              <Icons.KeyRound size={26} className="text-warning-ink" />
            </div>
            <h1 className="text-xl font-semibold text-ink">This till is locked</h1>
          </div>

          <Callout tone="warning">
            The till has been signed out — usually because it sat overnight. Enter
            your PIN to carry on. Any sales still waiting to send are safe and will
            go as soon as it unlocks.
          </Callout>

          <PinPad onSubmit={submit} error={error} busy={pending} />

          {/* The way out for somebody who is not a cashier. Not a link to the login
              form — this is a till, and the person here may not have an account. */}
          <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
            Sign in to the back office instead
          </Button>
        </div>
      </Card>
    </div>
  )
}
