'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Field, Input } from '@/components/ui'
import { resetPasswordAction } from '../../actions'

export function ResetForm({ token, resetToken }: { token: string; resetToken: string }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <Card className="mx-auto max-w-md">
        <div className="flex flex-col gap-2 p-5">
          <h1 className="text-lg font-semibold text-ink">Password changed</h1>
          <p className="text-sm text-muted">Sign in with your new password.</p>
          <Button onClick={() => router.push(`/store/${token}/account`)}>Go to sign in</Button>
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
          if (password !== confirm) {
            setError('The two passwords do not match.')
            return
          }
          setError('')
          start(async () => {
            const result = await resetPasswordAction(token, resetToken, password)
            if (result.ok) setDone(true)
            else setError(result.error)
          })
        }}
      >
        <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>

        <Field label="New password" hint="At least 8 characters.">
          <Input
            value={password}
            type="password"
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Type it again">
          <Input
            value={confirm}
            type="password"
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || password.length < 8}>
          {busy ? 'Saving…' : 'Save the new password'}
        </Button>
      </form>
    </Card>
  )
}
