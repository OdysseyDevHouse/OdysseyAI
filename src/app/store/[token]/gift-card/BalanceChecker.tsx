'use client'

import { useState, useTransition } from 'react'
import { Button, Card, Field, Input } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { checkGiftCardAction } from './actions'

export function BalanceChecker({ token, storeName }: { token: string; storeName: string }) {
  const [entry, setEntry] = useState('')
  const [answer, setAnswer] = useState<{ display: string; balance: number; expiresOn: string | null } | null>(null)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()

  return (
    <Card className="mx-auto max-w-md">
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          setError('')
          start(async () => {
            const result = await checkGiftCardAction(token, entry)
            if (!result.ok) {
              setError(result.error)
              setAnswer(null)
              return
            }
            setAnswer(result)
          })
        }}
      >
        <div>
          <h1 className="text-lg font-semibold text-ink">Gift card balance</h1>
          <p className="mt-1 text-sm text-muted">
            Type the number on your {storeName} gift card.
          </p>
        </div>

        <Field label="Card number" error={error || undefined}>
          <Input
            value={entry}
            placeholder="XXXX-XXXX-XXXX"
            onChange={(e) => {
              setEntry(e.target.value)
              setAnswer(null)
              setError('')
            }}
          />
        </Field>

        {answer && (
          <div className="rounded-card border border-success/40 bg-success-soft px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-success-ink">Card {answer.display}</span>
              <span className="numeric text-2xl font-extrabold text-success-ink">
                {formatMoney(answer.balance)}
              </span>
            </div>
            {answer.expiresOn && (
              <p className="mt-0.5 text-xs text-success-ink/80">Valid until {answer.expiresOn}</p>
            )}
          </div>
        )}

        <Button type="submit" disabled={busy || !entry.trim()}>
          {busy ? 'Checking…' : 'Check the balance'}
        </Button>
      </form>
    </Card>
  )
}
