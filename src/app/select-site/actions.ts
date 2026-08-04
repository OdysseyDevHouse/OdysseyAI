'use server'

import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { createSessionToken, setSessionCookie } from '@/lib/session'
import { getSiteForUser } from '@/lib/sites'

/**
 * Re-issues the session JWT with a different site open.
 *
 * The requested id is checked against cp2_user_sites for THIS user before it is
 * written into the token — otherwise posting an arbitrary site id here would
 * hand someone another company's data.
 */
export async function selectSiteAction(form: FormData): Promise<void> {
  const session = await requireSession()

  // Guarded here as well as on the page: this is a POST endpoint in its own
  // right, and a page-only check would leave it reachable directly.
  if (session.mustChangePassword) redirect('/change-password')

  const siteId = Number(form.get('siteId'))
  if (!Number.isFinite(siteId) || siteId <= 0) redirect('/select-site')

  const site = await getSiteForUser(session.userId, siteId)
  if (!site) redirect('/select-site')

  const token = await createSessionToken({ ...session, siteId: site.id })
  await setSessionCookie(token)

  redirect('/dashboard')
}
