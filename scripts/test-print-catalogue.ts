/**
 * The printable-document catalogue, and the plan resolver.
 *
 *   npx tsx scripts/test-print-catalogue.ts
 *
 * Everything here is pure — no database, no printer, no shell. Which is the
 * point: `planFor` is the function an OFFLINE till calls to decide where a slip
 * goes, so it has to be provable without any of the things a till has lost.
 *
 * The decisions under test are the ones that quietly lose paper:
 *
 *   · A KEY IS PERMANENT. It is stored in device_document_printers.doc_key, so
 *     renaming one orphans every row that carries it, and lengthening one past
 *     40 characters silently truncates on write.
 *   · THE TWO CATALOGUES AGREE. Where a document appears in both this file and
 *     stationery/catalog.ts the key is identical, or "Design" leads nowhere.
 *   · PAPER IS CHECKED. The A4-only cash-up declaration must be refused by an
 *     80mm head — accepted, it prints nothing and explains nothing.
 *   · NO CONFIG MEANS THE BROWSER DIALOG. That is what makes the whole feature
 *     additive: nothing changes for a document until somebody says otherwise.
 *   · AN UNREACHABLE PRINTER IS NAMED, never silently downgraded — a manager
 *     who is not told believes the assignment took effect.
 */

import {
  PRINT_DOCS,
  PRINT_DOC_GROUPS,
  PRINT_DOC_GROUP_LABELS,
  getPrintDoc,
  isPrintDoc,
  mediumFitsPaper,
  printDocsByGroup,
  PAPER_COLUMNS,
  PAPER_LABELS,
  type PrinterPaper,
} from '../src/lib/printing/documents'
import { planFor, type DevicePrintConfig } from '../src/lib/printing/resolve'
import { isDocType, DOC_TYPES } from '../src/lib/stationery/catalog'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── 1. The keys ─────────────────────────────────────────────────────────── */
console.log('\n── The keys ────────────────────────────────────────────────\n')

const keys = PRINT_DOCS.map((d) => d.key)
ok('every key is unique', new Set(keys).size === keys.length)
ok(
  '*** every key fits doc_key VARCHAR(40) ***',
  keys.every((k) => k.length > 0 && k.length <= 40),
  keys.filter((k) => k.length > 40).join(', '),
)
ok(
  'keys are lower_snake_case, so nothing depends on a shell quoting them',
  keys.every((k) => /^[a-z][a-z0-9_]*$/.test(k)),
  keys.filter((k) => !/^[a-z][a-z0-9_]*$/.test(k)).join(', '),
)
ok('isPrintDoc accepts a real key', isPrintDoc('slip'))
ok('*** isPrintDoc refuses anything else ***', !isPrintDoc('slip; DROP TABLE printers'))
ok('getPrintDoc finds a document', getPrintDoc('invoice')?.label.startsWith('Invoice') === true)

/* ── 2. Shape ────────────────────────────────────────────────────────────── */
console.log('\n── Shape ───────────────────────────────────────────────────\n')

ok(
  'every document has a group, a medium and at least one producer',
  PRINT_DOCS.every((d) => d.group && d.medium && d.producers.length > 0),
)
ok(
  'every group in use has a heading, and every heading is used',
  PRINT_DOCS.every((d) => PRINT_DOC_GROUPS.includes(d.group)) &&
    PRINT_DOC_GROUPS.every((g) => PRINT_DOC_GROUP_LABELS[g] !== undefined),
)
ok(
  '*** every document is reachable through printDocsByGroup ***',
  PRINT_DOC_GROUPS.flatMap((g) => printDocsByGroup(g)).length === PRINT_DOCS.length,
)
ok(
  'a source path is named for every document, so the list cannot describe paper nobody makes',
  PRINT_DOCS.every((d) => d.source.length > 5),
)

/* `defaultsTo` is a SINGLE HOP — the accessor and the resolver both look once
   and stop. A chain would work by accident there and hang nowhere useful; a
   cycle would hang a page render. Refused here so it can never be either. */
const inherits = PRINT_DOCS.filter((d) => d.defaultsTo)
ok(
  'every defaultsTo names a real document',
  inherits.every((d) => isPrintDoc(d.defaultsTo!)),
  inherits.filter((d) => !isPrintDoc(d.defaultsTo!)).map((d) => d.key).join(', '),
)
ok(
  '*** no defaultsTo chain, and no cycle ***',
  inherits.every((d) => !getPrintDoc(d.defaultsTo!)?.defaultsTo),
  inherits.filter((d) => getPrintDoc(d.defaultsTo!)?.defaultsTo).map((d) => d.key).join(', '),
)

ok(
  'exactly one document is routed per product, and it is the kitchen ticket',
  PRINT_DOCS.filter((d) => d.routedPerProduct).map((d) => d.key).join() === 'kitchen_ticket',
)

/* ── 3. The two catalogues agree ─────────────────────────────────────────── */
console.log('\n── Agreement with the stationery catalogue ─────────────────\n')

const linked = PRINT_DOCS.filter((d) => d.stationeryDocType)
ok(
  '*** every stationeryDocType is a real design type ***',
  linked.every((d) => isDocType(d.stationeryDocType!)),
  linked.filter((d) => !isDocType(d.stationeryDocType!)).map((d) => d.key).join(', '),
)

/* The other direction. A designable document that this catalogue cannot route
   is one a shop can lay out and then never print anywhere in particular. */
const routable = new Set(PRINT_DOCS.map((d) => d.stationeryDocType).filter(Boolean))
ok(
  '*** every designable document can also be routed ***',
  DOC_TYPES.every((t) => routable.has(t.key)),
  DOC_TYPES.filter((t) => !routable.has(t.key)).map((t) => t.key).join(', '),
)

/* The five that appear in both must use the SAME string, or a rename in either
   file leaves a Design button pointing at nothing. */
for (const t of DOC_TYPES) {
  const mine = PRINT_DOCS.find((d) => d.stationeryDocType === t.key)
  ok(`  ${t.key}: same key in both catalogues`, mine !== undefined && isPrintDoc(t.key) === true)
}

/* ── 4. Paper ────────────────────────────────────────────────────────────── */
console.log('\n── Paper ───────────────────────────────────────────────────\n')

const PAPERS: PrinterPaper[] = ['slip80', 'slip58', 'a4', 'label']
ok('every paper has a label', PAPERS.every((p) => PAPER_LABELS[p] !== undefined))
ok('both slip widths have a default column count', PAPER_COLUMNS.slip80 === 48 && PAPER_COLUMNS.slip58 === 32)

ok('a slip fits either roll', mediumFitsPaper('slip', 'slip80') && mediumFitsPaper('slip', 'slip58'))
ok('*** a slip does NOT fit A4 ***', !mediumFitsPaper('slip', 'a4'))
ok('*** an A4 document does NOT fit an 80mm head ***', !mediumFitsPaper('a4', 'slip80'))
ok('a label sheet prints on A4 or on label stock', mediumFitsPaper('label', 'a4') && mediumFitsPaper('label', 'label'))
ok('*** labels do not fit a slip roll ***', !mediumFitsPaper('label', 'slip80'))

/* The specific refusal this exists for. The cash-up declaration has no ESC/POS
   renderer, so pointing it at the till roll produces nothing at all. */
const declaration = getPrintDoc('cashup_declaration')!
ok(
  '*** the cash-up declaration is refused by a slip printer ***',
  !mediumFitsPaper(declaration.medium, 'slip80'),
)
ok(
  '*** every slip-medium document can actually be produced as bytes ***',
  PRINT_DOCS.filter((d) => d.medium === 'slip').every((d) => d.producers.includes('escpos')),
  PRINT_DOCS.filter((d) => d.medium === 'slip' && !d.producers.includes('escpos')).map((d) => d.key).join(', '),
)

/* ── 5. planFor ──────────────────────────────────────────────────────────── */
console.log('\n── planFor ─────────────────────────────────────────────────\n')

const slipPrinter = {
  id: 7,
  name: 'Front counter',
  paper: 'slip80' as PrinterPaper,
  columns: 48,
  connection: 'queue' as const,
  target: 'EPSON TM-T20III',
  shareName: '',
  port: null,
  drawerKick: true,
}

const config: DevicePrintConfig = {
  deviceId: 'test-device',
  pdfDir: '',
  printers: [slipPrinter],
  assignments: [
    { docKey: 'slip', mode: 'printer', printerId: 7, copies: 2 },
    { docKey: 'statement', mode: 'pdf', printerId: null, copies: 1 },
    { docKey: 'kitchen_ticket', mode: 'off', printerId: null, copies: 1 },
    { docKey: 'invoice', mode: 'browser', printerId: null, copies: 1 },
    // Points at a printer this machine cannot reach — dropped from `printers`.
    { docKey: 'delivery_note', mode: 'printer', printerId: 99, copies: 1 },
  ],
}

ok(
  '*** no config at all means the browser dialog ***',
  planFor('slip', null).kind === 'browser',
)
ok(
  '*** a document with no answer means the browser dialog ***',
  planFor('purchase_order', config).kind === 'browser',
)
ok('an unknown key means the browser dialog, never a throw', planFor('nonsense', config).kind === 'browser')

const slipPlan = planFor('slip', config)
ok(
  'an assigned document resolves to its printer, with its copies',
  slipPlan.kind === 'printer' && slipPlan.printer.id === 7 && slipPlan.copies === 2,
)
ok('pdf resolves to pdf', planFor('statement', config).kind === 'pdf')
ok('off resolves to off', planFor('kitchen_ticket', config).kind === 'off')
ok('browser resolves to browser', planFor('invoice', config).kind === 'browser')

const dangling = planFor('delivery_note', config)
ok(
  '*** a printer this machine cannot reach is NAMED, not silently downgraded ***',
  dangling.kind === 'unreachable',
)

/* Inheritance, applied by the resolver as well as by the accessor — the offline
   config carries only the rows a shop actually wrote. */
const giftPlan = planFor('gift_slip', config)
ok(
  '*** a gift slip follows the till slip without anybody saying so ***',
  giftPlan.kind === 'printer' && giftPlan.printer.id === 7,
)
const billPlan = planFor('bill', config)
ok('a table bill follows the till slip too', billPlan.kind === 'printer' && billPlan.printer.id === 7)
ok(
  '*** an explicit answer beats an inherited one ***',
  planFor('statement', config).kind === 'pdf',
)
ok(
  'a supplier statement inherits the customer statement',
  planFor('supplier_statement', config).kind === 'pdf',
)

console.log(
  fails === 0
    ? '\nThe catalogue and the plan resolver hold.\n'
    : `\n${fails} check(s) failed.\n`,
)
process.exit(fails === 0 ? 0 : 1)
