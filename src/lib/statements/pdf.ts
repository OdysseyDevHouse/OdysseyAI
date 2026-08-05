import 'server-only'
import PDFDocument from 'pdfkit'
import { formatMoney } from '../decimals'
import { AGING_BUCKETS, BUCKET_LABELS } from '../site/ledger'
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

export function renderStatementPdf(
  data: StatementData,
  variant: 'statement' | 'remittance' = 'statement',
): Promise<Buffer> {
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

function draw(doc: PDFKit.PDFDocument, data: StatementData, variant: 'statement' | 'remittance') {
  const isRemittance = variant === 'remittance'

  // ── Letterhead
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(data.site.name, MARGIN, MARGIN)
  if (data.site.vatNumber) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`VAT no. ${data.site.vatNumber}`)
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(isRemittance ? 'REMITTANCE ADVICE' : 'STATEMENT', MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: 'right',
    })
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(`${data.period.from} to ${data.period.to}`, MARGIN, MARGIN + 20, {
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
    y = tableRow(doc, y, ['', '', 'Nothing outstanding — thank you.', '', '', ''])
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
      doc.text(BUCKET_LABELS[bucket], MARGIN + index * cellWidth, y, {
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
  const boxHeight = !isRemittance && data.dueNow > 0 ? 46 : 28

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

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(isRemittance ? 'Amount paid' : 'Amount due', boxX + 10, boxY)
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
