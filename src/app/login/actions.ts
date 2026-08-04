'use server'

import { redirect } from 'next/navigation'
import { signIn } from '@/lib/auth'

export type LoginState = { error: string | null }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '')

  const result = await signIn(email, password)
  if (!result.ok) return { error: result.error }

  // A temporary password gets them in and no further until they replace it.
  if (result.mustChangePassword) redirect('/change-password')

  // No site linked to this account — send them somewhere that explains that
  // rather than to a dashboard that would have nothing to show.
  if (result.siteId === null) redirect('/select-site')

  // Only relative paths — an absolute URL here would make the login form an
  // open redirect. `/` and the retired `/login` are excluded too: bouncing
  // back to a login screen (or a route that no longer exists) after a
  // successful sign-in is never what the user wanted.
  const isSafe =
    next.startsWith('/') && !next.startsWith('//') && next !== '/' && !next.startsWith('/login')

  redirect(isSafe ? next : '/dashboard')
}
