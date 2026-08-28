'use server'

import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { createSessionToken, setSessionCookie } from '@/lib/session'
import { getSiteForUser } from '@/lib/sites'
import { opensHere } from '@/lib/desktopBackOffice'

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

  /* Guarded here as well as on the page, for the same reason the
     must-change-password check above is: this is a POST endpoint in its own
     right, and a picker that merely omits the row is not a check. On the back
     office EXE a cloud store is not openable at all — see
     lib/desktopBackOffice.ts. */
  if (!opensHere(site.connectionType)) redirect('/select-site?cloudsite=1')

  const token = await createSessionToken({ ...session, siteId: site.id })
  await setSessionCookie(token)

  // Where they were headed before login interrupted them. Relative paths only,
  // for the same reason as on the login form: anything else turns this action
  // into an open redirect. `/login` and `/select-site` are excluded so a stale
  // value can't bounce them straight back here.
  const next = String(form.get('next') ?? '')
  const isSafe =
    next.startsWith('/') &&
    !next.startsWith('//') &&
    next !== '/' &&
    !next.startsWith('/login') &&
    !next.startsWith('/select-site')

  redirect(isSafe ? next : '/dashboard')
}
