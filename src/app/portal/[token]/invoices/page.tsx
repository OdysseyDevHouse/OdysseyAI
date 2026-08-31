import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalInvoices } from '@/lib/site/portalData'
import { letterheadFor } from '../letterhead'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import PayAccountButton from '../PayAccountButton'
import InvoiceTable from './InvoiceTable'
import { Card, Icons, Pagination, StatStrip, StatTile } from '@/components/ui'
import { pageCountFor } from '@/lib/searchParams'
import { formatMoney } from '@/lib/decimals'

export const dynamic = 'force-dynamic'

/** Matches the back office's list default, so both paginate the same way. */
const PAGE_SIZE = 25

export const metadata: Metadata = {
  title: 'Invoices',
  robots: { index: false, follow: false },
}

/**
 * What this customer has been invoiced, and what is still owed.
 *
 * ── FINALISED ONLY ─────────────────────────────────────────────────────────
 *
 * portalInvoices filters to finalised documents. A draft is the business still
 * working out what to charge, and showing a customer a figure nobody has issued
 * to them starts an argument about a number that was never a bill.
 *
 * ── DOCUMENTS, NOT THE LEDGER ──────────────────────────────────────────────
 *
 * A list of invoices and what is left on each. The ageing, the running balance
 * and the credit notes live one tab across on the Statement, which is the view
 * built to explain them — this one answers the narrower question "what have you
 * billed me", and keeping it narrow is what makes it quick to scan.
 */
export default async function PortalInvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { token } = await params
  const { page: pageRaw } = await searchParams
  const ctx = await requireSection(token, 'account')

  const [invoices, head] = await Promise.all([
    portalInvoices(ctx.siteId, ctx.customerId),
    letterheadFor(ctx.siteId),
  ])

  const owing = invoices.filter((i) => !i.isPaid)
  const owed = owing.reduce((sum, i) => sum + i.outstanding, 0)

  const pageCount = pageCountFor(invoices.length, PAGE_SIZE)
  const page = Math.min(Math.max(Number(pageRaw) || 1, 1), Math.max(pageCount, 1))
  // The TILES count every invoice, not the page — a total that changed as you
  // paged would be a different fact on every screen.
  const rows = invoices.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <PortalShell
      name={head.name ?? undefined}
      hasLogo={head.hasLogo}
      token={token}
      onSignOut={<SignOutButton token={token} />}
      nav={<PortalNav token={token} active="invoices" settings={ctx.settings} />}
      title="Invoices"
      subtitle="Everything the business has invoiced you for."
      /*
       * ── "PAY THEM ALL" SITS ABOVE THE PER-INVOICE BUTTONS ──────────────
       *
       * The list already offers "Pay it" on every open row, and on an account
       * with several that is the wrong unit of work: each press is its own
       * card payment and its own gateway fee for what the customer thinks of
       * as one debt. This pays the balance in one go and lets the ledger
       * allocate it oldest-first, which is what a payment against a statement
       * has always meant.
       *
       * Only when something is owed. A page of settled invoices has nothing
       * to pay, and the top-up framing belongs on the account page rather
       * than at the head of a list of documents.
       */
      action={
        ctx.settings.allowPay && owed > 0.005 ? (
          <PayAccountButton token={token} balance={owed} label="Pay all" />
        ) : null
      }
      card={false}
    >
      {invoices.length > 0 && (
        <StatStrip columns={2}>
          <StatTile
            label="Outstanding"
            value={formatMoney(owed)}
            // The tone is on the figure that means ACT. When nothing is owing
            // it is a plain number, not a green one — "no exception" is the
            // absence of colour, not another colour.
            tone={owed > 0.005 ? 'warning' : 'default'}
            hint={
              owing.length > 0
                ? `Across ${owing.length} invoice${owing.length === 1 ? '' : 's'}`
                : 'Every invoice is settled'
            }
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Invoices"
            value={String(invoices.length)}
            hint="On your account"
            icon={<Icons.FileText size={16} />}
          />
        </StatStrip>
      )}

      <Card>
        <InvoiceTable
          rows={rows.map((inv) => ({
            id: inv.id,
            documentNumber: inv.documentNumber,
            docDate: inv.docDate,
            total: inv.total,
            outstanding: inv.outstanding,
            isPaid: inv.isPaid,
          }))}
          token={token}
          allowPay={ctx.settings.allowPay}
        />
        <Pagination
          page={page}
          pageCount={pageCount}
          total={invoices.length}
          pageSize={PAGE_SIZE}
          hrefFor={(next) =>
            next === 1 ? `/portal/${token}/invoices` : `/portal/${token}/invoices?page=${next}`
          }
        />
      </Card>
    </PortalShell>
  )
}
