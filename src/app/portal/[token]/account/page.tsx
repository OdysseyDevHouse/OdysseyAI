import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { requireSection } from '../guard'
import { portalProfile, portalAddresses } from '@/lib/site/portalData'
import { letterheadFor } from '../letterhead'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import PayAccountButton from '../PayAccountButton'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  RowTile,
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

  const [profile, addresses, head] = await Promise.all([
    portalProfile(ctx.siteId, ctx.customerId),
    portalAddresses(ctx.siteId, ctx.customerId),
    letterheadFor(ctx.siteId),
  ])

  const frame = {
    name: head.name ?? undefined,
    hasLogo: head.hasLogo,
    token,
    onSignOut: <SignOutButton token={token} />,
    nav: <PortalNav token={token} active="account" settings={ctx.settings} />,
  }

  /*
   * Signed in, but the customer record has gone — deleted or archived between
   * the session being minted and this request. Not an error page: the session
   * is valid and there is simply nothing to show.
   */
  if (!profile) {
    return (
      <PortalShell {...frame}>
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
   * The details, with a glyph each.
   *
   * Built as data rather than markup so the empty ones can be dropped in one
   * place: a row reading "VAT number —" on a customer who has none is a line
   * the reader has to process to learn nothing. What IS shown is then all
   * true, which is the point of the page.
   */
  const details: { label: string; value: string; icon: ReactNode }[] = [
    { label: 'Contact', value: profile.contactName ?? '', icon: <Icons.User size={14} /> },
    { label: 'Email', value: profile.email ?? '', icon: <Icons.Mail size={14} /> },
    { label: 'Phone', value: profile.phone ?? '', icon: <Icons.Phone size={14} /> },
    { label: 'VAT number', value: profile.vatNumber ?? '', icon: <Icons.FileText size={14} /> },
    {
      label: 'Address',
      value: profile.addressLines.join('\n'),
      icon: <Icons.MapPin size={14} />,
    },
  ].filter((row) => row.value.trim().length > 0)

  return (
    <PortalShell {...frame} card={false}>
      {/*
       * ── IDENTITY AND THE HEADLINE NUMBERS SHARE ONE ROW ─────────────────
       *
       * Who this account belongs to and what it stands at are one question, and
       * a customer opening this page asks both at once. Stacking the name above
       * a full-width strip pushed the balance below the fold on a phone and
       * left a band of empty canvas beside the name on a laptop.
       */}
      <div className="flex items-center gap-3">
        <RowTile label={profile.name} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-ink">{profile.name}</h1>
          <p className="numeric mt-0.5 text-sm text-muted">Account {profile.code}</p>
        </div>
      </div>

      {/* StatStrip rather than a hand-built flex row: StatTile takes no
          className by design, so sizing tiles at the call site would mean the
          kit no longer decides how a stat tile looks. The strip already lays
          them out and collapses to two-up on a phone. */}
      <StatStrip columns={2}>
        {/* The balance carries a TONE, because "you owe money" is an exception
            and "settled" is not. Colour here is the whole signal. */}
        <StatTile
          label={inCredit ? 'In credit' : 'Current balance'}
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
            icon={<Icons.Calendar size={16} />}
          />
        )}
      </StatStrip>

      {/*
       * ── PAYING FROM THE PAGE THAT STATES THE BALANCE ───────────────────
       *
       * The tile above says what the account stands at; this is what to do
       * about it, directly beneath. A customer who reads "you owe R4 320"
       * and has to find the Statement tab to act on it has been told a fact
       * and denied the response to it.
       *
       * It shows on a SETTLED account too, worded as a top-up. That is the
       * whole reason this page carries the button as well as the statement:
       * a statement is about what is owed, and an account in credit is a
       * legitimate thing to want — it is how a customer on cash terms keeps
       * buying without a card at the counter every time.
       */}
      {ctx.settings.allowPay && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3">
          <p className="text-sm text-muted">
            {owing
              ? 'Settle your balance, or pay part of it, with a card.'
              : 'Pay money onto your account to use against future invoices.'}
          </p>
          <PayAccountButton token={token} balance={profile.balance} />
        </div>
      )}

      <Card>
        {/* "Contact details", not "Your details" — that is the name of the TAB,
            and a card repeating its own tab's title tells the reader nothing
            about what is inside it. */}
        <CardHeader
          icon={<Icons.User size={16} />}
          title="Contact details"
          description="What we have on file for you. Contact us if anything here is wrong."
        />
        <CardBody>
          <dl className="divide-y divide-border">
            {details.map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0"
              >
                {/* A plain definition list rather than SummaryList: that one is
                    a totals panel and right-aligns every value as a number,
                    which turns a postal address into a ragged column. */}
                <dt className="flex w-36 shrink-0 items-center gap-2 text-muted">
                  <span className="text-faint">{row.icon}</span>
                  {row.label}
                </dt>
                <dd className="min-w-0 flex-1 whitespace-pre-line text-ink-2">{row.value}</dd>
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
