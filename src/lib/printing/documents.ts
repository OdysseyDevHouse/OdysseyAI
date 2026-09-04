import type { ModuleKey } from '@/lib/control/moduleCatalogue'

/**
 * The PRINTABLE DOCUMENT catalogue — every piece of paper this app can produce,
 * and what each one needs from a printer.
 *
 * ── WHAT THIS ANSWERS, AND WHAT stationery/catalog.ts ANSWERS ─────────────
 *
 * Two catalogues, two questions, deliberately not merged:
 *
 *   stationery/catalog.ts  WHAT A DOCUMENT MAY SAY. A token whitelist, and a
 *                          security boundary, covering only the five documents
 *                          a shop can DESIGN.
 *   this file              WHERE A DOCUMENT GOES. Every document that reaches
 *                          paper, designed or not — a kitchen ticket and a
 *                          shelf talker have no designer and never will.
 *
 * They meet at the KEY. Where a document appears in both, the string is
 * identical (`slip`, `invoice`, `statement`, `delivery_note`, `purchase_order`)
 * and `stationeryDocType` names the link, so a screen can offer "Design" on the
 * documents that have one. scripts/test-print-catalogue.ts asserts both
 * directions, so a rename in either file is a failing test rather than a button
 * that leads nowhere.
 *
 * ── IT IS A ROUTING BOUNDARY ──────────────────────────────────────────────
 *
 * `device_document_printers.doc_key` is a VARCHAR, not an ENUM — for the same
 * reason `stationery_templates.doc_type` is: the set of documents grows, and it
 * must grow without a schema change on every site. What keeps it honest is that
 * `setDocumentPrinter` refuses a key that is not here, so an unknown string can
 * never be assigned a printer, and a key retired from this file simply stops
 * appearing rather than breaking a read.
 *
 * ── CLIENT-SAFE ───────────────────────────────────────────────────────────
 *
 * No `server-only`, no database import. The setup screen renders this list, the
 * till resolves against it, and the server validates with it — so what the
 * screen offers and what the server accepts cannot drift.
 */

/**
 * What the DOCUMENT needs from paper. Not how wide the paper is.
 *
 * A document does not know whether the roll in the machine is 80mm or 58mm —
 * that is a fact about the head, and it lives on the printer as `paper`. Held
 * the other way round (as `columns: 42 | 48` in each machine's localStorage,
 * which is where it lived before this feature) replacing one 80mm printer with
 * a 58mm one meant editing every till that could reach it, and nothing in the
 * back office could see the answer.
 *
 * The pairing is enforced by `mediumFitsPaper`, and that check is what stops a
 * manager pointing the A4-only cash-up declaration at the till roll and getting
 * nothing out of either.
 */
export type PrintMedium = 'slip' | 'a4' | 'label'

/**
 * How the bytes are actually produced today. Names code that exists.
 *
 *   'escpos'  a renderer in lib/escpos — the only OFFLINE-SAFE producer, because
 *             it is a pure function over data already in the till's memory.
 *   'html'    a route in the (print) group, rendered by a browser.
 *   'pdf'     a pdfkit renderer under lib, served by an API route.
 *
 * Order is preference. A document with both 'escpos' and 'html' prints raw when
 * the target can take raw, and falls back to the rendered page when it cannot.
 */
export type PrintProducer = 'escpos' | 'html' | 'pdf'

/** How the setup screen groups the assignment table. The shop's own headings. */
export type PrintDocGroup = 'counter' | 'sales' | 'purchasing' | 'labels' | 'office' | 'jobs'

export type PrintDocDef = {
  /**
   * Stored in `device_document_printers.doc_key`. At most 40 characters — the
   * column's width, matching `stationery_templates.doc_type`.
   */
  key: string
  label: string
  /** One line under the label, where the name alone is ambiguous. */
  hint?: string
  group: PrintDocGroup
  medium: PrintMedium
  producers: readonly PrintProducer[]
  /**
   * Where it is produced. A real path, so this list can never quietly describe
   * a document nobody makes any more, and so a grep from here lands somewhere.
   */
  source: string
  /** The stationery design it shares, when it has one. Must satisfy isDocType(). */
  stationeryDocType?: string
  /**
   * The document whose printer this one borrows when it has none of its own.
   *
   * A gift slip comes off the till roll and a supplier statement off whatever
   * prints a customer statement; nobody should have to say so twice. Without
   * this a shop makes sixteen decisions to express about six. The accessor
   * returns `inheritedFrom` alongside the answer, so a screen never shows a
   * destination whose origin it cannot name.
   */
  defaultsTo?: string
  /** Hidden on a shop that does not hold this module. */
  module?: ModuleKey
  /**
   * TRUE for the one document whose destination is chosen by the PRODUCT rather
   * than by the assignment table.
   *
   * The row still appears. A table claiming to list every printable document
   * that quietly omitted the one a restaurant cares most about would be the
   * worst kind of gap — so it appears, says "Routed per product", and points at
   * the kitchen card.
   */
  routedPerProduct?: boolean
}

/* ── At the counter ────────────────────────────────────────────────────────
 *
 * The four that come off a till roll, plus the declaration that does not.
 * These are the documents that must still print with the server unreachable,
 * which is why every one of them that can carries an 'escpos' producer.
 */

const COUNTER: readonly PrintDocDef[] = [
  {
    key: 'slip',
    label: 'Till slip',
    hint: 'The customer’s copy of a sale.',
    group: 'counter',
    medium: 'slip',
    producers: ['escpos', 'html'],
    source: 'lib/escpos/slips.ts renderReceipt · (print)/sales/[id]/slip',
    stationeryDocType: 'slip',
  },
  {
    key: 'gift_slip',
    label: 'Gift slip',
    hint: 'The same sale with the prices left off.',
    group: 'counter',
    medium: 'slip',
    producers: ['escpos', 'html'],
    source: 'lib/escpos/slipSpec.ts · (print)/sales/[id]/slip?gift=1',
    stationeryDocType: 'slip',
    defaultsTo: 'slip',
  },
  {
    key: 'bill',
    label: 'Table bill',
    hint: 'The pro forma a waiter drops before payment. Not a tax invoice.',
    group: 'counter',
    medium: 'slip',
    producers: ['escpos', 'html'],
    source: 'lib/escpos/slips.ts renderBill · (print)/sales/[id]/bill',
    defaultsTo: 'slip',
  },
  {
    key: 'kitchen_ticket',
    label: 'Kitchen ticket',
    hint: 'Where each ticket goes is set on the product, not here.',
    group: 'counter',
    medium: 'slip',
    producers: ['escpos'],
    source: 'lib/escpos/slips.ts renderKitchenTicket',
    routedPerProduct: true,
  },
  {
    /*
     * The odd one in this group: it is A4 and it has no ESC/POS renderer — it is
     * window.print() over the React screen. `mediumFitsPaper` will therefore
     * refuse to point it at a slip printer, which is honest but will disappoint
     * a hospitality shop that wants it on the roll. A renderDeclaration in
     * lib/escpos/slips.ts is the follow-up, not a reason to lie here.
     */
    key: 'cashup_declaration',
    label: 'Cash-up declaration',
    hint: 'What was counted at the end of a shift.',
    group: 'counter',
    medium: 'a4',
    producers: ['html'],
    source: '(app)/sales/cashup/[shiftId]/declare/DeclarationClient.tsx',
  },
]

/* ── Customers and sales ───────────────────────────────────────────────────
 *
 * `invoice` is FIVE documents through one route — quote, sales order, pro
 * forma, tax invoice and credit note all render through (print)/sales/[id]/
 * document, branching on printKindFor(). One key, and the label has to say so
 * or a shop will hunt the table for "Quote" and conclude it cannot be printed.
 */

const SALES: readonly PrintDocDef[] = [
  {
    key: 'invoice',
    label: 'Invoice, quote, order, pro forma or credit note',
    hint: 'The A4 sales document. Which of the five it is comes from the document itself.',
    group: 'sales',
    medium: 'a4',
    producers: ['html', 'pdf'],
    source: '(print)/sales/[id]/document · lib/invoices/pdf.ts',
    stationeryDocType: 'invoice',
  },
  {
    key: 'delivery_note',
    label: 'Delivery note',
    hint: 'Quantities without prices, for the person signing for the goods.',
    group: 'sales',
    medium: 'a4',
    producers: ['html'],
    source: '(print)/sales/[id]/delivery',
    stationeryDocType: 'delivery_note',
  },
  {
    key: 'statement',
    label: 'Customer statement',
    group: 'sales',
    medium: 'a4',
    producers: ['pdf'],
    source: 'lib/statements/pdf.ts · /api/customers/[id]/statement',
    stationeryDocType: 'statement',
  },
  {
    key: 'layby_agreement',
    label: 'Lay-by agreement',
    hint: 'Printed twice — one for the customer, one signed for the file.',
    group: 'sales',
    medium: 'a4',
    producers: ['html'],
    source: '(invoicing)/invoicing/laybys/[id]/print',
  },
]

/* ── Purchasing and suppliers ──────────────────────────────────────────── */

const PURCHASING: readonly PrintDocDef[] = [
  {
    key: 'purchase_order',
    label: 'Purchase order',
    group: 'purchasing',
    medium: 'a4',
    producers: ['html'],
    source: '(print)/purchasing/[id]/order',
    stationeryDocType: 'purchase_order',
  },
  {
    key: 'supplier_statement',
    label: 'Supplier statement',
    group: 'purchasing',
    medium: 'a4',
    producers: ['pdf'],
    source: 'lib/statements/pdf.ts · /api/suppliers/[id]/statement',
    defaultsTo: 'statement',
  },
  {
    key: 'remittance',
    label: 'Remittance advice',
    hint: 'What was paid, and against which invoices.',
    group: 'purchasing',
    medium: 'a4',
    producers: ['pdf'],
    source: '/api/suppliers/[id]/remittance',
    defaultsTo: 'statement',
  },
]

/* ── Labels ────────────────────────────────────────────────────────────────
 *
 * `label` rather than `a4` as the medium even though both print on an A4
 * sheet: a shop with a dedicated label printer must be able to point these at
 * it without the paper check refusing, and `mediumFitsPaper` accepts a label on
 * either. The distinction is what makes that possible later without a
 * migration.
 */

const LABELS: readonly PrintDocDef[] = [
  {
    key: 'label_a4',
    label: 'Shelf labels',
    hint: 'A sheet of price labels.',
    group: 'labels',
    medium: 'label',
    producers: ['html'],
    source: '(print)/labels/a4',
  },
  {
    key: 'label_talker',
    label: 'Shelf talkers',
    hint: 'The larger promotional tickets.',
    group: 'labels',
    medium: 'label',
    producers: ['html'],
    source: '(print)/labels/talker',
  },
]

/* ── Office ────────────────────────────────────────────────────────────── */

const OFFICE: readonly PrintDocDef[] = [
  {
    key: 'report',
    label: 'Report printouts',
    hint: 'Anything printed from Reports.',
    group: 'office',
    medium: 'a4',
    producers: ['pdf', 'html'],
    source: 'lib/reports/pdf.ts · /api/reports/export',
  },
]

/* ── Jobs ──────────────────────────────────────────────────────────────── */

const JOBS: readonly PrintDocDef[] = [
  {
    key: 'job_card',
    label: 'Job card',
    group: 'jobs',
    medium: 'a4',
    producers: ['pdf'],
    source: 'lib/jobs/pdf.ts · /api/jobs/[id]/report',
    module: 'job_cards',
  },
]

/** Every printable document, in the order the setup screen shows them. */
export const PRINT_DOCS: readonly PrintDocDef[] = [
  ...COUNTER,
  ...SALES,
  ...PURCHASING,
  ...LABELS,
  ...OFFICE,
  ...JOBS,
]

/** The group headings, in order. */
export const PRINT_DOC_GROUPS: readonly PrintDocGroup[] = [
  'counter',
  'sales',
  'purchasing',
  'labels',
  'office',
  'jobs',
]

export const PRINT_DOC_GROUP_LABELS: Record<PrintDocGroup, string> = {
  counter: 'At the counter',
  sales: 'Customers and sales',
  purchasing: 'Purchasing and suppliers',
  labels: 'Labels',
  office: 'Reports',
  jobs: 'Job cards',
}

const BY_KEY = new Map(PRINT_DOCS.map((d) => [d.key, d]))

export function getPrintDoc(key: string): PrintDocDef | undefined {
  return BY_KEY.get(key)
}

/** The membership test every write goes through before it touches a row. */
export function isPrintDoc(key: string): boolean {
  return BY_KEY.has(key)
}

/** The documents in one group, filtered to the modules this shop holds. */
export function printDocsByGroup(
  group: PrintDocGroup,
  modules?: readonly ModuleKey[],
): PrintDocDef[] {
  return PRINT_DOCS.filter((d) => {
    if (d.group !== group) return false
    // No module list supplied means "do not filter" — the server passes one, a
    // test does not, and neither should have to invent an empty array.
    if (!d.module || !modules) return true
    return modules.includes(d.module)
  })
}

/** What a printer can be loaded with. A fact about the head. */
export type PrinterPaper = 'slip80' | 'slip58' | 'a4' | 'label'

export const PAPER_LABELS: Record<PrinterPaper, string> = {
  slip80: '80mm slip',
  slip58: '58mm slip',
  a4: 'A4',
  label: 'Labels',
}

/**
 * How many characters fit across, when the printer does not say otherwise.
 *
 * These are the two values `printBridge.ts` offered as a per-machine choice.
 * They are defaults rather than truth: `printers.slip_columns` overrides them
 * for the heads that disagree with their own spec sheet.
 */
export const PAPER_COLUMNS: Partial<Record<PrinterPaper, number>> = {
  slip80: 48,
  slip58: 32,
}

/**
 * Whether a document can come out of a printer loaded with that paper.
 *
 * A slip fits either roll. A4 needs A4. A label sheet IS an A4 sheet, so it
 * prints on either an A4 printer or a dedicated label printer — which is the
 * one asymmetry here, and the reason `label` is its own medium at all.
 *
 * The refusal this exists for: pointing `cashup_declaration` (A4, no ESC/POS
 * renderer) at an 80mm head. Without the check it is accepted, produces
 * nothing, and nobody can see why.
 */
export function mediumFitsPaper(medium: PrintMedium, paper: PrinterPaper): boolean {
  if (medium === 'slip') return paper === 'slip80' || paper === 'slip58'
  if (medium === 'a4') return paper === 'a4'
  return paper === 'a4' || paper === 'label'
}
