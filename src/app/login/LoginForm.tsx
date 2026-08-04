'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { LogIn, StatusError as AlertCircle } from '@/components/ui/icons'
import { Button } from '@/components/ui'
import LoginFields from '@/components/LoginFields'
import { loginAction, type LoginState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant="primary"
      className="mt-2 w-full"
      disabled={pending}
    >
      <LogIn size={16} />
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
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
