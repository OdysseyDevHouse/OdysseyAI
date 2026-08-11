import { NextResponse } from 'next/server'
import { actorForCapability } from '@/lib/auth'
import { getDashboardOverview } from '@/lib/site/dashboardOverview'

/**
 * The dashboard's as-at-now half — ageing, cash, stock, what needs attention.
 *
 * No parameters, deliberately: none of these figures move with the date range,
 * so the client fetches this ONCE on mount while `/sales` refetches on every
 * range change. Splitting the two endpoints by scope rather than by widget is
 * what makes that caching fall out for free.
 *
 * `actorForCapability` rather than `siteIdForCapability` because what comes
 * back depends on far more than the capability that opens the door —
 * `getDashboardOverview` gates every section, and every QUERY, on the caller's
 * full set. See that module's header.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  // Checked here because api/ sits outside the (app) route group, so the
  // layout's guard never runs for it. This URL is directly typeable, and with
  // no parameters it is the most trivially typeable one in the app.
  const ctx = await actorForCapability('dashboard.view')
  if (!ctx) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  try {
    return NextResponse.json(await getDashboardOverview(ctx.siteId, ctx.capabilities))
  } catch (error) {
    // Surfaced verbatim on the dashboard, as the sales route does: a site whose
    // database is unreachable should say so rather than render an empty action
    // list, which reads as "nothing needs doing".
    const message = error instanceof Error ? error.message : 'Failed to load overview'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
