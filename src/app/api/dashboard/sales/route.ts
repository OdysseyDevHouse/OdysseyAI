import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { getSalesDashboard, isIsoDate } from '@/lib/site/salesDashboard'

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
    return NextResponse.json(await getSalesDashboard(siteId, { from, to }))
  } catch (error) {
    // The message is surfaced verbatim on the dashboard. A site whose database
    // is unreachable should say so, rather than render six zeroes that look
    // like a day with no trade.
    const message = error instanceof Error ? error.message : 'Failed to load sales data'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
