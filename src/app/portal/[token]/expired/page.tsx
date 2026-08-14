import type { Metadata } from 'next'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { publicSiteName } from '@/lib/sites'
import PortalShell from '../PortalShell'
import { TextLink } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Link expired',
  robots: { index: false, follow: false },
}

/**
 * The sign-in link did not work.
 *
 * ── ONE PAGE FOR THREE CAUSES ──────────────────────────────────────────────
 *
 * Already used, expired, or never valid. They are deliberately indistinguishable
 * here: telling somebody which would let a person with a forged link learn
 * whether they had guessed a real one.
 *
 * What it does say is the thing that helps — links work once, they last half an
 * hour, an email program may have opened it first, and another takes seconds.
 */
export default async function PortalExpiredPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const siteId = await verifyPortalToken(token)
  const name = siteId === null ? null : await publicSiteName(siteId).catch(() => null)

  return (
    <PortalShell name={name ?? undefined}>
      <h1 className="text-xl font-semibold text-ink">That link no longer works</h1>
      <p className="mt-2 text-sm text-muted">
        Sign-in links work once and last half an hour, so this one may have expired — or your
        email program may have opened it before you did.
      </p>
      <p className="mt-3 text-sm">
        <TextLink href={`/portal/${token}`}>Ask for a new one</TextLink> — it takes a few
        seconds.
      </p>
    </PortalShell>
  )
}
