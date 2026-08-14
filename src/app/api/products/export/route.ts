import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { catalogueExport } from '@/lib/export/products'
import { exportFilename, toCsv, toXlsx } from '@/lib/export/table'

/**
 * The whole catalogue, shaped for re-import.
 *
 * Every heading is the import spec's own first alias, so the file can be
 * edited in Excel and loaded straight back — the round trip the import
 * engine promises. Deliberately unfiltered: this is the catalogue as a
 * portable file, not a view of the list screen.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // products.edit, not view: the file carries costs and supplier terms, and
  // its whole purpose is to come back through the import this capability gates.
  const siteId = await siteIdForCapability('products.edit')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const { columns, rows } = await catalogueExport(siteId)

  if (request.nextUrl.searchParams.get('format') === 'csv') {
    return new NextResponse(toCsv(rows, columns), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename('catalogue', 'csv')}"`,
      },
    })
  }

  const buffer = toXlsx(rows, columns, 'Catalogue')
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${exportFilename('catalogue', 'xlsx')}"`,
    },
  })
}
