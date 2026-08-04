'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, KeyRound } from 'lucide-react'
import { changePasswordAction, type ChangePasswordState } from './actions'

const MIN_LENGTH = 10

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-brand px-4 py-2.5 font-medium text-white transition hover:bg-brand-ink disabled:opacity-60"
    >
      <KeyRound size={16} />
      {pending ? 'Saving…' : 'Set password'}
    </button>
  )
}

function Rule({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-1.5 ${met ? 'text-positive' : 'text-muted'}`}>
      <Check size={12} className={met ? '' : 'opacity-30'} />
      {children}
    </li>
  )
}

export default function ChangePasswordForm() {
  const [state, formAction] = useActionState<ChangePasswordState, FormData>(changePasswordAction, {
    error: null,
  })

  // Mirrors the server rules in lib/auth.ts. Live feedback only — the server
  // re-checks everything, since anything here can be bypassed.
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const longEnough = password.length >= MIN_LENGTH
  const matches = password.length > 0 && password === confirm

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">New password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2.5 text-ink"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Confirm new password</span>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2.5 text-ink"
        />
      </label>

      <ul className="flex flex-col gap-1 text-xs">
        <Rule met={longEnough}>At least {MIN_LENGTH} characters</Rule>
        <Rule met={matches}>Both entries match</Rule>
      </ul>

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertCircle size={15} />
          {state.error}
        </p>
      )}

      <SubmitButton disabled={!longEnough || !matches} />
    </form>
  )
}
