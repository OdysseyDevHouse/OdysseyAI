import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { buildJobReport } from '@/lib/jobs/render'
import { renderJobReportPdf } from '@/lib/jobs/pdf'

/**
 * The service report for one job, as a PDF.
 *
 * ── WHY THE GUARD IS HERE AND NOT UPSTREAM ─────────────────────────────────
 *
 * api/ is outside the (app) route group, so nothing has checked a capability for
 * this URL — and it is directly typeable. The same reasoning the customer
 * statement route carries.
 *
 * Gated on `jobs.view`, deliberately not on `jobs.cost`: the report shows what
 * was done and what is being charged, never a cost or a margin. That is enforced
 * in buildJobReport by naming every field it maps rather than spreading a row —
 * see its header. A second permission here would imply the document contains
 * something it does not.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'jobs.view')) {
    return new NextResponse('Not allowed', { status: 403 })
  }

  const { id } = await params
  const jobId = Number(id)
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const data = await buildJobReport(site.id, site.displayName, site.vatNumber, jobId)
  if (!data) return new NextResponse('Not found', { status: 404 })

  const pdf = await renderJobReportPdf(data)
  const filename = `${data.job.documentNumber ?? `job-${data.job.id}`}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${
        request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'
      }; filename="${filename}"`,
      /*
       * A job is still being worked on. A cached report would show yesterday's
       * checklist to somebody who opened it after the technician finished — and
       * the whole point of the document is that it says what actually happened.
       */
      'cache-control': 'no-store',
    },
  })
}
