import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { buildStatement, type StatementFormat } from '@/lib/statements/render'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * One customer's statement as a PDF.
 *
 * A route handler because a server action cannot hand the browser a file. The
 * same StatementData feeds the on-screen preview, so the PDF can never show a
 * different closing balance from the screen it was opened from.
 *
 * `?download=1` forces a save; without it the browser previews it inline, which
 * is what "Print statement" wants.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // api/ is outside the (app) route group, so nothing upstream has checked a
  // capability for this URL — and it is directly typeable.
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'customers.view')) {
    return new NextResponse('Not allowed', { status: 403 })
  }
  const { id } = await params

  const customerId = Number(id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const search = request.nextUrl.searchParams
  const format: StatementFormat = search.get('format') === 'activity' ? 'activity' : 'open-item'
  const from = isoOrUndefined(search.get('from'))
  const to = isoOrUndefined(search.get('to'))

  const data = await buildStatement(site.id, site.displayName, site.vatNumber, customerId, {
    format,
    from,
    to,
  })
  if (!data) return new NextResponse('Not found', { status: 404 })

  const pdf = await renderStatementPdf(data, 'statement', site.id)
  const filename = `statement-${data.account.code}-${data.period.to}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${
        search.get('download') === '1' ? 'attachment' : 'inline'
      }; filename="${filename}"`,
      // A statement is a snapshot of a moving balance; a cached copy would be
      // wrong the moment a payment lands.
      'cache-control': 'no-store',
    },
  })
}

function isoOrUndefined(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
