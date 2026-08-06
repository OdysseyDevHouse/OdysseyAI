import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import {
  salesSummary,
  salesByDay,
  salesByProduct,
  salesByDepartment,
  salesByCashier,
  salesByTender,
  vatByRate,
  exceptionReport,
  slowMovers,
} from '@/lib/site/salesReports'
import { formatMoney, formatQty } from '@/lib/decimals'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  Card,
  CardHeader,
  StatTile,
  LinkTabs,
  Badge,
  EmptyState,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import RangePicker from './RangePicker'

export const dynamic = 'force-dynamic'

type Tab = 'summary' | 'products' | 'departments' | 'cashiers' | 'tenders' | 'vat' | 'exceptions'

const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'summary', label: 'Summary', icon: <Icons.BarChart size={15} /> },
  { value: 'products', label: 'Products', icon: <Icons.Boxes size={15} /> },
  { value: 'departments', label: 'Departments', icon: <Icons.LayoutGrid size={15} /> },
  { value: 'cashiers', label: 'Cashiers', icon: <Icons.Users size={15} /> },
  { value: 'tenders', label: 'Tenders', icon: <Icons.CreditCard size={15} /> },
  { value: 'vat', label: 'VAT', icon: <Icons.Percent size={15} /> },
  { value: 'exceptions', label: 'Exceptions', icon: <Icons.StatusWarning size={15} /> },
]

/** Default: this month to date — the period a store owner checks most. */
function defaultRange() {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string; sort?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.view')
  const params = await searchParams

  const fallback = defaultRange()
  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : fallback.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : fallback.to,
  }
  const tab = (TABS.find((t) => t.value === params.tab)?.value ?? 'summary') as Tab
  const sort = params.sort === 'profit' || params.sort === 'qty' ? params.sort : 'revenue'

  const summary = await salesSummary(siteId, range)
  const href = hrefBuilder('/reports', params)

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`${range.from} to ${range.to}`}
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Sales (incl.)"
          value={formatMoney(summary.salesIncl)}
          hint={`${summary.documents} invoice${summary.documents === 1 ? '' : 's'}`}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Gross profit"
          value={formatMoney(summary.profit)}
          hint={`${summary.gpPct.toFixed(1)}% GP`}
          tone={summary.profit < 0 ? 'danger' : 'default'}
          icon={<Icons.BarChart size={16} />}
        />
        <StatTile
          label="VAT"
          value={formatMoney(summary.vat)}
          hint="Output tax for the period"
          icon={<Icons.Percent size={16} />}
        />
        <StatTile
          label="Average sale"
          value={formatMoney(summary.averageSale)}
          hint={summary.discount > 0 ? `${formatMoney(summary.discount)} discounted` : undefined}
          icon={<Icons.Receipt size={16} />}
        />
      </div>

      <div className="px-6 pt-4">
        <RangePicker from={range.from} to={range.to} />
      </div>

      <div className="px-6 pt-4">
        <LinkTabs
          items={TABS.map((t) => ({
            ...t,
            href: href({ tab: t.value === 'summary' ? null : t.value, sort: null }),
          }))}
          value={tab}
          aria-label="Report"
        />
      </div>

      <div className="px-6 pt-4 pb-10">
        {tab === 'summary' && <SummaryTab siteId={siteId} range={range} />}
        {tab === 'products' && (
          <ProductsTab siteId={siteId} range={range} sort={sort} href={href} />
        )}
        {tab === 'departments' && <DepartmentsTab siteId={siteId} range={range} />}
        {tab === 'cashiers' && <CashiersTab siteId={siteId} range={range} />}
        {tab === 'tenders' && <TendersTab siteId={siteId} range={range} />}
        {tab === 'vat' && <VatTab siteId={siteId} range={range} />}
        {tab === 'exceptions' && <ExceptionsTab siteId={siteId} range={range} />}
      </div>
    </>
  )
}

type Range = { from: string; to: string }

async function SummaryTab({ siteId, range }: { siteId: number; range: Range }) {
  const [days, slow] = await Promise.all([
    salesByDay(siteId, range),
    slowMovers(siteId, range, 15),
  ])

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="By day" description="Sales and profit, day by day." />
        {days.length === 0 ? (
          <EmptyState title="No sales in this period" hint="Try a wider date range." />
        ) : (
          <Table
            head={['Date', 'Sales', 'Documents', 'Profit']}
            numeric={[false, true, true, true]}
            rows={days.map((d) => [
              d.date,
              formatMoney(d.salesIncl),
              String(d.documents),
              formatMoney(d.profit),
            ])}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Slow movers"
          description="Stock on hand with no sale in this period — money sitting on a shelf."
        />
        {slow.length === 0 ? (
          <EmptyState title="Everything moved" hint="No stocked product went unsold." />
        ) : (
          <Table
            head={['Code', 'Product', 'On hand', 'Stock value']}
            numeric={[false, false, true, true]}
            rows={slow.map((s) => [s.code, s.description, formatQty(s.onHand), formatMoney(s.value)])}
          />
        )}
      </Card>
    </div>
  )
}

async function ProductsTab({
  siteId,
  range,
  sort,
  href,
}: {
  siteId: number
  range: Range
  sort: 'revenue' | 'profit' | 'qty'
  href: (changes: Record<string, string | null>) => string
}) {
  const rows = await salesByProduct(siteId, range, sort, 100)

  return (
    <Card>
      <CardHeader
        title="By product"
        description="Top sellers by revenue and by profit are different lists — check both."
        action={
          <div className="flex gap-3 text-xs">
            {(['revenue', 'profit', 'qty'] as const).map((option) => (
              <Link
                key={option}
                href={href({ sort: option === 'revenue' ? null : option })}
                className={sort === option ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
              >
                {option === 'qty' ? 'Quantity' : option === 'profit' ? 'Profit' : 'Revenue'}
              </Link>
            ))}
          </div>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No sales in this period" />
      ) : (
        <Table
          head={['Code', 'Product', 'Qty', 'Sales', 'Profit', 'GP %']}
          numeric={[false, false, true, true, true, true]}
          rows={rows.map((r) => [
            r.key,
            r.label,
            formatQty(r.qty),
            formatMoney(r.salesIncl),
            formatMoney(r.profit),
            `${r.gpPct.toFixed(1)}%`,
          ])}
        />
      )}
    </Card>
  )
}

async function DepartmentsTab({ siteId, range }: { siteId: number; range: Range }) {
  const rows = await salesByDepartment(siteId, range)
  return (
    <Card>
      <CardHeader title="By department" />
      {rows.length === 0 ? (
        <EmptyState title="No sales in this period" />
      ) : (
        <Table
          head={['Department', 'Qty', 'Sales', 'Profit', 'GP %']}
          numeric={[false, true, true, true, true]}
          rows={rows.map((r) => [
            r.label,
            formatQty(r.qty),
            formatMoney(r.salesIncl),
            formatMoney(r.profit),
            `${r.gpPct.toFixed(1)}%`,
          ])}
        />
      )}
    </Card>
  )
}

async function CashiersTab({ siteId, range }: { siteId: number; range: Range }) {
  const rows = await salesByCashier(siteId, range)
  return (
    <Card>
      <CardHeader title="By cashier" />
      {rows.length === 0 ? (
        <EmptyState title="No sales in this period" />
      ) : (
        <Table
          head={['Cashier', 'Documents', 'Sales', 'Profit', 'GP %']}
          numeric={[false, true, true, true, true]}
          rows={rows.map((r) => [
            r.label,
            String(r.documents),
            formatMoney(r.salesIncl),
            formatMoney(r.profit),
            `${r.gpPct.toFixed(1)}%`,
          ])}
        />
      )}
    </Card>
  )
}

async function TendersTab({ siteId, range }: { siteId: number; range: Range }) {
  const rows = await salesByTender(siteId, range)
  return (
    <Card>
      <CardHeader
        title="By tender"
        description="What money arrived — reconcile this against the bank and the drawer. It does not equal sales: a credited sale left on an account moves no money."
      />
      {rows.length === 0 ? (
        <EmptyState title="Nothing taken in this period" />
      ) : (
        <Table
          head={['Tender', 'In the drawer', 'Transactions', 'Amount']}
          numeric={[false, false, true, true]}
          rows={rows.map((r) => [
            r.tenderName,
            r.countsAsDrawerCash ? 'Yes' : 'Bank',
            String(r.transactions),
            formatMoney(r.amount),
          ])}
        />
      )}
    </Card>
  )
}

async function VatTab({ siteId, range }: { siteId: number; range: Range }) {
  const rows = await vatByRate(siteId, range)
  return (
    <Card>
      <CardHeader
        title="VAT by rate"
        description="Grouped by the rate stored on each line, so a rate change cannot restate a return already filed."
      />
      {rows.length === 0 ? (
        <EmptyState title="No sales in this period" />
      ) : (
        <Table
          head={['Rate', 'Excluding VAT', 'VAT', 'Including VAT']}
          numeric={[false, true, true, true]}
          rows={rows.map((r) => [
            r.ratePct === 0 ? 'Zero-rated' : `${r.ratePct}%`,
            formatMoney(r.excl),
            formatMoney(r.vat),
            formatMoney(r.incl),
          ])}
        />
      )}
    </Card>
  )
}

async function ExceptionsTab({ siteId, range }: { siteId: number; range: Range }) {
  const rows = await exceptionReport(siteId, range)
  return (
    <Card>
      <CardHeader
        title="Cancellations, discounts and returns by cashier"
        description="None of these is wrong on its own. Someone far outside their colleagues' numbers is the pattern worth a conversation."
      />
      {rows.length === 0 ? (
        <EmptyState title="Nothing to report" hint="No cancellations, discounts or credits in this period." />
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Cashier</th>
                <th className={`${TABLE_TH} text-right`}>Cancelled</th>
                <th className={`${TABLE_TH} text-right`}>Cancelled value</th>
                <th className={`${TABLE_TH} text-right`}>Discounts</th>
                <th className={`${TABLE_TH} text-right`}>Credits</th>
                <th className={`${TABLE_TH} text-right`}>No receipt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className={TABLE_ROW}>
                  <td className={TABLE_TD}>{row.userName}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{row.voids || '—'}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {row.voidValue ? formatMoney(row.voidValue) : '—'}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {row.discountValue ? formatMoney(row.discountValue) : '—'}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {row.creditValue ? formatMoney(row.creditValue) : '—'}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {/* The easiest way to take money out of a till: there is no
                        original sale to check the return against. */}
                    {row.noReceiptReturns > 0 ? (
                      <Badge tone="warning">{row.noReceiptReturns}</Badge>
                    ) : (
                      <span className="text-faint">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** A plain report table, wearing the shared skin. */
function Table({
  head,
  rows,
  numeric,
}: {
  head: string[]
  rows: string[][]
  numeric: boolean[]
}) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {head.map((h, i) => (
              <th key={h} className={`${TABLE_TH} ${numeric[i] ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={TABLE_ROW}>
              {row.map((cell, i) => (
                <td key={i} className={`${TABLE_TD} ${numeric[i] ? TABLE_NUMERIC : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
