'use server'

import { redirect } from 'next/navigation'
import { signIn, type SignInChoice } from '@/lib/auth'

export type LoginState = {
  error: string | null
  /**
   * Set when the credentials were right but the account opens more than one
   * store. The form shows these in a dialog; the session is already signed in
   * at this point, with no site selected until one is picked.
   */
  choices?: SignInChoice[]
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '')

  const result = await signIn(email, password)
  if (!result.ok) return { error: result.error }

  // A temporary password gets them in and no further until they replace it.
  if (result.mustChangePassword) redirect('/change-password')

  // Only relative paths — an absolute URL here would make the login form an
  // open redirect. `/` and the retired `/login` are excluded too: bouncing
  // back to a login screen (or a route that no longer exists) after a
  // successful sign-in is never what the user wanted.
  const isSafe =
    next.startsWith('/') && !next.startsWith('//') && next !== '/' && !next.startsWith('/login')

  // Several stores: hand them back so the form can open the picker over the
  // login screen. Returned rather than redirected — the credentials were
  // accepted and the session exists, it simply has no site open yet, and
  // sending them to another URL would lose the screen they are looking at.
  if (result.choices.length > 0) return { error: null, choices: result.choices }

  // No site at all — a screen that explains that beats a dashboard with
  // nothing on it. The destination rides along so a deep link survives.
  if (result.siteId === null) {
    redirect(isSafe ? `/select-site?next=${encodeURIComponent(next)}` : '/select-site')
  }

  redirect(isSafe ? next : '/dashboard')
}
