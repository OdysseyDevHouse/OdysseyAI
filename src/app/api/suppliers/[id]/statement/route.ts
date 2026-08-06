import { NextResponse, type NextRequest } from 'next/server'
import { requireSite } from '@/lib/auth'
import { buildSupplierStatement, type StatementFormat } from '@/lib/statements/render'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * A supplier account as a PDF.
 *
 * The creditors twin of the customer statement route. Printed rather than sent:
 * this is our record of the account, and it goes into a reconciliation file or
 * next to the supplier's own statement — which is why there is no email path
 * here, unlike the remittance route.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const site = await requireSite()
  const { id } = await params

  const supplierId = Number(id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const search = request.nextUrl.searchParams
  const format: StatementFormat = search.get('format') === 'activity' ? 'activity' : 'open-item'

  const data = await buildSupplierStatement(
    site.id,
    site.displayName,
    site.vatNumber,
    supplierId,
    {
      format,
      from: isoOrUndefined(search.get('from')),
      to: isoOrUndefined(search.get('to')),
    },
  )
  if (!data) return new NextResponse('Not found', { status: 404 })

  const pdf = await renderStatementPdf(data, 'supplier-statement')
  const filename = `supplier-account-${data.account.code}-${data.period.to}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${
        search.get('download') === '1' ? 'attachment' : 'inline'
      }; filename="${filename}"`,
      // A moving balance; a cached copy is wrong the moment a payment posts.
      'cache-control': 'no-store',
    },
  })
}

function isoOrUndefined(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
