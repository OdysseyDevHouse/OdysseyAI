import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser, siteIdForCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  getSalesDashboard,
  isIsoDate,
  type SalesDashboardData,
} from '@/lib/site/salesDashboard'

/**
 * The same payload with every margin figure zeroed.
 *
 * Zeroed rather than deleted: the dashboard's types expect the fields, and a
 * missing key would render "NaN" where a tile used to be. The tiles that show
 * margin are also hidden for this role, so the zeroes are never displayed —
 * they exist so the numbers are not in the response at all.
 */
function withoutMargin(data: SalesDashboardData): SalesDashboardData {
  const blankRow = <T extends { grossProfit: number; grossProfitPct: number }>(row: T): T => ({
    ...row,
    grossProfit: 0,
    grossProfitPct: 0,
  })

  return {
    ...data,
    kpis: { ...data.kpis, grossProfit: 0, grossProfitPct: 0 },
    topProducts: data.topProducts.map(blankRow),
    topDepartments: data.topDepartments.map(blankRow),
    topCashiers: data.topCashiers.map(blankRow),
  }
}

/**
 * Every dashboard widget's data for one date range, in one payload.
 *
 * One endpoint rather than one per widget: the client refetches on every range
 * change, and a dozen parallel requests per change would be a dozen connections
 * to the site database for figures that all come from the same two tables.
 */

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // Checked here because api/ sits outside the (app) route group, so the
  // layout's guard never runs for it. This URL is directly typeable.
  const siteId = await siteIdForCapability('dashboard.view')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }
  const params = req.nextUrl.searchParams
  const from = params.get('from')
  const to = params.get('to')

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return NextResponse.json({ error: 'from and to are required as YYYY-MM-DD' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'The start date is after the end date.' }, { status: 400 })
  }

  try {
    const data = await getSalesDashboard(siteId, { from, to })

    // Margin is stripped from the RESPONSE, not merely hidden by the tile that
    // renders it: this endpoint is a typeable URL that returns JSON, so a
    // client-side check would leave the figures one network-tab away.
    const { capabilities } = await requireSiteUser()
    if (!can(capabilities, 'products.cost')) {
      return NextResponse.json(withoutMargin(data))
    }

    return NextResponse.json(data)
  } catch (error) {
    // The message is surfaced verbatim on the dashboard. A site whose database
    // is unreachable should say so, rather than render six zeroes that look
    // like a day with no trade.
    const message = error instanceof Error ? error.message : 'Failed to load sales data'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
