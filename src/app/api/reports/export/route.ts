import { NextResponse, type NextRequest } from 'next/server'
import { actorForCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { PERIOD_KEYS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { exportCell } from '@/lib/reportBuilder/format'
import { buildSections, computeTotals, resolveGroupKey } from '@/lib/reportBuilder/shape'
import { reportPrefsFor, parseStoredColumns, applyStoreColumns } from '@/lib/site/reportColumns'
import { toCsv, exportFilename, type ExportColumn } from '@/lib/export/table'
import { renderReportPdf } from '@/lib/reports/pdf'
import { renderReportXlsx } from '@/lib/reports/xlsx'

/**
 * A report as a file: PDF to read, a workbook to work in, CSV to import.
 *
 * This route is the reason `actorForCapability` exists: `reports.view` gets you
 * the file, but which COLUMNS are in it depends on the caller's other
 * capabilities, and the run engine applies that itself. An export that ignored
 * the distinction would be a way to read cost prices you cannot see on screen.
 *
 * Money is written as a NUMBER, never "R1 234.56" — the first thing anyone does
 * with an exported report is sum a column.
 *
 * The PDF and the workbook are BANDED the way the screen bands them, by the same
 * buildSections the grid calls; the CSV deliberately is not. See the branch
 * below for why.
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

  /* The store's columns, order and banding, exactly as the screen shows them.
     An export that carried a column the store switched off would make hiding it
     a screen-only gesture, and the spreadsheet is where these figures usually
     end up.

     Both come from the stored row rather than the URL, so a typed or shared
     link cannot produce a file that disagrees with the screen it came from —
     and the scheduled send, which has no URL at all, gets the same answer. */
  const prefs = await reportPrefsFor(auth.siteId, report.id)
  const shown = applyStoreColumns(
    result.columns,
    parseStoredColumns(prefs.columns, result.columns.map((c) => c.key)),
  )
  const groupKey = resolveGroupKey(prefs.groupBy, shown)

  const format = params.get('format')
  const base = slug(report.name)

  /* CSV stays FLAT. It is the format people import into something else, and a
     sheet carrying band headings and subtotal rows is not importable — those
     rows have a different shape from the data around them. The other two
     formats are for reading, and get the bands. */
  if (format === 'csv') {
    const columns: ExportColumn<Record<string, unknown>>[] = shown.map((col) => ({
      header: col.label,
      value: (row) => exportCell(row[col.key], col.type),
      money: col.type === 'currency',
    }))
    return new NextResponse(toCsv(result.rows, columns), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(base, 'csv')}"`,
      },
    })
  }

  const render = {
    title: report.name,
    subtitle: report.description || undefined,
    storeName: auth.siteName,
    range: result.range,
    columns: shown,
    sections: buildSections(result.rows, shown, groupKey),
    grandTotal: computeTotals(result.rows, shown),
    rowCount: result.rows.length,
    truncated: result.truncated,
    hiddenColumns: result.hiddenColumns,
  }

  if (format === 'pdf') {
    const pdf = await renderReportPdf(render)
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${exportFilename(base, 'pdf')}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  const buffer = renderReportXlsx(render)
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
