import { requireCapability } from '@/lib/auth'
import {
  stockAgeReport,
  abcReport,
  stockTurnReport,
  sellThroughReport,
} from '@/lib/site/stockIntelligence'
import { PageHeader, PageBody } from '@/components/ui'
import StockIntelClient from './StockIntelClient'

export const dynamic = 'force-dynamic'

const WINDOWS = [30, 60, 90, 180, 365]

/**
 * Stock intelligence — true aging, ABC, turn and sell-through in one place.
 *
 * These four cannot be expressed in the report builder: aging peels movement
 * history into layers, and the other three divide one query by another. The
 * builder's dead-stock templates are the cheap proxies; this page is the
 * measured version.
 */
export default async function StockIntelPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  // Costs everywhere on this page, so it takes the financial-reports gate —
  // the same one stock-valuation and the dead-stock templates sit behind.
  const { siteId } = await requireCapability('reports.financial')

  const params = await searchParams
  const requested = Number(params.days)
  const windowDays = WINDOWS.includes(requested) ? requested : 90

  const [age, abc, turn, sell] = await Promise.all([
    stockAgeReport(siteId),
    abcReport(siteId, windowDays),
    stockTurnReport(siteId, windowDays),
    sellThroughReport(siteId, windowDays),
  ])

  return (
    <>
      <PageHeader
        title="Stock intelligence"
        subtitle="Where the money on the shelf sits, how old it is, and how fast it moves."
        backHref="/reports"
        backLabel="Reports"
      />
      <PageBody>
        <StockIntelClient age={age} abc={abc} turn={turn} sell={sell} windowDays={windowDays} />
      </PageBody>
    </>
  )
}
