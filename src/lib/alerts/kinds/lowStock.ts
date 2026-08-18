import 'server-only'
import { defaultVat, listVatRates } from '../../site/lookups'
import { mainLocationId } from '../../site/stockLocations'
import { saveOrder } from '../../site/purchaseDocuments'
import { siteQuery } from '../../siteDb'
import { reorderBySupplier, type SupplierGroup } from '../../site/reorderSuggestions'
import { buildTableHtml, count, qty, rands, EMAIL_ROWS, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

type Row = Record<string, unknown>

/**
 * Low stock — and, if the rule says so, the draft orders to fix it.
 *
 * This is the one kind with an ACTION half, and the only one that writes
 * anything. Everything about how it writes is chosen so that an automation
 * running at 07:00 can never do something a buyer would not have done.
 *
 * ── IT DRAFTS, IT DOES NOT ORDER ─────────────────────────────────────────
 *
 * saveOrder() leaves a DRAFT. Nothing is sent, nothing is committed, no
 * supplier hears anything — issuing is a separate act on a separate screen,
 * behind its own approval threshold. So the worst case of this automation
 * misfiring is a draft somebody deletes, not stock arriving that nobody wanted.
 *
 * That is also why there is no "and issue it" option. An unattended process
 * that commits a shop to spending money is a different feature with a
 * different risk, and it should not arrive as a checkbox on this one.
 *
 * ── IT REUSES THE BUYER'S OWN PATH ───────────────────────────────────────
 *
 * The same reorderBySupplier() the "What to order" screen reads, and the same
 * saveOrder() its button calls. Not a copy: an automation that computed
 * shortfalls its own way would drift from the screen, and the first time the
 * two disagreed nobody would know which was right.
 *
 * ── WHY IT TRACKS ITS OWN DRAFTS ─────────────────────────────────────────
 *
 * reorderSuggestions' "on order" figure counts ISSUED orders only, and it is
 * right to: for a buyer looking at the screen, a draft nobody sent is not
 * stock coming. But that makes it the wrong figure for an unattended rule —
 * a daily automation would re-draft the same shortages every morning until
 * somebody got round to issuing them, and by Friday the buyer has five drafts
 * per supplier for the same shortfall.
 *
 * So this subtracts what is already sitting on an OPEN DRAFT as well, in the
 * alert rather than in the shared query, where changing it would silently
 * change what the buyer's screen says is on order.
 */

export type LowStockOrder = {
  documentId: number
  /**
   * What to CALL this order in the ledger and the email.
   *
   * Deliberately not a document number: a draft has none. Purchasing allocates
   * the number when an order is ISSUED, so every draft this raises carries
   * document_number NULL, and recording "#9958" would put a number in the audit
   * trail that matches nothing anybody can search for. The supplier's name and
   * the order's own id are what a person can actually follow.
   */
  label: string
  supplierName: string
  lines: number
  totalExcl: number
}

export type LowStockResult = {
  groups: SupplierGroup[]
  /** Every short line, across suppliers. */
  total: number
  /** Drafts this run actually created. */
  createdOrders: LowStockOrder[]
  /** Why a supplier's order could not be raised — never silently dropped. */
  problems: string[]
  createOrders: boolean
}

/**
 * Most drafts one firing will raise.
 *
 * One order per supplier is the right SHAPE — a buyer sends one order to one
 * supplier — but a catalogue with hundreds of suppliers turns that into
 * hundreds of drafts overnight, which is not an automation, it is a mess
 * somebody has to clean up by hand.
 *
 * The cap is on the ACT, never on the report: every shortage is still counted
 * and still listed, and what was not drafted is said out loud. A silent cap
 * would be the worst of both — an owner would believe the drafts were the
 * whole story.
 *
 * Biggest-value suppliers first, so the cap keeps the orders that matter.
 */
const MAX_DRAFTS_PER_RUN = 20

export async function evaluateLowStock(
  siteId: number,
  rule: AlertRule,
  actor: { userId: number; userName: string },
): Promise<LowStockResult> {
  const locationId = await mainLocationId(siteId)

  // 'below_minimum' is the basis this alert names: at or under the level
  // somebody set. The velocity bases answer a different question ("what will
  // run out"), which is a forecast and deserves its own rule rather than being
  // folded in under a name that promises a fact.
  const groups = await reorderBySupplier(siteId, {
    locationId,
    basis: 'below_minimum',
    // The digest must carry EVERY shortage, not the first page: a shortage that
    // exists but is missing from the alert defeats the point of sending one.
    limit: 2000,
  })

  const total = groups.reduce((sum, g) => sum + g.lines.length, 0)

  const result: LowStockResult = {
    groups,
    total,
    createdOrders: [],
    problems: [],
    createOrders: rule.config.createOrders,
  }

  if (!rule.config.createOrders || total === 0) return result

  // Purchase VAT resolved here, exactly as the interactive action does — the
  // rate a document is taxed at is not the caller's to decide.
  const vatRates = await listVatRates(siteId)
  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')

  // What is already waiting on an unsent draft — see the header. Read once for
  // the whole run rather than per supplier.
  const onDraft = await quantitiesOnOpenDrafts(siteId)

  // Biggest spend first, so a cap that bites keeps the orders worth having.
  const ordered = [...groups].sort((a, b) => b.totalExcl - a.totalExcl)
  const orderable = ordered.filter((g) => g.supplierId !== null)
  const noSupplier = ordered.filter((g) => g.supplierId === null)

  // A product with no preferred supplier cannot be ordered FROM anyone. It
  // stays in the report — it is genuinely short — but it is not quietly
  // attached to whichever supplier happened to sort first.
  const orphanLines = noSupplier.reduce((sum, g) => sum + g.lines.length, 0)
  if (orphanLines > 0) {
    result.problems.push(
      `${count(orphanLines, 'product')} had no preferred supplier, so no order was drafted for them.`,
    )
  }

  if (orderable.length > MAX_DRAFTS_PER_RUN) {
    const left = orderable.length - MAX_DRAFTS_PER_RUN
    result.problems.push(
      `Only the ${MAX_DRAFTS_PER_RUN} biggest suppliers were drafted — ${count(left, 'other supplier')} still needs an order raised by hand.`,
    )
  }

  for (const group of orderable.slice(0, MAX_DRAFTS_PER_RUN)) {
    // Narrowing only — `orderable` is already filtered to groups that have one.
    const supplierId = group.supplierId
    if (supplierId === null) continue


    const lines = group.lines
      .map((l) => {
        // roundToPack is the buyer's own convention: nobody orders 7 bottles
        // from a brewery. `suggested` is already rounded; rawSuggested is not.
        const wanted = rule.config.roundToPack ? l.suggested : Math.ceil(l.rawSuggested)
        return {
          productId: l.productId,
          productCode: l.code,
          supplierCode: l.supplierCode,
          description: l.description,
          productType: l.productType,
          locationId,
          // Less whatever is already waiting on an unsent draft, so running
          // daily does not stack a new draft on yesterday's.
          qtyOrdered: Math.max(0, wanted - (onDraft.get(l.productId) ?? 0)),
          unitCostExcl: l.unitCostExcl,
          vatRatePct: purchaseVat?.rate ?? 0,
        }
      })
      .filter((l) => l.qtyOrdered > 0)

    // Everything this supplier is short of is already on a draft somebody has
    // not sent. Raising a second one would not help them.
    if (lines.length === 0) continue

    const saved = await saveOrder(siteId, actor, { supplierId, lines })
    if (!saved.ok) {
      // Reported, never swallowed: a supplier gone inactive is exactly the sort
      // of thing the owner needs told, and a silent gap in the drafts would
      // read as "nothing was short from them".
      result.problems.push(`${group.supplierName ?? 'A supplier'}: ${saved.error}`)
      continue
    }

    const supplierName = group.supplierName ?? 'supplier'
    result.createdOrders.push({
      documentId: saved.id,
      label: `Draft ${saved.id} (${supplierName})`,
      supplierName,
      lines: lines.length,
      totalExcl: group.totalExcl,
    })
  }

  return result
}

/**
 * How much of each product is already sitting on an unsent purchase order.
 *
 * Drafts only: an ISSUED order is already counted by reorderSuggestions' own
 * "on order" figure, and counting it here as well would subtract it twice and
 * leave a genuine shortage unordered.
 */
async function quantitiesOnOpenDrafts(siteId: number): Promise<Map<number, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ol.product_id, SUM(GREATEST(ol.qty_ordered - ol.qty_received, 0)) AS qty
       FROM purchase_document_lines ol
       JOIN purchase_documents od ON od.id = ol.document_id
      WHERE od.doc_type = 'purchase_order'
        AND od.status = 'draft'
        AND ol.product_id IS NOT NULL
      GROUP BY ol.product_id`,
  )
  return new Map(rows.map((r) => [Number(r.product_id), Number(r.qty) || 0]))
}

export function lowStockMessage(rule: AlertRule, result: LowStockResult): AlertMessage {
  const n = result.total
  const flat = result.groups.flatMap((g) =>
    g.lines.map((l) => ({ ...l, supplierName: g.supplierName })),
  )
  const shown = flat.slice(0, TEXT_LINES)

  const lines = shown.map(
    (l) =>
      `${l.description} (${l.code}): ${qty(l.stockOnHand)} on hand, min ${qty(l.minStock)} — order ${qty(l.suggested)}`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  // What it DID leads the summary when it did something: an owner reading this
  // on a phone needs to know that drafts are waiting, not just that stock is low.
  const created = result.createdOrders
  const summary = created.length
    ? `${count(created.length, 'draft order')} raised for you — review and send them from Purchasing.`
    : 'Open Purchasing → What to order to raise the orders.'

  return {
    kind: 'low_stock',
    title: `Low stock: ${count(n, 'product')} at or below minimum`,
    summary,
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'product')} at or below its minimum${
        created.length ? `, and drafted ${count(created.length, 'order')}.` : '.'
      }`,
      columns: [
        { header: 'Product' },
        { header: 'Code' },
        { header: 'Supplier' },
        { header: 'On hand', align: 'right' },
        { header: 'Min', align: 'right' },
        { header: 'On order', align: 'right' },
        { header: 'Order', align: 'right' },
      ],
      rows: flat
        .slice(0, EMAIL_ROWS)
        .map((l) => [
          l.description,
          l.code,
          l.supplierName ?? '',
          qty(l.stockOnHand),
          qty(l.minStock),
          qty(l.onOrder),
          qty(l.suggested),
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more.`] : []),
        ...created.map(
          (o) =>
            `${o.label}: ${count(o.lines, 'line')}, ${rands(o.totalExcl)} excl.`,
        ),
        ...(created.length
          ? ['These are DRAFTS. Nothing has been sent to a supplier until you issue them.']
          : []),
        ...result.problems,
        'What is already on order is subtracted, so the same shortage is not ordered twice.',
      ],
    }),
    href: result.createOrders && created.length ? '/purchasing' : '/purchasing/suggest',
  }
}
