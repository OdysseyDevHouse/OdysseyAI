import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalProfile, portalAddresses } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import { Badge, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your details',
  robots: { index: false, follow: false },
}

/**
 * What the business has on file for this customer.
 *
 * ── READ-ONLY, DELIBERATELY ────────────────────────────────────────────────
 *
 * There is no edit button and no server action behind this page. A customer
 * changing their own VAT number, trading name or delivery address on a live
 * debtors account changes what gets invoiced and where it gets sent, silently,
 * with nobody at the shop reviewing it. The page instead says who to tell — a
 * worse experience and a far better control, and the same call the storefront's
 * account page makes.
 *
 * ── IT IS THE ANSWER TO "WHAT DO YOU HAVE FOR ME" ─────────────────────────
 *
 * Which is the question that makes it worth showing at all. A wrong email is
 * why a statement never arrived; a wrong address is why a delivery went astray.
 * Showing it lets the customer spot both without ringing to ask.
 */
export default async function PortalAccountPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const ctx = await requireSection(token, 'account')

  const [profile, addresses, name] = await Promise.all([
    portalProfile(ctx.siteId, ctx.customerId),
    portalAddresses(ctx.siteId, ctx.customerId),
    publicSiteName(ctx.siteId).catch(() => null),
  ])

  const shell = (children: React.ReactNode) => (
    <PortalShell
      name={name ?? undefined}
      nav={
        <PortalNav
          token={token}
          active="account"
          settings={ctx.settings}
          onSignOut={<SignOutButton token={token} />}
        />
      }
    >
      {children}
    </PortalShell>
  )

  /*
   * Signed in, but the customer record has gone — deleted or archived between
   * the session being minted and this request. Not an error page: the session
   * is valid and there is simply nothing to show.
   */
  if (!profile) {
    return shell(
      <EmptyState
        icon={<Icons.User size={22} />}
        title="We could not find your account"
        hint="Please contact the business — your account may have moved or closed."
      />,
    )
  }

  const owing = profile.balance > 0.005

  return shell(
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink">{profile.name}</h1>
          <p className="numeric mt-0.5 text-sm text-muted">Account {profile.code}</p>
        </div>
        {/* The balance is the one number somebody opens this page for, so it
            is stated here rather than only on the statement tab. */}
        <div className="text-right">
          <p className="numeric text-lg font-semibold text-ink">
            {formatMoney(Math.abs(profile.balance))}
          </p>
          <p className="text-xs text-muted">
            {owing ? 'owing' : profile.balance < -0.005 ? 'in credit' : 'settled'}
          </p>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-medium text-ink">Your details</h2>
        {/* A plain definition list rather than SummaryList: that one is a
            totals panel and right-aligns every value as a number, which turns a
            postal address into a ragged column of text. */}
        <dl className="divide-y divide-border rounded-card border border-border">
          {[
            ['Contact', profile.contactName],
            ['Email', profile.email],
            ['Phone', profile.phone],
            ['VAT number', profile.vatNumber],
            ['Address', profile.addressLines.join('\n')],
            [
              'Payment terms',
              profile.paymentTermsDays > 0 ? `${profile.paymentTermsDays} days` : null,
            ],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-wrap gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm">
              <dt className="w-32 shrink-0 text-muted">{label}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-line text-ink">{value || '—'}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">
          Something not right? Please contact us — we will update it for you.
        </p>
      </section>

      {addresses.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-ink">Your addresses</h2>
          <ul className="divide-y divide-border rounded-card border border-border">
            {addresses.map((address) => (
              <li key={address.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{address.label}</span>
                  <span className="block whitespace-pre-line text-xs text-muted">
                    {address.lines.join('\n') || '—'}
                  </span>
                </span>
                {address.isDefault && <Badge tone="neutral">Default</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>,
  )
}
