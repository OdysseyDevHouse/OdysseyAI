import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { PERIOD_KEYS, type PeriodKey } from '@/lib/reportBuilder/spec'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/reports/run — run a report BY ID, never a raw spec.
 *
 * The id space is the one favourites and schedules already use: a built-in's
 * template key ('sales-by-product') or 'saved:12'. The engine enforces the
 * source permission itself against the key's scope-derived capabilities and
 * strips fields the key may not see (cost, margin) exactly as it does for a
 * junior user — hiddenColumns says what was dropped.
 *
 * Body: { reportId, period?, from?, to?, limit? }
 */
export const POST = withApiKey(
  'reports:run',
  async (req: NextRequest, ctx: ApiContext) => {
    const body = (await req.json().catch(() => null)) as {
      reportId?: string
      period?: string
      from?: string
      to?: string
      limit?: number
    } | null
    if (!body?.reportId || typeof body.reportId !== 'string') {
      return NextResponse.json(
        { error: 'Pass { reportId } — a template key or saved:N.' },
        { status: 400 },
      )
    }

    const report = await resolveReport(ctx.siteId, body.reportId)
    if (!report) return NextResponse.json({ error: 'Report not found.' }, { status: 404 })
    // A built-in's own gate, on top of the source permission the engine checks.
    if (report.permission && !ctx.can(report.permission)) {
      return NextResponse.json(
        { error: 'This key does not have access to that report.' },
        { status: 403 },
      )
    }

    const periodKey = PERIOD_KEYS.includes(body.period as PeriodKey)
      ? (body.period as PeriodKey)
      : null
    const spec = periodKey
      ? {
          ...report.spec,
          period:
            periodKey === 'custom'
              ? { key: periodKey, from: body.from, to: body.to }
              : { key: periodKey },
        }
      : report.spec

    try {
      const result = await runBuilderSpec(ctx.siteId, spec, ctx.can, {
        limit: Math.min(Math.max(Number(body.limit) || 1000, 1), 10_000),
      })
      return NextResponse.json({
        reportId: body.reportId,
        name: report.name,
        range: result.range,
        columns: result.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
        rows: result.rows,
        totals: result.totals,
        truncated: result.truncated,
        hiddenColumns: result.hiddenColumns,
      })
    } catch (error) {
      if (error instanceof ReportAccessError) {
        return NextResponse.json({ error: error.message }, { status: 403 })
      }
      throw error
    }
  },
  // A report run costs many requests' worth of database time.
  { cost: 10 },
)
