import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSection } from '../guard'
import { customerStatement } from '@/lib/site/customerAuth'
import { portalProfile } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import PayButton from '../invoices/PayButton'
import { Badge, ButtonLink, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { documentHref, DOC_LABEL } from '../documents'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your statement',
  robots: { index: false, follow: false },
}

/**
 * What the customer owes, document by document, with a way to settle it.
 *
 * ── OPEN ITEMS FIRST, EVERYTHING BEHIND A LINK ─────────────────────────────
 *
 * The question this page answers is "what do I still owe you", so it opens on
 * the lines that are still open. The full history is one click away and is also
 * the Transactions tab — kept here as well because somebody who came looking
 * for a statement should not have to know we file the two separately.
 *
 * ── THE PAY BUTTON IS THE EXISTING ONE ─────────────────────────────────────
 *
 * Same component and same action as the Invoices tab, which mints an intent and
 * hands off to /pay. A second payment path is a second place for money to go
 * wrong, so there isn't one.
 */
export default async function PortalStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ all?: string }>
}) {
  const { token } = await params
  const { all } = await searchParams
  const ctx = await requireSection(token, 'statement')

  const showAll = all === '1'

  const [lines, profile, name] = await Promise.all([
    customerStatement(ctx.siteId, ctx.customerId, { openOnly: !showAll, limit: 200 }),
    portalProfile(ctx.siteId, ctx.customerId),
    publicSiteName(ctx.siteId).catch(() => null),
  ])

  const balance = profile?.balance ?? 0

  return (
    <PortalShell
      name={name ?? undefined}
      nav={
        <PortalNav
          token={token}
          active="statement"
          settings={ctx.settings}
          onSignOut={<SignOutButton token={token} />}
        />
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Your statement</h1>
          <p className="mt-0.5 text-sm text-muted">
            Balance{' '}
            <span className="numeric font-semibold text-ink">
              {formatMoney(Math.abs(balance))}
            </span>
            {balance < -0.005 && ' in credit'}
          </p>
        </div>
        {/* A real download rather than browser print: this is the document a
            customer forwards to their own bookkeeper, and it goes out on the
            shop's stationery. */}
        <ButtonLink href={`/portal/${token}/statement/pdf`} variant="secondary" size="sm">
          Download PDF
        </ButtonLink>
      </div>

      <div className="mt-4 flex gap-3 text-sm">
        <Link
          href={`/portal/${token}/statement`}
          className={showAll ? 'text-brand hover:underline' : 'font-semibold text-ink'}
        >
          Still owing
        </Link>
        <Link
          href={`/portal/${token}/statement?all=1`}
          className={showAll ? 'font-semibold text-ink' : 'text-brand hover:underline'}
        >
          Everything
        </Link>
      </div>

      {lines.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Icons.Receipt size={22} />}
            title={showAll ? 'Nothing on the account yet' : 'Nothing owing'}
            hint={
              showAll
                ? 'Invoices and payments will show up here.'
                : 'Every invoice on your account is settled.'
            }
          />
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-border">
          {lines.map((line) => {
            const href = documentHref(token, line)
            const open = line.amountOutstanding > 0.005
            return (
              <li
                key={line.transactionId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="numeric block text-sm font-medium text-ink">
                    {line.docNumber || DOC_LABEL[line.docType] || line.docType}
                  </span>
                  <span className="block text-xs text-muted">
                    {line.docDate}
                    {line.dueDate ? ` · due ${line.dueDate}` : ''} ·{' '}
                    {DOC_LABEL[line.docType] ?? line.docType}
                  </span>
                </span>

                {/* ── THE BADGE SAYS WHAT THE AMOUNT CANNOT ──────────────────
                    It used to repeat the outstanding figure beside the amount
                    it equalled on every untouched invoice — noise that also
                    buried the one line worth a second look. It now carries the
                    PART-PAID figure, which is the only case where "what this
                    was" and "what is left" differ.

                    On the "Everything" view a bare "Open" still earns its
                    place, because settled and unsettled lines sit together and
                    nothing else distinguishes them. */}
                {open &&
                  (Math.abs(line.amountOutstanding - line.amountSigned) > 0.005 ? (
                    <Badge tone="warning">{formatMoney(line.amountOutstanding)} left</Badge>
                  ) : showAll ? (
                    <Badge tone="warning">Open</Badge>
                  ) : null)}

                <span className="numeric text-sm font-medium text-ink">
                  {line.amountSigned < 0 ? '−' : ''}
                  {formatMoney(Math.abs(line.amountSigned))}
                </span>

                {href && (
                  <Link href={href} className="text-xs text-brand hover:underline">
                    PDF
                  </Link>
                )}

                {/* Only an invoice can be paid, and only one that came from a
                    sales document — an interest charge has nothing to settle
                    against. sourceDocId is what payLinkFor looks up. */}
                {ctx.settings.allowPay && open && line.docType === 'invoice' && line.sourceDocId && (
                  <PayButton token={token} documentId={line.sourceDocId} />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PortalShell>
  )
}
