/**
 * Reading a supplier's PDF into document lines.
 *
 * What is actually being protected here:
 *
 *  - the model TRANSCRIBES and does not compute — a freight line, a fuel levy
 *    and a VAT subtotal are not products, and a line total is never divided
 *    back into a unit price
 *  - a printed figure survives whatever the supplier's accounting package did
 *    to it: a decimal comma, a space thousands separator, a currency prefix,
 *    brackets for a credit
 *  - where a document shows both ORDERED and DELIVERED, the delivered figure
 *    is the one that lands — receiving 40 of something when 36 arrived is a
 *    stock error that surfaces weeks later at a count
 *  - a line whose product cannot be resolved COMES BACK anyway, flagged. The
 *    failure mode has to be "this needs a human", never a silently short
 *    delivery
 *  - resolution prefers the supplier's own code, which is the only identifier
 *    an invoice actually quotes
 *
 * ── THIS TEST SPENDS MONEY ────────────────────────────────────────────────
 *
 * One Opus call per run, because the thing under test is the model's reading of
 * a real PDF and a recorded fixture would only ever prove that the parsing half
 * still works. It is deliberately NOT in the default suite for that reason —
 * run it when documentScan.ts changes.
 *
 *   npm run test:document-scan
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  isScanConfigured,
  parsePrinted,
  scanPurchaseDocument,
} from '../src/lib/import/documentScan'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── the document ──────────────────────────────────────────────────────────
   Built rather than committed: a binary fixture nobody can read in a diff is
   a fixture nobody maintains, and the shapes being tested are exactly the
   ones visible in this table. */

const LINES = [
  // code        description                     ord  del  unit      disc
  ['BW-4471', 'Sunflower Cooking Oil 2L', '24', '24', '58,90', ''],
  ['BW-1120', 'White Sugar 2.5kg', '40', '36', '42,15', '5'],
  ['BW-9903', 'Long Grain Rice 10kg', '12', '12', '189,00', ''],
  ['', 'Assorted Spice Sachets (mixed)', '60', '60', '4,25', ''],
  ['BW-2288', 'Full Cream Milk 1L UHT', '48', '48', '17,80', '2,5'],
]

function writeInvoice(to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' })
    const out = fs.createWriteStream(to)
    out.on('finish', () => resolve())
    out.on('error', reject)
    doc.pipe(out)

    doc.fontSize(16).text('BLUEBIRD WHOLESALERS (PTY) LTD')
    doc.fontSize(9).text('VAT No 4120198765 · 12 Marine Drive, Durban')
    doc.moveDown(0.8)
    doc.fontSize(13).text('TAX INVOICE')
    doc.fontSize(9)
    doc.text('Invoice No:  BW-88214')
    doc.text('Date:        2026-08-11')
    doc.text('Account:     ODY001   Odyssey Trading')
    doc.moveDown(0.8)

    const y0 = doc.y
    const cols = [40, 110, 300, 350, 400, 455, 510]
    ;['Code', 'Description', 'Ord', 'Del', 'Unit', 'Disc%', 'Amount'].forEach((h, i) =>
      doc.text(h, cols[i], y0, { width: 70 }),
    )
    doc.moveTo(40, y0 + 14).lineTo(555, y0 + 14).stroke()

    let y = y0 + 22
    for (const [code, desc, ord, del, unit, disc] of LINES) {
      const amount = (parsePrinted(del)! * parsePrinted(unit)!).toFixed(2).replace('.', ',')
      ;[code, desc, ord, del, unit, disc, amount].forEach((cell, i) =>
        doc.text(cell, cols[i], y, { width: i === 1 ? 185 : 68, align: i >= 2 ? 'right' : 'left' }),
      )
      y += 16
    }

    // The two that must NOT come back as products.
    y += 4
    doc.moveTo(40, y).lineTo(555, y).stroke()
    y += 8
    doc.text('Delivery / Freight', cols[1], y, { width: 185 })
    doc.text('310,00', cols[6], y, { width: 68, align: 'right' })
    y += 16
    doc.text('Fuel Levy', cols[1], y, { width: 185 })
    doc.text('45,00', cols[6], y, { width: 68, align: 'right' })

    // Nor these.
    y += 26
    doc.text('Subtotal (excl VAT)', 380, y)
    doc.text('6 570,63', 500, y, { width: 55, align: 'right' })
    y += 14
    doc.text('VAT @ 15%', 380, y)
    doc.text('985,59', 500, y, { width: 55, align: 'right' })
    y += 14
    doc.fontSize(11).text('TOTAL DUE', 380, y)
    doc.text('R 7 556,22', 490, y, { width: 65, align: 'right' })

    doc.end()
  })
}

async function main() {
  /* ── the parsing half, which costs nothing and catches most regressions ── */
  console.log('── printed figures ──')
  const printed: [string | null, number | null][] = [
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1234,56', 1234.56],
    ['R 1 234.56', 1234.56],
    ['(12.00)', -12],
    ['-45.50', -45.5],
    ['1,500', 1500],
    ['1 500,00', 1500],
    ['1.234.567,89', 1234567.89],
    ['3,5', 3.5],
    ['0.00', 0],
    ['', null],
    [null, null],
    ['N/A', null],
  ]
  let printedBad = 0
  for (const [input, want] of printed) {
    const got = parsePrinted(input)
    const same =
      got === want ||
      (got !== null && want !== null && Math.abs(got - want) < 1e-9)
    if (!same) {
      printedBad++
      console.log(`  ${JSON.stringify(input)} -> ${got}, wanted ${want}`)
    }
  }
  ok(`${printed.length} printed figures parse`, printedBad === 0, `${printedBad} wrong`)

  if (!isScanConfigured()) {
    console.log('\nANTHROPIC_API_KEY is not set — skipping the extraction half.')
    console.log(fails === 0 ? '\nALL PASS (partial)' : `\n${fails} FAILURE(S)`)
    process.exit(fails === 0 ? 0 : 1)
  }

  /* ── a supplier and one product, so resolution has something to find ───── */
  const stamp = Date.now().toString().slice(-6)
  const supplierCode = `SCAN_${stamp}`
  await siteExecute(
    SITE,
    "INSERT INTO suppliers (code, name, status) VALUES (?, ?, 'active')",
    [supplierCode, `Bluebird Scan Test ${stamp}`],
  )
  const supplier = await siteQueryOne<RowDataPacket & { id: number }>(
    SITE,
    'SELECT id FROM suppliers WHERE code = ?',
    [supplierCode],
  )
  const supplierId = Number(supplier!.id)

  // A product this supplier calls BW-1120 — the sugar line. Resolution must
  // find it by THEIR code, which is the match the whole feature turns on.
  const productCode = `SCANP_${stamp}`
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, is_archived, has_variants)
     VALUES (?, ?, 'stock', 0, 0)`,
    [productCode, `Scan Test White Sugar ${stamp}`],
  )
  const product = await siteQueryOne<RowDataPacket & { id: number }>(
    SITE,
    'SELECT id FROM products WHERE code = ?',
    [productCode],
  )
  const productId = Number(product!.id)

  await siteExecute(
    SITE,
    `INSERT INTO product_suppliers (product_id, supplier_id, supplier_code, pack_size)
     VALUES (?, ?, 'BW-1120', 1)`,
    [productId, supplierId],
  )

  const pdfPath = path.join(os.tmpdir(), `odyssey-scan-${stamp}.pdf`)

  try {
    await writeInvoice(pdfPath)
    const base64 = fs.readFileSync(pdfPath).toString('base64')

    console.log('\n── reading the document ──')
    const result = await scanPurchaseDocument(
      SITE,
      { name: 'invoice.pdf', base64 },
      supplierId,
    )

    if (!result.ok) {
      ok('the document was read', false, result.error)
      throw new Error(result.error)
    }

    for (const line of result.lines) {
      console.log(
        `  ${(line.reference || '(none)').padEnd(10)}` +
          ` ${line.scannedDescription.slice(0, 30).padEnd(32)}` +
          ` qty=${String(line.qty).padStart(5)}` +
          ` cost=${String(line.unitCostExcl).padStart(8)}` +
          ` ${line.matchKind}`,
      )
    }

    console.log('\n── header ──')
    ok('their invoice number', result.header.documentNumber === 'BW-88214',
      String(result.header.documentNumber))
    ok('the document date', result.header.documentDate === '2026-08-11',
      String(result.header.documentDate))
    ok(
      'the total, through a space separator and an R prefix',
      result.header.totalIncl !== null && Math.abs(result.header.totalIncl - 7556.22) < 0.005,
      String(result.header.totalIncl),
    )

    console.log('\n── goods lines only ──')
    ok('five lines', result.lines.length === 5, `got ${result.lines.length}`)
    ok('freight is not a product',
      !result.lines.some((l) => /freight|delivery/i.test(l.scannedDescription)))
    ok('the fuel levy is not a product',
      !result.lines.some((l) => /fuel|levy/i.test(l.scannedDescription)))
    ok('no VAT or subtotal line',
      !result.lines.some((l) => /\bvat\b|subtotal|total due/i.test(l.scannedDescription)))

    console.log('\n── what each line says ──')
    const sugar = result.lines.find((l) => /sugar/i.test(l.scannedDescription))
    ok('the sugar line came back', !!sugar)
    ok('delivered 36, not the 40 ordered', sugar?.qty === 36, String(sugar?.qty))
    ok('its cost through a decimal comma',
      !!sugar && Math.abs((sugar.unitCostExcl ?? 0) - 42.15) < 0.005,
      String(sugar?.unitCostExcl))
    ok('its 5% discount', sugar?.discountPct === 5, String(sugar?.discountPct))

    const milk = result.lines.find((l) => /milk/i.test(l.scannedDescription))
    ok('a fractional discount survives',
      !!milk && Math.abs((milk.discountPct ?? 0) - 2.5) < 0.001,
      String(milk?.discountPct))

    // The line with no code at all. It must still be HERE — dropping it is how
    // a delivery gets received short with nobody knowing which line went.
    const spice = result.lines.find((l) => /spice/i.test(l.scannedDescription))
    ok('a line with no code still comes back', !!spice)
    ok('and carries no invented reference', spice?.reference === '',
      JSON.stringify(spice?.reference))

    console.log('\n── resolution ──')
    ok('the sugar matched on THEIR code', sugar?.matchKind === 'supplier_code',
      String(sugar?.matchKind))
    ok('and matched the right product', sugar?.productId === productId,
      `${sugar?.productId} vs ${productId}`)
    ok('everything else is unmatched, not guessed',
      result.lines.filter((l) => l.productId !== null).length === 1,
      `${result.matched} matched`)
    ok('unmatched lines are counted for the buyer', result.unmatched === 4,
      String(result.unmatched))
    ok('an unmatched line keeps what the PDF called it',
      result.lines.every((l) => l.productId !== null || l.scannedDescription.length > 0))
  } finally {
    /* ── leave nothing behind ─────────────────────────────────────────────
       A leaked row on a UNIQUE column kills an unrelated suite before its
       first assertion, so this runs even when an assertion above threw. */
    fs.rmSync(pdfPath, { force: true })
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE supplier_id = ?', [supplierId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE code = ?', [productCode]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE code = ?', [supplierCode]).catch(() => {})

    const left = await siteQuery<RowDataPacket & { n: number }>(
      SITE,
      `SELECT (SELECT COUNT(*) FROM suppliers WHERE code = ?)
            + (SELECT COUNT(*) FROM products  WHERE code = ?) AS n`,
      [supplierCode, productCode],
    )
    ok('test records cleaned up', Number(left[0]?.n ?? 0) === 0, String(left[0]?.n))
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
