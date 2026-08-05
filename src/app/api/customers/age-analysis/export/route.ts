import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteId } from '@/lib/auth'
import { customerAging, type AgingBasis, type AgingRow } from '@/lib/site/aging'
import { today } from '@/lib/site/ledger'
import { exportFilename, toCsv, toXlsx, type ExportColumn } from '@/lib/export/table'

/**
 * The age analysis as a spreadsheet.
 *
 * A route handler rather than a server action: an action returns data to the
 * React tree, and there is no way from there to hand the browser a file. This
 * is the first data route in the app, and the pattern every export follows.
 *
 * It re-reads the SAME query the screen ran, from the same params, so the
 * export can never quietly differ from what the user is looking at.
 */

export const dynamic = 'force-dynamic'

const COLUMNS: readonly ExportColumn<AgingRow>[] = [
  { header: 'Code', value: (r) => r.code },
  { header: 'Account', value: (r) => r.name },
  { header: 'Status', value: (r) => r.status },
  { header: 'Contact', value: (r) => r.contactName },
  { header: 'Email', value: (r) => r.email },
  { header: 'Phone', value: (r) => r.phone },
  { header: 'Group', value: (r) => r.groupName },
  { header: 'Rep', value: (r) => r.repName },
  { header: 'Current', value: (r) => r.aging.current, money: true },
  { header: '30 days', value: (r) => r.aging.d30, money: true },
  { header: '60 days', value: (r) => r.aging.d60, money: true },
  { header: '90 days', value: (r) => r.aging.d90, money: true },
  { header: '120+ days', value: (r) => r.aging.d120, money: true },
  { header: 'Total', value: (r) => r.aging.total, money: true },
  { header: 'Oldest (days)', value: (r) => r.oldestDays },
  { header: 'Credit limit', value: (r) => r.creditLimit, money: true },
]

export async function GET(request: NextRequest) {
  const siteId = await requireSiteId()
  const params = request.nextUrl.searchParams

  const asAtRaw = params.get('asAt') ?? ''
  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(asAtRaw) ? asAtRaw : today()
  const basis: AgingBasis = params.get('basis') === 'doc' ? 'doc' : 'due'

  const { rows } = await customerAging(siteId, {
    asAt,
    basis,
    overdueOnly: params.get('overdue') === '1',
    groupId: Number(params.get('group')) || undefined,
    repId: Number(params.get('rep')) || undefined,
  })

  if (params.get('format') === 'csv') {
    return new NextResponse(toCsv(rows, COLUMNS), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename('age-analysis', 'csv')}"`,
      },
    })
  }

  const buffer = toXlsx(rows, COLUMNS, `Age analysis ${asAt}`)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${exportFilename('age-analysis', 'xlsx')}"`,
    },
  })
}
