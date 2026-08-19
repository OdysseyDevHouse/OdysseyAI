/**
 * The invoice, as a block design.
 *
 *   npm run test:invoice-blocks
 *
 * ── THE SAME GATE THE PURCHASE ORDER FACED ───────────────────────────────
 *
 * The shipped invoice, expressed as BLOCKS and compiled, must render the same
 * document the hand-written markup default renders. If the block model cannot
 * express the invoice we already ship, the model is wrong — and finding that out
 * here is cheaper than finding it out after a shop has designed against it.
 *
 * ── AND A SECOND GATE THE PURCHASE ORDER NEVER HAD ───────────────────────
 *
 * An invoice is a legal document. Section 20(4) of the VAT Act names what it
 * must carry, validate.ts refuses to save a fork that drops any of it, and that
 * check runs over the COMPILED markup — so a design made by dragging answers to
 * exactly the same rule as one typed by hand. The checks at the end of this file
 * are the proof, including the negative cases: dropping a required block must
 * actually be refused, or the rule is decoration.
 *
 * Needs no database and no browser.
 */
import { INVOICE_DEFAULT } from '../src/lib/stationery/defaults/invoice'
import { INVOICE_BLOCKS } from '../src/lib/stationery/defaults/invoiceBlocks'
import { compileDocument, compileBlocks, supportsBlocks } from '../src/lib/stationery/compile'
import {
  parseSpec,
  serialiseSpec,
  validateSpec,
  blockKindsFor,
  removeBlock,
  newBlock,
  type DocumentSpec,
} from '../src/lib/stationery/blocks'
import { DEFAULT_SPECS } from '../src/lib/stationery/resolve'
import { invoiceTokens } from '../src/lib/stationery/adapters/invoice'
import { renderTemplate } from '../src/lib/stationery/render'
import { validateTemplate } from '../src/lib/stationery/validate'
import { sanitiseTemplate } from '../src/lib/stationery/sanitise'
import type { SalesDocument } from '../src/lib/site/salesDocuments'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const OWNER = { isOwner: true, granted: new Set<string>() }

function sale(over: Record<string, unknown> = {}): SalesDocument {
  return {
    id: 88,
    docType: 'invoice',
    docLabel: 'Invoice',
    status: 'finalised',
    documentNumber: 'INV000456',
    documentDate: '2026-08-18',
    dueDate: '2026-09-17',
    customerId: 3,
    customerCode: 'CUST-003',
    customerName: 'Khumalo Supplies',
    customerVatNo: '4111222333',
    customerPhone: '031 555 0111',
    customerAddress: '155 Industrial Road\nDurban 3957',
    userName: 'Tiaan',
    subtotalExcl: 1000,
    vatTotal: 150,
    discountTotal: 0,
    totalIncl: 1150,
    roundingAdj: 0,
    reference: 'REF-77',
    notes: 'Thank you for your business.',
    lines: [
      {
        id: 1, lineNumber: 1, productCode: 'W-1', description: 'Widget',
        qty: 10, unitPriceIncl: 57.5, discountPct: 0, vatRatePct: 15,
        lineTotalExcl: 500, lineTotalIncl: 575,
      },
      {
        id: 2, lineNumber: 2, productCode: 'G-2', description: 'Gadget',
        qty: 5, unitPriceIncl: 115, discountPct: 0, vatRatePct: 15,
        lineTotalExcl: 500, lineTotalIncl: 575,
      },
    ],
    ...over,
  } as unknown as SalesDocument
}

const SITE = {
  name: 'Acme Trading',
  vatNumber: '4123456789',
  registrationNumber: '2019/123456/07',
  address1: 'Unit 4',
  address2: 'Industrial Park',
  address3: 'Cape Town',
  postalCode: '7441',
  phone: '021 555 0100',
  email: 'sales@acme.co.za',
}

const BANKING = {
  bank: 'First National',
  accountName: 'Acme Trading',
  accountNumber: '620123456',
  branchCode: '250655',
}

const inputFor = (doc: SalesDocument, over: Record<string, unknown> = {}) =>
  invoiceTokens({
    doc,
    site: SITE,
    banking: BANKING,
    printedAt: '18/08/2026, 14:30',
    closing: 'Please pay by the due date.',
    ...over,
  } as never)

/** What a READER sees: visible text, whitespace-collapsed, CSS excluded. */
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

const fromMarkup = (doc: SalesDocument, over = {}) =>
  textOf(renderTemplate(INVOICE_DEFAULT, 'invoice', { ...inputFor(doc, over), capabilities: OWNER }))

const fromBlocks = (doc: SalesDocument, over = {}, spec = INVOICE_BLOCKS) =>
  textOf(
    renderTemplate(compileDocument(spec, 'invoice'), 'invoice', {
      ...inputFor(doc, over),
      capabilities: OWNER,
    }),
  )

/* ── the assertion this file exists for ──────────────────────────────────── */

console.log('\n-- the block model can express the invoice we ship --')
{
  const cases: [string, SalesDocument, Record<string, unknown>][] = [
    ['an ordinary invoice', sale(), {}],
    ['a cash sale with no customer', sale({ customerName: null, customerCode: null, customerAddress: '', customerPhone: '', customerVatNo: null }), {}],
    ['no reference, no due date', sale({ reference: null, dueDate: null }), {}],
    ['no notes', sale({ notes: null }), {}],
    ['a discount and a rounding adjustment', sale({ discountTotal: 50, roundingAdj: 0.03 }), {}],
    ['a draft with no number yet', sale({ documentNumber: null }), {}],
    ['banking not configured', sale(), { banking: null }],
  ]

  /*
   * Compared in three parts, exactly as the purchase order is — and for the same
   * reason, which is documented at length in test-stationery-blocks.ts.
   *
   * The block invoice puts the VAT summary beside the totals and banking beside
   * the notes, where the markup default stacks all four full-width. That is a
   * deliberate use of the room an A4 page has, so the two no longer read in the
   * same ORDER below the items table. Above it, and inside it, order is still
   * strict — and the whole page is compared as a set of values, so reordering is
   * allowed and losing a field is not.
   */
  const SPLIT = 'Item Qty'
  const words = (t: string) => t.split(' ').filter(Boolean).sort().join(' ')
  const above = (t: string) => {
    const at = t.indexOf(SPLIT)
    return at === -1 ? t : t.slice(0, at).trim()
  }

  for (const [label, doc, over] of cases) {
    const m = fromMarkup(doc, over)
    const b = fromBlocks(doc, over)

    ok(`${label} reads identically above the items`, above(m) === above(b),
      above(m) === above(b) ? '' : `\n   markup: ${above(m)}\n   blocks: ${above(b)}`)

    ok(`...and the whole page carries the same values`, words(m) === words(b),
      words(m) === words(b) ? '' : `\n   markup: ${m}\n   blocks: ${b}`)
  }

  // The items table on its own, strictly: a column out of place is a misread price.
  {
    const rowOf = (t: string) => {
      const at = t.indexOf(SPLIT)
      if (at === -1) return ''
      const ends = ['Subtotal (excl.)', 'VAT SUMMARY', 'BANKING']
        .map((x) => t.indexOf(x, at))
        .filter((i) => i !== -1)
      return t.slice(at, ends.length ? Math.min(...ends) : undefined).trim()
    }
    const m = rowOf(fromMarkup(sale()))
    const b = rowOf(fromBlocks(sale()))
    ok('the items table reads identically, column for column', m === b && m !== '',
      m === b ? '' : `\n   markup: ${m}\n   blocks: ${b}`)
  }
}

/* ── what the law asks for ───────────────────────────────────────────────── */

console.log('\n-- a designed invoice is still a lawful one --')
{
  const compiled = compileDocument(INVOICE_BLOCKS, 'invoice')

  const v = validateTemplate('invoice', compiled)
  ok('the shipped block design passes the legal validator', v.ok,
    JSON.stringify(v.errors.map((e) => e.message)))

  /*
   * THE NEGATIVE CASES, which are the ones that matter.
   *
   * A validator that never says no proves nothing about a design that happens to
   * be fine. Each of these is a field s20(4) names, removed one at a time.
   */
  const drops: [string, string][] = [
    ['the VAT summary', 'inv-vat'],
    ['the customer', 'inv-customer'],
    ['the totals', 'inv-totals'],
    ['the document title', 'inv-title'],
  ]
  for (const [what, id] of drops) {
    const without = compileDocument(removeBlock(INVOICE_BLOCKS, id), 'invoice')
    ok(`an invoice without ${what} is refused`, !validateTemplate('invoice', without).ok)
  }

  // The letterhead carries the business name and its VAT number, both required.
  const noLetterhead = compileDocument(removeBlock(INVOICE_BLOCKS, 'inv-letterhead'), 'invoice')
  ok('an invoice without the letterhead is refused', !validateTemplate('invoice', noLetterhead).ok)

  /*
   * TAX INVOICE comes from a token, not from typed words.
   *
   * Only a VAT vendor may call its document a tax invoice, and the adapter
   * decides that from whether the site has a VAT number. A design that hard-coded
   * the words would print a claim about the business that might not be true.
   */
  ok('the title is a token, so a non-vendor cannot be made to claim TAX INVOICE',
    !compiled.includes('TAX INVOICE') && compiled.includes('{doc.heading}'))

  const asVendor = fromBlocks(sale())
  ok('...a VAT vendor gets the words TAX INVOICE', /TAX INVOICE/.test(asVendor))

  const notVendor = textOf(
    renderTemplate(compileDocument(INVOICE_BLOCKS, 'invoice'), 'invoice', {
      ...invoiceTokens({
        doc: sale(),
        site: { ...SITE, vatNumber: null },
        banking: BANKING,
        printedAt: '18/08/2026, 14:30',
        closing: '',
      } as never),
      capabilities: OWNER,
    }),
  )
  ok('...and a non-vendor gets INVOICE, never TAX INVOICE',
    /INVOICE/.test(notVendor) && !/TAX INVOICE/.test(notVendor))
}

/* ── the blocks an invoice has that a purchase order does not ────────────── */

console.log('\n-- VAT summary, banking, and a five-row totals --')
{
  ok('banking is offered on an invoice', blockKindsFor('invoice').includes('banking'))
  ok('...and the VAT summary too', blockKindsFor('invoice').includes('vatSummary'))

  const withBank = fromBlocks(sale())
  ok('banking prints when every detail is set',
    /First National/.test(withBank) && /620123456/.test(withBank) && /250655/.test(withBank))

  /*
   * ALL FOUR OR NONE. build.ts puts the reason plainly: "an invoice with a
   * half-filled banking block is worse than one with none, because it looks like
   * enough information to pay against."
   */
  const halfBank = fromBlocks(sale(), { banking: { ...BANKING, branchCode: null } })
  ok('a half-filled banking block prints nothing at all',
    !/First National/.test(halfBank) && !/620123456/.test(halfBank))

  /*
   * ── HIDING IS CSS, SO IT IS CHECKED AS CSS ────────────────────────────
   *
   * The caption over an empty value disappears through `.sd-block:has(>
   * .sd-value:empty)`, not by being left out of the markup. `textOf` strips the
   * style block before comparing, so asserting that "BANKING DETAILS" is absent
   * from the extracted text tests something a text extractor cannot see — and it
   * fails identically against the SHIPPED MARKUP INVOICE, which is how I know
   * the first version of these three checks was wrong rather than the code.
   *
   * What actually decides the outcome is the pair: a wrapper the rule can match,
   * around a value that really did come out empty. Both are asserted here, and
   * the rule itself is asserted in test-stationery-blocks.
   */
  const halfMarkup = renderTemplate(compileDocument(INVOICE_BLOCKS, 'invoice'), 'invoice', {
    ...inputFor(sale(), { banking: { ...BANKING, branchCode: null } }),
    capabilities: OWNER,
  })
  ok('...and its caption is inside a wrapper the hide rule matches',
    /<div class="sd-block">[\s\S]*?BANKING DETAILS[\s\S]*?<p class="sd-value[^"]*"><\/p>/.test(halfMarkup),
    halfMarkup.slice(halfMarkup.indexOf('BANKING') - 60, halfMarkup.indexOf('BANKING') + 140))

  // The totals rows that hide themselves when zero, which is the ordinary case.
  const plainMarkup = renderTemplate(compileDocument(INVOICE_BLOCKS, 'invoice'), 'invoice', {
    ...inputFor(sale()),
    capabilities: OWNER,
  })
  const emptyRow = (label: string) =>
    new RegExp(`<div class="sd-row[^"]*"><dt[^>]*>${label}</dt><dd[^>]*></dd></div>`).test(
      plainMarkup,
    )
  ok('a zero discount leaves an empty row for the rule to hide', emptyRow('Discount'))
  ok('...and so does a zero rounding adjustment', emptyRow('Rounding'))

  const adjusted = fromBlocks(sale({ discountTotal: 50, roundingAdj: 0.03 }))
  ok('...but both carry a value when there is one',
    /Discount/.test(adjusted) && /Rounding/.test(adjusted) && /R50\.00/.test(adjusted))

  const plain = fromBlocks(sale())
  ok('the VAT summary prints by rate', /15/.test(plain) && /VAT SUMMARY/.test(plain))

  /*
   * ── THE CLOSING LINE IS BLANK ON A TAX INVOICE, AND THAT IS DELIBERATE ──
   *
   * {doc.closing} carries a warning on a quote ("no payment is due until it is
   * accepted") and on a pro forma, and is empty on a tax invoice, which needs no
   * such caveat. So the shipped invoice would otherwise reserve a line on every
   * page for a sentence that never prints.
   *
   * A text block that is ONE TOKEN and nothing else therefore hides itself, the
   * way a notes block does — and a block with words of its own does not, because
   * "Please quote {doc.number}" is still an instruction to the reader even if
   * the number is missing.
   */
  const compiledInv = compileDocument(INVOICE_BLOCKS, 'invoice')
  ok('a text block that is one token can hide itself',
    /<div class="sd-block"><p class="sd-value[^"]*">\{doc\.closing\}<\/p><\/div>/.test(compiledInv),
    compiledInv.slice(compiledInv.indexOf('doc.closing') - 90, compiledInv.indexOf('doc.closing') + 30))

  ok('...and a block with words of its own does not',
    /<p class="text-xs text-muted">Printed \{doc\.printedAt\}<\/p>/.test(compiledInv))
}

/* ── one template, four documents ────────────────────────────────────────── */

console.log('\n-- a quote, an order, a pro forma and a tax invoice --')
{
  /*
   * ONE ROUTE PRINTS ALL FOUR, and one design serves them.
   *
   * What differs is words and dates, and both arrive as tokens: {doc.heading}
   * says QUOTATION or TAX INVOICE, {doc.closing} carries the warning a quote
   * needs and nothing on an invoice, and the three date rows each print only on
   * the kind they belong to — because a detail list drops a row whose value is
   * empty. No conditionals, and nothing for a shop to configure per document.
   *
   * This is what makes the swap in (print)/sales/[id]/document honest: before
   * it, a shop could design an invoice, save it, and print the shipped layout
   * anyway.
   */
  /*
   * ROWS ARE CHECKED FOR A VALUE, NOT FOR A LABEL.
   *
   * A detail list emits every row and CSS hides the ones whose value came out
   * empty — so `textOf` strips the style block and the label survives in the
   * extracted text either way. Asserting a label is absent tests something a
   * text extractor cannot see; the first version of these two checks did
   * exactly that and failed against working code.
   *
   * What decides the outcome is whether the <dd> has anything in it.
   */
  const rowValue = (doc: SalesDocument, over: Record<string, unknown>, label: string) => {
    const html = renderTemplate(compileDocument(INVOICE_BLOCKS, 'invoice'), 'invoice', {
      ...inputFor(doc, over),
      capabilities: OWNER,
    })
    const m = html.match(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>([^<]*)</dd>`))
    return m ? m[1] : null
  }

  const quote = fromBlocks(sale({ docType: 'quote' }), {
    heading: 'QUOTATION',
    closing: 'This is a quotation, not an invoice.',
    validUntil: '2026-09-11',
    customerOrderNo: 'PO-88213',
  })
  ok('a quote calls itself a QUOTATION', /QUOTATION/.test(quote) && !/TAX INVOICE/.test(quote))
  ok('...and shows when it expires', /Valid until/.test(quote) && /2026-09-11/.test(quote))
  ok('...and carries its own warning', /not an invoice/.test(quote))
  ok("...and shows the customer's own order number", /PO-88213/.test(quote))

  const order = fromBlocks(sale({ docType: 'sales_order' }), {
    heading: 'SALES ORDER',
    closing: 'An invoice follows when the goods are delivered.',
    deliveryDate: '2026-08-25',
  })
  ok('an order calls itself a SALES ORDER', /SALES ORDER/.test(order))
  ok('...and shows its promised date', /Delivery date/.test(order) && /2026-08-25/.test(order))
  ok('...and leaves the quote expiry row empty, for the rule to hide',
    rowValue(sale({ docType: 'sales_order' }), { deliveryDate: '2026-08-25' }, 'Valid until') === '')

  const invoice = fromBlocks(sale(), { heading: 'TAX INVOICE', closing: '' })
  ok('a tax invoice shows when it falls due', /Due/.test(invoice) && /2026-09-17/.test(invoice))
  ok('...and leaves both the expiry and the delivery rows empty',
    rowValue(sale(), {}, 'Valid until') === '' && rowValue(sale(), {}, 'Delivery date') === '')

  /*
   * The status banner, in one token — the same shape the purchase order uses.
   *
   * REPRINT is only ever claimed for a FINALISED invoice: a quote is expected to
   * be printed repeatedly while it is negotiated, and stamping the second copy
   * of one as a reprint would say something untrue about the document.
   */
  ok('a cancelled document says so',
    /CANCELLED/.test(fromBlocks(sale({ status: 'cancelled' }))))
  ok('an unfinalised invoice is a PRO FORMA',
    /PRO FORMA/.test(fromBlocks(sale({ status: 'saved' }))))
  ok('a reprinted tax invoice says REPRINT',
    /REPRINT/.test(fromBlocks(sale(), { isReprint: true })))
  ok('...but a reprinted quote does not',
    !/REPRINT/.test(fromBlocks(sale({ docType: 'quote' }), { isReprint: true })))
  ok('an ordinary first print carries no banner at all',
    !/REPRINT|CANCELLED|PRO FORMA/.test(fromBlocks(sale())))
}

/* ── the ordinary block-model checks, on this document ───────────────────── */

console.log('\n-- storage, structure and the canvas --')
{
  const json = serialiseSpec(INVOICE_BLOCKS)
  const back = parseSpec(json, 'invoice')
  ok('the design survives being stored and read back',
    !!back && JSON.stringify(back.blocks) === JSON.stringify(INVOICE_BLOCKS.blocks))

  ok('it validates structurally', validateSpec(INVOICE_BLOCKS, 'invoice').ok,
    JSON.stringify(validateSpec(INVOICE_BLOCKS, 'invoice').errors))

  /*
   * NOTHING ON THE PAGE SITS ON TOP OF ANYTHING ELSE.
   *
   * Only a browser knows a block's real height, so these are the heights measured
   * from the rendered design — recorded here as the contract the y values are
   * chosen against. The first set of those y values was arithmetic and put the
   * third rule straight through the banking block; this is the check that caught
   * the same class of mistake on the purchase order, and it is worth having on
   * the document that goes to customers.
   *
   * If a block's content grows past its number this fails, which is the reminder
   * to re-measure rather than to quietly raise the number.
   */
  const MEASURED: Record<string, number> = {
    'inv-logo': 14,
    'inv-letterhead': 32.4,
    'inv-title': 16.5,
    'inv-rule-1': 4,
    'inv-customer': 35.3,
    'inv-details': 11,
    'inv-lines': 46.6,
    'inv-totals': 31.3,
    'inv-vat': 16,
    'inv-rule-2': 4,
    'inv-banking': 26,
    'inv-notes': 11,
    'inv-rule-3': 4,
    'inv-closing': 4,
    'inv-printed': 4,
  }

  ok('every block has a measured height on record',
    INVOICE_BLOCKS.blocks.every((b) => MEASURED[b.id] !== undefined),
    INVOICE_BLOCKS.blocks.filter((b) => MEASURED[b.id] === undefined).map((b) => b.id).join(', '))

  const placed = validateSpec(INVOICE_BLOCKS, 'invoice', MEASURED)
  ok('no two blocks overlap at their measured sizes', placed.ok,
    JSON.stringify(placed.errors))

  // And a real overlap must be refused, or the check above passes vacuously.
  const stacked: DocumentSpec = {
    version: 1,
    blocks: INVOICE_BLOCKS.blocks.map((b) => (b.id === 'inv-rule-3' ? { ...b, y: 42 } : b)),
  }
  ok('...and a block dragged on top of another is refused',
    !validateSpec(stacked, 'invoice', MEASURED).ok)

  ok('the visual designer is offered for an invoice', supportsBlocks('invoice'))
  ok('...and the shipped design is registered, so the screen can fork it',
    DEFAULT_SPECS.invoice === INVOICE_BLOCKS)

  // The canvas and the paper share one compiler — see the note in compile.ts.
  const perBlock = compileBlocks(INVOICE_BLOCKS, 'invoice')
  const whole = compileDocument(INVOICE_BLOCKS, 'invoice')
  const missing = INVOICE_BLOCKS.blocks.filter(
    (b) => perBlock[b.id] !== '' && !whole.includes(perBlock[b.id]),
  )
  ok("each block's canvas markup appears verbatim in the printed page",
    missing.length === 0, missing.map((b) => b.id).join(', '))

  // A purchase-order-only block cannot be dropped onto an invoice.
  const wrong: DocumentSpec = {
    version: 1,
    blocks: [...INVOICE_BLOCKS.blocks, newBlock('banking', INVOICE_BLOCKS)],
  }
  ok('a second banking block is refused', !validateSpec(wrong, 'invoice').ok)

  const cleaned = sanitiseTemplate(whole)
  ok('the compiled invoice survives the sanitiser with its structure intact',
    cleaned.includes('<article') && cleaned.includes('{#each lines}') && cleaned.includes('{/each}'))
}

console.log(`\n${fails === 0 ? 'All invoice-design checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
