import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
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
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  StatTile,
  StatStrip,
  LinkTabs,
  LinkSegmentedControl,
  ButtonLink,
  Icons,
} from '@/components/ui'
import RangePicker from './RangePicker'
import {
  DayTable,
  SlowMoversTable,
  ProductsTable,
  DepartmentsTable,
  CashiersTable,
  TendersTable,
  VatTable,
  ExceptionsTable,
} from './ReportTables'

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
  const { siteId, capabilities } = await requireCapability('reports.view')
  // Turnover and margin are different permissions: reports.view opens the
  // screen, reports.financial is what shows profit on it.
  const showProfit = can(capabilities, 'reports.financial')
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
  // The way out of an empty report: drop the date filter back to this month.
  const resetHref = href({ from: null, to: null })

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`${range.from} to ${range.to}`}
      />

      <PageBody>
        <StatStrip>
          <StatTile
            label="Sales (incl.)"
            value={formatMoney(summary.salesIncl)}
            hint={`${summary.documents} invoice${summary.documents === 1 ? '' : 's'}`}
            icon={<Icons.Coins size={16} />}
          />
          {showProfit && (
            <StatTile
              label="Gross profit"
              value={formatMoney(summary.profit)}
              hint={`${summary.gpPct.toFixed(1)}% GP`}
              tone={summary.profit < 0 ? 'danger' : 'default'}
              icon={<Icons.BarChart size={16} />}
            />
          )}
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
        </StatStrip>

        <RangePicker from={range.from} to={range.to} />

        <LinkTabs
          items={TABS.map((t) => ({
            ...t,
            href: href({ tab: t.value === 'summary' ? null : t.value, sort: null }),
          }))}
          value={tab}
          aria-label="Report"
        />

        {tab === 'summary' && <SummaryTab siteId={siteId} range={range} resetHref={resetHref} showProfit={showProfit} />}
        {tab === 'products' && (
          <ProductsTab siteId={siteId} range={range} sort={sort} href={href} resetHref={resetHref} showProfit={showProfit} />
        )}
        {tab === 'departments' && (
          <DepartmentsTab siteId={siteId} range={range} resetHref={resetHref} showProfit={showProfit} />
        )}
        {tab === 'cashiers' && <CashiersTab siteId={siteId} range={range} resetHref={resetHref} showProfit={showProfit} />}
        {tab === 'tenders' && <TendersTab siteId={siteId} range={range} resetHref={resetHref} />}
        {tab === 'vat' && <VatTab siteId={siteId} range={range} resetHref={resetHref} />}
        {tab === 'exceptions' && <ExceptionsTab siteId={siteId} range={range} />}
      </PageBody>
    </>
  )
}

type Range = { from: string; to: string }

/** The action every "no sales" empty offers: back to this month's figures. */
function resetAction(resetHref: string) {
  return (
    <ButtonLink href={resetHref} variant="secondary">
      Show this month
    </ButtonLink>
  )
}

async function SummaryTab({
  siteId,
  range,
  resetHref,
  showProfit,
}: {
  siteId: number
  range: Range
  resetHref: string
  showProfit: boolean
}) {
  const [days, slow] = await Promise.all([
    salesByDay(siteId, range),
    slowMovers(siteId, range, 15),
  ])

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="By day" description="Sales and profit, day by day." />
        <DayTable showProfit={showProfit}
          rows={days}
          empty={{
            title: 'No sales in this period',
            hint: 'Try a wider date range, or go back to this month.',
            icon: <Icons.BarChart size={28} strokeWidth={1.75} />,
            action: resetAction(resetHref),
          }}
        />
      </Card>

      <Card>
        <CardHeader
          title="Slow movers"
          description="Stock on hand with no sale in this period — money sitting on a shelf."
        />
        <SlowMoversTable
          rows={slow}
          empty={{
            title: 'Everything moved',
            hint: 'No stocked product went unsold.',
            icon: <Icons.Boxes size={28} strokeWidth={1.75} />,
          }}
        />
      </Card>
    </div>
  )
}

async function ProductsTab({
  siteId,
  range,
  sort,
  href,
  resetHref,
  showProfit,
}: {
  siteId: number
  range: Range
  sort: 'revenue' | 'profit' | 'qty'
  href: (changes: Record<string, string | null>) => string
  resetHref: string
  showProfit: boolean
}) {
  const rows = await salesByProduct(siteId, range, sort, 100)

  return (
    <Card>
      <CardHeader
        title="By product"
        description="Top sellers by revenue and by profit are different lists — check both."
        action={
          <LinkSegmentedControl
            aria-label="Rank products by"
            value={sort}
            options={[
              { value: 'revenue', label: 'Revenue', href: href({ sort: null }) },
              { value: 'profit', label: 'Profit', href: href({ sort: 'profit' }) },
              { value: 'qty', label: 'Quantity', href: href({ sort: 'qty' }) },
            ]}
          />
        }
      />
      <ProductsTable showProfit={showProfit}
        rows={rows}
        empty={{
          title: 'No sales in this period',
          hint: 'Nothing was sold between these dates.',
          icon: <Icons.Boxes size={28} strokeWidth={1.75} />,
          action: resetAction(resetHref),
        }}
      />
    </Card>
  )
}

async function DepartmentsTab({
  siteId,
  range,
  resetHref,
  showProfit,
}: {
  siteId: number
  range: Range
  resetHref: string
  showProfit: boolean
}) {
  const rows = await salesByDepartment(siteId, range)
  return (
    <Card>
      <CardHeader title="By department" />
      <DepartmentsTable showProfit={showProfit}
        rows={rows}
        empty={{
          title: 'No sales in this period',
          hint: 'Nothing was sold between these dates.',
          icon: <Icons.LayoutGrid size={28} strokeWidth={1.75} />,
          action: resetAction(resetHref),
        }}
      />
    </Card>
  )
}

async function CashiersTab({
  siteId,
  range,
  resetHref,
  showProfit,
}: {
  siteId: number
  range: Range
  resetHref: string
  showProfit: boolean
}) {
  const rows = await salesByCashier(siteId, range)
  return (
    <Card>
      <CardHeader title="By cashier" />
      <CashiersTable showProfit={showProfit}
        rows={rows}
        empty={{
          title: 'No sales in this period',
          hint: 'Nothing was sold between these dates.',
          icon: <Icons.Users size={28} strokeWidth={1.75} />,
          action: resetAction(resetHref),
        }}
      />
    </Card>
  )
}

async function TendersTab({
  siteId,
  range,
  resetHref,
}: {
  siteId: number
  range: Range
  resetHref: string
}) {
  const rows = await salesByTender(siteId, range)
  return (
    <Card>
      <CardHeader
        title="By tender"
        description="What money arrived — reconcile this against the bank and the drawer. It does not equal sales: a credited sale left on an account moves no money."
      />
      <TendersTable
        rows={rows}
        empty={{
          title: 'Nothing taken in this period',
          hint: 'No payment of any kind landed between these dates.',
          icon: <Icons.CreditCard size={28} strokeWidth={1.75} />,
          action: resetAction(resetHref),
        }}
      />
    </Card>
  )
}

async function VatTab({
  siteId,
  range,
  resetHref,
}: {
  siteId: number
  range: Range
  resetHref: string
}) {
  const rows = await vatByRate(siteId, range)
  return (
    <Card>
      <CardHeader
        title="VAT by rate"
        description="Grouped by the rate stored on each line, so a rate change cannot restate a return already filed."
      />
      <VatTable
        rows={rows}
        empty={{
          title: 'No sales in this period',
          hint: 'Nothing was sold between these dates.',
          icon: <Icons.Percent size={28} strokeWidth={1.75} />,
          action: resetAction(resetHref),
        }}
      />
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
      <ExceptionsTable
        rows={rows}
        empty={{
          title: 'Nothing to report',
          hint: 'No cancellations, discounts or credits in this period.',
          icon: <Icons.StatusWarning size={28} strokeWidth={1.75} />,
        }}
      />
    </Card>
  )
}
