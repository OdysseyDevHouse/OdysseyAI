import 'server-only'
import { pictureIds, pictureBytes } from './stationeryImages'
import { PICTURE_URL } from '../stationery/render'
import { sniffImage } from '../uploads'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../siteDb'
import { formatMoney } from '../decimals'
import { send, isConfigured } from '../mail'
import { getPurchaseDocument } from './purchaseDocuments'
import { getSupplier } from './suppliers'
import { activeTemplateBody } from './stationeryTemplates'
import { logoImgTag, readLogo, LOGO_URL } from './documentLogo'
import { purchaseOrderTokens } from '../stationery/adapters/purchaseOrder'
import { renderTemplate } from '../stationery/render'
import { resolveTemplate } from '../stationery/resolve'
import type { Actor } from './activityLog'

/**
 * Sending a purchase order to the supplier it is addressed to.
 *
 * ── WHY THE ORDER IS THE EMAIL, NOT AN ATTACHMENT ────────────────────────
 *
 * Because the shop already designed this document. A purchase order renders
 * from the site's own stationery template (lib/stationery), which is what the
 * print route puts on paper — so the emailed order is the SAME HTML, rendered
 * by the same adapter and the same renderer.
 *
 * Building a pdfkit PDF instead, the way invoiceEmail does, would have meant a
 * second layout for one document. The shop would design its letterhead, print
 * it, email it, and get two different-looking orders — and the two would drift
 * apart the first time anybody touched one of them. Reusing the template means
 * a change to the stationery lands on paper AND in the supplier's inbox with
 * nothing else to remember.
 *
 * The trade is that an old mail client may render the layout imperfectly. That
 * is worth it: the alternative is a document that is always right and always
 * different from the one on the wall.
 *
 * ── THE LOGO HAS TO TRAVEL ───────────────────────────────────────────────
 *
 * logoImgTag() points at /api/document-logo, which is exactly right for a
 * browser holding a session and useless in an email — the supplier's client
 * would fetch a URL on our network, behind our login, and show a broken image.
 * So this reads the BYTES and inlines them as a data URI. Bigger message, but
 * a letterhead that arrives.
 *
 * ── WHAT IT WILL NOT SEND ────────────────────────────────────────────────
 *
 * A draft. A draft has no number for the supplier to quote back and has been
 * agreed by nobody; emailing one is asking for goods the business has not
 * actually ordered. Same reasoning as invoiceEmail refusing a draft invoice.
 *
 * Issuing is NOT done here. A person who wants to send an order issues it and
 * then sends it — folding the two together would mean the Email button
 * silently claimed a document number, and an order that was emailed by mistake
 * could not be un-issued.
 */

export type EmailOrderResult = { ok: true; to: string } | { ok: false; error: string }

/** Injectable transport, so the suite can prove the flow without an SMTP host. */
export type MailDeps = {
  send: typeof send
  configured: () => boolean
}

export type IssuingSiteDetails = {
  name: string
  vatNumber: string | null
  registrationNumber: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
}

export async function emailPurchaseOrder(
  siteId: number,
  site: IssuingSiteDetails,
  actor: Actor,
  documentId: number,
  opts: { to: string; message?: string | null },
  deps: MailDeps = { send, configured: isConfigured },
): Promise<EmailOrderResult> {
  if (!deps.configured()) return { ok: false, error: 'Email is not set up on this system.' }

  const to = opts.to.trim()
  if (!to) return { ok: false, error: 'Give an address to send it to.' }

  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.docType !== 'purchase_order') {
    return { ok: false, error: `A ${doc.docLabel.toLowerCase()} is not emailed to a supplier.` }
  }
  if (doc.status === 'draft') {
    return { ok: false, error: 'Issue the order first — a draft has no number to quote.' }
  }
  if (doc.status === 'cancelled') {
    return { ok: false, error: 'That order was cancelled.' }
  }

  const supplier = await getSupplier(siteId, doc.supplierId)

  /*
   * Whether this copy is a duplicate, decided BEFORE the row for this send is
   * written — the same care the print route takes. An order emailed for the
   * first time must not call itself a reprint on the strength of its own
   * audit entry, and a supplier holding two copies of one order is how an
   * order gets filled twice.
   */
  const alreadySent = await hasBeenSent(siteId, documentId)

  const [custom, logoHtml] = await Promise.all([
    // Never throws: a site with no designed stationery gets null and the
    // shipped default is used.
    activeTemplateBody(siteId, 'purchase_order'),
    // The ORDINARY tag, pointing at /api/document-logo. It is swapped for a
    // data URI after rendering — see inlineLogo below for why it cannot be
    // handed to the renderer already inlined.
    logoImgTag(siteId),
  ])

  const deliverTo = [site.name, site.address1, site.address2, site.address3, site.postalCode]
    .filter((l): l is string => !!l && l.trim() !== '')

  const template = resolveTemplate('purchase_order', custom)
  const input = purchaseOrderTokens({
    doc,
    site,
    supplier,
    deliverTo,
    printedAt: new Date().toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }),
    isReprint: alreadySent,
    logoHtml,
  })

  /*
   * Costs print for a template that asks for them, exactly as on paper.
   *
   * The print route passes the READER's capabilities so a counter user sees a
   * picking list rather than what the shop pays. Here the reader is the
   * SUPPLIER, and they quoted these prices — an order that hides them is an
   * order they cannot check, and every one of these figures came from them.
   */
  const rendered = renderTemplate(template.body, 'purchase_order', {
    ...input,
    capabilities: { isOwner: true, granted: new Set(['products.cost']) },
    pictures: await pictureIds(siteId),
  })

  // Only now, on the finished document — never through a token. See inlineLogo.
  const html = await inlinePictures(siteId, await inlineLogo(siteId, rendered))

  const number = doc.documentNumber ?? `#${documentId}`
  const note = opts.message?.trim()

  const result = await deps.send({
    to,
    subject: `Purchase order ${number} from ${site.name}`,
    text: plainBody(site.name, number, doc.totalIncl, note),
    // The covering note sits ABOVE the document rather than inside it: the
    // template is the order, and a one-off "please deliver Friday" is not.
    html: note ? `${notePanel(note)}${html}` : html,
  })
  if (!result.ok) return { ok: false, error: result.error }

  await recordSend(siteId, actor, documentId, number, to, alreadySent)
  return { ok: true, to }
}

/**
 * Swaps the rendered logo tag for one carrying the image itself.
 *
 * ── WHY THIS RUNS AFTER THE RENDER AND NOT AS THE TOKEN ──────────────────
 *
 * The renderer treats `markup` tokens as hostile and passes exactly one shape:
 * an `<img>` whose src is `/api/document-logo?v=…`, matched by SAFE_MARKUP in
 * render.ts. Anything else — a data URI included — is replaced with ''. That
 * allowlist is the reason a designed template cannot be made to point an image
 * anywhere else, and widening it so this module could inline a logo would
 * weaken every document in the app to suit one of them.
 *
 * So the token stays the ordinary URL tag and the substitution happens here,
 * on the finished HTML, where it is this module's own output being rewritten
 * rather than the renderer's contract being loosened.
 *
 * It has to happen at all because that URL is useless in an inbox: the
 * supplier's mail client would fetch a route on our network, behind our
 * login, and show a broken image.
 *
 * Never allowed to break the send. A missing or unreadable logo means an order
 * without a letterhead, which the supplier can still act on; an order that did
 * not go out because a PNG could not be read is a worse outcome by far.
 */
async function inlineLogo(siteId: number, html: string): Promise<string> {
  if (!html.includes(LOGO_URL)) return html
  try {
    const logo = await readLogo(siteId)
    if (!logo) return stripLogoTag(html)
    const base64 = logo.bytes.toString('base64')
    return html.replace(
      new RegExp(`<img src="${LOGO_URL}\\?v=[^"]*"`, 'g'),
      `<img src="data:image/${logo.format};base64,${base64}"`,
    )
  } catch {
    // A tag pointing at a route the recipient cannot reach renders as a broken
    // image icon on the letterhead. Nothing at all is tidier.
    return stripLogoTag(html)
  }
}

/**
 * The shop's pictures, as data URIs — or gone.
 *
 * Exactly what inlineLogo does and for exactly the same reason: the recipient
 * of this email cannot reach /api/stationery-images, so a tag left pointing
 * there renders as a broken-image icon on a document going to a supplier.
 * Embedded, it survives; failing that, removed, because nothing is tidier than
 * a broken picture.
 *
 * Done AFTER rendering, on the finished document, never through a token — see
 * the note on inlineLogo. The tags this rewrites are ones renderTemplate built
 * from ids it had already checked against this site.
 */
async function inlinePictures(siteId: number, html: string): Promise<string> {
  if (!html.includes(PICTURE_URL)) return html

  const ids = [...html.matchAll(new RegExp(`<img src="${PICTURE_URL}/(\d+)"`, 'g'))].map((m) =>
    Number(m[1]),
  )
  if (ids.length === 0) return html

  let out = html
  const bytes = await pictureBytes(siteId, ids).catch(() => new Map<number, Buffer>())
  for (const id of new Set(ids)) {
    const found = bytes.get(id)
    const tag = new RegExp(`<img src="${PICTURE_URL}/${id}"([^>]*)>`, 'g')
    if (!found) {
      out = out.replace(tag, '')
      continue
    }
    const format = sniffImage(found) ?? 'png'
    out = out.replace(tag, `<img src="data:image/${format};base64,${found.toString('base64')}"$1>`)
  }
  return out
}

function stripLogoTag(html: string): string {
  return html.replace(new RegExp(`<img src="${LOGO_URL}\\?v=[^"]*"[^>]*>`, 'g'), '')
}

/** A covering note, escaped, above the order itself. */
function notePanel(note: string): string {
  const safe = note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
  return `<div style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #d0d5dd;color:#16191d;font:14px/1.5 system-ui,sans-serif">${safe}</div>`
}

/**
 * The text alternative. Always sent — some clients and most spam filters
 * want one, and a message with no plain part scores badly enough to be
 * filtered before anybody reads the layout we worked on.
 *
 * Deliberately a summary rather than the whole order rendered as text: the
 * lines are in the HTML, and a supplier reading the fallback needs to know
 * what arrived and who from, not to re-key it.
 */
function plainBody(
  siteName: string,
  number: string,
  totalIncl: number,
  note: string | null | undefined,
): string {
  const parts = [
    `Purchase order ${number} from ${siteName}.`,
    '',
    `Order total: ${formatMoney(totalIncl)}`,
    '',
    'The order is set out in the HTML version of this message.',
  ]
  if (note) parts.splice(1, 0, '', note)
  return parts.join('\n')
}

/** Whether this order has gone to anybody before. */
async function hasBeenSent(siteId: number, documentId: number): Promise<boolean> {
  if (!(await auditTableExists(siteId))) return false
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM purchase_document_audit
      WHERE document_id = ? AND action IN ('emailed','re_emailed') LIMIT 1`,
    [documentId],
  )
  return !!row
}

/**
 * The trail.
 *
 * A resend is its OWN action rather than a second 'emailed' row, for the same
 * reason a reprint is: the question afterwards is never "was this sent" but
 * "did this supplier get two copies", and that is answered by counting the
 * duplicates and seeing who made them.
 *
 * Silent when 139 has not reached this site. An order that would not send
 * because a history table is missing is a worse failure than an order whose
 * history panel is short a line — and by here the message has ALREADY gone,
 * so throwing would report a failure that did not happen.
 */
async function recordSend(
  siteId: number,
  actor: Actor,
  documentId: number,
  number: string,
  to: string,
  isResend: boolean,
): Promise<void> {
  if (!(await auditTableExists(siteId))) return
  await siteExecute(
    siteId,
    `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
     VALUES (?, ?, ?, ?, ?)`,
    [
      documentId,
      isResend ? 're_emailed' : 'emailed',
      `${number} to ${to}`.slice(0, 300),
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  ).catch(() => undefined)
}

async function auditTableExists(siteId: number): Promise<boolean> {
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_audit' LIMIT 1`,
  )
  return !!row
}

/** The most recent send, so a resend is an informed act. */
export async function lastOrderEmail(
  siteId: number,
  documentId: number,
): Promise<{ detail: string | null; userName: string; at: Date } | null> {
  if (!(await auditTableExists(siteId))) return null
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT detail, user_name, created_at FROM purchase_document_audit
      WHERE document_id = ? AND action IN ('emailed','re_emailed')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [documentId],
  )
  if (!row) return null
  return {
    detail: (row.detail as string | null) ?? null,
    userName: String(row.user_name ?? ''),
    at: row.created_at as Date,
  }
}
