'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { requireSession, changePassword } from '@/lib/auth'
import { claimSession } from '@/lib/control/sessions'
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

  /* ── A NEW PASSWORD ENDS EVERY OTHER SESSION ─────────────────────────────
     Rotating the session id and re-claiming displaces whatever else is signed
     in as this user, which is what somebody changing their password expects to
     happen and what they are usually changing it FOR. Before the registry
     existed this was impossible — a password change left every other session
     live until it expired.

     This browser keeps working because the token below carries the new id. */
  const sid = randomUUID()
  await claimSession(session.userId, sid)

  // Re-issue the token with the flag cleared, otherwise the guards would keep
  // bouncing the user back here even though the database is already updated.
  const token = await createSessionToken({ ...session, mustChangePassword: false, sid })
  await setSessionCookie(token)

  redirect(session.siteId === null ? '/select-site' : '/dashboard')
}
