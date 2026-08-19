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
import { bandExtent, compileDocument, supportsBlocks } from '../src/lib/stationery/compile'
import {
  parseSpec,
  serialiseSpec,
  validateSpec,
  blockKindsFor,
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
    'po-letterhead': 46.5,
    'po-title': 23.5,
    'po-rule-1': 4,
    'po-supplier': 40.3,
    'po-deliver': 26,
    'po-details': 23,
    'po-lines': 71,
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

  // The items table cannot be put anywhere else, however it is asked for.
  ok('the items table is pinned to the items band',
    newBlock('lineTable', spec, { band: 'footer' }).band === 'body')

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
