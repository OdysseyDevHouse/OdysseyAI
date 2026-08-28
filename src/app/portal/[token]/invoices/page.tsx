import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalInvoices } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import PayButton from './PayButton'
import { Badge, EmptyState, Icons } from '@/components/ui'
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
 * ── NO STATEMENT, NO BALANCE, NO AGEING ────────────────────────────────────
 *
 * Deliberately. A running balance brings in credit limits, interest, allocations
 * and unapplied credits — each of which needs its own decision about what a
 * customer may see and how it reads without a person to explain it. A list of
 * invoices with what is left on each is the honest, useful subset.
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
        <PortalNav token={token} active="invoices" settings={ctx.settings} onSignOut={<SignOutButton token={token} />} />
      }
    >
      <h1 className="text-xl font-semibold text-ink">Your invoices</h1>

      {invoices.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Icons.FileText size={22} />}
            title="No invoices yet"
            hint="Anything the business invoices you for will appear here."
          />
        </div>
      ) : (
        <>
          {owing.length > 0 && (
            <p className="mt-1 text-sm text-muted">
              <span className="numeric text-ink">{formatMoney(owed)}</span> outstanding across{' '}
              {owing.length} invoice{owing.length === 1 ? '' : 's'}.
            </p>
          )}

          <ul className="mt-5 divide-y divide-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-ink">
                    {inv.documentNumber ?? `Invoice ${inv.id}`}
                  </span>
                  <span className="block text-xs text-muted">{inv.docDate}</span>
                </span>
                <span className="numeric text-sm text-ink">{formatMoney(inv.total)}</span>
                {inv.isPaid ? (
                  <Badge tone="success">Paid</Badge>
                ) : (
                  <>
                    <Badge tone="warning">{formatMoney(inv.outstanding)} owing</Badge>
                    {/* Hands off to the payment flow that already exists rather
                        than building a second one. */}
                    {ctx.settings.allowPay && <PayButton token={token} documentId={inv.id} />}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </PortalShell>
  )
}
