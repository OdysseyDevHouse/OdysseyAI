import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { getAttachment } from '@/lib/site/attachments'
import { readStoredFile } from '@/lib/uploads'
import { toAttachmentTarget, readCapabilityFor } from '@/lib/attachmentTargets'

/**
 * Serves one attachment, on any kind of record.
 *
 * The general form of /api/documents/[id], which still serves the customer and
 * supplier screens. Same security model, and the reasoning is worth repeating
 * because every line of it is load-bearing:
 *
 * ── WHY THE ENTITY IS IN THE QUERY STRING ────────────────────────────────
 *
 * The lookup is (id, entity, entity_id), never id alone. An attachment id is a
 * guessable integer; matching on it by itself would let anyone with an account
 * walk the range and read every other record's paperwork. Making the caller
 * also name the record means a wrong guess returns 404 rather than someone
 * else's supplier invoice.
 *
 * ── WHY THE CAPABILITY IS DERIVED, NOT FIXED ─────────────────────────────
 *
 * It depends on WHICH record's attachment this is. A till operator who may see
 * expenses has no business reading a customer's signed credit application. So
 * the entity is validated to a known target first, and the required capability
 * comes from that target — not from a blanket permission that would flatten
 * every one of those distinctions into one.
 *
 * The site comes from the session, never the URL, so the whole read is already
 * confined to one site's database before any of this runs.
 *
 * ── WHY IT ALWAYS DOWNLOADS ──────────────────────────────────────────────
 *
 * Content-Disposition: attachment, unconditionally. These are arbitrary
 * uploads from outside the business, and rendering one inline on our own origin
 * is how a stored XSS gets in — an .svg or .html served inline runs script with
 * access to the session cookie. The stored MIME type is echoed for convenience
 * but never trusted to make that decision; X-Content-Type-Options stops the
 * browser sniffing its way to a different answer.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const attachmentId = Number(id)
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const search = request.nextUrl.searchParams
  // Narrowed before it decides anything. An unvalidated entity would select a
  // capability, so a caller could name one they happen to hold and read rows
  // belonging to a record type they do not.
  const entity = toAttachmentTarget(search.get('entity'))
  const entityId = Number(search.get('entityId'))
  if (entity === null || !Number.isFinite(entityId) || entityId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const siteId = await siteIdForCapability(readCapabilityFor(entity))
  if (siteId === null) return new NextResponse('Not allowed', { status: 403 })

  const attachment = await getAttachment(siteId, entity, entityId, attachmentId)
  if (!attachment) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(attachment.storedName)
  if (!bytes) {
    // The row outlived its file — a database restored without the uploads
    // directory. Saying so beats a generic 404 the user reads as a bug.
    return new NextResponse('This file is no longer on the server.', { status: 404 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': attachment.mimeType || 'application/octet-stream',
      // filename* carries the real name for anything modern; the plain filename
      // is the ASCII fallback. The stored name has already had the quotes and
      // newlines stripped that would otherwise break out of this header.
      'content-disposition': `attachment; filename="${asciiFallback(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'x-content-type-options': 'nosniff',
      // Private, not public: these belong to one record and must never sit in
      // a shared cache.
      'cache-control': 'private, no-store',
    },
  })
}

/** Non-ASCII replaced, for the legacy filename parameter. */
function asciiFallback(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '_')
}
