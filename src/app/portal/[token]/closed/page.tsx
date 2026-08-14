import type { Metadata } from 'next'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { publicSiteName } from '@/lib/sites'
import PortalShell from '../PortalShell'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Not available',
  robots: { index: false, follow: false },
}

/**
 * The portal is switched off for this business.
 *
 * A page rather than a 404, on the reservation page's reasoning: this link is on
 * the business's own website and in the footer of their emails, and somebody who
 * followed it is entitled to be told to phone rather than shown a dead end.
 */
export default async function PortalClosedPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const siteId = await verifyPortalToken(token)
  const name = siteId === null ? null : await publicSiteName(siteId).catch(() => null)

  return (
    <PortalShell name={name ?? undefined}>
      <h1 className="text-xl font-semibold text-ink">No online account here</h1>
      <p className="mt-2 text-sm text-muted">
        This business does not offer an online account at the moment. Please contact them
        directly and they will be able to help.
      </p>
    </PortalShell>
  )
}
