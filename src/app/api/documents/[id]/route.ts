import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteId } from '@/lib/auth'
import { getDocument } from '@/lib/site/partyDocuments'
import { readStoredFile } from '@/lib/uploads'
import type { PartyKind } from '@/lib/site/partyContacts'

/**
 * Serves one attached document.
 *
 * A route handler because a server action cannot hand the browser a file.
 *
 * ── WHY THE PARTY IS IN THE QUERY STRING ─────────────────────────────────
 *
 * The lookup is (id, entity, entity_id), not id alone. A document id is a
 * guessable integer, and a query that matched on it by itself would let anyone
 * with an account walk the range and read every other account's paperwork.
 * Requiring the caller to also name the account the document hangs off means a
 * wrong guess returns 404 instead of someone else's credit application.
 *
 * The site comes from the session, never the URL, so the whole read is already
 * confined to one site's database before any of this runs.
 *
 * ── WHY IT ALWAYS DOWNLOADS ──────────────────────────────────────────────
 *
 * Content-Disposition: attachment, unconditionally. These files are arbitrary
 * uploads from outside the business, and rendering one inline on our own origin
 * is how a stored XSS gets in — an .svg or .html served inline runs script with
 * access to the session cookie. The stored MIME type is echoed for convenience
 * but is never trusted to make that decision; X-Content-Type-Options stops the
 * browser sniffing its way to a different answer.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const siteId = await requireSiteId()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const search = request.nextUrl.searchParams
  const partyRaw = search.get('party')
  const partyId = Number(search.get('partyId'))
  if ((partyRaw !== 'customer' && partyRaw !== 'supplier') || !Number.isFinite(partyId) || partyId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const doc = await getDocument(siteId, partyRaw as PartyKind, partyId, documentId)
  if (!doc) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(doc.storedName)
  if (!bytes) {
    // The row outlived its file — a database restored without the uploads
    // directory. Saying so beats a generic 404 the user reads as a bug.
    return new NextResponse('This file is no longer on the server.', { status: 404 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': doc.mimeType || 'application/octet-stream',
      // filename* carries the real name for anything modern; the plain filename
      // is the ASCII fallback. cleanDisplayName has already stripped the quotes
      // and newlines that would otherwise break out of this header.
      'content-disposition': `attachment; filename="${asciiFallback(doc.filename)}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      'x-content-type-options': 'nosniff',
      // Private, not public: these are one account's documents and must never
      // sit in a shared cache.
      'cache-control': 'private, no-store',
    },
  })
}

/** Non-ASCII replaced, for the legacy filename parameter. */
function asciiFallback(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '_')
}
