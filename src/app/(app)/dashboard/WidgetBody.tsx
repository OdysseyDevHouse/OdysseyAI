'use client'

import type { ReactNode } from 'react'
import { EmptyState, Icons, Skeleton } from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import type { DashboardOverview } from '@/lib/site/dashboardOverview'
import type { WidgetId } from './widgets'
import {
  SalesPerHourChart,
  SalesCountPerDayChart,
  TenderMixChart,
  TurnoverPerDayChart,
} from './Charts'
import { RankedTable, TABLE_CONFIG } from './RankedTable'
import { ExceptionsTable } from './ExceptionsTable'
import { perDayTakeaway, perHourTakeaway, secondaryStats } from './insights'
import { SecondaryStrip } from './SecondaryStrip'
import {
  AttentionList,
  CashPositionPanel,
  PipelinePanel,
  ReorderTable,
  JobStat,
  JobSplit,
} from './OverviewWidgets'

/**
 * What goes INSIDE a dashboard widget, for every widget there is.
 *
 * Extracted from SalesDashboard so the phone can show the same figures without
 * inheriting the desktop's drag-and-resize grid. That grid is not merely
 * decorative on a small screen — it is sixty columns wide with a single
 * breakpoint, so at 390px it hands the narrowest widget one pixel and pushes six
 * of them off the side. The phone therefore stacks instead, and calls this.
 *
 * The extraction matters more than the stacking. Two copies of this switch would
 * be two answers to what the shop turned over, and the copy that drifts is
 * always the one nobody is looking at. There is one, and both screens read it.
 *
 * Deliberately presentational: it takes the two payloads and returns a body. No
 * fetching, no permission logic — both callers have already decided which
 * widgets they may show, and the SERVER decided what it would put on the wire.
 */

export type WidgetData = {
  data: SalesDashboardData
  overview: DashboardOverview | null
  overviewError: string | null
}

export function widgetBody(id: WidgetId, { data, overview, overviewError }: WidgetData) {
    switch (id) {
      case 'rates':
        return <SecondaryStrip data={data} />
      case 'perHour':
        return (
          /* The hour chart plots an AVERAGE day, so it needs to know how many
             days it is averaging over. Measured here from the same buckets
             rather than passed down from the strip, so the two cannot drift. */
          <ChartWithTakeaway takeaway={perHourTakeaway(data.perHour, tradingDays(data))}>
            <SalesPerHourChart data={data.perHour} tradingDays={tradingDays(data)} />
          </ChartWithTakeaway>
        )
      case 'perDay':
        return (
          <ChartWithTakeaway takeaway={perDayTakeaway(data.perDay)}>
            <TurnoverPerDayChart data={data.perDay} />
          </ChartWithTakeaway>
        )
      case 'countPerDay':
        return <SalesCountPerDayChart data={data.perDay} />
      case 'tenderTypes':
        return <TenderMixChart data={data.tenderTypes} />
      case 'topProducts':
        return <RankedTable rows={data.topProducts} config={TABLE_CONFIG.products} />
      case 'topDepartments':
        return <RankedTable rows={data.topDepartments} config={TABLE_CONFIG.departments} />
      case 'topCashiers':
        return <RankedTable rows={data.topCashiers} config={TABLE_CONFIG.cashiers} />
      case 'voidsAndReturns':
        return <ExceptionsTable rows={data.exceptions} />

      /* The as-at half. A null section means the user may not see it — the
         server never put it on the wire — so the widget says so rather than
         rendering an empty box that looks like a zero. */
      case 'attention':
        return overview ? <AttentionList items={overview.attention} /> : notAllowed(overviewError, overview !== null)
      case 'debtorsAgeing':
        return overview?.debtors ? (
          <div className="p-4">
            <AgeingStrip
              aging={overview.debtors}
              hrefFor={(bucket) => `/customers/age-analysis?bucket=${bucket}`}
            />
          </div>
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'creditorsAgeing':
        return overview?.creditors ? (
          <div className="p-4">
            <AgeingStrip
              aging={overview.creditors}
              hrefFor={(bucket) => `/suppliers/age-analysis?bucket=${bucket}`}
            />
          </div>
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'cashPosition':
        return overview?.cash ? (
          <CashPositionPanel cash={overview.cash} />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'pipeline':
        return overview?.pipeline ? (
          <PipelinePanel pipeline={overview.pipeline} />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'reorder':
        return overview?.reorder ? (
          <ReorderTable reorder={overview.reorder} />
        ) : (
          notAllowed(overviewError, overview !== null)
        )

      /* ── Job cards ────────────────────────────────────────────────────────
         Every figure links to the list filtered to itself — the PRD requires
         it, and a count nobody can open is a count nobody reads. */
      case 'jobsOpen':
        return overview?.jobs ? (
          <JobStat label="jobs open now" value={overview.jobs.open} href="/jobs?state=open" />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsUnassigned':
        return overview?.jobs ? (
          <JobStat
            label="waiting for an owner"
            value={overview.jobs.unassigned}
            href="/jobs?state=open"
            tone="warning"
          />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsInProgress':
        return overview?.jobs ? (
          <JobStat label="being worked on" value={overview.jobs.inProgress} href="/jobs?state=open" />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsAwaitingParts':
        return overview?.jobs ? (
          <JobStat
            label="blocked on a part"
            value={overview.jobs.awaitingParts}
            href="/jobs?state=open"
            tone="warning"
          />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsNotInvoiced':
        return overview?.jobs ? (
          <JobStat
            label="closed with work unbilled"
            value={overview.jobs.notInvoiced}
            href="/jobs?state=closed"
            // Danger rather than warning: this one is money already earned and
            // not yet asked for.
            tone="danger"
          />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsByStatus':
        return overview?.jobs ? (
          <JobSplit
            rows={overview.jobs.byStatus}
            emptyHint="Nothing is open. Every job has been closed or cancelled."
          />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      case 'jobsByTechnician':
        return overview?.jobs ? (
          <JobSplit
            rows={overview.jobs.byTechnician}
            emptyHint="Nothing is open, so nobody is carrying anything."
          />
        ) : (
          notAllowed(overviewError, overview !== null)
        )
      default:
        return null
    }
}

/** Days in the range on which anything sold — the divisor the hour chart needs. */
function tradingDays(data: SalesDashboardData): number {
  return secondaryStats(data.perDay, data.perHour, data.kpis.saleCount).tradingDays
}

/**
 * A chart with a plain-English line under it.
 *
 * The sentence is the point of this wrapper. A chart shows a shape and leaves
 * the reader to name it; the line names it — which day was best, when the two
 * rushes are, what the quiet hour costs. That is the sentence a shop owner
 * repeats to their staff, and it is the difference between a dashboard that is
 * looked at and one that is read.
 *
 * It is generated from the same buckets the chart plots (see insights.ts), so
 * it can never describe data that is not on the screen above it. When there is
 * nothing true to say — a range with no weekend in it, a single trading day —
 * the takeaway comes back null and the footer is not drawn at all, rather than
 * padded out with a sentence that says nothing.
 *
 * The footer is `shrink-0` and the chart takes the rest: in a widget the user
 * has dragged short, the CHART gives up height and the sentence stays whole. A
 * half-clipped line of prose is unreadable in a way a shorter chart is not.
 */
function ChartWithTakeaway({
  takeaway,
  children,
}: {
  takeaway: string | null
  children: ReactNode
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {takeaway && (
        <p className="shrink-0 border-t border-border pt-2.5 text-xs text-muted">{takeaway}</p>
      )}
    </div>
  )
}

/** The header suffix for a widget: where relevant, which location it read. */
export function widgetNote(id: WidgetId, overview: DashboardOverview | null): string | null {
  if (id === 'reorder' && overview?.reorder?.multipleLocations) {
    return overview.reorder.locationName
  }
  return null
}

function notAllowed(error: string | null, loaded: boolean) {
  if (error) {
    return (
      <EmptyState
        icon={<Icons.StatusWarning size={22} />}
        title="Couldn't load this"
        hint={error}
      />
    )
  }
  // Still in flight. A skeleton rather than a message, so the box does not
  // flash "not available" at every reader for the first few hundred ms.
  if (!loaded) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    )
  }
  return (
    <EmptyState
      icon={<Icons.Lock size={22} />}
      title="Not available"
      hint="Your role does not include this information."
    />
  )
}
