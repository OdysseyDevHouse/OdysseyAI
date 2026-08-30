import 'server-only'
import { taxLabel } from '../site/taxIdentity'
import { qrContextFor } from '../site/qrLinks'
import { pictureIds, pictureBytes } from '../site/stationeryImages'
import PDFDocument from 'pdfkit'
import { formatMoney } from '../decimals'

/**
 * An invoice as a PDF.
 *
 * Built the way statements/pdf.ts is built, and for the same reasons: laid out
 * by hand rather than through an HTML renderer, because a headless browser is a
 * 300MB dependency and a second runtime to keep alive for a document that is a
 * letterhead, a table and a totals box.
 *
 * pdfkit is in serverExternalPackages (next.config.mjs) — it reads its font
 * files from disk at runtime, which a bundler would otherwise inline or break.
 * Verify any change here against a PRODUCTION build, not just `next dev`.
 *
 * ── WHY THIS IS A TAX INVOICE AND SAYS SO ────────────────────────────────
 *
 * A South African VAT vendor's invoice must carry the words "TAX INVOICE", both
 * parties' names, the supplier's VAT number, a serial number, the date, and the
 * VAT either shown separately or stated as included. Section 20(4) of the VAT
 * Act. A customer cannot claim input VAT on a document missing any of them, so
 * these are not decoration — an invoice without them will come back.
 *
 * The heading falls back to "INVOICE" when the business has no VAT number,
 * because a non-vendor calling its document a tax invoice is its own problem.
 */

/* A4 at 72dpi, which is pdfkit's unit. Same page geometry as the statement. */
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

/* Greys, since a PDF has no access to the app's CSS tokens. Matched to
   statements/pdf.ts so the two documents look like one business wrote them. */
const INK = '#16191d'
const MUTED = '#667085'
const LINE = '#d0d5dd'
const ACCENT = '#16191d'

type Column = { label: string; width: number; align?: 'left' | 'right' }

/* Widths sum to CONTENT_WIDTH (499pt). The money columns are wide enough for
   "R123 456.78" at 8.5pt without wrapping — a wrapped amount reads as two
   numbers, which on an invoice is worse than an ugly column. */
const COLUMNS: Column[] = [
  { label: 'Code', width: 62 },
  { label: 'Description', width: 197 },
  { label: 'Qty', width: 40, align: 'right' },
  { label: 'Unit price', width: 68, align: 'right' },
  { label: 'VAT', width: 40, align: 'right' },
  { label: 'Amount', width: 92, align: 'right' },
]

export type InvoiceLine = {
  productCode: string | null
  description: string
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  lineTotalIncl: number
}

export type InvoiceData = {
  /** The business issuing it. */
  site: {
    name: string
    vatNumber: string | null
    addressLines?: string[]
    phone?: string | null
    email?: string | null
    registrationNumber?: string | null
  }
  /** Where the money should go. Omitted entirely when not configured. */
  banking?: {
    bank: string | null
    accountName: string | null
    accountNumber: string | null
    branchCode: string | null
  } | null
  customer: {
    code: string | null
    name: string
    vatNumber: string | null
    phone: string | null
    addressLines: string[]
  }
  documentNumber: string | null
  documentDate: string
  dueDate: string | null
  reference: string | null
  notes: string | null
  lines: InvoiceLine[]
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  totalIncl: number
  /**
   * A "pay online" link, when one has been minted for this invoice. Drawn as a
   * real PDF link annotation as well as visible text — a URL nobody can click
   * in a PDF is a URL nobody uses.
   */
  paymentUrl?: string | null
  /** Free text under the totals — "Contract CON000012, March 2027". */
  footNote?: string | null
  /**
   * Nothing is owed on this invoice any more.
   *
   * ── WHY THE CALLER DECIDES, AND NOT THIS FILE ────────────────────────────
   *
   * "Paid" is a question about the LEDGER, not about the document: an account
   * invoice is settled by a receipt allocated against it, which lives in the
   * customer database and is not part of the figures used to draw the page. A
   * renderer that went looking would be a print path issuing its own queries,
   * and would make every emailed invoice slower to satisfy a stamp.
   *
   * So the caller — which has already asked `outstandingForDocument` for its own
   * reasons — says so. Undefined means "not known", which prints nothing rather
   * than claiming unpaid: an invoice wrongly stamped PAID is a debt nobody
   * chases, and one wrongly stamped UNPAID is an argument with a customer who
   * has the receipt.
   */
  paidInFull?: boolean
  generatedAt: Date
}

/**
 * An invoice as a PDF — from the site's own design where it has one.
 *
 * ── THE DESIGN NOW REACHES THE EMAIL ──────────────────────────────────────
 *
 * A shop that redesigned its invoice used to change the PRINTED copy and not
 * the one that lands in the customer's inbox, because this file drew a fixed
 * layout that read no template. Passing a siteId resolves that site's active
 * design and draws it instead; the hand-drawn layout below stays as the fallback
 * for a site that has designed nothing, and for the case where reading the
 * design fails.
 *
 * ── FAILURE FALLS BACK, IT DOES NOT THROW ─────────────────────────────────
 *
 * An invoice that will not send because a template row is unreadable is a worse
 * failure than one that sends looking ordinary. So every step of resolving the
 * design is caught, and a miss lands on `draw` — the same document this function
 * has always produced.
 *
 * Omitting the siteId keeps the old behaviour exactly, which is what makes this
 * safe to adopt one caller at a time.
 */
export async function renderInvoicePdf(
  data: InvoiceData,
  siteId?: number,
  /**
   * What this paper calls itself, and what it asks the reader to do.
   *
   * Passed in because InvoiceData carries no document TYPE — it is assembled the
   * same way for an invoice and for a credit note. Without it the heading fell
   * back to the VAT-vendor rule, so an emailed CREDIT NOTE called itself
   * INVOICE, carried a negative total and explained nothing. The caller knows
   * which it is; this function cannot.
   */
  kind?: {
    heading?: string
    closing?: string
    /**
     * The document's own pay link, for a QR block aimed at "this document".
     *
     * Passed in rather than derived here, because InvoiceData carries no
     * document TYPE or status and this function cannot tell an invoice from a
     * credit note — the same reason `heading` is a parameter. The caller knows
     * which it is; see documentPayUrl in site/qrLinks.ts for which documents
     * get one and why a credit note never does.
     */
    payUrl?: string | null
  },
): Promise<Buffer> {
  if (siteId !== undefined) {
    const designed = await renderDesignedInvoice(data, siteId, kind).catch(() => null)
    if (designed) return designed
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      draw(doc, data, kind?.heading)
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * The site's design, drawn — or null to fall back.
 *
 * Null rather than a throw for anything that goes wrong, because the caller is
 * sending an invoice to a customer and the shipped layout is a perfectly good
 * invoice. The one thing that must not happen is no invoice at all.
 */
async function renderDesignedInvoice(
  data: InvoiceData,
  siteId: number,
  kind?: { heading?: string; closing?: string; payUrl?: string | null },
): Promise<Buffer | null> {
  const { activeTemplate } = await import('../site/stationeryTemplates')
  const custom = await activeTemplate(siteId, 'invoice').catch(() => null)

  /*
   * Only a BLOCK design can be drawn. A site that chose the HTML editor has
   * markup this cannot render — there is no honest way to draw arbitrary HTML
   * with pdfkit — so it keeps the hand-drawn layout, and the setup screen already
   * says the emailed copy follows the standard layout.
   */
  const { parseSpec } = await import('../stationery/blocks')
  const { INVOICE_BLOCKS } = await import('../stationery/defaults/invoiceBlocks')

  const spec =
    custom?.format === 'blocks' && custom.body
      ? parseSpec(custom.body, 'invoice')
      : custom
        ? null // markup design: not drawable, keep the hand-drawn layout
        : INVOICE_BLOCKS // nothing designed: the shipped block layout

  if (!spec || spec.blocks.length === 0) return null

  const { invoiceDataTokens } = await import('../stationery/adapters/invoiceData')
  const { renderSpecPdf } = await import('../stationery/pdf')
  const { readLogo } = await import('../site/documentLogo')

  /*
   * ── TWO REASONS TO LEAVE THE LOGO OFF ──────────────────────────────
   *
   * FORMAT: pdfkit reads PNG and JPEG and nothing else — a GIF or a WebP would
   * throw mid-draw and lose the whole invoice.
   *
   * SIZE: a PDF EMBEDS its images, and pdfkit stores a PNG's pixels without
   * re-compressing them. The 2MB logo on this dev site became a 2.1MB image in
   * every emailed invoice — the HTML page gets away with the same file because
   * the browser fetches it once over /api/document-logo and caches it, and a
   * mailbox does not work that way.
   *
   * A logo above the cap is therefore left off rather than sent. The invoice is
   * a little plainer, it still arrives, and the shop can upload a smaller file —
   * which is the right trade against attaching two megabytes to every email.
   */
  const MAX_LOGO_BYTES = 512 * 1024
  const found = await readLogo(siteId).catch(() => null)
  const logo =
    found && (found.format === 'png' || found.format === 'jpeg') && found.bytes.length <= MAX_LOGO_BYTES
      ? found
      : null

  const input = invoiceDataTokens(data, {
    ...kind,
    printedAt: data.generatedAt.toLocaleString('en-ZA', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
    // The token itself is never drawn as text; the bytes go in separately.
    logoHtml: null,
    taxLabel: await taxLabel(siteId),
  })

  /*
   * The pictures the design actually uses, read once. An emailed document
   * carries its images as bytes, so only what is on the page is fetched.
   */
  const usedPictures = spec.blocks
    .filter((b) => b.kind === 'image' && b.imageId)
    .map((b) => b.imageId as number)

  return renderSpecPdf(
    spec,
    'invoice',
    {
      ...input,
      pictures: await pictureIds(siteId),
      // The pay link finally answers the "this document" QR target, which every
      // caller has left null since it was written. See documentPayUrl.
      qr: await qrContextFor(siteId, kind?.payUrl ?? null),
    },
    logo?.bytes ?? null,
    usedPictures.length ? await pictureBytes(siteId, usedPictures) : undefined,
  )
}

function draw(doc: PDFKit.PDFDocument, data: InvoiceData, heading?: string) {
  const isTaxInvoice = !!data.site.vatNumber

  // ── Letterhead ─────────────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(data.site.name, MARGIN, MARGIN)

  let headY = doc.y + 2
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  for (const line of (data.site.addressLines ?? []).filter(Boolean)) {
    doc.text(line, MARGIN, headY, { width: 260 })
    headY = doc.y
  }
  const contact = [data.site.phone, data.site.email].filter(Boolean).join(' · ')
  if (contact) {
    doc.text(contact, MARGIN, headY, { width: 260 })
    headY = doc.y
  }
  if (data.site.registrationNumber) {
    doc.text(`Reg. ${data.site.registrationNumber}`, MARGIN, headY, { width: 260 })
    headY = doc.y
  }
  if (data.site.vatNumber) {
    doc.text(`VAT no. ${data.site.vatNumber}`, MARGIN, headY, { width: 260 })
    headY = doc.y
  }

  // Title block, right-aligned against the letterhead.
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(ACCENT)
    .text(heading ?? (isTaxInvoice ? 'TAX INVOICE' : 'INVOICE'), MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: 'right',
    })

  if (data.documentNumber) {
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(data.documentNumber, MARGIN, MARGIN + 21, { width: CONTENT_WIDTH, align: 'right' })
  } else {
    // An unposted invoice has no number yet. Saying so is better than a blank
    // space that reads as a printing fault — and better than inventing one.
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(MUTED)
      .text('DRAFT — not yet issued', MARGIN, MARGIN + 21, {
        width: CONTENT_WIDTH,
        align: 'right',
      })
  }

  let y = Math.max(headY, MARGIN + 40) + 12
  rule(doc, y)
  y += 14

  // ── Bill-to, left; invoice facts, right ────────────────────────────────
  const blockTop = y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('INVOICE TO', MARGIN, y)
  y += 13
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(data.customer.name, MARGIN, y, {
    width: 260,
  })
  y = doc.y + 1

  doc.font('Helvetica').fontSize(9).fillColor(INK)
  for (const line of data.customer.addressLines.filter(Boolean)) {
    doc.text(line, MARGIN, y, { width: 260 })
    y = doc.y
  }
  if (data.customer.phone) {
    doc.fontSize(8).fillColor(MUTED).text(data.customer.phone, MARGIN, y, { width: 260 })
    y = doc.y
  }
  if (data.customer.vatNumber) {
    doc.fontSize(8).fillColor(MUTED).text(`VAT no. ${data.customer.vatNumber}`, MARGIN, y)
    y = doc.y
  }

  const detailX = MARGIN + CONTENT_WIDTH - 210
  let detailY = blockTop
  const facts: [string, string][] = [
    ['Invoice date', data.documentDate],
    ...(data.dueDate ? ([['Due date', data.dueDate]] as [string, string][]) : []),
    ...(data.customer.code ? ([['Account', data.customer.code]] as [string, string][]) : []),
    ...(data.reference ? ([['Your reference', data.reference]] as [string, string][]) : []),
  ]
  for (const [label, value] of facts) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, detailX, detailY, { width: 105 })
    doc
      .fillColor(INK)
      .text(value, detailX + 105, detailY, { width: 105, align: 'right' })
    detailY += 13
  }

  y = Math.max(y, detailY) + 14

  // ── Lines ──────────────────────────────────────────────────────────────
  y = tableHeader(doc, y)

  for (const line of data.lines) {
    // A new page needs its header repeated, or page two is a wall of numbers
    // with nothing naming the columns. 690 leaves room for the tallest row.
    if (y > 690) {
      doc.addPage()
      y = MARGIN
      y = tableHeader(doc, y)
    }

    y = tableRow(doc, y, [
      line.productCode ?? '',
      line.description +
        (line.discountPct > 0 ? `\nLess ${trimNumber(line.discountPct)}% discount` : ''),
      trimNumber(line.qty),
      formatMoney(line.unitPriceIncl),
      line.vatRatePct > 0 ? `${trimNumber(line.vatRatePct)}%` : '—',
      formatMoney(line.lineTotalIncl),
    ])
  }

  y += 4
  rule(doc, y)
  y += 14

  // ── Totals ─────────────────────────────────────────────────────────────
  //
  // Everything the app stores is VAT-INCLUSIVE and the exclusive figure is
  // derived by subtraction (THE MONEY RULE, 001/015). The box states all three
  // so the customer can claim input VAT without doing the arithmetic — which is
  // what section 20(4) is really asking for.
  const boxWidth = 232
  const boxX = MARGIN + CONTENT_WIDTH - boxWidth
  const rows: [string, string, boolean][] = [
    ['Subtotal (excl. VAT)', formatMoney(data.subtotalExcl), false],
    ...(data.discountTotal > 0
      ? ([['Discount', `-${formatMoney(data.discountTotal)}`, false]] as [string, string, boolean][])
      : []),
    ['VAT', formatMoney(data.vatTotal), false],
    ['Total due', formatMoney(data.totalIncl), true],
  ]

  const boxHeight = rows.length * 16 + 12

  if (y + boxHeight > PAGE_HEIGHT - MARGIN - 60) {
    doc.addPage()
    y = MARGIN
  }

  doc.rect(boxX, y, boxWidth, boxHeight).lineWidth(0.5).strokeColor(LINE).stroke()

  let boxY = y + 8
  for (const [label, value, strong] of rows) {
    if (strong) {
      // A rule above the total, so the eye lands on the figure that matters.
      doc
        .moveTo(boxX + 10, boxY - 3)
        .lineTo(boxX + boxWidth - 10, boxY - 3)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke()
      boxY += 3
    }
    doc
      .font(strong ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(strong ? 10 : 9)
      .fillColor(strong ? INK : MUTED)
      .text(label, boxX + 10, boxY)
    doc
      .fillColor(INK)
      .text(value, boxX + 10, boxY, { width: boxWidth - 20, align: 'right' })
    boxY += strong ? 18 : 16
  }

  const afterBox = y + boxHeight + 16
  y = afterBox

  // ── Pay online ─────────────────────────────────────────────────────────
  //
  // A real link annotation, not just blue text: a URL that cannot be clicked in
  // the PDF is a URL nobody uses, and the whole point of the link is to shorten
  // the distance between reading the invoice and paying it.
  if (data.paymentUrl) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT).text('Pay this invoice online', MARGIN, y)
    const linkY = doc.y
    // Full content width, not the narrow column beside the totals box: the box
    // has already been drawn ABOVE this point, so there is nothing to avoid —
    // and a pay-link broken across two lines mid-token is one people retype
    // wrongly rather than click.
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    doc.text(data.paymentUrl, MARGIN, linkY, {
      width: CONTENT_WIDTH,
      link: data.paymentUrl,
      underline: true,
      lineBreak: false,
    })
    y = doc.y + 12
  }

  // ── Banking, notes, footer ─────────────────────────────────────────────
  if (data.banking && (data.banking.accountNumber || data.banking.bank)) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BANKING DETAILS', MARGIN, y)
    y = doc.y + 3
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
    const bankLine = [
      data.banking.accountName,
      data.banking.bank,
      data.banking.accountNumber ? `Acc ${data.banking.accountNumber}` : null,
      data.banking.branchCode ? `Branch ${data.banking.branchCode}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    doc.text(bankLine, MARGIN, y, { width: CONTENT_WIDTH })
    y = doc.y + 10
  }

  if (data.notes) {
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(data.notes, MARGIN, y, {
      width: CONTENT_WIDTH,
    })
    y = doc.y + 8
  }

  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  if (data.footNote) {
    doc.text(data.footNote, MARGIN, y, { width: CONTENT_WIDTH })
    y = doc.y + 2
  }
  if (data.documentNumber) {
    doc.text(
      `Please quote ${data.documentNumber}${data.customer.code ? ` and account ${data.customer.code}` : ''} with your payment.`,
      MARGIN,
      y,
      { width: CONTENT_WIDTH },
    )
    y = doc.y
  }
  doc.text(`Generated ${data.generatedAt.toLocaleString('en-ZA')} · E & O E`, MARGIN, y + 2)
}

function rule(doc: PDFKit.PDFDocument, y: number) {
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.5)
    .strokeColor(LINE)
    .stroke()
}

function tableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  let x = MARGIN
  for (const column of COLUMNS) {
    doc.text(column.label.toUpperCase(), x, y, {
      width: column.width - 6,
      align: column.align ?? 'left',
    })
    x += column.width
  }
  y += 12
  rule(doc, y)
  return y + 6
}

/** One row. Returns the y for the next one, since rows vary in height. */
function tableRow(doc: PDFKit.PDFDocument, y: number, cells: string[]): number {
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)

  let x = MARGIN
  let tallest = 0

  cells.forEach((cell, index) => {
    const column = COLUMNS[index]!
    const height = doc.heightOfString(cell, { width: column.width - 6 })
    doc.text(cell, x, y, { width: column.width - 6, align: column.align ?? 'left' })
    tallest = Math.max(tallest, height)
    x += column.width
  })

  return y + tallest + 6
}

/** 2 rather than 2.000, 2.5 rather than 2.500 — quantities read as counts. */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)))
}
