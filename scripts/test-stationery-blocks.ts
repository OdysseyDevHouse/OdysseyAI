/**
 * The visual designer's block model.
 *
 *   npm run test:stationery-blocks
 *
 * ── THE CENTRAL ASSERTION ────────────────────────────────────────────────
 *
 * The shipped purchase order, expressed as BLOCKS and compiled, must render the
 * same document the hand-written HTML default renders. If the block model
 * cannot express the document we already ship, the model is wrong — and finding
 * that out here is far cheaper than finding it out after a shop has designed
 * against it.
 *
 * Every other check here is secondary to that one.
 *
 * Needs no database and no browser.
 */
import { PURCHASE_ORDER_DEFAULT } from '../src/lib/stationery/defaults/purchaseOrder'
import { PURCHASE_ORDER_BLOCKS } from '../src/lib/stationery/defaults/purchaseOrderBlocks'
import { compileDocument, rowsOf, supportsBlocks } from '../src/lib/stationery/compile'
import {
  parseSpec,
  serialiseSpec,
  validateSpec,
  blockKindsFor,
  newBlock,
  MAX_BLOCKS,
  type DocumentSpec,
} from '../src/lib/stationery/blocks'
import { purchaseOrderTokens } from '../src/lib/stationery/adapters/purchaseOrder'
import { renderTemplate } from '../src/lib/stationery/render'
import { validateTemplate } from '../src/lib/stationery/validate'
import { sanitiseTemplate } from '../src/lib/stationery/sanitise'
import type { PurchaseDocument } from '../src/lib/site/purchaseDocuments'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const OWNER = { isOwner: true, granted: new Set<string>() }
const JUNIOR = { isOwner: false, granted: new Set<string>(['purchasing.view']) }

function order(over: Record<string, unknown> = {}): PurchaseDocument {
  return {
    id: 12, docType: 'purchase_order', status: 'open', documentNumber: 'PO000123',
    documentDate: '2026-08-18', supplierId: 5, supplierName: 'Bolt Supply Co',
    userName: 'Tiaan', subtotalExcl: 1000, vatTotal: 150, totalIncl: 1150,
    chargesExcl: 0, discountExcl: 0, discountPct: 0, reference: 'REF-9',
    notes: 'Deliver before noon.', expectedDate: '2026-08-25', createdAt: new Date(),
    lines: [
      { id: 1, lineNumber: 1, productCode: 'W-1', supplierCode: 'BS-W1', description: 'Widget',
        qtyOrdered: 10, unitCostExcl: 50, discountPct: 0, discountAmount: 0, vatRatePct: 15,
        lineTotalExcl: 500, lineVat: 75, lineTotalIncl: 575 },
      { id: 2, lineNumber: 2, productCode: 'G-2', supplierCode: null, description: 'Gadget',
        qtyOrdered: 5, unitCostExcl: 100, discountPct: 0, discountAmount: 0, vatRatePct: 15,
        lineTotalExcl: 500, lineVat: 75, lineTotalIncl: 575 },
    ],
    ...over,
  } as unknown as PurchaseDocument
}

const SITE = {
  name: 'Acme Trading', vatNumber: '4123456789', registrationNumber: '2019/123456/07',
  address1: 'Unit 4', address2: 'Industrial Park', address3: 'Cape Town', postalCode: '7441',
  phone: '021 555 0100', email: 'buying@acme.co.za',
}
const SUPPLIER = {
  name: 'Bolt Supply Co', contactName: 'Sam', email: 'sales@bolt.co.za',
  phone: '021 555 0200', addressLine1: '12 Nut Street', addressLine2: null,
  city: 'Durban', postalCode: '4001', vatNumber: '4987654321',
  accountNumber: 'ACME-01', paymentTermsDays: 30,
}
const DELIVER = ['Acme Trading', 'Unit 4', 'Industrial Park', 'Cape Town', '7441']

const inputFor = (doc: PurchaseDocument) =>
  purchaseOrderTokens({
    doc, site: SITE, supplier: SUPPLIER, deliverTo: DELIVER,
    printedAt: '18/08/2026, 14:30', isReprint: false,
  })

/** What a READER sees: visible text, whitespace-collapsed, CSS excluded. */
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

const renderBlocks = (spec: DocumentSpec, doc = order(), caps = OWNER) =>
  renderTemplate(compileDocument(spec, 'purchase_order'), 'purchase_order', {
    ...inputFor(doc),
    capabilities: caps,
  })

/* ── the assertion this file exists for ──────────────────────────────────── */

console.log('\n-- the block model can express the document we ship --')
{
  const cases: [string, PurchaseDocument][] = [
    ['an ordinary order', order()],
    ['a draft', order({ documentNumber: null, status: 'draft' })],
    ['no reference, no expected date', order({ reference: null, expectedDate: null })],
    ['no notes', order({ notes: null })],
    ['a line with no supplier code', order({
      lines: [{ id: 1, lineNumber: 1, productCode: 'X-1', supplierCode: null,
        description: 'Thing', qtyOrdered: 1, unitCostExcl: 10, discountPct: 0,
        discountAmount: 0, vatRatePct: 15, lineTotalExcl: 10, lineVat: 1.5,
        lineTotalIncl: 11.5 }],
    })],
  ]

  for (const [label, doc] of cases) {
    const fromHtml = textOf(renderTemplate(PURCHASE_ORDER_DEFAULT, 'purchase_order', {
      ...inputFor(doc), capabilities: OWNER,
    }))
    const fromBlocks = textOf(renderBlocks(PURCHASE_ORDER_BLOCKS, doc))
    ok(`${label} reads identically`, fromHtml === fromBlocks,
      fromHtml === fromBlocks ? '' : `\n   html  : ${fromHtml}\n   blocks: ${fromBlocks}`)
  }
}

/* ── the compiled document is a first-class template ─────────────────────── */

console.log('\n-- what compiles is an ordinary template --')
{
  const compiled = compileDocument(PURCHASE_ORDER_BLOCKS, 'purchase_order')

  ok('it passes the same validator a hand-written template does',
    validateTemplate('purchase_order', compiled).ok,
    JSON.stringify(validateTemplate('purchase_order', compiled).errors))

  // The whole reason to compile rather than render directly: everything
  // downstream keeps working, unchanged.
  const cleaned = sanitiseTemplate(compiled)
  ok('it survives the sanitiser with its structure intact',
    cleaned.includes('<article') && cleaned.includes('{#each lines}') && cleaned.includes('{/each}'))

  ok('the block model is offered for A4 documents', supportsBlocks('purchase_order'))
  ok('...and not for the till slip, whose blocks are ESC/POS', !supportsBlocks('slip'))
}

/* ── permissions still degrade silently ─────────────────────────────────── */

console.log('\n-- a designed document obeys the same permissions --')
{
  const buyer = renderBlocks(PURCHASE_ORDER_BLOCKS, order(),
    { isOwner: false, granted: new Set(['purchasing.view', 'products.cost']) })
  const junior = renderBlocks(PURCHASE_ORDER_BLOCKS, order(), JUNIOR)

  ok('a buyer sees unit cost', /R50\.00/.test(buyer))
  ok('a junior gets the same document with cost blank, not an error',
    !/R50\.00/.test(junior) && /Widget/.test(junior))
  ok('...and the order total still prints for them', /R1 150\.00/.test(junior))
}

/* ── the column controls, which is what was actually asked for ───────────── */

console.log('\n-- the line table columns --')
{
  const table = PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.kind === 'lineTable')!

  // Hide a column.
  const without: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.kind === 'lineTable'
        ? { ...b, columns: b.columns!.filter((c) => c.token !== 'line.unitCostExcl') }
        : b),
  }
  const hidden = renderBlocks(without)
  ok('a column removed in the designer leaves the paper',
    !/Unit cost/.test(hidden) && !/R50\.00/.test(hidden))
  ok('...and the rest of the table is untouched',
    /Widget/.test(hidden) && /R500\.00/.test(hidden))

  // Rename a heading.
  const renamed: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.kind === 'lineTable'
        ? { ...b, columns: b.columns!.map((c) =>
            c.token === 'line.unitCostExcl' ? { ...c, heading: 'Rate' } : c) }
        : b),
  }
  const r = renderBlocks(renamed)
  ok('a renamed heading prints', /Rate/.test(r) && !/Unit cost/.test(r))
  ok('...and the column still shows the same field', /R50\.00/.test(r))

  // Reorder.
  const reordered: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.kind === 'lineTable' ? { ...b, columns: [...b.columns!].reverse() } : b),
  }
  const head = textOf(renderBlocks(reordered)).match(/Total \(excl\.\) Unit cost Qty Item/)
  ok('reordering the columns reorders the headings', !!head, textOf(renderBlocks(reordered)).slice(180, 260))

  // Width.
  const widened: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.kind === 'lineTable'
        ? { ...b, columns: b.columns!.map((c) =>
            c.token === 'line.description' ? { ...c, width: 55 } : c) }
        : b),
  }
  ok('a column width reaches the markup', /width:55%/.test(compileDocument(widened, 'purchase_order')))

  ok('the shipped table has the four columns a PO needs', table.columns!.length === 4)
}

/* ── layout ──────────────────────────────────────────────────────────────── */

console.log('\n-- two columns, and only two --')
{
  const rows = rowsOf(PURCHASE_ORDER_BLOCKS.blocks)
  ok('a left/right pair becomes one row',
    rows.some((r) => 'left' in r && r.left.kind === 'letterhead' && r.right.kind === 'docTitle'))

  // A half-width block whose partner was dragged away must not leave a hole.
  const orphan = rowsOf([newBlock('letterhead', { span: 'left' }), newBlock('lineTable')])
  ok('a left block with no partner spans the page', 'full' in orphan[0])

  const strayRight = rowsOf([newBlock('lineTable'), newBlock('totals', { span: 'right' })])
  ok('a stray right block spans too', strayRight.every((r) => 'full' in r))
}

/* ── reading a stored spec ───────────────────────────────────────────────── */

console.log('\n-- storage round trip --')
{
  const json = serialiseSpec(PURCHASE_ORDER_BLOCKS)
  const back = parseSpec(json, 'purchase_order')
  ok('a design survives being stored and read back',
    !!back && JSON.stringify(back.blocks) === JSON.stringify(PURCHASE_ORDER_BLOCKS.blocks))

  ok('unreadable JSON is null, not a throw', parseSpec('{{{', 'purchase_order') === null)
  ok('JSON with no blocks is null', parseSpec('{"version":1}', 'purchase_order') === null)

  // The saved_reports rule: a spec outlives the code that wrote it.
  const future = parseSpec(
    '{"version":1,"blocks":[{"id":"a","kind":"lineTable","columns":[{"token":"line.qty","heading":"Q"}]},{"id":"b","kind":"someFutureBlock"}]}',
    'purchase_order')
  ok('a block kind we no longer know is dropped, not fatal',
    !!future && future.blocks.length === 1 && future.blocks[0].kind === 'lineTable')

  const staleCol = parseSpec(
    '{"version":1,"blocks":[{"id":"a","kind":"lineTable","columns":[{"token":"line.qty","heading":"Q"},{"token":"line.goneAway","heading":"X"}]}]}',
    'purchase_order')
  ok('a column naming a token that no longer exists is dropped',
    !!staleCol && staleCol.blocks[0].columns!.length === 1)

  // Two blocks sharing an id would share a React key AND a drag handle.
  const dupes = parseSpec(
    '{"version":1,"blocks":[{"id":"same","kind":"rule"},{"id":"same","kind":"spacer"}]}',
    'purchase_order')
  ok('duplicate ids are re-identified, not dropped',
    !!dupes && dupes.blocks.length === 2 && dupes.blocks[0].id !== dupes.blocks[1].id)

  const foreign = parseSpec(
    '{"version":1,"blocks":[{"id":"a","kind":"banking"},{"id":"b","kind":"lineTable"}]}',
    'purchase_order')
  ok('a block that does not belong on this document is dropped',
    !!foreign && !foreign.blocks.some((b) => b.kind === 'banking'))
}

/* ── validation ──────────────────────────────────────────────────────────── */

console.log('\n-- validation --')
{
  ok('the shipped design validates',
    validateSpec(PURCHASE_ORDER_BLOCKS, 'purchase_order').ok,
    JSON.stringify(validateSpec(PURCHASE_ORDER_BLOCKS, 'purchase_order').errors))

  for (const kind of ['docTitle', 'lineTable', 'totals'] as const) {
    const without: DocumentSpec = {
      version: 1,
      blocks: PURCHASE_ORDER_BLOCKS.blocks.filter((b) => b.kind !== kind),
    }
    ok(`a document without "${kind}" is refused`, !validateSpec(without, 'purchase_order').ok)
  }

  const twice: DocumentSpec = {
    version: 1,
    blocks: [...PURCHASE_ORDER_BLOCKS.blocks, newBlock('totals')],
  }
  ok('two totals blocks are refused', !validateSpec(twice, 'purchase_order').ok)

  const noCols: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.kind === 'lineTable' ? { ...b, columns: [] } : b),
  }
  ok('an items table with no columns is refused', !validateSpec(noCols, 'purchase_order').ok)

  const many: DocumentSpec = {
    version: 1,
    blocks: Array.from({ length: MAX_BLOCKS + 5 }, () => newBlock('rule')),
  }
  ok('too many blocks is refused', !validateSpec(many, 'purchase_order').ok)

  ok('banking is offered on an invoice', blockKindsFor('invoice').includes('banking'))
  ok('...and not on a purchase order', !blockKindsFor('purchase_order').includes('banking'))
}

/* ── the custom-HTML escape hatch ────────────────────────────────────────── */

console.log('\n-- the html block --')
{
  const spec: DocumentSpec = {
    version: 1,
    blocks: [
      ...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('html', { text: '<p>Custom <strong>bit</strong></p><script>alert(1)</script>' }),
    ],
  }
  const compiled = compileDocument(spec, 'purchase_order')
  ok('custom markup reaches the compiled document', /Custom/.test(compiled))

  // It is no more trusted than any other markup someone typed.
  const cleaned = sanitiseTemplate(compiled)
  ok('...and the sanitiser still strips a script from it',
    !/<\s*script/i.test(cleaned) && !/alert\s*\(/.test(cleaned))
  ok('...while keeping the legitimate part', /<strong>bit<\/strong>/.test(cleaned))
}

/* ── a designer's own words ──────────────────────────────────────────────── */

console.log('\n-- text blocks --')
{
  const spec: DocumentSpec = {
    version: 1,
    blocks: [...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('text', { text: 'Ask for {doc.number} & quote it' })],
  }
  const out = renderBlocks(spec)
  ok('a token inside typed words resolves', /Ask for PO000123/.test(out))
  ok('...and an ampersand is escaped, not left raw', /&amp;/.test(out))

  const hostile: DocumentSpec = {
    version: 1,
    blocks: [...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('text', { text: '<img src=x onerror=alert(1)>' })],
  }
  ok('typed words cannot introduce markup',
    !/<img/.test(renderBlocks(hostile)) && /&lt;img/.test(renderBlocks(hostile)))
}

console.log(`\n${fails === 0 ? 'All block-model checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
