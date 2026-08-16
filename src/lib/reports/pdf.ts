import 'server-only'
import PDFDocument from 'pdfkit'
import { formatCell } from '../reportBuilder/format'
import { isGrouped, rowCountKeyFor } from '../reportBuilder/shape'
import type { ReportColumn } from '../reportBuilder/spec'
import { footnotes, periodLabel, type ReportRender } from './xlsx'

/**
 * A report as a PDF.
 *
 * Draws the same sections the grid draws and formats every cell through the
 * same formatCell, so the document and the screen cannot disagree about a
 * figure. Laid out by hand for the reason statements/pdf.ts gives: a headless
 * browser is a 300MB dependency and a second runtime, for a document that is a
 * letterhead and a table.
 *
 * pdfkit is in serverExternalPackages (next.config.mjs) — it reads its fonts
 * from disk at runtime, which a bundler would inline or break. Verify any change
 * here against a PRODUCTION build, not just `next dev`.
 *
 * ── LANDSCAPE, UNLIKE EVERY OTHER DOCUMENT HERE ──────────────────────────
 *
 * An invoice has six columns and a statement has six. A report has as many as
 * someone asked for, and the portrait layout the other documents use would
 * squeeze a twelve-column report into unreadable slivers.
 *
 * ── IT DROPS COLUMNS, AND SAYS WHICH ─────────────────────────────────────
 *
 * Past the point where the remaining columns cannot be legible at any width,
 * this prints the ones that fit and NAMES the ones it dropped in the footer.
 * The spreadsheet carries them all — that is the honest division of labour
 * between the two formats, and it is why the footer points at it rather than
 * silently truncating.
 */

/* A4 landscape at 72dpi, which is pdfkit's unit. */
const MARGIN = 32

/**
 * Greys, since a PDF has no access to the app's CSS tokens — the same exemption
 * statements/pdf.ts documents, and the same palette, so a printed report and a
 * printed statement look like they came from one system.
 */
const INK = '#16191d'
const MUTED = '#667085'
const LINE = '#d0d5dd'
const DANGER = '#b42318'
const BAND = '#f2f4f7'
const BAND_HEAVY = '#e4e7ec'

/**
 * Rows this will draw before it stops and says so. A 20,000-row PDF is hundreds
 * of pages and tens of megabytes, which is not a document anybody wanted.
 */
const PDF_MAX_ROWS = 2000

/** Below this a column cannot hold even a short number legibly. */
const MIN_COL_WIDTH = 46

type Doc = InstanceType<typeof PDFDocument>

export async function renderReportPdf(report: ReportRender): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    draw(doc, report)
    doc.end()
  })
}

function draw(doc: Doc, report: ReportRender): void {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const contentWidth = right - left
  const bottom = doc.page.height - doc.page.margins.bottom

  /* ── header ─────────────────────────────────────────────────────────── */
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(report.title, left, doc.y)
  doc.moveDown(0.2)
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
  if (report.storeName) doc.text(report.storeName)
  doc.text(`Period: ${periodLabel(report.range)}`)
  if (report.subtitle) doc.text(report.subtitle)
  doc.moveDown(0.6)

  const { columns, widths, dropped } = fitColumns(doc, report, contentWidth)

  if (report.rowCount === 0) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    doc.text('Nothing matched this report over the period selected.', left, doc.y + 12, {
      width: contentWidth,
      align: 'center',
    })
    finish(doc, report, dropped, left, contentWidth, bottom, 0)
    return
  }

  /* ── table ──────────────────────────────────────────────────────────── */
  const rowH = 14
  const grouped = isGrouped(report.sections)
  const labelKey = rowCountKeyFor(columns)

  /*
   * The header band is measured, not fixed.
   *
   * Column widths are scaled to fit the page, so a two-word heading like
   * "Customer reference" wraps at whatever width it ended up with. A fixed band
   * clipped the second line into the first row of data — the heading and the
   * band label overlapping, which looks like a rendering fault rather than a
   * narrow column. Measuring the tallest heading and sizing the band to it costs
   * one pass and cannot collide.
   */
  doc.font('Helvetica-Bold').fontSize(6.5)
  const headerH =
    Math.max(
      ...columns.map((col, i) =>
        doc.heightOfString(col.label.toUpperCase(), { width: widths[i] - 6 }),
      ),
    ) + 8

  const drawHeader = () => {
    const y = doc.y
    doc.rect(left, y, contentWidth, headerH).fill(BAND)
    let x = left
    columns.forEach((col, i) => {
      doc
        .fillColor(MUTED)
        .font('Helvetica-Bold')
        .fontSize(6.5)
        .text(col.label.toUpperCase(), x + 3, y + 4, {
          width: widths[i] - 6,
          align: col.numeric ? 'right' : 'left',
        })
      x += widths[i]
    })
    doc.y = y + headerH
  }

  /** Start a new page when the next block would not fit, repeating the header. */
  const ensure = (needed: number) => {
    if (doc.y + needed <= bottom) return
    doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN })
    doc.y = doc.page.margins.top
    drawHeader()
  }

  drawHeader()

  let printed = 0
  let cut = false

  for (const section of report.sections) {
    if (printed >= PDF_MAX_ROWS) {
      cut = true
      break
    }

    if (section.label !== null) {
      ensure(rowH + 4)
      const y = doc.y
      doc.rect(left, y, contentWidth, rowH).fill(BAND)
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(`${section.label}  (${section.rows.length})`, left + 4, y + 4, {
          width: contentWidth - 8,
          lineBreak: false,
          ellipsis: true,
        })
      doc.y = y + rowH
    }

    for (const row of section.rows) {
      if (printed >= PDF_MAX_ROWS) {
        cut = true
        break
      }
      ensure(rowH)
      const y = doc.y
      let x = left
      columns.forEach((col, i) => {
        const value = row[col.key] ?? null
        const negative = col.numeric && Number(value) < 0
        doc
          .fillColor(negative ? DANGER : INK)
          .font('Helvetica')
          .fontSize(7)
          .text(formatCell(value, col.type), x + 3, y + 4, {
            width: widths[i] - 6,
            align: col.numeric ? 'right' : 'left',
            lineBreak: false,
            ellipsis: true,
          })
        x += widths[i]
      })
      doc.strokeColor(LINE).lineWidth(0.3).moveTo(left, y + rowH).lineTo(right, y + rowH).stroke()
      doc.y = y + rowH
      printed++
    }

    // Only when banded — an unbanded table closes with the grand total, and the
    // same figures twice under two names read as a discrepancy.
    if (grouped && section.subtotal && !cut) {
      ensure(rowH)
      /* Named for the band it closes — "Card subtotal", matching the screen. A
         bare "Total" on a printed page, several bands down from the heading it
         belongs to, does not say what it is the total OF. */
      const label = section.label ? `${section.label} subtotal` : 'Total'
      drawTotals(doc, columns, widths, section.subtotal, label, left, contentWidth, labelKey, false)
    }
  }

  if (!cut) {
    ensure(rowH + 2)
    drawTotals(
      doc,
      columns,
      widths,
      report.grandTotal,
      'Grand total',
      left,
      contentWidth,
      labelKey,
      true,
    )
  }

  finish(doc, report, dropped, left, contentWidth, bottom, cut ? printed : 0)
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function drawTotals(
  doc: Doc,
  columns: readonly ReportColumn[],
  widths: readonly number[],
  totals: Record<string, number>,
  label: string,
  left: number,
  contentWidth: number,
  labelKey: string | undefined,
  heavy: boolean,
): void {
  const y = doc.y
  const h = 14
  doc.rect(left, y, contentWidth, h).fill(heavy ? BAND_HEAVY : BAND)
  let x = left
  columns.forEach((col, i) => {
    const isLabelCell = labelKey === undefined ? i === 0 : col.key === labelKey
    if (isLabelCell) {
      doc
        .fillColor(MUTED)
        .font('Helvetica-Bold')
        .fontSize(6.5)
        .text(label.toUpperCase(), x + 3, y + 4, { width: widths[i] - 6, lineBreak: false })
    } else if (col.total) {
      const v = totals[col.key]
      if (v !== null && v !== undefined) {
        /*
         * A total is bold and is usually the widest figure in its column, so it
         * is the one most likely to overflow the width the data was measured
         * for. Shrink it a little rather than let it wrap: a total split across
         * two lines reads as two numbers, which on a money column is worse than
         * a slightly smaller one.
         */
        const text = formatCell(v, col.type)
        const room = widths[i] - 6
        doc.font('Helvetica-Bold').fontSize(7)
        const size = doc.widthOfString(text) > room ? 6 : 7
        doc
          .fillColor(v < 0 ? DANGER : INK)
          .font('Helvetica-Bold')
          .fontSize(size)
          .text(text, x + 3, y + 4 + (7 - size) / 2, {
            width: room,
            align: 'right',
            lineBreak: false,
            ellipsis: true,
          })
      }
    }
    x += widths[i]
  })
  doc.y = y + h
}

/**
 * Which columns fit, and how wide each one is.
 *
 * Natural width is measured from the header and a sample of the data, so a
 * description column gets the room it needs and a quantity column does not hog
 * it. Columns are then dropped from the RIGHT — the report's own order puts the
 * important ones first — until the rest can be at least MIN_COL_WIDTH wide, and
 * what is left is scaled to fill the page exactly.
 */
function fitColumns(
  doc: Doc,
  report: ReportRender,
  contentWidth: number,
): { columns: ReportColumn[]; widths: number[]; dropped: string[] } {
  const sample = report.sections.flatMap((s) => s.rows).slice(0, 60)

  const natural = report.columns.map((col) => {
    doc.font('Helvetica-Bold').fontSize(6.5)
    // A two-word heading is allowed to wrap, so only the longer word has to fit.
    let w = Math.max(...col.label.toUpperCase().split(' ').map((word) => doc.widthOfString(word))) + 10
    doc.font('Helvetica').fontSize(7)
    for (const row of sample) {
      w = Math.max(w, doc.widthOfString(formatCell(row[col.key] ?? null, col.type)) + 10)
    }
    // The grand total is bold and often the widest figure the column ever
    // shows — a column sized only to its rows would make its own total wrap.
    if (col.total) {
      const total = report.grandTotal[col.key]
      if (total !== null && total !== undefined) {
        doc.font('Helvetica-Bold').fontSize(7)
        w = Math.max(w, doc.widthOfString(formatCell(total, col.type)) + 10)
      }
    }
    return Math.max(MIN_COL_WIDTH, Math.min(w, 190))
  })

  let keep = report.columns.length
  while (keep > 1 && keep * MIN_COL_WIDTH > contentWidth) keep--

  const columns = report.columns.slice(0, keep)
  const dropped = report.columns.slice(keep).map((c) => c.label)

  const kept = natural.slice(0, keep)
  const total = kept.reduce((a, b) => a + b, 0)
  const widths = kept.map((w) => (w / total) * contentWidth)

  return { columns, widths, dropped }
}

/** The footer note: row count, what was cut, and any columns not shown. */
function finish(
  doc: Doc,
  report: ReportRender,
  dropped: readonly string[],
  left: number,
  contentWidth: number,
  bottom: number,
  cutAfter: number,
): void {
  const notes = footnotes(report)
  if (cutAfter > 0) {
    notes.push(
      `only the first ${cutAfter.toLocaleString('en-ZA')} rows are drawn here — the spreadsheet export has them all`,
    )
  }
  if (dropped.length > 0) {
    notes.push(
      `columns too narrow to print: ${dropped.join(', ')} (the spreadsheet export has them)`,
    )
  }

  if (doc.y + 22 > bottom) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN })
    doc.y = doc.page.margins.top
  }
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(6.5)
    .text(notes.join(' · '), left, doc.y + 8, { width: contentWidth })
}
