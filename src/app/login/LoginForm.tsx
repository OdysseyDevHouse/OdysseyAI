'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { LogIn, AlertCircle } from 'lucide-react'
import LoginFields from '@/components/LoginFields'
import { loginAction, type LoginState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-brand px-4 py-2.5 font-medium text-white transition hover:bg-brand-ink disabled:opacity-60"
    >
      <LogIn size={16} />
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

export default function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, { error: null })

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />

      <LoginFields autoFocus />

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertCircle size={15} />
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  )
}
