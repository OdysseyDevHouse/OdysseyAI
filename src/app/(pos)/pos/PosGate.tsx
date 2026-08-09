'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, PinPad, Button, Icons } from '@/components/ui'
import { tillSignInAction } from '@/app/(app)/sales/new/pinActions'

/**
 * The PIN prompt in front of the touch till.
 *
 * Deliberately reuses `tillSignInAction` rather than getting its own: there is
 * one answer to "who is standing at this till", it is a bcrypt check against
 * users.pin_hash, and a second copy is a second place for the lockout rules and
 * the site check to drift.
 *
 * What differs from the back-office gate is only the frame — full screen, centred,
 * no page header — because this is the first thing a shop sees at 07:00 and it
 * should look like a till rather than like a form on a website.
 */
export default function PosGate({ siteName }: { siteName: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      const result = await tillSignInAction(pin)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // The server component re-reads the till cookie and renders the basket.
      router.refresh()
    })
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-6 px-6 py-8">
          <div className="text-center">
            {/* Round because it is an identity mark, not a control — the same
                tinted-glyph idiom as SettingRow's icon tile. */}
            <div
              data-kit-ok
              className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-brand-soft"
            >
              <Icons.KeyRound size={26} className="text-brand" />
            </div>
            <h2 className="text-xl font-semibold text-ink">Enter your PIN</h2>
            <p className="text-sm text-muted">{siteName}</p>
          </div>

          <PinPad onSubmit={submit} error={error} busy={pending} />

          {/* The way out. A till with no exit is a machine somebody has to
              restart to get back to the back office. */}
          <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
            Back to the back office
          </Button>
        </div>
      </Card>
    </div>
  )
}
