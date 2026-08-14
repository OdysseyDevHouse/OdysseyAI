'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Field, Input } from '@/components/ui'
import { changePasswordAction, signInAction, signOutAction } from './actions'

/**
 * Signing in, and changing a password once signed in.
 *
 * ── ERRORS STAY ON SCREEN ────────────────────────────────────────────────
 *
 * Not a toast. "That email and password do not match an account" needs to be
 * readable while retyping the password, and a message that fades after three
 * seconds is gone by the time someone has looked back at the keyboard.
 */

export function SignInForm({ token, storeName }: { token: string; storeName: string }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    start(async () => {
      const result = await signInAction(token, email, password)
      if (result.ok) router.refresh()
      else setError(result.error)
    })
  }

  return (
    <Card className="mx-auto max-w-md">
      <form className="flex flex-col gap-3 p-5" onSubmit={submit}>
        <div>
          <h1 className="text-lg font-semibold text-ink">Sign in to your account</h1>
          <p className="mt-1 text-sm text-muted">
            For customers with an account at {storeName}. Ask the shop to set one up for you.
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

        <Field label="Password">
          <Input
            value={password}
            type="password"
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <a href={`/store/${token}/account/forgot`} className="text-sm text-brand hover:underline">
          Forgot your password?
        </a>
      </form>
    </Card>
  )
}

export function SignOutButton({ token }: { token: string }) {
  const router = useRouter()
  const [busy, start] = useTransition()

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={() =>
        start(async () => {
          await signOutAction(token)
          router.refresh()
        })
      }
    >
      Sign out
    </Button>
  )
}

export function ChangePasswordForm({
  token,
  /** True after staff issued a temporary password — the prompt is then not optional. */
  required,
}: {
  token: string
  required: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(required)
  const [busy, start] = useTransition()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return <p className="text-sm text-success">Your password has been changed.</p>
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Change password
      </Button>
    )
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    start(async () => {
      const result = await changePasswordAction(token, current, next)
      if (result.ok) {
        setDone(true)
        router.refresh()
      } else setError(result.error)
    })
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {required && (
        <p className="rounded-control bg-warning-soft px-3 py-2 text-sm text-warning-ink">
          The shop set this password for you. Please choose your own.
        </p>
      )}

      <Field label="Current password">
        <Input
          value={current}
          type="password"
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>

      <Field label="New password" hint="At least 8 characters">
        <Input
          value={next}
          type="password"
          autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
        {/* No cancel when it is required: the shop's temporary password must
            not stay in use just because the prompt was dismissed. */}
        {!required && (
          <Button variant="ghost" type="button" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
