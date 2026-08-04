'use server'

import { redirect } from 'next/navigation'
import { requireSession, changePassword } from '@/lib/auth'
import { createSessionToken, setSessionCookie } from '@/lib/session'

export type ChangePasswordState = { error: string | null }

export async function changePasswordAction(
  _prev: ChangePasswordState,
  form: FormData,
): Promise<ChangePasswordState> {
  const session = await requireSession()

  const password = String(form.get('password') ?? '')
  const confirm = String(form.get('confirm') ?? '')

  const result = await changePassword(session.userId, password, confirm)
  if (!result.ok) return { error: result.error }

  // Re-issue the token with the flag cleared, otherwise the guards would keep
  // bouncing the user back here even though the database is already updated.
  const token = await createSessionToken({ ...session, mustChangePassword: false })
  await setSessionCookie(token)

  redirect(session.siteId === null ? '/select-site' : '/dashboard')
}
