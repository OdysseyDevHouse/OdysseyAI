import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { costReport, listPayPeriods, payLinesFor, getPayPeriod } from '@/lib/site/staffCost'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import CostScreen from './CostScreen'

export const dynamic = 'force-dynamic'

/** The first and last day of the month a date falls in. */
function monthOf(d: Date): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const iso = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
  return { from: iso(first), to: iso(last) }
}

/**
 * What each person costs, and what they brought in.
 *
 * Defaults to LAST month rather than this one: a part-month cost is a number
 * nobody can act on, and somebody opening this screen is nearly always about
 * to pay for the month just finished.
 *
 * A locked period reads its frozen lines; anything else is computed live.
 */
export default async function CostPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}) {
  const { site, capabilities } = await requireSiteUser()

  // `staff.cost` alone, not view_all: this screen is money from top to bottom,
  // and somebody who may see who worked Saturday has no business here.
  if (!can(capabilities, 'staff.cost')) redirect('/not-allowed')

  const params = await searchParams
  const iso = /^\d{4}-\d{2}-\d{2}$/

  const lastMonth = monthOf(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
  const periodId = params.period && /^\d+$/.test(params.period) ? Number(params.period) : null

  const [periods, selected] = await Promise.all([
    listPayPeriods(site.id),
    periodId ? getPayPeriod(site.id, periodId) : Promise.resolve(null),
  ])

  // A selected period drives the range; otherwise the query string does.
  const from = selected?.periodStart ?? (iso.test(params.from ?? '') ? params.from! : lastMonth.from)
  const to = selected?.periodEnd ?? (iso.test(params.to ?? '') ? params.to! : lastMonth.to)

  // Locked reads what was frozen. Everything else is live, so a corrected
  // clock-out corrects the cost.
  const report =
    selected?.status === 'locked'
      ? {
          from,
          to,
          lines: await payLinesFor(site.id, selected.id, true),
          totalCost: selected.totalCost,
          totalRevenue: 0,
          totalProfit: 0,
        }
      : await costReport(site.id, from, to, true)

  // A frozen report has no header revenue, so it is summed from the lines.
  if (selected?.status === 'locked') {
    report.totalRevenue = report.lines.reduce((s, l) => s + l.revenueSold, 0)
    report.totalProfit = report.lines.reduce((s, l) => s + l.grossProfit, 0)
  }

  const missingRates = report.lines.filter((l) => l.noRateOnFile)

  return (
    <>
      <PageHeader
        title="Cost per employee"
        subtitle={
          selected
            ? `${from} to ${to} — ${selected.status === 'locked' ? 'locked' : 'open'} period`
            : `${from} to ${to}`
        }
      />

      <PageBody>
        {missingRates.length > 0 && (
          <Callout
            tone="warning"
            title={`${missingRates.length} ${missingRates.length === 1 ? 'person has' : 'people have'} no pay rate on file`}
          >
            {missingRates.map((l) => l.userName).join(', ')} worked in this period but cannot be
            costed. Add their terms under Staff → People, then calculate again.
          </Callout>
        )}

        <CostScreen
          report={report}
          periods={periods}
          selectedPeriodId={selected?.id ?? null}
          selectedStatus={selected?.status ?? null}
          from={from}
          to={to}
          canRun={can(capabilities, 'staff.run')}
        />
      </PageBody>
    </>
  )
}
