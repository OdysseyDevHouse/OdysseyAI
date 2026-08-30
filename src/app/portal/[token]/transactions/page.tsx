import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { customerStatement } from '@/lib/site/customerAuth'
import { portalProfile } from '@/lib/site/portalData'
import { letterheadFor } from '../letterhead'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import LedgerTable from '../LedgerTable'
import { Card, Pagination } from '@/components/ui'
import { pageCountFor } from '@/lib/searchParams'
import { formatMoney } from '@/lib/decimals'
import { documentHref } from '../documents'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Transactions',
  robots: { index: false, follow: false },
}

/** Matches the back office's list default, so both paginate the same way. */
const PAGE_SIZE = 25

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
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { token } = await params
  const { page: pageRaw } = await searchParams
  const ctx = await requireSection(token, 'transactions')

  const [lines, profile, head] = await Promise.all([
    /*
     * The full history rather than open items — this is the activity view, and
     * a settled invoice is exactly what somebody comes here to re-download.
     *
     * Paged in memory rather than in SQL. The running balance is accumulated
     * across the WHOLE ledger by customerStatement, so slicing in the query
     * would give page 2 a balance column that starts from nothing. The cap is
     * 500 lines, which is the read's own ceiling.
     */
    customerStatement(ctx.siteId, ctx.customerId, { openOnly: false, limit: 500 }),
    portalProfile(ctx.siteId, ctx.customerId),
    letterheadFor(ctx.siteId),
  ])

  /*
   * customerStatement returns oldest-first so the running balance accumulates
   * correctly. Reversed for display — the balance on each line still reads as
   * the balance AFTER that line, which is the standard ledger convention.
   */
  const all = [...lines].reverse().map((line) => ({
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

  const pageCount = pageCountFor(all.length, PAGE_SIZE)
  const page = Math.min(Math.max(Number(pageRaw) || 1, 1), Math.max(pageCount, 1))
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <PortalShell
      name={head.name ?? undefined}
      hasLogo={head.hasLogo}
      token={token}
      onSignOut={<SignOutButton token={token} />}
      nav={<PortalNav token={token} active="transactions" settings={ctx.settings} />}
      title="Transactions"
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
        <Pagination
          page={page}
          pageCount={pageCount}
          total={all.length}
          pageSize={PAGE_SIZE}
          hrefFor={(next) =>
            next === 1
              ? `/portal/${token}/transactions`
              : `/portal/${token}/transactions?page=${next}`
          }
        />
      </Card>
    </PortalShell>
  )
}
