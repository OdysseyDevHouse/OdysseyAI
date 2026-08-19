/**
 * The delivery note.
 *
 *   npm run test:delivery-note
 *
 * ── THE ASSERTION THIS FILE EXISTS FOR ───────────────────────────────────
 *
 * NO PRICES, and not by convention — by construction. Goods are delivered to
 * receiving bays, site foremen and tenants, and what the customer is paying is
 * none of their business. So the checks below do not merely confirm that the
 * shipped design leaves money off: they confirm that a shop REDESIGNING it
 * cannot put money on, because the delivery note's token catalog contains none.
 *
 * A leak here is silent, permanent and only discovered after the paper has been
 * handed over, which is why it gets the strongest test in the suite.
 *
 * Needs no database and no browser.
 */
import { DELIVERY_NOTE_BLOCKS } from '../src/lib/stationery/defaults/deliveryNoteBlocks'
import { DELIVERY_NOTE_DEFAULT } from '../src/lib/stationery/defaults/deliveryNote'
import { compileDocument, compileBlocks, supportsBlocks } from '../src/lib/stationery/compile'
import { deliveryNoteTokens } from '../src/lib/stationery/adapters/deliveryNote'
import { renderTemplate } from '../src/lib/stationery/render'
import { validateTemplate } from '../src/lib/stationery/validate'
import { sanitiseTemplate } from '../src/lib/stationery/sanitise'
import { getDocType, allTokens } from '../src/lib/stationery/catalog'
import { parseSpec, serialiseSpec, validateSpec, removeBlock } from '../src/lib/stationery/blocks'
import { DEFAULT_SPECS } from '../src/lib/stationery/resolve'
import type { SalesDocument } from '../src/lib/site/salesDocuments'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const OWNER = { isOwner: true, granted: new Set<string>() }

function order(over: Record<string, unknown> = {}): SalesDocument {
  return {
    id: 77,
    docType: 'sales_order',
    status: 'issued',
    documentNumber: 'SO000001',
    documentDate: '2026-08-19',
    customerId: 3,
    customerCode: 'CUST-003',
    customerName: 'Harbour Cafe',
    customerPhone: '021 555 0100',
    customerAddress: '9 Long Street\nCape Town 8001',
    userName: 'Tiaan',
    reference: 'REF-SO-1',
    notes: 'Ring the bell at the gate.',
    lines: [
      // Fully delivered before now: nothing going today.
      { id: 1, lineNumber: 1, productCode: 'AVO', description: 'Avo each', qty: 10, qtyDelivered: 10 },
      // A part delivery: 3 went before, 5 going now.
      { id: 2, lineNumber: 2, productCode: 'CC500', description: 'Coca-Cola 500ml', qty: 8, qtyDelivered: 3 },
      // First delivery of this line.
      { id: 3, lineNumber: 3, productCode: 'FCM1L', description: 'Full Cream Milk 1L', qty: 4, qtyDelivered: 0 },
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

const inputFor = (doc: SalesDocument, over: Record<string, unknown> = {}) =>
  deliveryNoteTokens({
    doc,
    details: { documentId: doc.id, deliveryDate: '2026-08-22', fulfilmentStatus: 'part_delivered',
      reservesStock: true, reservedAt: null, expiresAt: null, customerOrderNo: 'PO-99001' },
    site: SITE,
    // The ADDRESS only. The block prints customer.name above it, and the route
    // passes address lines alone — a fixture that repeated the name here would
    // have hidden a duplication rather than found one.
    deliverTo: ['9 Long Street', 'Cape Town', '8001'],
    printedAt: '19/08/2026, 14:30',
    ...over,
  } as never)

const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const render = (doc = order(), over = {}, spec = DELIVERY_NOTE_BLOCKS) =>
  renderTemplate(compileDocument(spec, 'delivery_note'), 'delivery_note', {
    ...inputFor(doc, over),
    capabilities: OWNER,
  })

/* ── the assertion this file exists for ──────────────────────────────────── */

console.log('\n-- a delivery note carries no prices, and cannot be made to --')
{
  const text = textOf(render())

  ok('no money appears anywhere on it', !/R\s?[\d]/.test(text), (text.match(/R\s?[\d ,.]+/g) ?? []).join(' '))
  ok('...and no price, total or VAT wording', !/price|total|amount|vat no|discount/i.test(
    text.replace(/VAT no\.[^ ]*/g, ''),
  ), text.slice(0, 200))

  /*
   * THE BOUNDARY ITSELF.
   *
   * The checks above prove the shipped design leaves money off. This one proves
   * a shop cannot put it back: the catalog is what a design may NAME, and the
   * delivery note's list has no money token in it at all.
   */
  const doc = getDocType('delivery_note')!
  const money = allTokens(doc).filter((t) => t.format === 'money')
  ok('the catalog exposes no money token at all', money.length === 0,
    money.map((t) => t.key).join(', '))

  /*
   * And a design that names one anyway renders nothing — belt and braces, since
   * a hand-edited template is markup somebody typed.
   */
  const sneaky = renderTemplate(
    '<p>{line.unitPriceIncl}{totals.totalIncl}{banking}</p>{#each lines}<p>{line.totalIncl}</p>{/each}',
    'delivery_note',
    { ...inputFor(order()), capabilities: OWNER },
  )
  ok('...and a template naming one anyway resolves it to nothing',
    !/\d/.test(textOf(sneaky)), textOf(sneaky))
}

/* ── the three quantities ────────────────────────────────────────────────── */

console.log('\n-- ordered, sent before, going now --')
{
  const text = textOf(render())

  ok('the columns say what they are',
    /Ordered/.test(text) && /Sent before/.test(text) && /Delivered now/.test(text))

  // Line 2: 8 ordered, 3 before, 5 now.
  ok('a part delivery shows all three numbers', / 8 3 5 /.test(` ${text} `), text)

  /*
   * A line with NOTHING going today stays on the note — the receiver is checking
   * against the whole order — but its "delivered now" is blank, because the
   * column says Delivered now and a 0 under it contradicts its own heading.
   */
  const rows = inputFor(order()).sections.lines!
  ok('a line already delivered shows no quantity for today', rows[0]['line.qty'] === null)
  ok('...but still shows what was ordered and what came before',
    rows[0]['line.qtyOrdered'] === 10 && rows[0]['line.qtyDeliveredBefore'] === 10)

  ok('a first delivery leaves "sent before" blank', rows[2]['line.qtyDeliveredBefore'] === null)
  ok('...and shows the full quantity as going now', rows[2]['line.qty'] === 4)

  /*
   * PART DELIVERY, in one token, decided from the LINES rather than from
   * fulfilment_status — the lines are the arithmetic a driver can check against
   * the boxes.
   */
  ok('an order with something outstanding says PART DELIVERY', /PART DELIVERY/.test(text))

  const complete = order({
    lines: order().lines.map((l) => ({ ...l, qtyDelivered: l.qty })),
  })
  ok('...and a complete one says nothing at all',
    !/PART DELIVERY/.test(textOf(render(complete))))
}

/* ── what the driver actually needs ──────────────────────────────────────── */

console.log('\n-- the paper is usable --')
{
  const text = textOf(render())
  const wants: [string, string][] = [
    ['who sent it', 'Acme Trading'],
    ['what it is', 'DELIVERY NOTE'],
    ['the order number', 'SO000001'],
    ['who it is for', 'Harbour Cafe'],
    ['where it goes', '9 Long Street'],
    ['when it is due', '2026-08-22'],
    ["the customer's own order number", 'PO-99001'],
    ['what is in the boxes', 'Coca-Cola 500ml'],
    ['the delivery instructions', 'Ring the bell at the gate'],
    ['somewhere to sign', 'Received by'],
    ['a date to write', 'Date received'],
    ['what to do before signing', 'check the goods'],
  ]
  for (const [what, needle] of wants) {
    ok(`it carries ${what}`, text.includes(needle), text.includes(needle) ? '' : needle)
  }

  /*
   * THE SIGNATURE LINES SURVIVE.
   *
   * They were tokens first — always empty, so the renderer treated them as
   * absent (rightly: an unfilled field should read as "not applicable") and the
   * hide rule deleted the whole block. A line to sign on is a rule DRAWN on the
   * page, not a value that happens to be blank, so it is a block kind.
   */
  const compiled = compileDocument(DELIVERY_NOTE_BLOCKS, 'delivery_note')
  ok('the signature lines are drawn rules, not empty values',
    (compiled.match(/<hr class="border-ink-2">/g) ?? []).length === 2)
  ok('...so nothing can hide them', !/sd-value[^>]*>\{sign\./.test(compiled))
}

/* ── the ordinary checks every document gets ─────────────────────────────── */

console.log('\n-- structure, storage and the law --')
{
  const compiled = compileDocument(DELIVERY_NOTE_BLOCKS, 'delivery_note')

  const v = validateTemplate('delivery_note', compiled)
  ok('the shipped design passes the validator', v.ok, JSON.stringify(v.errors.map((e) => e.message)))

  /*
   * A delivery note answers to no statute, so what it must carry is what makes
   * it USABLE — and the negative cases are what prove the rule is real.
   */
  for (const [what, id] of [['the address', 'dn-deliver'], ['the letterhead', 'dn-letterhead']] as const) {
    const without = compileDocument(removeBlock(DELIVERY_NOTE_BLOCKS, id), 'delivery_note')
    ok(`a delivery note without ${what} is refused`, !validateTemplate('delivery_note', without).ok)
  }

  ok('it validates structurally', validateSpec(DELIVERY_NOTE_BLOCKS, 'delivery_note').ok,
    JSON.stringify(validateSpec(DELIVERY_NOTE_BLOCKS, 'delivery_note').errors))

  const back = parseSpec(serialiseSpec(DELIVERY_NOTE_BLOCKS), 'delivery_note')
  ok('the design survives being stored and read back',
    !!back && JSON.stringify(back.blocks) === JSON.stringify(DELIVERY_NOTE_BLOCKS.blocks))

  ok('the visual designer is offered for it', supportsBlocks('delivery_note'))
  ok('...and the shipped design is registered so the screen can fork it',
    DEFAULT_SPECS.delivery_note === DELIVERY_NOTE_BLOCKS)

  /*
   * The markup default is COMPILED from the block one rather than written twice,
   * so they are identical by construction. This is the check that it was
   * regenerated after the blocks last changed.
   */
  ok('the markup default matches the block design', DELIVERY_NOTE_DEFAULT === compiled,
    DELIVERY_NOTE_DEFAULT === compiled ? '' : 'regenerate defaults/deliveryNote.ts')

  const perBlock = compileBlocks(DELIVERY_NOTE_BLOCKS, 'delivery_note')
  const missing = DELIVERY_NOTE_BLOCKS.blocks.filter(
    (b) => perBlock[b.id] !== '' && !compiled.includes(perBlock[b.id]),
  )
  ok("each block's canvas markup appears verbatim in the printed page",
    missing.length === 0, missing.map((b) => b.id).join(', '))

  const cleaned = sanitiseTemplate(compiled)
  ok('it survives the sanitiser with its structure intact',
    cleaned.includes('<article') && cleaned.includes('{#each lines}'))
}

console.log(`\n${fails === 0 ? 'All delivery-note checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
