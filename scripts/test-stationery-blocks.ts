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
 * It started as one word-for-word comparison of the whole page and is now three
 * checks, because the block default deliberately improves one thing: NOTES sits
 * beside the totals rather than stacked below them. The reasoning, and why the
 * relaxation is still a real gate rather than a rubber stamp, is at the
 * comparison itself.
 *
 * Every other check here is secondary to that one.
 *
 * Needs no database and no browser.
 */
import { PURCHASE_ORDER_DEFAULT } from '../src/lib/stationery/defaults/purchaseOrder'
import { PURCHASE_ORDER_BLOCKS } from '../src/lib/stationery/defaults/purchaseOrderBlocks'
import {
  BLOCK_STYLE,
  bandExtent,
  compileBlocks,
  compileDocument,
  supportsBlocks,
} from '../src/lib/stationery/compile'
import {
  parseSpec,
  serialiseSpec,
  validateSpec,
  blockKindsFor,
  DEFAULT_LOGO_HEIGHT,
  MAX_LOGO_HEIGHT,
  MIN_LOGO_HEIGHT,
  findBlock,
  bandBlocks,
  newBlock,
  patchBlock,
  removeBlock,
  MAX_BLOCKS,
  type DocBlock,
  type DocumentSpec,
} from '../src/lib/stationery/blocks'
import {
  BAND_PX,
  BAND_REM,
  clampBlock,
  gapsFor,
  snapBlock,
  MIN_BLOCK_W,
} from '../src/lib/stationery/geometry'
import { allTokens, getDocType } from '../src/lib/stationery/catalog'
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

  /*
   * ── ONE DELIBERATE DIFFERENCE, AND WHY THE GATE IS SHAPED AROUND IT ─────
   *
   * The block default puts NOTES beside the totals; the markup default stacks it
   * full width below them. That is a chosen improvement to the shipped layout,
   * approved as such — a purchase order has room beside a totals box and wasting
   * it prints a longer document than it needs.
   *
   * Which means the two no longer read in the same ORDER, so a word-for-word
   * comparison of the whole page would fail on a difference that is correct. But
   * "compare the words in any order" is not a gate at all: a document with every
   * field scrambled would pass it.
   *
   * So the page is compared in three parts, and order still has to hold
   * everywhere it means anything:
   *
   *   ABOVE THE ITEMS — strict sequence. That order is the document's own
   *   structure: letterhead, title, who it is to, the dates.
   *
   *   THE WHOLE PAGE — as a set of values. Reordering below the table is
   *   allowed; losing or inventing a field is not. This is the check that keeps
   *   the relaxation honest.
   *
   *   THE ITEMS TABLE — strict again, on its own, because a column out of place
   *   is a misread price and the relaxation must not cover it.
   */
  const SPLIT = 'Item Qty'

  const words = (t: string) => t.split(' ').filter(Boolean).sort().join(' ')

  for (const [label, doc] of cases) {
    const fromHtml = textOf(renderTemplate(PURCHASE_ORDER_DEFAULT, 'purchase_order', {
      ...inputFor(doc), capabilities: OWNER,
    }))
    const fromBlocks = textOf(renderBlocks(PURCHASE_ORDER_BLOCKS, doc))

    const above = (t: string) => {
      const at = t.indexOf(SPLIT)
      return at === -1 ? t : t.slice(0, at).trim()
    }

    // STRICT above the items: order here is the document's own structure.
    const h = above(fromHtml)
    const bl = above(fromBlocks)
    ok(`${label} reads identically above the items`, h === bl,
      h === bl ? '' : `\n   html  : ${h}\n   blocks: ${bl}`)

    /*
     * And the whole page carries exactly the same values — nothing lost, nothing
     * invented. This is the check that keeps the relaxation honest: reordering is
     * allowed below the table, losing a field is not.
     */
    ok(`...and the whole page carries the same values`,
      words(fromHtml) === words(fromBlocks),
      words(fromHtml) === words(fromBlocks)
        ? ''
        : `\n   html  : ${fromHtml}\n   blocks: ${fromBlocks}`)
  }

  /*
   * The items table itself, in strict order, because a column out of place is a
   * misread price. Checked separately from the surrounding layout so the
   * relaxation above cannot quietly cover it.
   */
  {
    const doc = order()
    // Ends at whichever of the footer blocks comes first, since which one that
    // is differs between the two layouts — that being the whole point above.
    const rowOf = (t: string) => {
      const at = t.indexOf(SPLIT)
      if (at === -1) return ''
      const ends = ['Goods (excl.)', 'NOTES']
        .map((m) => t.indexOf(m, at))
        .filter((i) => i !== -1)
      return t.slice(at, ends.length ? Math.min(...ends) : undefined).trim()
    }
    const h = rowOf(textOf(renderTemplate(PURCHASE_ORDER_DEFAULT, 'purchase_order', {
      ...inputFor(doc), capabilities: OWNER,
    })))
    const bl = rowOf(textOf(renderBlocks(PURCHASE_ORDER_BLOCKS, doc)))
    ok('the items table reads identically, column for column', h === bl && h !== '',
      h === bl ? '' : `\n   html  : ${h}\n   blocks: ${bl}`)
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

/* ── the canvas must not lie about the paper ─────────────────────────────── */

console.log('\n-- what the designer sees is what prints --')
{
  /*
   * THE POINT OF COMPILING RATHER THAN RENDERING.
   *
   * The canvas draws each block on its own so it can be selected and dragged;
   * the printer gets the whole document. Two paths, and the entire architecture
   * rests on them producing the same markup for the same block — the moment they
   * differ, the preview is a lie and the designer finds out on paper.
   *
   * They DID differ, and it took a browser to notice: compileBlocks returned the
   * bare fragment while compileDocument wrapped the hide-when-empty blocks in
   * `sd-block`. So an empty notes block kept its "NOTES" caption on the canvas
   * and correctly dropped it when printed. Untested, so nothing caught it.
   */
  const perBlock = compileBlocks(PURCHASE_ORDER_BLOCKS, 'purchase_order')
  const whole = compileDocument(PURCHASE_ORDER_BLOCKS, 'purchase_order')

  ok('every block compiles for the canvas',
    PURCHASE_ORDER_BLOCKS.blocks.every((b) => perBlock[b.id] !== undefined))

  /*
   * Every fragment must appear VERBATIM in the printed document. That is a
   * stronger check than "both mention NOTES": it fails on a wrapper, a class or
   * an attribute that only one side adds.
   */
  const missing = PURCHASE_ORDER_BLOCKS.blocks.filter(
    (b) => perBlock[b.id] !== '' && !whole.includes(perBlock[b.id]),
  )
  ok('each block\'s canvas markup appears verbatim in the printed page',
    missing.length === 0,
    missing.map((b) => b.id).join(', '))

  // The specific one that was wrong, named so a regression reads clearly.
  ok('a hide-when-empty block carries its wrapper on the canvas too',
    perBlock['po-notes'].startsWith('<div class="sd-block">'),
    perBlock['po-notes'].slice(0, 60))

  ok('...and the rules that hide it are exported for the canvas to apply',
    BLOCK_STYLE.includes('.sd-block:has(> .sd-value:empty)'))

  // A block with nothing to hide is not wrapped, because a wrapper that never
  // does anything is a class someone later has to work out the purpose of.
  ok('a block with nothing to hide is not wrapped',
    !perBlock['po-letterhead'].includes('sd-block'))
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

/* ── bands ───────────────────────────────────────────────────────────────── */

console.log('\n-- three bands, and why --')
{
  const html = compileDocument(PURCHASE_ORDER_BLOCKS, 'purchase_order')

  ok('the page compiles to three bands', (html.match(/<section/g) ?? []).length === 3)

  // The header and footer are positioned; the body is not. That asymmetry is
  // the whole design, so it is asserted rather than assumed.
  ok('the header and footer position their blocks absolutely',
    (html.match(/section class="relative/g) ?? []).length === 2)

  const bodyAt = html.indexOf('<section class="py-4">')
  const bodyInner = html.slice(bodyAt, html.indexOf('</section>', bodyAt))
  ok('the items band is ordinary flow, so a long order can make it taller',
    bodyAt > 0 && !/position:absolute/.test(bodyInner) && !/height:/.test(bodyInner))
  ok('...and it is the band holding the table', /<table/.test(bodyInner))

  /*
   * THE REASON BANDS EXIST.
   *
   * Absolute positions everywhere would print a forty-line order's items on top
   * of its totals — and would pass every test written against a three-line one.
   * The footer must come after the body in document order so flow pushes it
   * down, whatever the table became.
   */
  ok('the footer follows the items, so a long order pushes it down',
    html.lastIndexOf('<section class="relative') > bodyAt)

  // Percentages so screen and paper agree; rem for the vertical, because a
  // percentage top inside a min-height container resolves against nothing.
  ok('horizontal position and width are percentages of the page',
    /left:60\.00%/.test(html) && /width:40\.00%/.test(html))
  ok('vertical position is in rem, not a percentage of an unknown height',
    /top:[\d.]+rem/.test(html) && !/top:[\d.]+%/.test(html))

  ok('a band reserves room for the lowest block in it',
    bandExtent(PURCHASE_ORDER_BLOCKS, 'header') === 84 &&
      bandExtent(PURCHASE_ORDER_BLOCKS, 'footer') === 42,
    `header ${bandExtent(PURCHASE_ORDER_BLOCKS, 'header')}, footer ${bandExtent(PURCHASE_ORDER_BLOCKS, 'footer')}`)

  // Side by side is now a coordinate, not a container.
  const letterhead = PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-letterhead')!
  const title = PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-title')!
  ok('the shipped header puts two blocks beside each other by coordinate',
    letterhead.y === title.y && letterhead.x + letterhead.w <= title.x)
}

/* ── the shipped design must not overlap itself ──────────────────────────── */

console.log('\n-- nothing on the shipped page sits on top of anything else --')
{
  /*
   * THE TEST THAT WAS MISSING.
   *
   * The parity assertion above passed while the shipped default rendered the
   * letterhead straight through the rule below it, and DELIVER TO through the
   * detail list. It could not have caught it: it compares the WORDS on the page
   * in order, and two overlapping blocks say the same words in the same order.
   *
   * Only a browser knows a block's real height, so these are the heights measured
   * from the rendered page — recorded here as the contract the y values are
   * chosen against. If a block's content grows past its number the check fails,
   * which is the reminder to re-measure rather than to raise the number.
   */
  const MEASURED: Record<string, number> = {
    'po-logo': 14,
    'po-letterhead': 32.4,
    'po-title': 23.5,
    'po-rule-1': 4,
    'po-supplier': 40.3,
    'po-deliver': 26,
    'po-details': 11,
    'po-lines': 71.1,
    'po-totals': 24.8,
    'po-notes': 6,
    'po-rule-2': 4,
    'po-terms': 4,
    'po-printed': 4,
  }

  ok(
    'every shipped block has a measured height on record',
    PURCHASE_ORDER_BLOCKS.blocks.every((b) => MEASURED[b.id] !== undefined),
    PURCHASE_ORDER_BLOCKS.blocks.filter((b) => MEASURED[b.id] === undefined).map((b) => b.id).join(),
  )

  const v = validateSpec(PURCHASE_ORDER_BLOCKS, 'purchase_order', MEASURED)
  ok('the shipped design has no overlapping blocks', v.ok, JSON.stringify(v.errors))

  /*
   * And a real overlap must actually be refused, or the check above passes
   * vacuously — a validator that never says no proves nothing about a design
   * that happens to be fine.
   */
  const stacked: DocumentSpec = {
    version: 1,
    blocks: PURCHASE_ORDER_BLOCKS.blocks.map((b) =>
      b.id === 'po-rule-1' ? { ...b, y: 10 } : b,
    ),
  }
  const bad = validateSpec(stacked, 'purchase_order', MEASURED)
  ok('a block dragged on top of another is refused', !bad.ok, JSON.stringify(bad.errors))

  // Without measurements there is nothing to check, and refusing on a guess
  // would be worse than not checking.
  ok(
    'an unmeasured design is not refused on a guess',
    validateSpec(stacked, 'purchase_order').ok,
  )

  // Blocks in different bands cannot overlap however close their numbers are:
  // the bands stack, so a header block at y 0 and a footer block at y 0 are
  // nowhere near each other.
  const acrossBands: DocumentSpec = {
    version: 1,
    blocks: [
      { ...PURCHASE_ORDER_BLOCKS.blocks[0], band: 'header', x: 0, y: 0, w: 50 },
      { ...PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-totals')!, x: 0, y: 0, w: 50 },
      PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-lines')!,
      PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-title')!,
    ],
  }
  ok(
    'two blocks in different bands are not an overlap',
    !validateSpec(acrossBands, 'purchase_order', MEASURED).errors.some((e) =>
      e.includes('overlap'),
    ),
  )

  /*
   * THE SCALE IS SHARED.
   *
   * The canvas and the compiler carried separate numbers for what a band percent
   * is worth — 3.5px against 0.22em, which on a 14px page is 3.08 — so every
   * block sat 14 percent lower on screen than it printed, and a designer lining
   * two blocks up by eye was lining up a lie. One constant now, asserted here so
   * a future edit to either side cannot quietly reintroduce the drift.
   */
  const compiled = compileDocument(PURCHASE_ORDER_BLOCKS, 'purchase_order')
  const rule = PURCHASE_ORDER_BLOCKS.blocks.find((b) => b.id === 'po-rule-1')!
  ok(
    'the compiler places a block using the shared scale',
    compiled.includes(`top:${(rule.y * BAND_REM).toFixed(2)}rem`),
    `expected top:${(rule.y * BAND_REM).toFixed(2)}rem`,
  )
  ok('...and the canvas measures in the same units', BAND_PX === BAND_REM * 16)
}

/* ── snapping and guides ─────────────────────────────────────────────────── */

console.log('\n-- dragging one block beside another --')
{
  const other = { x: 60, y: 20, w: 30, h: 10 }

  // Left edges. Dropped a hair off and it lands EXACTLY, which is the whole
  // promise of the feature — "nearly aligned" is what the user complained about.
  const left = snapBlock({ x: 59.3, y: 50, w: 20, h: 8 }, [other], 100)
  ok('a block dragged near another\'s left edge lands exactly on it', left.x === 60,
    String(left.x))
  ok('...and a guide is drawn to say why',
    left.guides.some((g) => g.axis === 'v' && g.at === 60))

  // Centres, which is what "show me when it is centred" asked for.
  const centre = snapBlock({ x: 64.8, y: 50, w: 20, h: 8 }, [other], 100)
  ok('a block dragged near another\'s centre snaps to its centre',
    centre.x + 10 === 75, `centre at ${centre.x + 10}`)

  // Tops, so "align at the top" works by dragging rather than by a button.
  const top = snapBlock({ x: 10, y: 20.5, w: 20, h: 8 }, [other], 100)
  ok('a block dragged level with another\'s top snaps to it', top.y === 20, String(top.y))

  const bottom = snapBlock({ x: 10, y: 22.6, w: 20, h: 8 }, [other], 100)
  ok('...and its bottom edge snaps too', bottom.y + 8 === 30, `bottom at ${bottom.y + 8}`)

  // The page's own edges and centre come free, because alignmentFor takes the
  // container as a zero-thickness rect.
  const margin = snapBlock({ x: 0.4, y: 50, w: 20, h: 8 }, [], 100)
  ok('a block dragged near the page edge goes flush to it', margin.x === 0, String(margin.x))

  const pageCentre = snapBlock({ x: 39.6, y: 50, w: 20, h: 8 }, [], 100)
  ok('a block dragged near the middle of the page centres on it',
    pageCentre.x + 10 === 50, `centre at ${pageCentre.x + 10}`)

  // Far away, nothing happens. A tool that snaps everywhere is a grid, and the
  // point of guides is that they offer alignment only where it was being aimed for.
  const free = snapBlock({ x: 20, y: 50, w: 20, h: 8 }, [other], 100)
  ok('a block dropped nowhere near anything stays where it was put',
    free.x === 20 && !free.guides.some((g) => g.axis === 'v'))
}

/* ── gap measurement ─────────────────────────────────────────────────────── */

console.log('\n-- how far apart are these --')
{
  const right = { x: 60, y: 0, w: 30, h: 10 }

  const g = gapsFor({ x: 0, y: 0, w: 50, h: 10 }, [right])
  const gx = g.find((r) => r.axis === 'x')
  ok('the gap to the block beside it is measured', gx?.distance === 10, JSON.stringify(g))
  ok('...and it spans from one facing edge to the other',
    gx?.from === 50 && gx?.to === 60)

  const below = gapsFor({ x: 0, y: 0, w: 50, h: 10 }, [{ x: 0, y: 25, w: 50, h: 10 }])
  ok('the gap below is measured too',
    below.find((r) => r.axis === 'y')?.distance === 15, JSON.stringify(below))

  /*
   * Only between blocks that actually sit beside each other.
   *
   * The horizontal distance to something on a different line is not spacing,
   * and reporting it as spacing would send a designer chasing a number that
   * means nothing.
   */
  const past = gapsFor({ x: 0, y: 0, w: 20, h: 5 }, [{ x: 60, y: 40, w: 20, h: 5 }])
  ok('a block on a different line is not reported as a gap', past.length === 0,
    JSON.stringify(past))

  // Overlapping is not a gap of a negative amount; it is not a gap at all.
  const over = gapsFor({ x: 0, y: 0, w: 50, h: 10 }, [{ x: 40, y: 0, w: 30, h: 10 }])
  ok('an overlap is not reported as spacing',
    !over.some((r) => r.axis === 'x'), JSON.stringify(over))

  // The NEAREST neighbour, not all of them: one number per axis is a reading,
  // six numbers is noise.
  const many = gapsFor({ x: 0, y: 0, w: 20, h: 10 },
    [{ x: 30, y: 0, w: 10, h: 10 }, { x: 70, y: 0, w: 10, h: 10 }])
  ok('only the nearest neighbour on each axis is reported',
    many.filter((r) => r.axis === 'x').length === 1 &&
      many.find((r) => r.axis === 'x')?.distance === 10)
}

/* ── staying on the page ─────────────────────────────────────────────────── */

console.log('\n-- a block cannot be dragged off the page --')
{
  ok('dragged left past the edge, it stops at the edge',
    clampBlock({ x: -20, y: 10, w: 40 }).x === 0)
  ok('dragged right past the edge, its far side stops at the edge',
    clampBlock({ x: 90, y: 10, w: 40 }).x === 60)
  ok('narrowed past legibility, it stops at the minimum',
    clampBlock({ x: 0, y: 0, w: 2 }).w === MIN_BLOCK_W)
  ok('dragged above the top, it stops at the top',
    clampBlock({ x: 0, y: -5, w: 40 }).y === 0)

  /*
   * `y` has NO maximum, deliberately.
   *
   * A band is as tall as its contents, so a block dragged low simply makes the
   * band taller. Clamping it would fight the thing that keeps the document
   * printing correctly when it grows.
   */
  ok('dragged low, it makes the band taller rather than being pushed back',
    clampBlock({ x: 0, y: 400, w: 40 }).y === 400)
}

/* ── the helpers the designer edits through ──────────────────────────────── */

console.log('\n-- finding and changing a block --')
{
  const spec = PURCHASE_ORDER_BLOCKS

  /*
   * A FLAT LIST, which is most of what free placement bought.
   *
   * The old model needed `locate` to say which cell a block was in, and every
   * edit had to walk two levels to find its target. A block now carries its own
   * position, so finding one is a find and changing one is a map — and the
   * "two dropzones" the user was seeing were exactly the cost of the structure
   * that made those helpers necessary.
   */
  ok('a block is found by id', findBlock(spec, 'po-lines')?.kind === 'lineTable')
  ok('a block that does not exist is null', findBlock(spec, 'nope') === null)
  ok('every block is at the top level', spec.blocks.every((b) => !('cells' in b)))

  const renamed = patchBlock(spec, 'po-title', { title: 'ORDER' })
  ok('a block can be patched by id', findBlock(renamed, 'po-title')?.title === 'ORDER')
  ok('...without disturbing its neighbours',
    findBlock(renamed, 'po-lines')?.columns?.length === 4)

  const moved = patchBlock(spec, 'po-title', { x: 10, y: 30 })
  ok('moving a block is a patch like any other',
    findBlock(moved, 'po-title')?.x === 10 && findBlock(moved, 'po-title')?.y === 30)

  const pruned = removeBlock(spec, 'po-deliver')
  ok('a block can be removed by id', findBlock(pruned, 'po-deliver') === null)
  ok('...leaving the rest of its band alone',
    findBlock(pruned, 'po-details') !== null && findBlock(pruned, 'po-supplier') !== null)

  ok('a band reports its own blocks',
    bandBlocks(spec, 'body').length === 1 && bandBlocks(spec, 'body')[0].kind === 'lineTable')
  ok('...and the header holds the letterhead and the title',
    bandBlocks(spec, 'header').some((b) => b.id === 'po-letterhead') &&
      bandBlocks(spec, 'header').some((b) => b.id === 'po-title'))

  /*
   * A NEW BLOCK LANDS BELOW WHAT IS THERE.
   *
   * At 0,0 it would land on top of the letterhead, which the validator then
   * refuses — so the designer would have to fix an overlap before they had done
   * anything at all.
   */
  const added = newBlock('text', spec, { band: 'header' })
  const lowest = bandBlocks(spec, 'header').reduce((m, b) => Math.max(m, b.y), 0)
  ok('a new block is placed below whatever is already in that band', added.y > lowest,
    `y=${added.y} vs lowest=${lowest}`)
  ok('...and the first block in an empty band goes to the top',
    newBlock('text', { version: 1, blocks: [] }, { band: 'footer' }).y === 0)

  /*
   * BELOW THEIR BOTTOMS, NOT BELOW THEIR TOPS.
   *
   * These are not the same thing, and treating them as one put a new logo block
   * straight on top of the supplier address — visibly, on screen. A block at y 56
   * that is 40 tall ends at 96, so a "step below the lowest y" landed at 68.
   *
   * Heights are measured and never stored, so the caller passes what the canvas
   * measured; this is the check that it is actually used.
   */
  {
    const two: DocumentSpec = {
      version: 1,
      blocks: [
        newBlock('partyBlock', null, { band: 'header', y: 0 }),
        newBlock('detailList', null, { band: 'header', y: 56 }),
      ],
    }
    const tall = { [two.blocks[0].id]: 20, [two.blocks[1].id]: 40 }
    const under = newBlock('logo', two, { band: 'header' }, tall)
    ok('a new block clears the BOTTOM of the lowest block, not its top',
      under.y >= 96, `landed at ${under.y}, the block below ends at 96`)

    // Without heights it still lands below, which is a guess but a bounded one —
    // and better than the top of the page.
    ok('...and with no heights it still lands below rather than on top',
      newBlock('logo', two, { band: 'header' }).y > 56)
  }

  /*
   * A TABLE GOES WHERE IT IS ASKED, and there may be more than one.
   *
   * It used to be pinned to the items band and forbidden to repeat, which was
   * right while a document had exactly one table. A statement has two — the
   * movements and the age ladder below them, the same block walking a different
   * section — so both restrictions had to go.
   *
   * What survives is the rule that matters: the validator still insists a
   * document HAS one. See requiredBlockKinds.
   */
  ok('a table can be put in the band a design asks for',
    newBlock('lineTable', spec, { band: 'footer' }).band === 'footer')
  ok('...and a document still cannot do without one',
    !validateSpec(removeBlock(spec, 'po-lines'), 'purchase_order').ok)

  ok('two blocks minted together do not share an id',
    newBlock('text', spec).id !== newBlock('text', spec).id)
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
    /*
     * Removed from the document, and there is only one place to remove it from.
     *
     * When blocks nested inside row cells, filtering only the top level left
     * docTitle in place and this check passed vacuously — the flat list free
     * placement brought is what removes that hazard, since there is now only
     * one level for a block to be at.
     */
    const target = PURCHASE_ORDER_BLOCKS.blocks.find((b: DocBlock) => b.kind === kind)!
    const without = removeBlock(PURCHASE_ORDER_BLOCKS, target.id)
    ok(`a document without "${kind}" is refused`, !validateSpec(without, 'purchase_order').ok)
  }

  const twice: DocumentSpec = {
    version: 1,
    blocks: [...PURCHASE_ORDER_BLOCKS.blocks, newBlock('totals', PURCHASE_ORDER_BLOCKS)],
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

/* ── the logo, as a block you can move ───────────────────────────────────── */

console.log('\n-- the logo on its own --')
{
  /*
   * WHY THIS EXISTS AS WELL AS THE TOKEN.
   *
   * `site.logo` is a token the letterhead includes, and that is right for most
   * documents — above the business name, moving with it, which is what the
   * shipped default does. But a token inside another block cannot be dragged,
   * because there is nothing to take hold of, and "if a customer wants to move
   * his logo he can simply drag it" was the first thing asked for.
   */
  const spec: DocumentSpec = {
    version: 1,
    blocks: [
      ...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('logo', PURCHASE_ORDER_BLOCKS, { band: 'footer', x: 70, y: 60 }),
    ],
  }

  const compiled = compileDocument(spec, 'purchase_order')
  ok('a logo block emits the logo token', compiled.includes('{site.logo}'))

  /*
   * The fixture site has no logo, so one is supplied here. What is under test is
   * that a logo BLOCK resolves the token at all; a shop with no logo getting
   * nothing is the separate case checked below, and conflating the two would
   * have this pass for the wrong reason.
   */
  const LOGO =
    '<img src="/api/document-logo?v=abc123.png" alt="" style="max-height:56px;width:auto">'
  const base = inputFor(order())
  const withLogo = renderTemplate(compileDocument(spec, 'purchase_order'), 'purchase_order', {
    ...base,
    values: { ...base.values, 'site.logo': LOGO },
    capabilities: OWNER,
  })
  ok('...which resolves to the real image tag',
    /<img src="\/api\/document-logo\?v=[^"]+"/.test(withLogo),
    withLogo.includes('document-logo') ? '' : 'no logo tag reached the output')

  // It is placed like anything else, which is the whole point.
  ok('it is positioned by its own coordinates',
    /left:70\.00%/.test(compiled))

  /*
   * A HEIGHT, because a width cannot express it.
   *
   * `w` is the box the logo sits in and decides where it can be dragged to; the
   * height is how large the image is drawn inside it. A shop with a tall crest
   * wants a different answer from one with a wide wordmark.
   */
  const tall: DocumentSpec = {
    version: 1,
    blocks: spec.blocks.map((b) => (b.kind === 'logo' ? { ...b, logoHeight: 120 } : b)),
  }
  ok('the height a shop sets reaches the markup',
    compileDocument(tall, 'purchase_order').includes('--sd-logo-h:120px'))

  ok('a logo with no height set still prints at a sensible one',
    compileDocument(spec, 'purchase_order').includes(`--sd-logo-h:${DEFAULT_LOGO_HEIGHT}px`))

  /*
   * AND THE HEIGHT MUST ACTUALLY WIN.
   *
   * `{site.logo}` resolves to a tag carrying its own inline max-height, and an
   * inline style outranks every ordinary selector — so the first version of this
   * capped the wrapper and left the image at 56px whatever the shop typed. The
   * rule needs `!important` to beat it, which is worth asserting precisely
   * because it looks like something a tidy-up would remove.
   */
  ok('the rule that sizes it can outrank the tag\'s own inline height',
    /\.sd-logo img[^}]*max-height:\s*var\(--sd-logo-h\)\s*!important/.test(BLOCK_STYLE),
    BLOCK_STYLE)

  ok('...and the size arrives as a variable the rule can read',
    compileDocument(tall, 'purchase_order').includes('--sd-logo-h:120px'))

  // Clamped on read, so a hand-edited spec cannot put a logo over the whole page
  // or shrink it to nothing.
  const stored = serialiseSpec({
    version: 1,
    blocks: spec.blocks.map((b) => (b.kind === 'logo' ? { ...b, logoHeight: 9000 } : b)),
  })
  const back = parseSpec(stored, 'purchase_order')
  const logo = back?.blocks.find((b) => b.kind === 'logo')
  ok('an absurd height is clamped rather than honoured',
    logo?.logoHeight === MAX_LOGO_HEIGHT, String(logo?.logoHeight))

  const tiny = parseSpec(
    serialiseSpec({
      version: 1,
      blocks: spec.blocks.map((b) => (b.kind === 'logo' ? { ...b, logoHeight: 1 } : b)),
    }),
    'purchase_order',
  )
  ok('...and so is one too small to see',
    tiny?.blocks.find((b) => b.kind === 'logo')?.logoHeight === MIN_LOGO_HEIGHT)

  /*
   * A SHOP WITH NO LOGO GETS NOTHING, NOT A BROKEN IMAGE.
   *
   * The block wraps its value in `sd-block` round an `sd-value`, so the existing
   * hide-when-empty rule removes the whole thing — the same mechanism an empty
   * notes block uses, rather than a second rule that could disagree with it.
   */
  ok('the logo block can hide itself when no logo is set',
    compileDocument(spec, 'purchase_order').includes('class="sd-block"'))

  const noLogo = renderTemplate(compileDocument(spec, 'purchase_order'), 'purchase_order', {
    ...inputFor(order()),
    values: { ...inputFor(order()).values, 'site.logo': '' },
    capabilities: OWNER,
  })
  ok('...and renders no image at all for that shop', !/<img/.test(noLogo))

  // One per document: two logos is a mistake, not a layout.
  const twice: DocumentSpec = {
    version: 1,
    blocks: [...spec.blocks, newBlock('logo', spec, { band: 'header' })],
  }
  ok('two logo blocks are refused', !validateSpec(twice, 'purchase_order').ok)

  // And the letterhead's own logo token still works, because most documents
  // want it there and the shipped default relies on it.
  /*
 * THE SHIPPED DEFAULT SPLITS THEM.
 *
 * The logo used to be a letterhead token, which printed correctly and could
 * not be moved — a token has no box to take hold of. So the default a shop
 * starts from now has it as its own block, and the letterhead below is just
 * the words.
 *
 * The token still EXISTS for anyone who wants them welded together, which is
 * what the next check is for.
 */
  ok('the shipped default has the logo as its own block',
    PURCHASE_ORDER_BLOCKS.blocks.some((b) => b.kind === 'logo'))
  ok('...and the letterhead is only the words',
    PURCHASE_ORDER_BLOCKS.blocks
      .find((b) => b.kind === 'letterhead')
      ?.tokens?.includes('site.logo') === false)
  ok('...while the token remains available to a letterhead that wants it',
    allTokens(getDocType('purchase_order')!).some((t) => t.key === 'site.logo'))
}

/* ── the custom-HTML escape hatch ────────────────────────────────────────── */

console.log('\n-- the html block --')
{
  const spec: DocumentSpec = {
    version: 1,
    blocks: [
      ...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('html', null, { text: '<p>Custom <strong>bit</strong></p><script>alert(1)</script>' }),
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
      newBlock('text', null, { text: 'Ask for {doc.number} & quote it' })],
  }
  const out = renderBlocks(spec)
  ok('a token inside typed words resolves', /Ask for PO000123/.test(out))
  ok('...and an ampersand is escaped, not left raw', /&amp;/.test(out))

  const hostile: DocumentSpec = {
    version: 1,
    blocks: [...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('text', null, { text: '<img src=x onerror=alert(1)>' })],
  }
  ok('typed words cannot introduce markup',
    !/<img/.test(renderBlocks(hostile)) && /&lt;img/.test(renderBlocks(hostile)))
}

/* ── converting a design to markup ───────────────────────────────────────── */

console.log('\n-- "Edit as HTML" --')
{
  /*
   * The one-way door. Compiling blocks to markup is a function; recovering
   * blocks from markup would be a parser, and a parser is what this design
   * exists to avoid. So the conversion must at least be LOSSLESS in the
   * direction it goes — a shop that converts and saves must get the document
   * they were looking at, not an approximation of it.
   */
  const compiled = compileDocument(PURCHASE_ORDER_BLOCKS, 'purchase_order')
  const converted = sanitiseTemplate(compiled)

  const before = textOf(
    renderTemplate(compiled, 'purchase_order', { ...inputFor(order()), capabilities: OWNER }),
  )
  const after = textOf(
    renderTemplate(converted, 'purchase_order', { ...inputFor(order()), capabilities: OWNER }),
  )

  ok('converting to markup changes nothing on the page', before === after,
    before === after ? '' : `\n   before: ${before}\n   after : ${after}`)
  ok('...and the result is a template the validator accepts',
    validateTemplate('purchase_order', converted).ok,
    JSON.stringify(validateTemplate('purchase_order', converted).errors))
  ok('...that the markup editor can actually edit',
    converted.includes('{#each lines}') && converted.includes('{site.name}'))

  // The html block is the one part a designer typed, and it stays untrusted.
  const withScript: DocumentSpec = {
    version: 1,
    blocks: [
      ...PURCHASE_ORDER_BLOCKS.blocks,
      newBlock('html', PURCHASE_ORDER_BLOCKS, { text: '<p>Keep</p><script>alert(1)</script>' }),
    ],
  }
  const cleaned = sanitiseTemplate(compileDocument(withScript, 'purchase_order'))
  ok('a script inside a custom-HTML block does not survive conversion',
    !/<\s*script/i.test(cleaned) && !/alert\s*\(/.test(cleaned))
  ok('...while the rest of that block does', /<p>Keep<\/p>/.test(cleaned))
}

console.log(`\n${fails === 0 ? 'All block-model checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
