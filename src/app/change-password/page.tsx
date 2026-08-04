import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import LoginScreen from '@/components/LoginScreen'
import ChangePasswordForm from './ChangePasswordForm'

export const dynamic = 'force-dynamic'

export default async function ChangePasswordPage() {
  const session = await requireSession()

  // Reachable only while the flag is set. Without this, someone who already
  // chose a password could land here and be told to choose another.
  if (!session.mustChangePassword) redirect('/dashboard')

  return (
    <LoginScreen>
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-sm font-semibold text-ink">Choose your password</h2>
          <p className="mt-1 text-xs text-muted">
            You signed in with a temporary password. Set your own to continue.
          </p>
          <p className="mt-0.5 text-xs text-muted">{session.email}</p>
        </div>

        <ChangePasswordForm />

        <form action="/api/auth/signout" method="post" className="text-center">
          <button type="submit" className="text-xs text-muted hover:text-ink">
            Sign out instead
          </button>
        </form>
      </div>
    </LoginScreen>
  )
}
