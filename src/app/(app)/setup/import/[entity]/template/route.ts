import { NextResponse } from 'next/server'
import { actorForCapability } from '@/lib/auth'
import { specFor } from '@/lib/import/registry'
import { fieldsFor } from '@/lib/import/spec'
import { templateXlsx } from '@/lib/import/template'
import type { Capability } from '@/lib/site/permissions'

/**
 * The blank file to fill in.
 *
 * A route rather than a server action, because an action cannot hand the
 * browser a file — the same split the attachments panel makes.
 *
 * The headings come from the same field list that does the auto-mapping, so a
 * returned template maps perfectly with nothing for anyone to correct. That
 * closure is the point: a template the importer then cannot read would be the
 * most annoying possible bug.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entity: string }> },
) {
  const { entity } = await params
  const spec = specFor(entity)
  if (!spec) return new NextResponse('Not found', { status: 404 })

  // API routes sit outside the (app) group, so no layout guard has run.
  const ctx = await actorForCapability(spec.capability as Capability)
  if (!ctx) return new NextResponse('Not allowed', { status: 403 })

  // The site's own price lists and locations become columns, so the template
  // has to be built per site rather than served as a static file.
  const lookups = await spec.loadLookups(ctx.siteId)
  const { body, filename } = templateXlsx(fieldsFor(spec, lookups), spec.title)

  return new NextResponse(new Uint8Array(body), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
