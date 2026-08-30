import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalProfile, portalAddresses } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  StatStrip,
  StatTile,
} from '@/components/ui'
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

  const nav = (
    <PortalNav
      token={token}
      active="account"
      settings={ctx.settings}
      onSignOut={<SignOutButton token={token} />}
    />
  )

  /*
   * Signed in, but the customer record has gone — deleted or archived between
   * the session being minted and this request. Not an error page: the session
   * is valid and there is simply nothing to show.
   */
  if (!profile) {
    return (
      <PortalShell name={name ?? undefined} nav={nav}>
        <EmptyState
          icon={<Icons.User size={22} />}
          title="We could not find your account"
          hint="Please contact the business — your account may have moved or closed."
        />
      </PortalShell>
    )
  }

  const owing = profile.balance > 0.005
  const inCredit = profile.balance < -0.005

  /*
   * The details, as label/value pairs.
   *
   * Built as data rather than markup so the empty ones can be dropped in one
   * place: a row reading "VAT number —" on a customer who has none is a line
   * the reader has to process to learn nothing. What IS shown is then all
   * true, which is the point of the page.
   */
  const details: [string, string][] = [
    ['Contact', profile.contactName ?? ''],
    ['Email', profile.email ?? ''],
    ['Phone', profile.phone ?? ''],
    ['VAT number', profile.vatNumber ?? ''],
    ['Address', profile.addressLines.join('\n')],
    /*
     * Payment terms are NOT here — they are a stat tile above. Shown in both
     * places the page stated the same fact twice within one screen, which
     * makes a reader check whether the two agree instead of reading either.
     * It falls back into this list only when there are no terms to headline.
     */
    ...(profile.paymentTermsDays > 0
      ? []
      : ([['Payment terms', 'On invoice']] as [string, string][])),
  ]
  const shown = details.filter(([, value]) => value.trim().length > 0)

  return (
    <PortalShell
      name={name ?? undefined}
      nav={nav}
      title={profile.name}
      subtitle={<span className="numeric">Account {profile.code}</span>}
      card={false}
    >
      {/*
       * The balance is the one number somebody opens this page for, so it gets
       * the kit's headline treatment rather than small print in the corner —
       * and a TONE, because "you owe money" is an exception and "settled" is
       * not. Colour here is the whole signal.
       */}
      <StatStrip columns={2}>
        <StatTile
          label={inCredit ? 'In credit' : 'Balance'}
          value={formatMoney(Math.abs(profile.balance))}
          tone={owing ? 'warning' : inCredit ? 'success' : 'default'}
          hint={owing ? 'Owing on your account' : inCredit ? 'We owe you' : 'Nothing outstanding'}
          icon={<Icons.Coins size={16} />}
        />
        {profile.paymentTermsDays > 0 && (
          <StatTile
            label="Payment terms"
            value={`${profile.paymentTermsDays} days`}
            hint="From the date of invoice"
            icon={<Icons.Clock size={16} />}
          />
        )}
      </StatStrip>

      <Card>
        <CardHeader
          icon={<Icons.User size={16} />}
          title="Your details"
          description="What we have on file for you. Contact us if anything here is wrong."
        />
        <CardBody>
          <dl className="divide-y divide-border">
            {shown.map(([label, value]) => (
              <div
                key={label}
                className="flex flex-wrap gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0"
              >
                {/* A plain definition list rather than SummaryList: that one is
                    a totals panel and right-aligns every value as a number,
                    which turns a postal address into a ragged column. */}
                <dt className="w-32 shrink-0 text-muted">{label}</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-line text-ink-2">{value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      {addresses.length > 0 && (
        <Card>
          <CardHeader
            icon={<Icons.MapPin size={16} />}
            title="Your addresses"
            description="Where we deliver to."
          />
          <CardBody>
            <ul className="divide-y divide-border">
              {addresses.map((address) => (
                <li
                  key={address.id}
                  className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{address.label}</span>
                    <span className="block whitespace-pre-line text-xs text-muted">
                      {address.lines.join('\n') || '—'}
                    </span>
                  </span>
                  {address.isDefault && <Badge tone="brand">Default</Badge>}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </PortalShell>
  )
}
