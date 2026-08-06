'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, PinPad, Button, Icons } from '@/components/ui'
import { tillSignInAction } from './pinActions'

/**
 * The PIN prompt in front of the till.
 *
 * Stands between the operator and the basket so that every sale has a name
 * against it from the first line, rather than being attributed at the end to
 * whoever happened to be signed into the browser. That matters most on the
 * shop floor the system was built for, where one machine is shared all day.
 */
export default function TillGate({ siteName }: { siteName: string }) {
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
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-brand/10">
              <Icons.KeyRound size={22} className="text-brand" />
            </div>
            <h2 className="text-lg font-semibold text-ink">Enter your PIN</h2>
            <p className="text-sm text-muted">{siteName}</p>
          </div>

          <PinPad onSubmit={submit} error={error} busy={pending} />

          <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
            Back to the back office
          </Button>
        </div>
      </Card>
    </div>
  )
}
