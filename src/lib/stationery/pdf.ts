import 'server-only'
import PDFDocument from 'pdfkit'
import { formatMoney, formatQty } from '../decimals'
import {
  BAND_KEYS,
  DOC_BLOCK_CATALOG,
  type ColumnSpec,
  type DocBlock,
  type DocumentSpec,
} from './blocks'
import { findToken, getDocType, labelWithTax, type TokenFormat } from './catalog'
import { conditionHolds } from './conditions'
import { qrMatrix } from './qr'
import { resolveBarcodeText } from './barcodeSource'
import { code128Bars } from '../labels/code128'
import { resolveQrUrl, type QrContext } from './qrTarget'
import type { RenderInput, TokenValues } from './render'

/**
 * A block design, drawn as a PDF.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A shop that redesigned its invoice changed the PRINTED one and not the one
 * that lands in the customer's inbox, because the emailed copy was 416 lines of
 * hand-drawn pdfkit that read no template. That was the last place the feature
 * did not reach, and it was the copy customers actually receive.
 *
 * ── WHY pdfkit AND NOT A HEADLESS BROWSER ─────────────────────────────────
 *
 * The standing decision, stated in lib/invoices/pdf.ts and unchanged here: a
 * headless browser is "a 300MB dependency and a second runtime to keep alive"
 * for a document that is a letterhead, a table and a totals box. Rendering the
 * HTML would have been less code and a much larger thing to own.
 *
 * ── WHAT MAKES THE SPEC PORTABLE ──────────────────────────────────────────
 *
 * A block carries a band and an x/y/width in PERCENT, and pdfkit draws at
 * absolute coordinates — so the conversion is a multiplication, not an
 * interpretation. That is the property that made this worth doing rather than
 * maintaining two layouts: the same spec that positions a div positions a
 * drawing, because neither stores anything about how it will be rendered.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * The `html` block is skipped. Its whole purpose is markup the block model
 * cannot express, and there is no honest way to draw arbitrary HTML with
 * pdfkit — a partial rendering of someone's custom markup would be worse than
 * an obvious absence. A design that leans on it should print, not email.
 *
 * Alignment inside a block is honoured; CSS classes are not. A PDF has no access
 * to the app's tokens, so the greys are matched to lib/invoices/pdf.ts and
 * statements/pdf.ts, and the three documents look like one business wrote them.
 */

/* A4 at 72dpi, pdfkit's unit. The same page geometry as the invoice and the
   statement, so a shop's paperwork is consistent whichever produced it. */
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

const INK = '#16191d'
const MUTED = '#667085'
const LINE = '#d0d5dd'
/* The status stamp's two meanings — matched to globals.css --color-success-ink
   and --color-danger, and to the same hex in compile.ts BLOCK_STYLE. */
const SUCCESS = '#0f7b37'
const DANGER = '#b42318'

/**
 * What one percent of band height is worth, in points.
 *
 * The screen's BAND_REM is 0.25rem — 4px at the default size — against a page
 * about 800px tall. This is the same proportion in PDF units, so a design laid
 * out on screen lands in the same place on the page rather than in a squashed or
 * stretched version of it.
 */
const BAND_PT = 4.2

/* A caller that supplied no QR context resolves nothing, which is the same
   fail-closed direction the A4 path takes. */
const EMPTY_QR: QrContext = { appUrl: null, storeUrl: null, reviewUrl: null, documentUrl: null }

/** A block's box on the page, in points. */
type Box = { x: number; y: number; w: number }

function boxOf(b: DocBlock, bandTop: number): Box {
  return {
    x: MARGIN + (b.x / 100) * CONTENT_WIDTH,
    y: bandTop + b.y * BAND_PT,
    w: (b.w / 100) * CONTENT_WIDTH,
  }
}

/* ── values ──────────────────────────────────────────────────────────────── */

/**
 * One token's value as the text that goes on the page.
 *
 * The same formatting rules render.ts applies, because a number that reads
 * R1 150.00 on screen and 1150 in the email is two documents. Money and
 * quantity go through lib/decimals exactly as they do there.
 */
function valueOf(raw: unknown, format: TokenFormat): string {
  if (raw === null || raw === undefined || raw === '') return ''
  switch (format) {
    case 'money':
      return typeof raw === 'number' ? formatMoney(raw) : String(raw)
    case 'qty':
      return typeof raw === 'number' ? formatQty(raw, { exact: true }) : String(raw)
    case 'percent':
      return typeof raw === 'number' ? `${Number(raw.toFixed(2))}%` : String(raw)
    case 'markup':
      // Never drawn as text. The logo is handled as an image; anything else
      // marked `markup` would put a tag on the page.
      return ''
    default:
      return String(raw)
  }
}

/** Resolve one `{token}` for a document, or '' when it means nothing here. */
function tokenValue(key: string, values: TokenValues, docKey: string): string {
  const doc = getDocType(docKey)
  const def = doc ? findToken(doc, key) : null
  if (!def) return ''
  return valueOf(values[key], def.format)
}

/** Resolve every `{token}` inside a designer's own words. */
function resolveText(text: string, values: TokenValues, docKey: string): string {
  return text.replace(/\{([a-zA-Z0-9._]+)\}/g, (_, key: string) =>
    tokenValue(key, values, docKey),
  )
}

/* ── drawing ─────────────────────────────────────────────────────────────── */

type Ctx = {
  doc: PDFKit.PDFDocument
  input: RenderInput
  docKey: string
  /** The logo's bytes, where the site has one and it could be read. */
  logo: Buffer | null
  /**
   * The shop's pictures, by id.
   *
   * Only ids in here can be drawn, which is the same boundary the A4 path
   * enforces with its own list: a design naming a picture belonging to nobody —
   * a copy from another site, a deleted row — draws nothing rather than
   * reaching for a file.
   */
  pictures?: Map<number, Buffer>
}

/** Draw one block at its box, and report how tall it turned out. */
function drawBlock(ctx: Ctx, b: DocBlock, box: Box): number {
  const { doc, input, docKey } = ctx
  const v = input.values

  /*
   * ── A BLOCK THE DESIGN SAID TO HIDE ─────────────────────────────────────
   *
   * Answered here rather than carried in the output, because this renderer
   * holds the block and the document's values at the same moment — the A4 path
   * does not, which is why it ships a `{#when}` marker through the markup
   * instead. Same rule, same file behind it, different mechanics.
   *
   * ZERO HEIGHT is the whole of "hidden": the body band stacks blocks by what
   * the last one returned, so a hidden block that reported its real height
   * would leave a gap the shape of the paragraph nobody can see.
   */
  if (!conditionHolds(b.showWhen, v)) return 0
  const align = b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left'
  const startY = box.y

  /* Every branch starts by placing the cursor, since pdfkit's `doc.y` is
     wherever the last block left it. */
  doc.x = box.x
  doc.y = box.y

  switch (b.kind) {
    case 'barcode': {
      /*
       * Bars as rectangles, like the QR's modules — same reason: pdfkit draws
       * them natively and the result is resolution-independent, where a raster
       * would be fixed at whatever pixel size it was encoded.
       */
      const text = resolveBarcodeText(b.barcodeSource ?? 'docNumber', b.barcodeText, v)
      if (!text) return 0
      const encoded = code128Bars(text)
      if (!encoded) return 0

      const barsH = Math.min(Math.max(Math.round(b.barcodeHeight ?? 40), 16), 120)
      /* The symbol keeps its proportions inside the box the designer drew: a
         stretched barcode is a barcode that will not scan. */
      const unit = box.w / encoded.totalModules

      doc.save().fillColor('#000000')
      for (const bar of encoded.bars) {
        doc.rect(box.x + bar.x * unit, box.y, bar.width * unit, barsH).fill()
      }
      doc.restore()

      /* The digits under the bars, so a person can key it in when a scanner
         will not read it. The thermal path asks the printer for the same thing
         with GS H 2. */
      doc.fillColor(MUTED).fontSize(7)
      doc.text(text, box.x, box.y + barsH + 2, { width: box.w, align: 'center' })
      return doc.y - box.y
    }

    case 'qr': {
      /*
       * Drawn as RECTANGLES, not as an image.
       *
       * pdfkit has no .svg(), and going through a PNG would mean encoding one
       * only for pdfkit to decode it again. The module matrix is already the
       * thing being drawn, so each dark module is a filled square — which is
       * also resolution-independent in the finished PDF, where a raster would
       * not be.
       */
      const url = b.qrTarget ? resolveQrUrl(b.qrTarget, b.qrUrl, input.qr ?? EMPTY_QR) : null
      if (!url) return 0

      const pt = Math.min(Math.max(Math.round(b.qrSize ?? 90), 40), 200)
      const m = qrMatrix(url)
      /* Four modules of quiet zone, per the QR spec — a code printed hard
         against other ink is one a scanner will not find. */
      const quiet = 4
      const unit = pt / (m.size + quiet * 2)

      doc.save().fillColor('#ffffff').rect(box.x, box.y, pt, pt).fill()
      doc.fillColor('#000000')
      for (let row = 0; row < m.size; row++) {
        for (let col = 0; col < m.size; col++) {
          if (!m.dark(row, col)) continue
          doc.rect(box.x + (col + quiet) * unit, box.y + (row + quiet) * unit, unit, unit).fill()
        }
      }
      doc.restore()

      let used = pt
      const caption = b.qrCaption?.trim()
      if (caption) {
        doc.fillColor(MUTED).fontSize(8)
        doc.text(caption, box.x, box.y + pt + 2, { width: Math.max(box.w, pt), align })
        used = doc.y - box.y
      }
      return used
    }

    case 'image': {
      /*
       * A picture the shop uploaded. The BYTES are handed in by the caller —
       * this renderer has no database and must not grow one — keyed by the id
       * the block names. A picture that has been deleted, or whose file has
       * gone, is simply absent from the map and the block draws nothing, which
       * is what the A4 path does too.
       */
      const bytes = b.imageId ? ctx.pictures?.get(b.imageId) : undefined
      if (!bytes) return 0
      const h = b.imageHeight ?? 90
      // fit, for the same reason the logo uses it: the picture keeps its shape
      // and stays inside the box the designer drew.
      doc.image(bytes, box.x, box.y, { fit: [box.w, h] })
      return h
    }

    case 'logo': {
      if (!ctx.logo) return 0
      const h = b.logoHeight ?? 56
      // fit rather than a fixed width: a wordmark and a crest are different
      // shapes and both must stay inside the box the designer drew.
      // No align: pdfkit only offers centre and right for an image, and left is
      // the default. A designer who wants it centred moves the BOX.
      doc.image(ctx.logo, box.x, box.y, { fit: [box.w, h] })
      return h
    }

    case 'letterhead': {
      const tokens = (b.tokens ?? []).filter((t) => t !== 'site.logo')
      const name = tokens.includes('site.name')
      if (name) {
        doc
          .font('Helvetica-Bold')
          .fontSize(13)
          .fillColor(INK)
          .text(tokenValue('site.name', v, docKey), box.x, box.y, { width: box.w, align })
      }
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      for (const t of tokens.filter((x) => x !== 'site.name')) {
        const text = tokenValue(t, v, docKey)
        // Multi-line values (an address) arrive with newlines and pdfkit honours
        // them, so nothing has to be split here.
        if (text !== '') doc.text(text, box.x, doc.y, { width: box.w, align })
      }
      return doc.y - startY
    }

    case 'docTitle': {
      if (b.title) {
        doc
          .font('Helvetica-Bold')
          .fontSize(16)
          .fillColor(INK)
          .text(b.title, box.x, box.y, { width: box.w, align })
      }
      for (const [i, t] of (b.tokens ?? []).entries()) {
        const text = tokenValue(t, v, docKey)
        if (text === '') continue

        /*
         * ── THE STATUS BANNER IS A STAMP, NOT A DETAIL LINE ────────────────
         *
         * PAID, CANCELLED, PRO FORMA, REPRINT — the most consequential word on
         * the page, and it used to draw at 9pt grey like the document date, as
         * a fourth line under it. On paper that is invisible: a shop printed a
         * settled invoice and reported that no status had printed at all.
         *
         * Drawn in a box here, matching the bordered treatment the HTML path
         * gives it (see compile.ts docTitle), so the two engines produce the
         * same document rather than one that stamps and one that whispers.
         */
        if (t === 'doc.statusBanner') {
          const size = 10
          /*
           * Coloured by what it says, matching the HTML path exactly (see
           * BLOCK_STYLE in compile.ts). Not simply green: PAID is good news,
           * CANCELLED says the document is void, and PRO FORMA and REPRINT are
           * neither — a green REPRINT would read as a reassurance nobody
           * offered. The box takes the same colour as the word.
           */
          const stampColour =
            text.toUpperCase() === 'PAID'
              ? SUCCESS
              : text.toUpperCase() === 'CANCELLED'
                ? DANGER
                : INK
          doc.font('Helvetica-Bold').fontSize(size)
          const textWidth = doc.widthOfString(text.toUpperCase(), { characterSpacing: 1 })
          const padX = 5
          const padY = 3
          const boxW = textWidth + padX * 2
          const boxH = size + padY * 2
          // Boxed at the block's own alignment, so a right-aligned title block
          // gets a right-aligned stamp rather than one adrift on the left.
          const x =
            align === 'right'
              ? box.x + box.w - boxW
              : align === 'center'
                ? box.x + (box.w - boxW) / 2
                : box.x
          const y = doc.y + 4

          doc.lineWidth(0.75).strokeColor(stampColour).rect(x, y, boxW, boxH).stroke()
          doc
            .fillColor(stampColour)
            .text(text.toUpperCase(), x + padX, y + padY, {
              width: textWidth,
              characterSpacing: 1,
              lineBreak: false,
            })
          // pdfkit leaves the cursor mid-box after a positioned draw, so put it
          // below the stamp for whatever the design stacks next.
          doc.y = y + boxH
          continue
        }

        doc
          .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(i === 0 ? 11 : 9)
          .fillColor(i === 0 ? INK : MUTED)
          .text(text, box.x, doc.y, { width: box.w, align })
      }
      return doc.y - startY
    }

    case 'partyBlock': {
      if (b.title) {
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(b.title.toUpperCase(), box.x, box.y, { width: box.w, align })
      }
      for (const [i, t] of (b.tokens ?? []).entries()) {
        const text = tokenValue(t, v, docKey)
        if (text === '') continue
        doc
          .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(i === 0 ? 10 : 8.5)
          .fillColor(i === 0 ? INK : MUTED)
          .text(text, box.x, doc.y, { width: box.w, align })
      }
      return doc.y - startY
    }

    case 'detailList': {
      if (b.title) {
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(b.title.toUpperCase(), box.x, box.y, { width: box.w, align: 'left' })
      }
      /*
       * A row whose value is empty is SKIPPED rather than drawn blank — the same
       * outcome the screen reaches with CSS. That is what lets one design carry a
       * quote's expiry, an order's delivery date and an invoice's due date at
       * once, each appearing only where it applies.
       */
      for (const row of b.rows ?? []) {
        const text = tokenValue(row.token, v, docKey)
        if (text === '') continue
        const y = doc.y
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(row.label, box.x, y, {
          width: box.w * 0.5,
        })
        doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(text, box.x + box.w * 0.5, y, {
          width: box.w * 0.5,
          align: 'right',
        })
      }
      return doc.y - startY
    }

    case 'lineTable':
      return drawTable(ctx, b, box)

    case 'totals': {
      const tokens = b.tokens ?? []
      const above = tokens.slice(0, -1)
      const last = tokens[tokens.length - 1]
      const doc2 = getDocType(docKey)

      for (const t of above) {
        const text = tokenValue(t, v, docKey)
        // Discount and rounding print only when they happened, as on screen.
        if (text === '') continue
        const def = doc2 ? findToken(doc2, t) : null
        const y = doc.y
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(labelWithTax(def?.label ?? t, input.taxLabel), box.x, y, {
          width: box.w * 0.55,
        })
        doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(text, box.x + box.w * 0.55, y, {
          width: box.w * 0.45,
          align: 'right',
        })
      }

      if (last) {
        const y = doc.y + 4
        rule(doc, y - 2, box.x, box.w)
        const def = doc2 ? findToken(doc2, last) : null
        /*
         * The block's own title wins, and a token in it resolves — the same rule
         * the HTML compiler follows. Without it a statement's summary printed
         * "The figure to pay", which is the catalog label written for a token
         * PICKER, where the page wants "Amount due" or "Balance owed" or
         * "Amount paid" depending on which of the three documents this is.
         */
        const label = b.title
          ? resolveText(b.title, v, docKey)
          : labelWithTax(def?.label ?? 'Total', input.taxLabel)
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor(INK)
          .text(label, box.x, y, { width: box.w * 0.5 })
        doc
          .font('Helvetica-Bold')
          .fontSize(13)
          .fillColor(INK)
          .text(tokenValue(last, v, docKey), box.x + box.w * 0.5, y - 2, {
            width: box.w * 0.5,
            align: 'right',
          })
      }
      return doc.y - startY
    }

    case 'vatSummary':
      return titled(
        ctx,
        blockTitle(b.title, '{{tax}} SUMMARY', input.taxLabel),
        tokenValue('totals.vatSummary', v, docKey),
        box,
        align,
      )

    case 'banking':
      return titled(ctx, blockTitle(b.title, 'BANKING DETAILS', input.taxLabel), tokenValue('banking', v, docKey), box, align)

    case 'notes':
      return titled(ctx, blockTitle(b.title, 'NOTES', input.taxLabel), tokenValue('doc.notes', v, docKey), box, align)

    case 'text': {
      const text = resolveText(b.text ?? '', v, docKey)
      if (text.trim() === '') return 0
      /*
       * A pay-online link is drawn as a real PDF link as well as visible text —
       * the reason lib/invoices/pdf.ts gives still holds: "a URL nobody can click
       * in a PDF is a URL nobody uses."
       */
      const url = /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : null
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(url ? '#1d4ed8' : MUTED)
        .text(text, box.x, box.y, { width: box.w, align, ...(url ? { link: url } : {}) })
      return doc.y - startY
    }

    case 'signature': {
      /*
       * A rule to sign on, with its label under it — where a signature line puts
       * it, because the space above the line is what gets written in.
       */
      const label = blockTitle(b.title, 'Received by', input.taxLabel)
      rule(doc, box.y + 26, box.x, box.w)
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(label, box.x, box.y + 30, { width: box.w, align })
      return 42
    }

    case 'rule':
      rule(doc, box.y, box.x, box.w)
      return 4

    case 'spacer':
      return 12

    case 'html':
      /*
       * Deliberately not drawn. Its purpose is markup the block model cannot
       * express, and pdfkit cannot render arbitrary HTML — a partial rendering of
       * a shop's custom markup would be worse than an obvious absence.
       */
      return 0

    default:
      return 0
  }
}

/** A caption over one value, which disappears entirely when the value is empty. */
/**
 * A block title with `{{tax}}` resolved to the shop's word for VAT.
 *
 * ── WHY A TITLE CARRIES A MARKER AT ALL ───────────────────────────────────
 *
 * The block compiler writes "{{tax}} SUMMARY" as the DEFAULT title, so a shop
 * that calls its tax something else gets its own word without editing anything.
 * The marker is resolved at print time rather than at design time, because a
 * design copied to another shop must not carry the first one's tax name.
 *
 * ── THE BUG THIS CLOSES ───────────────────────────────────────────────────
 *
 * The HTML renderer resolves `{{tax}}` across the whole document (render.ts), so
 * the designer preview and the on-screen document were always right. This PDF
 * renderer resolved it only for CATALOG labels, never for a saved block title —
 * and `b.title ?? default` means a stored title bypasses the default entirely.
 *
 * So an emailed invoice printed the literal text "{{TAX}} SUMMARY" while the
 * designer showed "VAT SUMMARY", which is the worst shape for this kind of bug:
 * the preview is not lying about the layout, only about one word, and the first
 * person to see it is the customer.
 */
function blockTitle(title: string | undefined, fallback: string, taxLabel?: string): string {
  return (title ?? fallback).replace(/\{\{tax\}\}/g, taxLabel ?? 'VAT')
}

function titled(
  ctx: Ctx,
  title: string,
  value: string,
  box: Box,
  align: 'left' | 'center' | 'right',
): number {
  if (value.trim() === '') return 0
  const { doc } = ctx
  const startY = box.y
  if (title) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(title.toUpperCase(), box.x, box.y, { width: box.w, align })
  }
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(INK)
    .text(value, box.x, doc.y, { width: box.w, align })
  return doc.y - startY
}

/**
 * The items.
 *
 * The designer's columns, at the designer's widths — which is the feature this
 * whole thing exists for. A column with no width shares what the explicit ones
 * leave, so the common case needs no arithmetic.
 */
/**
 * A table's column headings, and the rule under them. Returns the new `y`.
 *
 * One function because it is needed twice: once at the top of the table, and
 * again at the top of every page the table continues onto. A continuation page
 * of figures with no headings is a page nobody can read.
 */
function drawHeadings(
  doc: PDFKit.PDFDocument,
  cols: ColumnSpec[],
  widths: number[],
  box: Box,
  y: number,
): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  let x = box.x
  cols.forEach((c, i) => {
    doc.text(c.heading.toUpperCase(), x, y, {
      width: widths[i] - 6,
      align: c.align === 'right' ? 'right' : 'left',
    })
    x += widths[i]
  })
  const ruled = y + 12
  rule(doc, ruled, box.x, box.w)
  return ruled + 6
}

function drawTable(ctx: Ctx, b: DocBlock, box: Box): number {
  const { doc, input, docKey } = ctx
  const cols = b.columns ?? []
  if (cols.length === 0) return 0

  /*
   * WHICH SECTION, and nothing at all when it is empty.
   *
   * A statement has two tables — the movements and the age ladder — and the
   * ladder has no rows on a remittance, because nothing is overdue on money
   * already paid. The HTML compiler hides an empty table with CSS; a PDF has
   * none, so it simply must not draw one. Headings over an empty table read as
   * a table that failed to load.
   */
  const rows = input.sections[b.section ?? 'lines'] ?? []
  if (rows.length === 0) return 0

  const fixed = cols.reduce((sum, c) => sum + (c.width ?? 0), 0)
  const autos = cols.filter((c) => c.width === undefined).length
  const each = autos > 0 ? Math.max((100 - fixed) / autos, 4) : 0
  const widths = cols.map((c) => ((c.width ?? each) / 100) * box.w)

  const startY = box.y
  let y = box.y

  // Headings, and the same call again at the top of every continuation page.
  y = drawHeadings(doc, cols, widths, box, y)
  let x = box.x

  /*
   * ── WHERE THE PAGE ENDS ─────────────────────────────────────────────────
   *
   * This loop walks `y` down the page and pdfkit does not stop it. Past the
   * bottom margin every doc.text() at an off-page y makes pdfkit add a page of
   * its own accord — and because y keeps growing, the NEXT row is further off
   * still, so each row adds another one. A 120-line invoice came out as 149
   * pages, nearly all of them blank.
   *
   * The break is therefore taken here, deliberately, before a row is drawn that
   * would not fit. `drawHeadings` repeats the column headings at the top of the
   * new page, because a page of figures under no headings is unreadable.
   */
  const pageBottom = PAGE_HEIGHT - MARGIN

  for (const row of rows) {
    /*
     * Measured BEFORE drawing: the tallest cell decides whether the row fits,
     * and a row half on one page and half on the next is worse than a break.
     * 24pt covers a single line plus its sub-line and the gap under it.
     */
    if (y + 24 > pageBottom) {
      doc.addPage()
      y = MARGIN
      y = drawHeadings(doc, cols, widths, box, y)
    }

    x = box.x
    let tallest = 0

    cols.forEach((c, i) => {
      const w = widths[i] - 6
      const align = c.align === 'right' ? 'right' : 'left'
      const main = tokenValue(c.token, row, docKey)

      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      doc.text(main, x, y, { width: w, align })
      let h = doc.heightOfString(main, { width: w })

      // The second field under the first — a product code beneath a
      // description, which is how a real invoice reads.
      if (c.subToken) {
        const sub = tokenValue(c.subToken, row, docKey)
        if (sub !== '') {
          doc.font('Helvetica').fontSize(7).fillColor(MUTED)
          doc.text(sub, x, y + h, { width: w, align })
          h += doc.heightOfString(sub, { width: w })
        }
      }

      tallest = Math.max(tallest, h)
      x += widths[i]
    })

    y += tallest + 6
  }

  rule(doc, y, box.x, box.w)
  return y + 4 - startY
}

function rule(doc: PDFKit.PDFDocument, y: number, x = MARGIN, w = CONTENT_WIDTH) {
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor(LINE).stroke()
}

/* ── the page ────────────────────────────────────────────────────────────── */

/**
 * A designed document as a PDF.
 *
 * Bands stack exactly as they do on screen: the header and footer place their
 * blocks at the coordinates they were given, and the BODY is flowed — the items
 * table decides its own height and pushes the footer down. That is the whole
 * reason bands exist, and a forty-line invoice is where it earns its keep.
 */
export function renderSpecPdf(
  spec: DocumentSpec,
  docKey: string,
  input: RenderInput,
  logo: Buffer | null = null,
  /** The shop's pictures by id, for any image blocks the design uses. */
  pictures?: Map<number, Buffer>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const ctx: Ctx = { doc, input, docKey, logo, pictures }

    try {
      let bandTop = MARGIN

      for (const band of BAND_KEYS) {
        const blocks = spec.blocks
          .filter((x) => x.band === band)
          .sort((a, z) => a.y - z.y || a.x - z.x)
        if (blocks.length === 0) continue

        if (band === 'body') {
          // Flowed: each block starts where the last one ended.
          let y = bandTop
          for (const b of blocks) {
            const h = drawBlock(ctx, b, { x: MARGIN + (b.x / 100) * CONTENT_WIDTH, y, w: (b.w / 100) * CONTENT_WIDTH })
            y += h + 6
          }
          bandTop = y + 8
          continue
        }

        let lowest = bandTop
        for (const b of blocks) {
          const box = boxOf(b, bandTop)
          const h = drawBlock(ctx, b, box)
          lowest = Math.max(lowest, box.y + h)
        }
        bandTop = lowest + 12
      }
    } catch (err) {
      doc.end()
      reject(err)
      return
    }

    doc.end()
  })
}

export { PAGE_HEIGHT, DOC_BLOCK_CATALOG }
