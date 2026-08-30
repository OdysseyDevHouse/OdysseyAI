import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { customerStatement } from '@/lib/site/customerAuth'
import { portalProfile } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import LedgerTable from '../LedgerTable'
import { Card } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { documentHref } from '../documents'

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

  const [lines, profile, name] = await Promise.all([
    // The full history rather than open items: this is the activity view, and
    // a settled invoice is exactly what somebody comes here to re-download.
    customerStatement(ctx.siteId, ctx.customerId, { openOnly: false, limit: 200 }),
    portalProfile(ctx.siteId, ctx.customerId),
    publicSiteName(ctx.siteId).catch(() => null),
  ])

  /*
   * customerStatement returns oldest-first so the running balance accumulates
   * correctly. Reversed for display — the balance on each line still reads as
   * the balance AFTER that line, which is the standard ledger convention.
   */
  const rows = [...lines].reverse().map((line) => ({
    transactionId: line.transactionId,
    docType: line.docType,
    docNumber: line.docNumber,
    docDate: line.docDate,
    dueDate: line.dueDate,
    amountSigned: line.amountSigned,
    amountOutstanding: line.amountOutstanding,
    runningBalance: line.runningBalance,
    href: documentHref(token, line),
    sourceDocId: line.sourceDocId,
  }))

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
      title="Your transactions"
      subtitle={
        profile
          ? `Everything on your account, most recent first. Balance ${formatMoney(profile.balance)}.`
          : 'Everything on your account, most recent first.'
      }
      card={false}
    >
      <Card>
        <LedgerTable
          rows={rows}
          token={token}
          showBalance
          emptyTitle="Nothing on the account yet"
          emptyHint="Invoices, payments and credits will show up here."
        />
      </Card>
    </PortalShell>
  )
}
