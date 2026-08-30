import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalInvoices } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import InvoiceTable from './InvoiceTable'
import { Card, Icons, StatStrip, StatTile } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your invoices',
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
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const ctx = await requireSection(token, 'account')

  const [invoices, name] = await Promise.all([
    portalInvoices(ctx.siteId, ctx.customerId),
    publicSiteName(ctx.siteId).catch(() => null),
  ])

  const owing = invoices.filter((i) => !i.isPaid)
  const owed = owing.reduce((sum, i) => sum + i.outstanding, 0)

  return (
    <PortalShell
      name={name ?? undefined}
      nav={
        <PortalNav
          token={token}
          active="invoices"
          settings={ctx.settings}
          onSignOut={<SignOutButton token={token} />}
        />
      }
      title="Your invoices"
      subtitle="Everything the business has invoiced you for."
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
          rows={invoices.map((inv) => ({
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
      </Card>
    </PortalShell>
  )
}
