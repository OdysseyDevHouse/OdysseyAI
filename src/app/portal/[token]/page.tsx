import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings } from '@/lib/site/portalAuth'
import { publicSiteName } from '@/lib/sites'
import PortalShell from './PortalShell'
import SignInForm from './SignInForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your account',
  robots: { index: false, follow: false },
}

/**
 * The portal front door.
 *
 * ── IT ASKS FOR AN EMAIL AND SENDS A LINK ──────────────────────────────────
 *
 * No password field, because there is no password — see portalAuth. A customer
 * types the address the business already has for them and gets a link that works
 * once.
 *
 * ── ALREADY SIGNED IN GOES STRAIGHT THROUGH ────────────────────────────────
 *
 * A session lasts a fortnight, so somebody returning inside that window should
 * not be asked to fetch another email.
 */
export default async function PortalSignInPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const siteId = await verifyPortalToken(token)

  if (siteId === null) {
    return (
      <PortalShell>
        <h1 className="text-xl font-semibold text-ink">This link is not valid</h1>
        <p className="mt-2 text-sm text-muted">
          Please ask the business for the address of their customer account page.
        </p>
      </PortalShell>
    )
  }

  const [name, settings, session] = await Promise.all([
    publicSiteName(siteId).catch(() => null),
    portalSettings(siteId),
    getCustomerSession(siteId),
  ])

  if (!settings.isEnabled) redirect(`/portal/${token}/closed`)
  if (session) redirect(`/portal/${token}/jobs`)

  return (
    <PortalShell name={name ?? undefined}>
      <SignInForm token={token} />
    </PortalShell>
  )
}
