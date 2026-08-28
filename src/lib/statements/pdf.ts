import 'server-only'
import { taxLabel } from '../site/taxIdentity'
import { qrContextFor } from '../site/qrLinks'
import { pictureIds, pictureBytes } from '../site/stationeryImages'
import PDFDocument from 'pdfkit'
import { formatMoney } from '../decimals'
import { AGING_BUCKETS } from '../site/ledger'
import type { StatementData } from './render'

/**
 * The statement as a PDF.
 *
 * Draws from the same StatementData the on-screen preview renders, so the two
 * cannot disagree about a figure. Laid out by hand rather than through an HTML
 * renderer: a headless browser is a 300MB dependency and a second runtime to
 * keep alive, for a document that is a letterhead, a table and a totals box.
 *
 * pdfkit is in serverExternalPackages (next.config.mjs) — it reads its font
 * files from disk at runtime, which a bundler would otherwise inline or break.
 * Verify any change here against a PRODUCTION build, not just `next dev`.
 */

/* A4 at 72dpi, which is pdfkit's unit. */
const PAGE_WIDTH = 595.28
const MARGIN = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

/** Greys, since a PDF has no access to the app's CSS tokens. */
const INK = '#16191d'
const MUTED = '#667085'
const LINE = '#d0d5dd'
const DANGER = '#b42318'

type Column = { label: string; width: number; align?: 'left' | 'right' }

/* Widths sum to CONTENT_WIDTH (499pt). Money columns are wide enough for
   "R123 456.78" at 8.5pt without wrapping — a wrapped amount reads as two
   numbers, which on a statement is worse than an ugly column. */
const COLUMNS: Column[] = [
  { label: 'Date', width: 58 },
  { label: 'Document', width: 88 },
  { label: 'Description', width: 137 },
  { label: 'Debit', width: 72, align: 'right' },
  { label: 'Credit', width: 72, align: 'right' },
  /* "Outstanding" wraps at this width even at 8pt; "Balance" is what the
     activity format shows in this column anyway, and "Owing" says the same
     thing in half the space. */
  { label: 'Owing', width: 72, align: 'right' },
]

// Moved to variant.ts, which is client-safe: the stationery adapter needs to
// know what a statement is CALLED without importing this file's PDF stack.
export type { StatementVariant } from './variant'
import type { StatementVariant } from './variant'

/**
 * A statement, a supplier account or a remittance — from the site's own design
 * where it has one.
 *
 * ── THE DESIGN REACHES ALL THREE ──────────────────────────────────────────
 *
 * Passing a siteId resolves that site's active statement design and draws it
 * instead of the fixed layout below. One design serves all three variants,
 * because what differs between them arrives as tokens: {doc.heading} names the
 * paper, {totals.dueLabel} names the figure, and the age ladder simply has no
 * rows on a remittance so the table disappears.
 *
 * ── FAILURE FALLS BACK, IT DOES NOT THROW ─────────────────────────────────
 *
 * A statement that will not send because a template row is unreadable is worse
 * than one that sends looking ordinary — and a statement run sends hundreds at a
 * time, so one bad template must not take the run down. Every step of resolving
 * the design is caught, and a miss lands on `draw`.
 *
 * Omitting the siteId keeps the old behaviour exactly, which is what makes this
 * safe to adopt one caller at a time.
 */
export async function renderStatementPdf(
  data: StatementData,
  variant: StatementVariant = 'statement',
  siteId?: number,
): Promise<Buffer> {
  if (siteId !== undefined) {
    const designed = await renderDesignedStatement(data, variant, siteId).catch(() => null)
    if (designed) return designed
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      draw(doc, data, variant)
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * The site's design, drawn — or null to fall back.
 *
 * Null rather than a throw for anything that goes wrong: the caller is sending a
 * customer their statement, and the shipped layout is a perfectly good one. The
 * only thing that must not happen is no statement at all.
 */
async function renderDesignedStatement(
  data: StatementData,
  variant: StatementVariant,
  siteId: number,
): Promise<Buffer | null> {
  const { activeTemplate } = await import('../site/stationeryTemplates')
  const custom = await activeTemplate(siteId, 'statement').catch(() => null)

  /*
   * Only a BLOCK design can be drawn — there is no honest way to render
   * arbitrary HTML with pdfkit, so a site that chose the markup editor keeps the
   * hand-drawn layout. The setup screen says so.
   */
  const { parseSpec } = await import('../stationery/blocks')
  const { STATEMENT_BLOCKS } = await import('../stationery/defaults/statementBlocks')

  const spec =
    custom?.format === 'blocks' && custom.body
      ? parseSpec(custom.body, 'statement')
      : custom
        ? null
        : STATEMENT_BLOCKS

  if (!spec || spec.blocks.length === 0) return null

  const { statementTokens } = await import('../stationery/adapters/statement')
  const { renderSpecPdf } = await import('../stationery/pdf')
  const { readLogo } = await import('../site/documentLogo')

  /*
   * PNG or JPEG only, and under half a megabyte — pdfkit reads no other format
   * and stores a PNG's pixels uncompressed, so a large logo would be attached to
   * every statement in a run of hundreds. See lib/invoices/pdf.ts.
   */
  const MAX_LOGO_BYTES = 512 * 1024
  const found = await readLogo(siteId).catch(() => null)
  const logo =
    found &&
    (found.format === 'png' || found.format === 'jpeg') &&
    found.bytes.length <= MAX_LOGO_BYTES
      ? found
      : null

  /*
   * The full letterhead, which StatementData does not carry: its `site` is a
   * name and a VAT number, because the hand-drawn layout below needed no more.
   * A designed one can show an address, a phone number and a registration
   * number, so it is read here rather than by widening six call signatures for
   * data only one of them uses.
   *
   * A miss is not fatal — a statement with a shorter letterhead still says who
   * sent it and what is owed.
   */
  const { issuingSiteFor } = await import('../site/invoiceEmail')
  const letterhead = await issuingSiteFor(siteId).catch(() => null)

  const input = statementTokens(data, variant, {
    printedAt: data.generatedAt.toLocaleString('en-ZA', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
    siteAddress: letterhead
      ? [letterhead.address1, letterhead.address2, letterhead.address3, letterhead.postalCode]
          .filter((x): x is string => !!x && x.trim() !== '')
      : [],
    sitePhone: letterhead?.phone ?? null,
    siteEmail: letterhead?.email ?? null,
    siteRegistrationNumber: letterhead?.registrationNumber ?? null,
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
    'statement',
    { ...input, pictures: await pictureIds(siteId), qr: await qrContextFor(siteId) },
    logo?.bytes ?? null,
    usedPictures.length ? await pictureBytes(siteId, usedPictures) : undefined,
  )
}

function draw(doc: PDFKit.PDFDocument, data: StatementData, variant: StatementVariant) {
  const isRemittance = variant === 'remittance'
  // Our record of a supplier account. Keeps the ageing and the totals box, but
  // must not address the reader as the debtor — see StatementDocument.
  const isSupplier = variant === 'supplier-statement'

  // ── Letterhead
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(data.site.name, MARGIN, MARGIN)
  if (data.site.vatNumber) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`VAT no. ${data.site.vatNumber}`)
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(isRemittance ? 'REMITTANCE ADVICE' : isSupplier ? 'SUPPLIER ACCOUNT' : 'STATEMENT', MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: 'right',
    })
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(data.periodLabel, MARGIN, MARGIN + 20, {
      width: CONTENT_WIDTH,
      align: 'right',
    })

  let y = MARGIN + 48
  rule(doc, y)
  y += 14

  // ── Account block, address left and terms right
  const addressTop = y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('ACCOUNT', MARGIN, y)
  y += 13
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(data.account.name, MARGIN, y)
  y += 13
  doc.font('Helvetica').fontSize(9).fillColor(INK)
  for (const line of [data.account.contactName, ...data.account.addressLines].filter(Boolean)) {
    doc.text(String(line), MARGIN, y)
    y += 11
  }
  if (data.account.vatNumber) {
    doc.fontSize(8).fillColor(MUTED).text(`VAT no. ${data.account.vatNumber}`, MARGIN, y)
    y += 11
  }

  const detailX = MARGIN + CONTENT_WIDTH - 190
  let detailY = addressTop
  for (const [label, value] of [
    ['Account code', data.account.code],
    ['Terms', data.account.paymentTermsDays === 0 ? 'Cash on delivery' : `${data.account.paymentTermsDays} days`],
    ['Statement date', data.period.to],
    ...(!isRemittance && data.account.creditLimit > 0
      ? [['Credit limit', formatMoney(data.account.creditLimit)]]
      : []),
  ] as [string, string][]) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, detailX, detailY, { width: 95 })
    doc.fillColor(INK).text(value, detailX + 95, detailY, { width: 95, align: 'right' })
    detailY += 13
  }

  y = Math.max(y, detailY) + 12

  // ── Transactions
  y = tableHeader(doc, y)

  if (data.format === 'activity') {
    y = tableRow(doc, y, ['', '', 'Balance brought forward', '', '', formatMoney(data.openingBalance)])
  }

  if (data.lines.length === 0) {
    // Same wording rule as the on-screen document, so the two cannot disagree.
    y = tableRow(doc, y, [
      '',
      '',
      data.format === 'activity' ? 'No movements in this period.' : 'Nothing outstanding — thank you.',
      '',
      '',
      '',
    ])
  }

  for (const line of data.lines) {
    // A new page needs its header repeated, or page two is a wall of numbers
    // with nothing naming the columns.
    if (y > 700) {
      doc.addPage()
      y = MARGIN
      y = tableHeader(doc, y)
    }

    y = tableRow(
      doc,
      y,
      [
        line.date,
        `${line.docType}${line.docNumber ? `\n${line.docNumber}` : ''}`,
        line.description + (line.daysOverdue > 0 ? `\n${line.daysOverdue} days overdue` : ''),
        line.debit ? formatMoney(line.debit) : '',
        line.credit ? formatMoney(line.credit) : '',
        formatMoney(data.format === 'open-item' ? Math.abs(line.outstanding) : line.balance),
      ],
      line.daysOverdue > 0,
    )
  }

  y += 6
  rule(doc, y)
  y += 16

  // ── Age analysis
  if (!isRemittance) {
    if (y > 660) {
      doc.addPage()
      y = MARGIN
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('AGE ANALYSIS', MARGIN, y)
    y += 14

    const cellWidth = CONTENT_WIDTH / 6
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    AGING_BUCKETS.forEach((bucket, index) => {
      doc.text(data.bucketLabels[bucket], MARGIN + index * cellWidth, y, {
        width: cellWidth - 6,
        align: 'right',
      })
    })
    doc.text('Total', MARGIN + 5 * cellWidth, y, { width: cellWidth - 6, align: 'right' })
    y += 12

    doc.font('Helvetica').fontSize(9).fillColor(INK)
    AGING_BUCKETS.forEach((bucket, index) => {
      doc
        .fillColor(bucket === 'd90' || bucket === 'd120' ? DANGER : INK)
        .text(formatMoney(data.aging[bucket]), MARGIN + index * cellWidth, y, {
          width: cellWidth - 6,
          align: 'right',
        })
    })
    doc
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text(formatMoney(data.aging.total), MARGIN + 5 * cellWidth, y, {
        width: cellWidth - 6,
        align: 'right',
      })
    y += 22
  }

  // ── Totals box
  const boxWidth = 200
  const boxX = MARGIN + CONTENT_WIDTH - boxWidth
  // A remittance that took a discount shows the arithmetic — invoices, less
  // discount, equals paid — so the supplier can reconcile it rather than
  // reading the payment as short by the discount.
  const discount = data.settlementDiscount ?? 0
  const showsDiscount = isRemittance && discount > 0
  const boxHeight = showsDiscount ? 64 : !isRemittance && data.dueNow > 0 ? 46 : 28

  doc.rect(boxX, y, boxWidth, boxHeight).lineWidth(0.5).strokeColor(LINE).stroke()

  let boxY = y + 8
  if (!isRemittance && data.dueNow > 0) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Overdue', boxX + 10, boxY)
    doc
      .font('Helvetica-Bold')
      .fillColor(DANGER)
      .text(formatMoney(data.dueNow), boxX + 10, boxY, { width: boxWidth - 20, align: 'right' })
    boxY += 18
  }

  if (showsDiscount) {
    const gross = Math.abs(data.closingBalance) + discount

    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Invoices settled', boxX + 10, boxY)
    doc.text(formatMoney(gross), boxX + 10, boxY, { width: boxWidth - 20, align: 'right' })
    boxY += 15

    doc.text('Settlement discount', boxX + 10, boxY)
    doc.text(`-${formatMoney(discount)}`, boxX + 10, boxY, {
      width: boxWidth - 20,
      align: 'right',
    })
    boxY += 18
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(
      isRemittance ? 'Amount paid' : isSupplier ? 'Balance owed' : 'Amount due',
      boxX + 10,
      boxY,
    )
  doc.text(formatMoney(Math.abs(data.closingBalance)), boxX + 10, boxY, {
    width: boxWidth - 20,
    align: 'right',
  })

  y += boxHeight + 20

  // ── Footer
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  doc.text(
    isRemittance
      ? 'Payment has been made to the banking details we hold for you.'
      : isSupplier
        ? `Our account ${data.account.code}. Our records as at ${data.period.to} — please advise of any difference against your own statement.`
        : `Please quote your account code ${data.account.code} with any payment. Queries within 7 days of the statement date.`,
    MARGIN,
    y,
    { width: CONTENT_WIDTH },
  )
  doc.text(`Generated ${data.generatedAt.toLocaleString('en-ZA')} · E & O E`, MARGIN, y + 12)
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
      width: column.width,
      align: column.align ?? 'left',
    })
    x += column.width
  }
  y += 12
  rule(doc, y)
  return y + 6
}

/** One row. Returns the y for the next one, since rows vary in height. */
function tableRow(
  doc: PDFKit.PDFDocument,
  y: number,
  cells: string[],
  overdue = false,
): number {
  doc.font('Helvetica').fontSize(8.5)

  let x = MARGIN
  let tallest = 0

  cells.forEach((cell, index) => {
    const column = COLUMNS[index]
    doc.fillColor(overdue && index === 2 ? DANGER : INK)
    const height = doc.heightOfString(cell, { width: column.width - 6 })
    doc.text(cell, x, y, { width: column.width - 6, align: column.align ?? 'left' })
    tallest = Math.max(tallest, height)
    x += column.width
  })

  return y + tallest + 6
}
