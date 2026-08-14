'use client'

import { useState, useTransition } from 'react'
import { Button, Card, Field, Input } from '@/components/ui'
import { requestPasswordResetAction } from '../actions'

/**
 * "Forgot your password" — the answer is the same whether or not the address
 * matched, so the form cannot be used to discover which customers have
 * accounts. The only distinct refusal is a shop with no mail set up, where
 * pretending to send would be worse.
 */
export function ForgotForm({ token }: { token: string }) {
  const [busy, start] = useTransition()
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <Card className="mx-auto max-w-md">
        <div className="flex flex-col gap-2 p-5">
          <h1 className="text-lg font-semibold text-ink">Check your email</h1>
          <p className="text-sm text-muted">
            If that address has an account here, a reset link is on its way. It works once,
            for an hour.
          </p>
          <a href={`/store/${token}/account`} className="text-sm text-brand hover:underline">
            ← Back to sign in
          </a>
        </div>
      </Card>
    )
  }

  return (
    <Card className="mx-auto max-w-md">
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          setError('')
          start(async () => {
            const result = await requestPasswordResetAction(token, email)
            if (result.ok) setSent(true)
            else setError(result.error)
          })
        }}
      >
        <div>
          <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
          <p className="mt-1 text-sm text-muted">
            Type the email you sign in with and we&apos;ll send a reset link.
          </p>
        </div>

        <Field label="Email">
          <Input
            value={email}
            type="email"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send the link'}
        </Button>
      </form>
    </Card>
  )
}
