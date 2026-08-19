import 'server-only'
import PDFDocument from 'pdfkit'
import { formatMoney, formatQty } from '../decimals'
import { BAND_KEYS, DOC_BLOCK_CATALOG, type DocBlock, type DocumentSpec } from './blocks'
import { findToken, getDocType, type TokenFormat } from './catalog'
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

/**
 * What one percent of band height is worth, in points.
 *
 * The screen's BAND_REM is 0.25rem — 4px at the default size — against a page
 * about 800px tall. This is the same proportion in PDF units, so a design laid
 * out on screen lands in the same place on the page rather than in a squashed or
 * stretched version of it.
 */
const BAND_PT = 4.2

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
      return typeof raw === 'number' ? formatQty(raw) : String(raw)
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
}

/** Draw one block at its box, and report how tall it turned out. */
function drawBlock(ctx: Ctx, b: DocBlock, box: Box): number {
  const { doc, input, docKey } = ctx
  const v = input.values
  const align = b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left'
  const startY = box.y

  /* Every branch starts by placing the cursor, since pdfkit's `doc.y` is
     wherever the last block left it. */
  doc.x = box.x
  doc.y = box.y

  switch (b.kind) {
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
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(def?.label ?? t, box.x, y, {
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
        const label = b.title ? resolveText(b.title, v, docKey) : (def?.label ?? 'Total')
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
      return titled(ctx, b.title ?? 'VAT SUMMARY', tokenValue('totals.vatSummary', v, docKey), box, align)

    case 'banking':
      return titled(ctx, b.title ?? 'BANKING DETAILS', tokenValue('banking', v, docKey), box, align)

    case 'notes':
      return titled(ctx, b.title ?? 'NOTES', tokenValue('doc.notes', v, docKey), box, align)

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
      const label = b.title ?? 'Received by'
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

  // Headings.
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  let x = box.x
  cols.forEach((c, i) => {
    doc.text(c.heading.toUpperCase(), x, y, {
      width: widths[i] - 6,
      align: c.align === 'right' ? 'right' : 'left',
    })
    x += widths[i]
  })
  y += 12
  rule(doc, y, box.x, box.w)
  y += 6

  for (const row of rows) {
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
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const ctx: Ctx = { doc, input, docKey, logo }

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
