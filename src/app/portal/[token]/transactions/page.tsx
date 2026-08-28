import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSection } from '../guard'
import { customerStatement } from '@/lib/site/customerAuth'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import { Badge, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { documentHref, DOC_LABEL } from '../documents'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your transactions',
  robots: { index: false, follow: false },
}

/**
 * Everything that has moved on this account, newest first.
 *
 * ── THE WHOLE LEDGER, NOT JUST INVOICES ────────────────────────────────────
 *
 * The Invoices tab answers "what have you billed me". This answers "what has
 * happened on my account" — payments, credit notes, interest and write-offs
 * included. A customer reconciling their own books needs the credits as much as
 * the debits, and an invoice-only list is why they ring to ask whether a
 * payment landed.
 *
 * ── EVERY LINE THAT HAS PAPER OFFERS IT ───────────────────────────────────
 *
 * A tax invoice, a credit note and a receipt are all documents the customer is
 * entitled to a copy of, and the reason they open this page at all is usually
 * to fetch one. `documentHref` decides which line has what, in one place, so
 * this page and the statement cannot disagree about it.
 */
export default async function PortalTransactionsPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const ctx = await requireSection(token, 'transactions')

  const [lines, name] = await Promise.all([
    // The full history rather than open items: this is the activity view, and
    // a settled invoice is exactly what somebody comes here to re-download.
    customerStatement(ctx.siteId, ctx.customerId, { openOnly: false, limit: 200 }),
    publicSiteName(ctx.siteId).catch(() => null),
  ])

  return (
    <PortalShell
      name={name ?? undefined}
      nav={
        <PortalNav
          token={token}
          active="transactions"
          settings={ctx.settings}
          onSignOut={<SignOutButton token={token} />}
        />
      }
    >
      <h1 className="text-xl font-semibold text-ink">Your transactions</h1>
      <p className="mt-0.5 text-sm text-muted">
        Everything on your account, most recent first.
      </p>

      {lines.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Icons.Receipt size={22} />}
            title="Nothing on the account yet"
            hint="Invoices, payments and credits will show up here."
          />
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-border">
          {/* customerStatement returns oldest-first so the running balance
              accumulates correctly. Reversed for display only — the balance on
              each line still reads as the balance AFTER that line. */}
          {[...lines].reverse().map((line) => {
            const href = documentHref(token, line)
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
                    {line.docDate} · {DOC_LABEL[line.docType] ?? line.docType}
                    {line.dueDate ? ` · due ${line.dueDate}` : ''}
                  </span>
                </span>

                {/* "Open", or the part-paid figure when it differs from the
                    amount already shown beside it. Repeating an identical
                    number twice on a row taught the reader nothing — see the
                    same call on the statement. */}
                {line.amountOutstanding > 0.005 &&
                  (Math.abs(line.amountOutstanding - line.amountSigned) > 0.005 ? (
                    <Badge tone="warning">{formatMoney(line.amountOutstanding)} left</Badge>
                  ) : (
                    <Badge tone="warning">Open</Badge>
                  ))}

                <span className="text-right">
                  {/* Signed, so a payment reads as a credit rather than as
                      another charge — the sign is the whole meaning here. */}
                  <span className="numeric block text-sm font-medium text-ink">
                    {line.amountSigned < 0 ? '−' : ''}
                    {formatMoney(Math.abs(line.amountSigned))}
                  </span>
                  <span className="numeric block text-xs text-muted">
                    bal {formatMoney(line.runningBalance)}
                  </span>
                </span>

                {href ? (
                  <Link href={href} className="text-xs text-brand hover:underline">
                    PDF
                  </Link>
                ) : (
                  // A fixed-width blank keeps the money column from jumping
                  // between rows that have paper and rows that do not.
                  <span className="w-7" aria-hidden />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PortalShell>
  )
}
