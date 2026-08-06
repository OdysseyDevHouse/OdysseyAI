import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteId } from '@/lib/auth'
import { isIsoDate, rankedDimension, type DetailDimension } from '@/lib/site/salesDashboard'

/**
 * The FULL ranked list for one dimension — what "View more" opens.
 *
 * The dashboard card shows the top ten; this returns everything that traded in
 * the period, because the question behind "view more" is usually about the
 * tail (what is NOT selling) rather than the head.
 */

export const dynamic = 'force-dynamic'

const DIMENSIONS: DetailDimension[] = ['products', 'departments', 'cashiers']

export async function GET(req: NextRequest) {
  const siteId = await requireSiteId()
  const params = req.nextUrl.searchParams
  const from = params.get('from')
  const to = params.get('to')
  const dimension = params.get('dimension')

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return NextResponse.json({ error: 'from and to are required as YYYY-MM-DD' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'The start date is after the end date.' }, { status: 400 })
  }
  if (!DIMENSIONS.includes(dimension as DetailDimension)) {
    return NextResponse.json(
      { error: `dimension must be one of ${DIMENSIONS.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    // null: no top-N cap. rankedDimension still bounds it at 500 rows.
    const rows = await rankedDimension(siteId, { from, to }, dimension as DetailDimension, null)
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
