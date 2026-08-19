import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { buildRemittance } from '@/lib/statements/remittance'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * A remittance advice as a PDF.
 *
 * The creditors mirror of the customer statement route, and it renders through
 * the SAME renderer — only the `remittance` variant differs. That is the
 * shared-vs-duplicated line working: the document is one implementation, and
 * only what fills it is written per side.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // api/ is outside the (app) route group, so nothing upstream has checked a
  // capability for this URL — and it is directly typeable.
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'purchasing.pay')) {
    return new NextResponse('Not allowed', { status: 403 })
  }
  const { id } = await params

  const supplierId = Number(id)
  const runId = Number(request.nextUrl.searchParams.get('run'))

  if (!Number.isFinite(supplierId) || supplierId <= 0 || !Number.isFinite(runId) || runId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const data = await buildRemittance(site.id, site.displayName, site.vatNumber, runId, supplierId)
  if (!data) return new NextResponse('Not found', { status: 404 })

  const pdf = await renderStatementPdf(data, 'remittance', site.id)
  const filename = `remittance-${data.account.code}-${data.period.to}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${
        request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'
      }; filename="${filename}"`,
      // A remittance is a snapshot of a payment; caching one would risk showing
      // a stale allocation after a correction.
      'cache-control': 'no-store',
    },
  })
}
