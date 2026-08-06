import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { listCustomers, toCustomerStatus, type Customer } from '@/lib/site/customers'
import { exportFilename, toCsv, toXlsx, type ExportColumn } from '@/lib/export/table'

/**
 * The debtors book as a spreadsheet, honouring the list screen's filters.
 *
 * Reads the same params the list page reads, so "export" always means "what I
 * am looking at" rather than "everything" — the difference between a useful
 * button and a surprising one.
 */

export const dynamic = 'force-dynamic'

const COLUMNS: readonly ExportColumn<Customer>[] = [
  { header: 'Code', value: (c) => c.code },
  { header: 'Name', value: (c) => c.name },
  { header: 'Status', value: (c) => c.status },
  { header: 'Status reason', value: (c) => c.statusReason },
  { header: 'Contact', value: (c) => c.contactName },
  { header: 'Email', value: (c) => c.email },
  { header: 'Phone', value: (c) => c.phone },
  { header: 'Address 1', value: (c) => c.addressLine1 },
  { header: 'Address 2', value: (c) => c.addressLine2 },
  { header: 'City', value: (c) => c.city },
  { header: 'Postal code', value: (c) => c.postalCode },
  { header: 'VAT number', value: (c) => c.vatNumber },
  { header: 'Group', value: (c) => c.groupName },
  { header: 'Rep', value: (c) => c.repName },
  { header: 'Category', value: (c) => c.category },
  { header: 'Terms (days)', value: (c) => c.paymentTermsDays },
  { header: 'Credit limit', value: (c) => c.creditLimit, money: true },
  { header: 'Balance', value: (c) => c.balance, money: true },
  { header: 'Available credit', value: (c) => c.availableCredit, money: true },
  { header: 'Over limit', value: (c) => (c.overLimit ? 'Yes' : 'No') },
]

export async function GET(request: NextRequest) {
  // Checked here because api/ sits outside the (app) route group, so the
  // layout's guard never runs for it. This URL is directly typeable.
  const siteId = await siteIdForCapability('customers.view')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }
  const params = request.nextUrl.searchParams

  const status = toCustomerStatus(params.get('status'))
  const balance = params.get('balance')

  // No page size: an export is the whole filtered set, not the page the user
  // happens to be on. Capped at the data layer's own ceiling.
  const { items } = await listCustomers(siteId, {
    search: params.get('q') ?? undefined,
    statuses: status ? [status] : undefined,
    groupId: Number(params.get('group')) || undefined,
    repId: Number(params.get('rep')) || undefined,
    category: params.get('category') ?? undefined,
    withBalanceOnly: balance === 'owing',
    overLimitOnly: balance === 'over',
    limit: 500,
  })

  if (params.get('format') === 'csv') {
    return new NextResponse(toCsv(items, COLUMNS), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename('customers', 'csv')}"`,
      },
    })
  }

  const buffer = toXlsx(items, COLUMNS, 'Customers')
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${exportFilename('customers', 'xlsx')}"`,
    },
  })
}
