import 'server-only'
import PDFDocument from 'pdfkit'
import { formatMoney } from '../decimals'
import { inflateSync } from 'node:zlib'
import { readStoredFile } from '../uploads'
import type { JobReportData, ReportCheck } from './render'

/**
 * The job card as a PDF the customer can be handed.
 *
 * Draws only what buildJobReport() assembled, so what may be seen is decided in
 * one place — see that module's header. Laid out by hand for the reason
 * statements/pdf.ts gives: a headless browser is a 300MB dependency and a second
 * runtime, for a document that is a letterhead, some lists and a signature box.
 *
 * pdfkit is in serverExternalPackages (next.config.mjs) — it reads its fonts
 * from disk at runtime, which a bundler would inline or break. Verify any change
 * here against a PRODUCTION build, not just `next dev`.
 *
 * ── IT EMBEDS IMAGES, WHICH NO OTHER PDF HERE DOES ─────────────────────────
 *
 * A photograph and a signature are the point of this document — a checklist that
 * says "Signed" without the mark proves nothing. So the bytes are read from disk
 * and drawn.
 *
 * Two rules make that safe. Every image is scaled to fit a FIXED box, because a
 * customer's phone photo is 4000px wide and pdfkit will happily draw it off the
 * page. And a file that cannot be read is SKIPPED with a line of text, never
 * thrown — a missing photo must not be the reason a whole report fails.
 */

/* A4 at 72dpi, which is pdfkit's unit. */
const PAGE_WIDTH = 595.28
const MARGIN = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

/** The y past which a new page is started. Matches statements/pdf.ts. */
const PAGE_BREAK = 700

/** Greys, since a PDF has no access to the app's CSS tokens. */
const INK = '#16191d'
const MUTED = '#667085'
const LINE = '#d0d5dd'

/** Photos are boxed so a 4000px phone picture cannot run off the page. */
const PHOTO_BOX = { width: 150, height: 110 }
/** A signature is wider than tall; 600px wide as captured (job_signature_width). */
const SIGNATURE_BOX = { width: 200, height: 60 }


/**
 * The report, as bytes.
 *
 * Async because it reads attachments from disk — the one way this differs from
 * renderStatementPdf, which needs nothing but its data.
 */
export async function renderJobReportPdf(data: JobReportData): Promise<Buffer> {
  // Read every attachment FIRST, before drawing starts.
  //
  // pdfkit's document stream is synchronous once open: awaiting inside draw()
  // would interleave writes with the 'data' handler and produce a corrupt file.
  // So the I/O happens here and draw() stays synchronous.
  const images = new Map<string, Buffer>()
  const toRead = [
    ...data.checks.map((c) => c.attachment),
    // The two sign-off marks (159), which are not checklist evidence and so are
    // not in data.checks. Omitting them here would leave the block ruled and
    // named with no mark drawn above the line — signed, and looking unsigned.
    data.signOff.customerSignature,
    data.signOff.technicianSignature,
  ]
  for (const attachment of toRead) {
    if (!attachment || images.has(attachment.storedName)) continue
    const bytes = await readStoredFile(attachment.storedName).catch(() => null)
    if (bytes && isDrawable(bytes)) images.set(attachment.storedName, bytes)
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      draw(doc, data, images)
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Whether pdfkit can actually draw these bytes.
 *
 * ── WHY A try/catch AROUND doc.image() IS NOT ENOUGH ───────────────────────
 *
 * Found by feeding the report a malformed PNG, which killed the whole node
 * process. pdfkit's PNG decoder inflates the pixel data on a LATER TICK and
 * rethrows from inside a zlib callback — so the error arrives with no caller on
 * the stack, escaping the try/catch at the draw site, escaping the Promise, and
 * taking the server down. `doc.image()` had already returned successfully.
 *
 * A corrupt customer photograph must not be able to do that. So the bytes are
 * validated BEFORE pdfkit sees them, and for PNGs that means doing the same
 * inflate synchronously, where a throw is catchable. The try/catch at the draw
 * site stays as a second line for whatever this does not anticipate.
 *
 * Note pdfkit sniffs CONTENT, not the extension: a PNG saved as .pdf is still
 * decoded as a PNG, so checking the filename would prove nothing.
 */
function isDrawable(bytes: Buffer): boolean {
  if (bytes.length < 32) return false

  // JPEG: SOI at the front, EOI at the back. pdfkit reads the header only and
  // does not inflate anything, so a well-formed one cannot throw the way a PNG
  // can.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  }

  const isPng =
    bytes.length > 24 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR'
  if (!isPng) {
    // A PDF, an iPhone HEIC, a renamed file. pdfkit draws neither.
    return false
  }

  if (bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) return false

  /*
   * INFLATE THE PIXEL DATA HERE, where a throw can be caught.
   *
   * This is the whole reason the function exists, and it was found by feeding
   * the report a malformed PNG: pdfkit's decoder inflates on a LATER TICK and
   * rethrows from inside a zlib callback, so the error arrives with no caller
   * on the stack. It escapes the try/catch at the draw site, escapes the
   * Promise, and takes the process down — a corrupt customer photograph
   * crashing the server.
   *
   * Doing the same inflate synchronously first means a bad file is simply not
   * drawn. It costs one decompression per photograph, which is the price of a
   * report that cannot be killed by its own evidence.
   */
  try {
    const idat: Buffer[] = []
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
      if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
      if (type === 'IEND') break
      offset += 12 + length
    }
    if (idat.length === 0) return false
    inflateSync(Buffer.concat(idat))
    return true
  } catch {
    return false
  }
}

function draw(
  doc: PDFKit.PDFDocument,
  data: JobReportData,
  images: Map<string, Buffer>,
) {
  // ── Letterhead
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(data.site.name, MARGIN, MARGIN)
  if (data.site.vatNumber) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`VAT no. ${data.site.vatNumber}`)
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text('SERVICE REPORT', MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' })
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(data.job.documentNumber ?? `Job ${data.job.id}`, MARGIN, MARGIN + 20, {
      width: CONTENT_WIDTH,
      align: 'right',
    })

  let y = MARGIN + 48
  rule(doc, y)
  y += 14

  // ── Who and where, left; when and what stage, right
  const blockTop = y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('CUSTOMER', MARGIN, y)
  y += 13
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(data.customer.name ?? 'Walk-in', MARGIN, y)
  y += 13
  doc.font('Helvetica').fontSize(9).fillColor(INK)
  if (data.customer.phone) {
    doc.text(data.customer.phone, MARGIN, y)
    y += 11
  }
  if (data.address) {
    doc.fontSize(8).fillColor(MUTED).text(data.address.name, MARGIN, y)
    y += 11
    doc.fillColor(INK).fontSize(9)
    for (const line of data.address.lines) {
      doc.text(line, MARGIN, y)
      y += 11
    }
  }

  const detailX = MARGIN + CONTENT_WIDTH - 190
  let detailY = blockTop
  for (const [label, value] of [
    ['Logged', data.job.reportedAt ?? '—'],
    ...(data.job.closedAt ? [['Completed', data.job.closedAt]] : []),
    ['Stage', data.job.statusName],
    ...(data.job.reference ? [['Your reference', data.job.reference]] : []),
  ] as [string, string][]) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, detailX, detailY, { width: 95 })
    doc.fillColor(INK).text(value, detailX + 95, detailY, { width: 95, align: 'right' })
    detailY += 13
  }

  y = Math.max(y, detailY) + 12
  rule(doc, y)
  y += 16

  // ── What was asked for, in the customer's own words
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(data.job.title, MARGIN, y)
  y = doc.y + 4
  if (data.job.description) {
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(data.job.description, MARGIN, y, {
      width: CONTENT_WIDTH,
    })
    y = doc.y + 8
  }

  // ── When somebody attended
  if (data.visits.length > 0) {
    y = heading(doc, y, 'Visits')
    for (const visit of data.visits) {
      y = pageBreak(doc, y)
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(INK)
        .text(visit.startsAt ?? 'To be arranged', MARGIN, y, { width: 200 })
      doc
        .fillColor(MUTED)
        .text(`${visit.durationMinutes} min · ${visit.status}`, MARGIN + 200, y, { width: 200 })
      y += 13
    }
    y += 6
  }

  // ── What was done, grouped by the form that asked
  if (data.checks.length > 0) {
    y = heading(doc, y, 'What was done')
    /*
     * Grouped by FORM since 224 retired the checklist. It used to group by
     * before/during/after, which was a property of a checklist item and has no
     * equivalent on a form — a form orders itself and its own headings say
     * where the reader is.
     *
     * The grouping is derived from the order the rows arrive in rather than
     * sorted, because answeredFieldsFor already returns them by response and
     * then by field position. Re-sorting here would put a form's questions in
     * an order nobody chose.
     */
    const formNames = [...new Set(data.checks.map((c) => c.formName))]
    for (const formName of formNames) {
      const inPhase = data.checks.filter((c) => c.formName === formName)
      if (inPhase.length === 0) continue

      /*
       * The phase heading must not be the last thing on a page.
       *
       * Reserved with its first item's height, so "AFTER THE WORK" cannot sit
       * alone at the foot with the signature it introduces overleaf — which is
       * exactly what happened before this line, leaving a hand-sized blank gap
       * and an orphaned heading.
       */
      const first = inPhase[0]
      const firstNeeds =
        first.attachment && images.has(first.attachment.storedName)
          ? (first.answer === 'Signed' ? SIGNATURE_BOX : PHOTO_BOX).height + 40
          : 40
      y = pageBreak(doc, y, 13 + firstNeeds)

      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(MUTED)
        .text(formName.toUpperCase(), MARGIN, y)
      y += 13

      for (const check of inPhase) {
        y = drawCheck(doc, y, check, images)
      }
      y += 4
    }
  }

  // ── What is being charged
  if (data.lines.length > 0) {
    y = heading(doc, y, 'What is being charged')
    y = lineHeader(doc, y)
    for (const line of data.lines) {
      if (y > PAGE_BREAK) {
        doc.addPage()
        y = MARGIN
        y = lineHeader(doc, y)
      }
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      doc.text(line.description, MARGIN, y, { width: 300, ellipsis: true })
      doc.text(String(line.qty), MARGIN + 300, y, { width: 60, align: 'right' })
      doc.text(formatMoney(line.priceIncl), MARGIN + 360, y, { width: 139, align: 'right' })
      y += 14
    }
    rule(doc, y)
    y += 6
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
    doc.text('Total incl VAT', MARGIN + 240, y, { width: 120, align: 'right' })
    doc.text(formatMoney(data.total), MARGIN + 360, y, { width: 139, align: 'right' })
    y += 20
  }

  // ── Sign-off
  //
  // Always drawn, even with nothing in it: a service report with no space for a
  // signature is a report somebody has to hand-rule a line onto.
  y = pageBreak(doc, y, 160)
  y = heading(doc, y, 'Sign-off')
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(data.signatureStatement, MARGIN, y, { width: CONTENT_WIDTH })
  y = doc.y + 10

  const boxWidth = (CONTENT_WIDTH - 20) / 2
  for (const [index, party] of (
    [
      [
        'Customer',
        data.signOff.customerName,
        data.signOff.customerAt,
        data.signOff.customerSignature,
      ],
      [
        'On behalf of ' + data.site.name,
        data.signOff.technicianName,
        data.signOff.technicianAt,
        data.signOff.technicianSignature,
      ],
    ] as [string, string | null, string | null, { storedName: string } | null][]
  ).entries()) {
    const x = MARGIN + index * (boxWidth + 20)

    /*
     * The mark, above the rule.
     *
     * `fit` scales the PNG down into the space between the top of the block and
     * the line at y + 40, and never scales it UP: a small mark drawn at full
     * width would be a blurry smear, and a signature is evidence. It sits above
     * the printed name so the layout reads the way a signed page does.
     *
     * A signature whose file could not be read simply does not draw, leaving the
     * name and the date. The alternative — failing the whole report — would mean
     * a deleted file could stop a customer being handed anything at all.
     */
    const signature = party[3]
    const bytes = signature ? images.get(signature.storedName) : undefined
    if (bytes) {
      try {
        // No `align`: pdfkit's image options offer only center and right, and
        // left is the default — a signature sits at the start of its line.
        doc.image(bytes, x, y, { fit: [boxWidth, 24], valign: 'bottom' })
      } catch {
        // isDrawable already rejected the files pdfkit chokes on synchronously;
        // this is the belt to that braces. A report must not die for a mark.
      }
    }

    doc
      .moveTo(x, y + 40)
      .lineTo(x + boxWidth, y + 40)
      .lineWidth(0.5)
      .strokeColor(LINE)
      .stroke()
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(party[0], x, y + 45, { width: boxWidth })
    if (party[1]) {
      doc.fontSize(9).fillColor(INK).text(party[1], x, y + 26, { width: boxWidth })
    }
    if (party[2]) {
      doc.fontSize(7.5).fillColor(MUTED).text(party[2], x, y + 57, { width: boxWidth })
    }
  }
}

/** One checklist result, with its evidence if there is any. */
function drawCheck(
  doc: PDFKit.PDFDocument,
  yIn: number,
  check: ReportCheck,
  images: Map<string, Buffer>,
): number {
  const bytes = check.attachment ? images.get(check.attachment.storedName) : undefined
  const isSignature = check.answer === 'Signed'
  const box = isSignature ? SIGNATURE_BOX : PHOTO_BOX

  /*
   * Reserve the WHOLE row — label, note and image — before deciding to break.
   *
   * pdfkit does not refuse to draw past the foot of a page; it draws into the
   * void and the content is simply not on the paper. That produced a report
   * whose last checklist item said "Signed" with the signature nowhere to be
   * seen — the image was in the file, below the page. Every path through this
   * function must therefore be measured before any of it is drawn.
   */
  /*
   * The note line and the failure styling went with the checklist (224).
   *
   * A form field cannot be "failed": what counts as a failure is the question's
   * own wording, and drawing "250 kPa" in red would mean this module deciding
   * something the business never told it. A form asks a second question instead,
   * which prints as its own row — and reads better than a caption did.
   */
  const needed = 13 + (bytes ? box.height + 8 : check.attachment ? 14 : 0)
  let y = pageBreak(doc, yIn, needed)

  doc.font('Helvetica').fontSize(9).fillColor(INK).text(check.name, MARGIN, y, { width: 300 })
  doc
    .font('Helvetica')
    .fillColor(INK)
    .text(check.answer, MARGIN + 300, y, { width: 199, align: 'right' })
  y += 13

  if (bytes) {
    /*
     * Break HERE too, not only before the row.
     *
     * The reserve above covers the common case, but a note that wrapped onto
     * three lines can still push the image past the foot — and pdfkit does not
     * refuse to draw off the page, it simply draws into the void. The result is
     * a checklist that says "Signed" with nothing beneath it, which was exactly
     * the bug: the image WAS in the PDF, just below the paper.
     */
    if (y + box.height > PAGE_BREAK) {
      doc.addPage()
      y = MARGIN
    }
    try {
      // `fit` scales to the box and preserves aspect ratio, so an arbitrary
      // phone photo cannot overflow the page.
      doc.image(bytes, MARGIN + 12, y, { fit: [box.width, box.height] })
      y += box.height + 8
    } catch {
      // Not a format pdfkit can draw (HEIC, a PDF attachment, a corrupt file).
      // Say so rather than dropping the evidence silently.
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(MUTED)
        .text('Attachment could not be displayed here.', MARGIN + 12, y)
      y += 14
    }
  } else if (check.attachment) {
    /*
     * The item HAS evidence, but it could not be drawn — the file is gone, is
     * truncated, or is a format pdfkit cannot render (a PDF, an iPhone HEIC).
     *
     * Said rather than hidden, and said without guessing which: a customer
     * reading "photograph attached" with no photograph beneath it would
     * reasonably conclude the report was wrong.
     */
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(MUTED)
      .text('The attached file could not be shown here.', MARGIN + 12, y)
    y += 14
  }

  return y
}

function heading(doc: PDFKit.PDFDocument, yIn: number, text: string): number {
  const y = pageBreak(doc, yIn, 40)
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(text, MARGIN, y)
  const next = y + 16
  rule(doc, next - 4)
  return next
}

/** Starts a new page when the next block would not fit. */
function pageBreak(doc: PDFKit.PDFDocument, y: number, needed = 20): number {
  if (y + needed > PAGE_BREAK) {
    doc.addPage()
    return MARGIN
  }
  return y
}

function lineHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  doc.text('DESCRIPTION', MARGIN, y, { width: 300 })
  doc.text('QTY', MARGIN + 300, y, { width: 60, align: 'right' })
  doc.text('AMOUNT', MARGIN + 360, y, { width: 139, align: 'right' })
  const next = y + 14
  rule(doc, next - 3)
  return next
}

function rule(doc: PDFKit.PDFDocument, y: number) {
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.5)
    .strokeColor(LINE)
    .stroke()
}
