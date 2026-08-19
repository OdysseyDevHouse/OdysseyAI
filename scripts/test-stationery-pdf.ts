/**
 * A block design, drawn as a PDF.
 *
 *   npm run test:stationery-pdf
 *
 * ── WHAT THIS PROVES ─────────────────────────────────────────────────────
 *
 * That the emailed invoice carries the same document the screen designs. Until
 * this renderer existed, a shop could redesign its invoice and change the
 * printed copy only — the emailed one was a fixed layout that read no template,
 * which is the copy customers actually receive.
 *
 * The PDF is READ BACK rather than trusted: pdfkit writes text as hex glyph
 * arrays inside compressed streams, so the checks below inflate the streams and
 * decode them. My first version of that reader looked for parenthesised strings,
 * found none, and reported a perfectly good PDF as blank — which is why the
 * decoding is asserted before anything else.
 *
 * Needs no database and no browser.
 */
import zlib from 'node:zlib'
import { renderSpecPdf } from '../src/lib/stationery/pdf'
import { INVOICE_BLOCKS } from '../src/lib/stationery/defaults/invoiceBlocks'
import { invoiceDataTokens } from '../src/lib/stationery/adapters/invoiceData'
import { removeBlock, type DocumentSpec } from '../src/lib/stationery/blocks'
import type { InvoiceData } from '../src/lib/invoices/pdf'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Every character of text in a PDF, in the order it was drawn. */
function textOf(pdf: Buffer): string {
  const s = pdf.toString('latin1')
  let content = ''
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endstream', start)
    if (end < 0) continue
    try {
      content += zlib.inflateSync(pdf.subarray(start, end)).toString('latin1')
    } catch {
      /* a font file, not a content stream */
    }
  }
  return [...content.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
    .join('')
}

function invoice(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    site: {
      name: 'Acme Trading',
      vatNumber: '4123456789',
      registrationNumber: '2019/123456/07',
      addressLines: ['Unit 4', 'Industrial Park', 'Cape Town', '7441'],
      phone: '021 555 0100',
      email: 'sales@acme.co.za',
    },
    banking: {
      bank: 'First National',
      accountName: 'Acme Trading',
      accountNumber: '620123456',
      branchCode: '250655',
    },
    customer: {
      code: 'CUST-003',
      name: 'Khumalo Supplies',
      vatNumber: '4111222333',
      phone: '031 555 0111',
      addressLines: ['155 Industrial Road', 'Durban 3957'],
    },
    documentNumber: 'INV000456',
    documentDate: '2026-08-18',
    dueDate: '2026-09-17',
    reference: 'REF-77',
    notes: 'Thank you for your business.',
    lines: [
      { productCode: 'W-1', description: 'Widget', qty: 10, unitPriceIncl: 57.5, discountPct: 0, vatRatePct: 15, lineTotalIncl: 575 },
      { productCode: 'G-2', description: 'Gadget', qty: 5, unitPriceIncl: 115, discountPct: 0, vatRatePct: 15, lineTotalIncl: 575 },
      { productCode: null, description: 'Zero-rated item', qty: 1, unitPriceIncl: 100, discountPct: 0, vatRatePct: 0, lineTotalIncl: 100 },
    ],
    subtotalExcl: 1086.96,
    vatTotal: 163.04,
    discountTotal: 0,
    totalIncl: 1250,
    generatedAt: new Date('2026-08-18T12:00:00Z'),
    ...over,
  } as InvoiceData
}

const draw = async (data = invoice(), spec: DocumentSpec = INVOICE_BLOCKS) =>
  renderSpecPdf(spec, 'invoice', invoiceDataTokens(data, { printedAt: '18/08/2026, 14:30' }))

async function main() {
  /* ── the reader itself ───────────────────────────────────────────────────── */

  console.log('\n-- the PDF can be read back --')
  {
    const pdf = await draw()
    ok('it is a PDF', pdf.subarray(0, 5).toString() === '%PDF-')
    const text = textOf(pdf)
    ok('and its text can be decoded', text.length > 100, `${text.length} characters`)
    /*
     * Asserted BEFORE anything else, because every check below is worthless if
     * this decoding is wrong — a broken reader reports a perfect document as
     * blank, which is exactly what happened the first time.
     */
    ok('...and it is really the invoice, not noise', text.includes('Acme Trading'))
  }

  /* ── the whole document reaches the page ────────────────────────────────── */

  console.log('\n-- what the emailed invoice carries --')
  {
    const text = textOf(await draw())

    const wants: [string, string][] = [
      ['the letterhead', 'Acme Trading'],
      ['the address', 'Industrial Park'],
      ['our VAT number', 'VAT no. 4123456789'],
      ['the words TAX INVOICE', 'TAX INVOICE'],
      ['the document number', 'INV000456'],
      ['the date', '2026-08-18'],
      ['the customer', 'Khumalo Supplies'],
      ["the customer's VAT number", '4111222333'],
      ['the due date', '2026-09-17'],
      ['a line description', 'Widget'],
      ['a product code', 'W-1'],
      ['a line price', 'R57.50'],
      ['the VAT summary', 'VAT @ 15%'],
      ['...including the zero-rated line', 'VAT @ 0%'],
      ['the total', 'R1 250.00'],
      ['the banking details', '620123456'],
      ['the notes', 'Thank you for your business'],
    ]
    for (const [what, needle] of wants) {
      ok(`it carries ${what}`, text.includes(needle), text.includes(needle) ? '' : needle)
    }

    /*
     * WHAT MUST NOT BE ON IT.
     *
     * The catalog does not expose cost or margin to an invoice at all, so this is
     * belt and braces — but it is the check that would catch a token wrongly added
     * to the invoice's list, and printing what a shop paid on a customer's copy is
     * the kind of mistake nobody reports politely.
     */
    ok('and nothing about what the goods cost us', !/cost|margin|markup/i.test(text))
  }

  /* ── one design, both media ─────────────────────────────────────────────── */

  console.log('\n-- the emailed copy follows the design --')
  {
    /*
     * The point of the whole exercise: change the design, and the EMAIL changes.
     * Before this renderer a shop could remove a block, print the new layout, and
     * email the old one for ever.
     */
    const without = removeBlock(INVOICE_BLOCKS, 'inv-banking')
    const text = textOf(await draw(invoice(), without))
    ok('removing the banking block removes it from the email', !text.includes('620123456'))
    ok('...and leaves the rest of the invoice alone', text.includes('Khumalo Supplies'))

    const renamed: DocumentSpec = {
      version: 1,
      blocks: INVOICE_BLOCKS.blocks.map((b) =>
        b.kind === 'lineTable'
          ? { ...b, columns: (b.columns ?? []).map((c) =>
              c.token === 'line.unitPriceIncl' ? { ...c, heading: 'Rate' } : c) }
          : b,
      ),
    }
    const t2 = textOf(await draw(invoice(), renamed))
    ok('a renamed column heading reaches the email', t2.includes('RATE') && !t2.includes('UNIT PRICE'))
  }

  /* ── the rows that hide themselves ──────────────────────────────────────── */

  console.log('\n-- empty values leave nothing behind --')
  {
    /*
     * On screen this is CSS; here the block is simply not drawn. Same outcome,
     * reached differently — which is the one place the two renderers genuinely
     * diverge in mechanism, and so the one worth testing on both sides.
     */
    const noBank = textOf(await draw(invoice({ banking: null })))
    ok('an unconfigured banking block prints nothing', !noBank.includes('620123456'))
    ok('...and takes its caption with it', !noBank.includes('BANKING'))

    const noNotes = textOf(await draw(invoice({ notes: null })))
    ok('an invoice with no notes prints no NOTES caption', !noNotes.includes('NOTES'))

    const plain = textOf(await draw())
    ok('a zero discount prints no Discount row', !plain.includes('Discount'))

    const discounted = textOf(await draw(invoice({ discountTotal: 50 })))
    ok('...but a real one does', discounted.includes('Discount'))

    // The three kind-specific dates: an email is always an invoice, so two of the
    // three rows are empty and must not print their labels.
    ok('an emailed invoice shows no quote expiry', !plain.includes('Valid until'))
    ok('...and no delivery date', !plain.includes('Delivery date'))
    ok('...but does show when it is due', plain.includes('Due'))
  }

  /* ── the pay link ───────────────────────────────────────────────────────── */

  console.log('\n-- paying it ---')
  {
    const withLink = await draw(invoice({ paymentUrl: 'https://pay.example.test/inv/456' }))
    const raw = withLink.toString('latin1')

    ok('the pay-online link is on the page', textOf(withLink).includes('pay.example.test'))
    /*
     * And as a real annotation, not only as text. lib/invoices/pdf.ts puts the
     * reason plainly: "a URL nobody can click in a PDF is a URL nobody uses."
     */
    ok('...and it is clickable', /\/Subtype\s*\/Link/.test(raw) && /\/URI\s*\(https:\/\/pay/.test(raw))

    const without = textOf(await draw())
    ok('an invoice with no link shows nothing there', !without.includes('pay.example.test'))

    const foot = textOf(await draw(invoice({ footNote: 'Contract CON000012, March 2027' })))
    ok('a foot note prints when there is one', foot.includes('CON000012'))
  }

  /* ── a long invoice ─────────────────────────────────────────────────────── */

  console.log('\n-- an invoice that runs long --')
  {
    /*
     * THE REASON BANDS EXIST.
     *
     * The body is flowed and the footer follows it, so a long invoice pushes the
     * totals down rather than printing them over the items. A layout that placed
     * everything absolutely would pass every test written against three lines and
     * fail on the first real order.
     */
    const many = invoice({
      lines: Array.from({ length: 30 }, (_, i) => ({
        productCode: `P-${i}`,
        description: `Item number ${i} with a description long enough to wrap`,
        qty: 2,
        unitPriceIncl: 115,
        discountPct: 0,
        vatRatePct: 15,
        lineTotalIncl: 230,
      })),
    })
    const text = textOf(await draw(many))
    ok('every line is drawn', text.includes('Item number 0') && text.includes('Item number 29'))
    ok('...and the totals are still after them',
      text.indexOf('Item number 29') < text.lastIndexOf('R1 250.00') ||
        text.indexOf('Item number 29') < text.indexOf('Subtotal'))
  }

  console.log(`\n${fails === 0 ? 'All stationery-PDF checks passed.' : `${fails} FAILED`}`)
  process.exit(fails === 0 ? 0 : 1)

}

main().then(() => {
  console.log(`
${fails === 0 ? 'All stationery-PDF checks passed.' : `${fails} FAILED`}`)
  process.exit(fails === 0 ? 0 : 1)
})
