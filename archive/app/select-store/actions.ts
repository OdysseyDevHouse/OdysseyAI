'use server'

import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { createSessionToken, setSessionCookie } from '@/lib/session'
import { getStore } from '@/lib/lookups'

/**
 * Re-issues the session JWT with a store selected. Only a platform admin may
 * switch — a store user's storeId comes from their user record and must not be
 * changeable from the client, or one store's staff could read another's data.
 */
export async function selectStoreAction(form: FormData): Promise<void> {
  const session = await requireSession()
  if (session.role !== 'platform_admin') redirect('/dashboard')

  const storeId = Number(form.get('storeId'))
  if (!Number.isFinite(storeId) || storeId <= 0) redirect('/select-store')

  const store = await getStore(storeId)
  if (!store) redirect('/select-store')

  const token = await createSessionToken({ ...session, storeId })
  await setSessionCookie(token)

  redirect('/dashboard')
}
