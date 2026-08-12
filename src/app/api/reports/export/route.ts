import { NextResponse, type NextRequest } from 'next/server'
import { actorForCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { PERIOD_KEYS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { exportCell } from '@/lib/reportBuilder/format'
import { reportColumnsFor, applyStoreColumns } from '@/lib/site/reportColumns'
import { toXlsx, toCsv, exportFilename, type ExportColumn } from '@/lib/export/table'

/**
 * A report as a spreadsheet.
 *
 * This route is the reason `actorForCapability` exists: `reports.view` gets you
 * the file, but which COLUMNS are in it depends on the caller's other
 * capabilities, and the run engine applies that itself. An export that ignored
 * the distinction would be a way to read cost prices you cannot see on screen.
 *
 * Money is written as a NUMBER, never "R1 234.56" — the first thing anyone does
 * with an exported report is sum a column.
 */
export async function GET(request: NextRequest) {
  const auth = await actorForCapability('reports.view')
  if (!auth) return NextResponse.json({ error: 'Not allowed' }, { status: 403 })

  const allow = (c: Capability) => can(auth.capabilities, c)
  const params = request.nextUrl.searchParams

  const id = params.get('id')
  if (!id) return NextResponse.json({ error: 'No report' }, { status: 400 })

  const report = await resolveReport(auth.siteId, id)
  if (!report) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })
  if (report.permission && !allow(report.permission)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const periodParam = params.get('period')
  const period = PERIOD_KEYS.includes(periodParam as PeriodKey)
    ? (periodParam as PeriodKey)
    : report.spec.period.key

  const spec = {
    ...report.spec,
    period:
      period === 'custom'
        ? {
            key: period,
            from: params.get('from') ?? undefined,
            to: params.get('to') ?? undefined,
          }
        : { key: period },
  }

  let result
  try {
    result = await runBuilderSpec(auth.siteId, spec, allow)
  } catch (e) {
    if (e instanceof ReportAccessError) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Report failed' },
      { status: 400 },
    )
  }

  /* The store's columns and order, exactly as the screen shows them. An export
     that carried a column the store switched off would make hiding it a
     screen-only gesture, and the spreadsheet is where these figures usually
     end up. */
  const shown = applyStoreColumns(
    result.columns,
    await reportColumnsFor(auth.siteId, report.id, result.columns.map((c) => c.key)),
  )

  const columns: ExportColumn<Record<string, unknown>>[] = shown.map((col) => ({
    header: col.label,
    value: (row) => exportCell(row[col.key], col.type),
    money: col.type === 'currency',
  }))

  const format = params.get('format') === 'csv' ? 'csv' : 'xlsx'
  const base = slug(report.name)

  if (format === 'csv') {
    return new NextResponse(toCsv(result.rows, columns), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(base, 'csv')}"`,
      },
    })
  }

  const buffer = toXlsx(result.rows, columns, report.name)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(base, 'xlsx')}"`,
    },
  })
}

/** A filename-safe version of the report's name. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'report'
  )
}
