import { requireCapability } from '@/lib/auth'
import { buildVatReturn, vatPeriods } from '@/lib/site/vatReturn'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder } from '@/lib/searchParams'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  LinkTabs,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * The VAT return.
 *
 * Output VAT has been reportable since sales shipped; input VAT never has been,
 * despite being captured on every GRV. This screen is mostly about the
 * subtraction between them — the step a bookkeeper otherwise does by hand every
 * two months, and the one nobody checks.
 *
 * The headline is net payable, and the warnings sit directly beneath it rather
 * than at the bottom: a draft invoice inside the period changes the figure, and
 * finding that out after filing is the expensive outcome.
 */
export default async function VatReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const params = await searchParams

  // Default to the current two-month period, which is what a vendor is usually
  // looking at when they open this.
  const now = today()
  const year = Number(now.slice(0, 4))
  const presets = vatPeriods(year, 'A')
  const currentPeriod = presets.find((p) => p.from <= now && p.to >= now) ?? presets[0]

  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : currentPeriod.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : currentPeriod.to,
  }

  const vat = await buildVatReturn(siteId, range)
  const href = hrefBuilder('/accounting/vat', params)

  if (!vat) {
    return (
      <>
        <PageHeader title="VAT return" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="That period is not valid"
                hint="Choose a start date on or before the end date."
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  const refundDue = vat.netPayable < 0

  return (
    <>
      <PageHeader
        title="VAT return"
        subtitle={`${range.from} to ${range.to}${vat.vatNumber ? ` · VAT ${vat.vatNumber}` : ''}`}
      />

      <PageBody>
        {/* The two-month VAT periods a Category A vendor files against. Offered
            as presets so nobody types a period boundary by hand — an off-by-one
            day moves a document between returns. */}
        <LinkTabs
          items={presets.map((p) => ({
            value: `${p.from}:${p.to}`,
            label: `${MONTH_LABELS[Number(p.from.slice(5, 7)) - 1]}–${MONTH_LABELS[Number(p.to.slice(5, 7)) - 1]}`,
            href: href({ from: p.from, to: p.to }),
          }))}
          value={`${range.from}:${range.to}`}
          aria-label="VAT period"
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Output VAT"
            value={formatMoney(vat.outputTotal.vat)}
            hint="Charged on sales"
          />
          <StatTile
            label="Input VAT"
            value={formatMoney(vat.inputTotal.vat)}
            hint="Paid on purchases"
          />
          <StatTile
            label={refundDue ? 'Refund due' : 'Payable to SARS'}
            value={formatMoney(Math.abs(vat.netPayable))}
            tone={refundDue ? 'positive' : 'warning'}
            hint={refundDue ? 'Input exceeded output' : 'Output less input'}
          />
          <StatTile
            label="Zero-rated sales"
            value={formatMoney(vat.zeroRatedSales)}
            hint="Excluded from the VAT above"
          />
        </div>

        {/* Warnings sit high because each one changes the figure above. */}
        {vat.warnings.length > 0 && (
          <Card>
            <CardHeader
              title="Check these before filing"
              description="Each of these can change the figures above."
            />
            <CardBody>
              <ul className="space-y-2">
                {vat.warnings.map((w, i) => (
                  <li
                    key={i}
                    className="rounded-control bg-warning-soft px-3 py-2 text-sm text-warning-ink"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <RateTable
            title="Output VAT — sales"
            description="Net of credit notes issued in the period."
            rows={vat.outputByRate}
            total={vat.outputTotal}
            emptyHint="No sales were invoiced in this period."
          />
          <RateTable
            title="Input VAT — purchases"
            description="Net of supplier returns in the period."
            rows={vat.inputByRate}
            total={vat.inputTotal}
            emptyHint="No supplier invoices were finalised in this period."
          />
        </div>

        <Card>
          <CardHeader
            title="Summary"
            description="What goes on the return, and what it nets to."
          />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Line label="Output VAT — charged on sales" value={vat.outputTotal.vat} />
              <Line
                label="  of which credit notes reversed"
                value={-vat.salesCreditNotes.vat}
                muted
              />
              <Line label="Input VAT — paid on purchases" value={-vat.inputTotal.vat} />
              {vat.purchaseReturns.vat !== 0 && (
                <Line
                  label="  of which supplier returns reversed"
                  value={vat.purchaseReturns.vat}
                  muted
                />
              )}
              <div className="border-t border-border pt-2">
                <Line
                  label={refundDue ? 'Refund due from SARS' : 'Payable to SARS'}
                  value={Math.abs(vat.netPayable)}
                  strong
                />
              </div>
            </dl>

            <p className="mt-4 text-xs text-muted">
              These figures come from the documents captured in this system on the invoice basis
              — VAT is accounted for when a document is issued, not when it is paid. Anything
              that never passed through here (an accountant&apos;s journal, an apportionment for
              private use, an asset bought privately) is not included. Check them against your
              records before filing.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

function RateTable({
  title,
  description,
  rows,
  total,
  emptyHint,
}: {
  title: string
  description: string
  rows: { ratePct: number; excl: number; vat: number; incl: number }[]
  total: { excl: number; vat: number; incl: number }
  emptyHint: string
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {rows.length === 0 ? (
        <CardBody>
          <EmptyState title="Nothing in this period" hint={emptyHint} />
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Rate</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Excluding</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>VAT</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Including</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ratePct} className={TABLE_ROW}>
                  <td className={TABLE_TD}>{r.ratePct}%</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.excl)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.vat)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.incl)}</td>
                </tr>
              ))}
              <tr className={TABLE_TOTAL_ROW}>
                <td className={TABLE_TD}>Total</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(total.excl)}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(total.vat)}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(total.incl)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Line({
  label,
  value,
  strong,
  muted,
}: {
  label: string
  value: number
  strong?: boolean
  muted?: boolean
}) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-muted' : strong ? 'font-medium text-ink' : 'text-ink-2'}>
        {label}
      </dt>
      <dd
        className={`numeric ${strong ? 'text-base font-semibold text-ink' : muted ? 'text-muted' : 'text-ink-2'}`}
      >
        {formatMoney(value)}
      </dd>
    </div>
  )
}
