'use server'

import { revalidatePath } from 'next/cache'
import { requireSession } from '@/lib/auth'
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
} from '@/lib/twoFactor'

/**
 * Own-account only, always: the user id comes from the SESSION on every
 * call, never a payload, so nobody can enrol or strip anybody else here.
 * The owner's recovery path lives on /setup/users behind setup.users.
 */

export async function beginEnrolmentAction(): Promise<
  { ok: true; secret: string; uri: string } | { ok: false; error: string }
> {
  const session = await requireSession()
  return beginTotpEnrolment(session.userId, session.email)
}

export async function confirmEnrolmentAction(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession()
  const result = await confirmTotpEnrolment(session.userId, code)
  if (result.ok) revalidatePath('/security')
  return result
}

export async function disableTotpAction(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession()
  const result = await disableTotp(session.userId, code)
  if (result.ok) revalidatePath('/security')
  return result
}
