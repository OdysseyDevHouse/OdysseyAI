import { MAX_ROWS, type CustomReportSpec } from './spec'
import type { Capability } from '../site/permissions'

/**
 * The built-in report catalogue.
 *
 * Every built-in is expressed as a BUILDER SPEC rather than hand-written SQL.
 * That single decision is what makes the hub coherent:
 *
 *   · one engine runs everything, so a fix to totalling or permissions lands
 *     everywhere at once;
 *   · any built-in can be opened in the builder and adjusted, which is how most
 *     people will ever discover the builder exists — "nearly what I want" is a
 *     far better entry point than a blank screen;
 *   · a built-in can be scheduled, favourited and exported with no extra code,
 *     because those features consume specs and know nothing about reports.
 *
 * The cost is that a report needing something the catalog cannot express has to
 * gain a catalog field first. That is the right pressure: it keeps the builder
 * genuinely capable rather than letting built-ins quietly become the only way
 * to see certain numbers.
 */

export interface ReportTemplate {
  /** Stable id — appears in URLs, favourites and schedules. Never reuse one. */
  id: string
  name: string
  description: string
  /*
   * "Multi-store" carries no template of its own — its two reports are dedicated
   * pages, listed by the hub — but it is named here because this union is what
   * makes a category a real thing rather than a free string, and the hub's
   * `HubItem.category` is typed from it.
   */
  category: 'Sales' | 'Stock' | 'Customers' | 'Suppliers' | 'Money' | 'Operations' | 'Multi-store'
  /** Capability needed to see it in the catalogue at all. */
  permission: Capability
  /** Extra capability the report's headline figures need (cost/margin). */
  financial?: boolean
  spec: Omit<CustomReportSpec, 'name'>
}

/** Terser template authoring — every spec shares these defaults. */
function spec(s: Partial<CustomReportSpec> & Pick<CustomReportSpec, 'source'>): Omit<
  CustomReportSpec,
  'name'
> {
  return {
    version: 1,
    period: { key: 'thisMonth' },
    columns: [],
    filters: [],
    groupFields: [],
    totalFilters: [],
    limit: 5000,
    ...s,
  }
}

export const TEMPLATES: ReportTemplate[] = [
  /* ── Sales ───────────────────────────────────────────────────────────────── */
  {
    id: 'sales-summary-by-day',
    name: 'Sales by day',
    description: 'Turnover, VAT and profit for each trading day in the period.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      groupFields: ['day'],
      columns: [
        { field: 'lineTotalIncl', agg: 'sum' },
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineVat', agg: 'sum' },
        { field: 'grossProfit', agg: 'sum' },
        { field: 'grossProfitPct', agg: 'avg' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'day', dir: 'asc' },
      chartType: 'line',
    }),
  },
  {
    id: 'sales-by-product',
    name: 'Sales by product',
    description: 'What sold, how much of it, and what it made. The top-sellers list.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      /* Department is a GROUP field, not a column: on a summarised report an
         unaggregated text column takes defaultAgg, which for text is `count` —
         it would have rendered "Count department" showing a row count. Grouping
         by it is also free, since a product sits in one department. */
      groupFields: ['lineDepartment', 'productCode', 'description'],
      /* v2's Product performance, which carried the department, the cost and
         the VAT beside the margin.
         Stock on hand is NOT here. It is a live per-product figure, so summing
         it multiplies the shop's stock by how often the product sold, and the
         `max` that fixes the arithmetic labels the column "Highest stock on
         hand now" — accurate and daft for a number that is the same on every
         row. A store that wants it beside sales adds it as a grouping, where it
         adds no rows and keeps its own name. stock-on-hand answers it plainly. */
      columns: [
        { field: 'qty', agg: 'sum' },
        { field: 'lineCostExcl', agg: 'sum' },
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineVat', agg: 'sum' },
        { field: 'lineTotalIncl', agg: 'sum' },
        { field: 'discountIncl', agg: 'sum' },
        { field: 'grossProfit', agg: 'sum' },
        { field: 'grossProfitPct', agg: 'avg' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'lineTotalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'sales-by-department',
    name: 'Sales by department',
    description: 'Which parts of the business are earning, and at what margin.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      groupFields: ['lineDepartment'],
      /* Cost and excl. selling added, as v2's Department performance carried
         them. Its "Turnover %" — each department's share of the total — has no
         equivalent: a percent-of-grand-total column is not something the spec
         model can express, and it is a known gap rather than an oversight. */
      columns: [
        { field: 'qty', agg: 'sum' },
        { field: 'lineCostExcl', agg: 'sum' },
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineTotalIncl', agg: 'sum' },
        { field: 'grossProfit', agg: 'sum' },
        { field: 'grossProfitPct', agg: 'avg' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'lineTotalIncl_sum', dir: 'desc' },
      chartType: 'pie',
    }),
  },
  {
    id: 'sales-by-cashier',
    name: 'Sales by cashier',
    description: 'Turnover, basket count and average basket for each person serving.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['userName'],
      /* Deliberately still on `sales` rather than `saleLines`, though that
         source has no cost and so this report can never show margin.
         `__rows` here is a BASKET count and `totalIncl avg` a real average
         basket; on saleLines both would silently become line counts, which is
         the wrong answer to the question this report asks.
         v2's "Clerk performance" was a different report — one row per clerk AND
         product — and is added separately as products-sold-per-clerk rather
         than by bending this one out of shape. */
      columns: [
        { field: '__rows' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'totalIncl', agg: 'avg' },
        { field: 'subtotalExcl', agg: 'sum' },
        { field: 'vatTotal', agg: 'sum' },
        { field: 'discountTotal', agg: 'sum' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'invoice' },
      ],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'sales-by-hour',
    name: 'Trading by hour',
    description: 'When the shop is busy — takings and basket count by hour of day.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['hour'],
      columns: [
        { field: '__rows' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'totalIncl', agg: 'avg' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'hour', dir: 'asc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'sales-by-tender',
    name: 'Payments by tender',
    description: 'What money arrived and in what form — reconcile against the bank and the drawer.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'tenders',
      groupFields: ['tenderName'],
      columns: [{ field: '__rows' }, { field: 'netAmount', agg: 'sum' }, { field: 'surcharge', agg: 'sum' }],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'netAmount_sum', dir: 'desc' },
      chartType: 'pie',
    }),
  },
  {
    id: 'vat-by-rate',
    name: 'VAT by rate',
    description: 'Output tax grouped by the rate stored on each line, so a rate change cannot restate a filed return.',
    category: 'Sales',
    permission: 'reports.financial',
    spec: spec({
      source: 'saleLines',
      /* Per DAY and rate, which is what a VAT return is assembled from — v2's
         Daily TAXES report. Grouping by rate alone gives the period total, and
         a store that wants only that removes the day column. */
      groupFields: ['day', 'vatRatePct'],
      columns: [
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineVat', agg: 'sum' },
        { field: 'lineTotalIncl', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'day', dir: 'asc' },
    }),
  },
  {
    id: 'invoice-list',
    name: 'Invoice list',
    description: 'Every document raised in the period, with its total and who served.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      /* The columns the v2 invoice history carried. A store that only wants a
         total and a name hides the rest — which is now a thing it can do. */
      columns: [
        { field: 'documentNumber' },
        { field: 'documentDate' },
        { field: 'docType' },
        { field: 'status' },
        { field: 'customerName' },
        { field: 'accountCode' },
        { field: 'userName' },
        { field: 'terminalCode' },
        /* The customer's own order number, which is what `reference` holds. */
        { field: 'reference' },
        { field: 'subtotalExcl' },
        { field: 'vatTotal' },
        { field: 'discountTotal' },
        { field: 'roundingAdj' },
        { field: 'totalIncl' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'invoice-detail-list',
    name: 'Invoice detail list',
    description: 'Every line on every document — the line-by-line twin of the invoice list.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      /* The widest report in the catalogue, deliberately: v2's detailed history
         was the one people exported and pivoted, so it carries the identity,
         the money and the margin rather than making each a separate report.
         Cost and GP drop out for a role without products.cost. */
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'accountCode' },
        { field: 'userName' },
        { field: 'terminalCode' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'lineDepartment' },
        { field: 'qty' },
        { field: 'unitPriceIncl' },
        { field: 'vatRatePct' },
        { field: 'discountPct' },
        { field: 'discountIncl' },
        { field: 'lineTotalExcl' },
        { field: 'lineVat' },
        { field: 'lineTotalIncl' },
        { field: 'unitCostExcl' },
        { field: 'lineCostExcl' },
        { field: 'grossProfit' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'sales-by-month',
    name: 'Sales by month',
    description: 'Turnover and profit month by month — the shape of the year rather than of the week.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      period: { key: 'thisYear' },
      groupFields: ['month'],
      columns: [
        { field: 'lineTotalIncl', agg: 'sum' },
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineVat', agg: 'sum' },
        { field: 'grossProfit', agg: 'sum' },
        { field: 'grossProfitPct', agg: 'avg' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'month', dir: 'asc' },
      chartType: 'line',
    }),
  },
  {
    id: 'sales-by-till',
    name: 'Sales by till',
    description: 'Turnover, basket count and average basket for each till — which lanes carry the shop.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['terminalCode'],
      columns: [
        { field: '__rows' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'totalIncl', agg: 'avg' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'invoice' },
      ],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'credit-notes',
    name: 'Credit notes',
    description: 'What went back and who authorised it. Returns are normal; a pattern in them is worth reading.',
    category: 'Sales',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'userName' },
        { field: 'reference' },
        { field: 'totalIncl' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'credit_sale' },
      ],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    /* Id kept for the reason void-history's is — see there. */
    id: 'discounts-and-voids',
    name: 'Discounts and cancellations by cashier',
    description:
      'None of these is wrong on its own. Someone far outside their colleagues’ numbers is the pattern worth a conversation.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['userName', 'status'],
      columns: [{ field: '__rows' }, { field: 'discountTotal', agg: 'sum' }, { field: 'totalIncl', agg: 'sum' }],
      filters: [],
      sort: { key: 'discountTotal_sum', dir: 'desc' },
    }),
  },
  {
    /* Id kept for the reason void-history's is — see there. */
    id: 'voids-by-reason',
    name: 'Cancellations by reason',
    description:
      'What cancelling is costing, and why. One reason far ahead of the rest is either a training problem or a process one — the split says which.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['cancelReasonName'],
      columns: [{ field: '__rows' }, { field: 'totalIncl', agg: 'sum' }],
      filters: [{ field: 'status', op: 'eq', value: 'cancelled' }],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'returns-by-reason',
    name: 'Returns by reason',
    description:
      'Why goods come back, and what it costs. Faulty is a supplier conversation; wrong size is a description one.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['returnReasonName'],
      columns: [{ field: '__rows' }, { field: 'totalIncl', agg: 'sum' }],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'credit_sale' },
      ],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },

  /* ── Stock ───────────────────────────────────────────────────────────────── */
  {
    id: 'stock-valuation',
    name: 'Stock valuation',
    description: 'What is on the shelf and what it cost — the money tied up in stock.',
    category: 'Stock',
    permission: 'reports.financial',
    financial: true,
    spec: spec({
      source: 'products',
      groupFields: ['department'],
      columns: [
        { field: '__rows' },
        { field: 'stockOnHand', agg: 'sum' },
        { field: 'stockValue', agg: 'sum' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      sort: { key: 'stockValue_sum', dir: 'desc' },
    }),
  },
  {
    id: 'stock-on-hand',
    name: 'Stock on hand',
    description: 'What is on the shelf right now, by product. Quantities only — no cost, so anyone may read it.',
    category: 'Stock',
    permission: 'products.view',
    spec: spec({
      source: 'products',
      // A stock list that stops at 5,000 is a stocktake sheet missing pages.
      limit: MAX_ROWS,
      /* No cost columns, on purpose — this report is products.view so that
         anyone counting a shelf may read it, and cost lives in stock-valuation
         behind reports.financial. Max level added to complete the pair with
         min, which v2's stock-on-hand carried. */
      columns: [
        { field: 'code' },
        { field: 'barcode' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'minStock' },
        { field: 'maxStock' },
        { field: 'lastSoldDate' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      sort: { key: 'description', dir: 'asc' },
    }),
  },
  {
    id: 'dead-stock-by-age',
    name: 'Dead stock by age',
    description:
      'The money on the shelf, grouped by how long since it last sold — where the bands past 90 days are the capital quietly going stale.',
    category: 'Stock',
    permission: 'reports.financial',
    financial: true,
    spec: spec({
      source: 'products',
      groupFields: ['ageBand'],
      columns: [
        { field: '__rows' },
        { field: 'stockOnHand', agg: 'sum' },
        { field: 'stockValue', agg: 'sum' },
      ],
      filters: [
        { field: 'isArchived', op: 'eq', value: 'No' },
        { field: 'stockOnHand', op: 'gt', value: '0' },
      ],
      sort: { key: 'stockValue_sum', dir: 'desc' },
    }),
  },
  {
    id: 'dead-stock-detail',
    name: 'Dead stock detail',
    description:
      'Every stocked product that has not sold in six months — the clearance list, with what each line is still worth.',
    category: 'Stock',
    permission: 'reports.financial',
    financial: true,
    spec: spec({
      source: 'products',
      limit: MAX_ROWS,
      columns: [
        { field: 'code' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'stockValue' },
        { field: 'lastSoldDate' },
        { field: 'daysSinceSold' },
        { field: 'ageBand' },
      ],
      filters: [
        { field: 'isArchived', op: 'eq', value: 'No' },
        { field: 'stockOnHand', op: 'gt', value: '0' },
        // gt 180, not gte: the boundary day still belongs to the 91–180 band.
        { field: 'daysSinceSold', op: 'gt', value: '180' },
      ],
      sort: { key: 'stockValue', dir: 'desc' },
    }),
  },
  {
    id: 'product-price-list',
    name: 'Product price list',
    description: 'Every selling price in one list — for a shelf-edge check or a printed catalogue.',
    category: 'Stock',
    permission: 'products.view',
    spec: spec({
      source: 'products',
      // A price list is printed and worked through — a truncated one is wrong
      // in a way nobody notices until a shelf has no price.
      limit: MAX_ROWS,
      /* v2's price list carried stock, cost and margin beside the price. The
         cost columns drop out for a role without products.cost, which is why
         this can stay a products.view report and still show them to a buyer. */
      columns: [
        { field: 'code' },
        { field: 'barcode' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'lastCost' },
        { field: 'averageCost' },
        { field: 'sellingPriceIncl' },
        { field: 'marginPct' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      sort: { key: 'description', dir: 'asc' },
    }),
  },
  {
    id: 'price-list-by-supplier',
    name: 'Price list per supplier',
    description:
      'What each supplier charges and what it sells for, from the lines actually bought — the buying list before an order goes out.',
    category: 'Stock',
    permission: 'purchasing.view',
    spec: spec({
      source: 'purchaseLines',
      period: { key: 'thisYear' },
      limit: MAX_ROWS,
      groupFields: ['supplierName', 'productCode', 'description'],
      columns: [
        { field: 'unitCostExcl', agg: 'max' },
        { field: 'qtyReceived', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'supplierName', dir: 'asc' },
    }),
  },
  {
    id: 'product-movement',
    name: 'Product movement',
    description:
      'Every movement grouped by product — what came in, what went out and where a count went wrong.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      /* Department joins the grouping rather than sitting as a column: a
         product has one, and an unaggregated text column on a summarised
         report silently renders as a COUNT. */
      groupFields: ['productDepartment', 'productCode', 'productDescription'],
      /* v2 showed an opening and a closing quantity here. Neither is offered,
         and deliberately: stock_movements records qty_after per movement, so a
         CLOSING balance would have to be "the last one in the period" and the
         only aggregate that comes close is `max` — which is the period's PEAK,
         a different number wearing the right label. The net change is the
         honest figure this source can give, and stock-on-hand answers "what is
         there now" without guessing. */
      columns: [
        { field: '__rows' },
        { field: 'qtyChange', agg: 'sum' },
        { field: 'movementValue', agg: 'sum' },
      ],
      sort: { key: 'qtyChange_sum', dir: 'asc' },
    }),
  },
  {
    id: 'below-minimum',
    name: 'Below minimum level',
    description: 'Products at or under their reorder point — what to buy next.',
    category: 'Stock',
    permission: 'products.view',
    spec: spec({
      source: 'products',
      columns: [
        { field: 'code' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'minStock' },
        { field: 'maxStock' },
        { field: 'shortfall' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      totalFilters: [{ key: 'shortfall', op: 'gt', value: '0' }],
      sort: { key: 'shortfall', dir: 'desc' },
    }),
  },
  {
    id: 'slow-movers',
    name: 'Slow movers',
    description: 'Stock on hand that has not sold in a long time — money sitting on a shelf.',
    category: 'Stock',
    permission: 'products.view',
    spec: spec({
      source: 'products',
      columns: [
        { field: 'code' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'lastSoldDate' },
        { field: 'daysSinceSold' },
        { field: 'averageCost' },
        { field: 'stockValue' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      totalFilters: [{ key: 'stockOnHand', op: 'gt', value: '0' }],
      sort: { key: 'daysSinceSold', dir: 'desc' },
    }),
  },
  {
    id: 'stock-movements',
    name: 'Stock movements',
    description: 'Every change in stock in the period, and what caused it.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      columns: [
        { field: 'movedAt' },
        { field: 'productCode' },
        { field: 'productDescription' },
        { field: 'movementType' },
        { field: 'qtyChange' },
        { field: 'qtyAfter' },
        { field: 'userName' },
      ],
      sort: { key: 'movedAt', dir: 'desc' },
    }),
  },
  {
    id: 'shrinkage-by-product',
    name: 'Shrinkage by product',
    /*
     * Counted stock only — source = 'stock_take'.
     *
     * The wider "Stock adjustments" template below covers every adjustment,
     * which includes the ones a document VOID writes. Those are corrections to
     * paperwork, not stock that walked, and mixing them in is what makes a
     * shrinkage figure impossible to act on. This one answers the question a
     * business actually asks after a count: what is going missing, and what is
     * it costing.
     *
     * Sorted by value ascending, so the worst write-off is the first row.
     */
    description: 'What counting found missing, by product — the losses worth acting on.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      groupFields: ['productCode', 'productDescription'],
      columns: [
        { field: '__rows' },
        { field: 'qtyChange', agg: 'sum' },
        { field: 'movementValue', agg: 'sum' },
      ],
      filters: [{ field: 'source', op: 'eq', value: 'stock_take' }],
      sort: { key: 'movementValue_sum', dir: 'asc' },
    }),
  },
  {
    id: 'shrinkage-by-department',
    name: 'Shrinkage by department',
    description: 'Where stock is going missing — the aisle to count next.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      groupFields: ['productDepartment'],
      columns: [
        { field: '__rows' },
        { field: 'qtyChange', agg: 'sum' },
        { field: 'movementValue', agg: 'sum' },
      ],
      filters: [{ field: 'source', op: 'eq', value: 'stock_take' }],
      sort: { key: 'movementValue_sum', dir: 'asc' },
    }),
  },
  {
    id: 'stock-adjustments',
    name: 'Stock adjustments',
    description: 'Write-offs and corrections only — the movements a person chose to make.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      /* One row per ADJUSTMENT, not per person — v2's grain, and the useful
         one: "who adjusted what, when, and by how much" is the question this
         report is opened to answer. The per-person rollup is a group away, and
         product-movement already gives the per-product one.
         The adjustment REASON is the column this still lacks; it lives in
         stock_adjustments (100), which has no catalog source yet. */
      columns: [
        { field: 'movedAt' },
        { field: 'productCode' },
        { field: 'productDescription' },
        { field: 'productDepartment' },
        { field: 'userName' },
        { field: 'qtyChange' },
        { field: 'qtyAfter' },
        { field: 'unitCostExcl' },
        { field: 'movementValue' },
        { field: 'note' },
      ],
      filters: [{ field: 'movementType', op: 'eq', value: 'adjustment' }],
      sort: { key: 'movedAt', dir: 'desc' },
    }),
  },
  {
    id: 'ingredient-usage',
    name: 'Ingredients used in production',
    description: 'What manufacturing consumed, by product — the flour behind the bread.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      groupFields: ['productCode', 'productDescription'],
      columns: [{ field: '__rows' }, { field: 'qtyChange', agg: 'sum' }, { field: 'movementValue', agg: 'sum' }],
      // manufacture_out only. The matching manufacture_in is the finished item
      // arriving, and summing both together would net a build to roughly zero
      // and answer nothing.
      filters: [{ field: 'movementType', op: 'eq', value: 'manufacture_out' }],
      sort: { key: 'movementValue_sum', dir: 'asc' },
    }),
  },
  {
    id: 'production-output',
    name: 'What was manufactured',
    description: 'Finished goods built, by product, with what they cost to make.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockMovements',
      groupFields: ['productCode', 'productDescription'],
      columns: [{ field: '__rows' }, { field: 'qtyChange', agg: 'sum' }, { field: 'movementValue', agg: 'sum' }],
      filters: [{ field: 'movementType', op: 'eq', value: 'manufacture_in' }],
      sort: { key: 'movementValue_sum', dir: 'desc' },
    }),
  },

  /* ── Customers ───────────────────────────────────────────────────────────── */
  {
    id: 'customer-balances',
    name: 'Customer balances',
    description: 'Who owes what, against their limit.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customers',
      columns: [
        { field: 'code' },
        { field: 'name' },
        { field: 'status' },
        { field: 'balance' },
        { field: 'creditLimit' },
        { field: 'availableCredit' },
      ],
      totalFilters: [{ key: 'balance', op: 'ne', value: '0' }],
      sort: { key: 'balance', dir: 'desc' },
    }),
  },
  {
    id: 'overdue-accounts',
    name: 'Overdue accounts',
    description: 'Unpaid invoices past their due date, oldest first.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customerTransactions',
      period: { key: 'lastYear' },
      columns: [
        { field: 'customerName' },
        { field: 'docNumber' },
        { field: 'docDate' },
        { field: 'dueDate' },
        { field: 'daysOverdue' },
        { field: 'amountOutstanding' },
      ],
      filters: [{ field: 'docType', op: 'eq', value: 'invoice' }],
      totalFilters: [
        { key: 'amountOutstanding', op: 'gt', value: '0' },
        { key: 'daysOverdue', op: 'gt', value: '0' },
      ],
      sort: { key: 'daysOverdue', dir: 'desc' },
    }),
  },
  {
    id: 'customer-age-analysis',
    name: 'Age analysis',
    description:
      'Every unsettled document by how long it has been outstanding. The debtors ageing you work the phone from.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customerTransactions',
      period: { key: 'thisYear' },
      columns: [
        { field: 'customerCode' },
        { field: 'customerName' },
        { field: 'docNumber' },
        { field: 'docDate' },
        { field: 'dueDate' },
        { field: 'daysOverdue' },
        { field: 'amountOutstanding' },
      ],
      // Settled documents are not part of an ageing, and leaving them in pushed
      // the report past its row cap — which truncates the OLDEST debt, the one
      // line the report exists to show.
      filters: [{ field: 'amountOutstanding', op: 'gt', value: '0' }],
      sort: { key: 'daysOverdue', dir: 'desc' },
    }),
  },
  {
    id: 'customer-age-analysis-bucketed',
    name: 'Age analysis, bucketed',
    description:
      'One row per account with Current/30/60/90/120+ columns — the classic ladder, aged from today. For an as-at ladder use the Age analysis page, which rolls allocations back.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customerTransactions',
      period: { key: 'thisYear' },
      groupFields: ['customerCode', 'customerName'],
      columns: [
        { field: 'agedCurrent', agg: 'sum' },
        { field: 'aged30', agg: 'sum' },
        { field: 'aged60', agg: 'sum' },
        { field: 'aged90', agg: 'sum' },
        { field: 'aged120', agg: 'sum' },
        { field: 'amountOutstanding', agg: 'sum' },
      ],
      filters: [{ field: 'amountOutstanding', op: 'gt', value: '0' }],
      sort: { key: 'amountOutstanding_sum', dir: 'desc' },
    }),
  },
  {
    id: 'customer-payments',
    name: 'Customer payments',
    description: 'Money received from accounts in the period, and who receipted it.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customerTransactions',
      columns: [
        { field: 'docDate' },
        { field: 'docNumber' },
        { field: 'customerName' },
        { field: 'reference' },
        { field: 'userName' },
        { field: 'amountSigned' },
      ],
      filters: [{ field: 'docType', op: 'eq', value: 'payment' }],
      sort: { key: 'docDate', dir: 'desc' },
    }),
  },
  {
    id: 'sales-by-customer',
    name: 'Sales by customer',
    description: 'Who buys the most — turnover and basket count per account.',
    category: 'Customers',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      groupFields: ['customerName'],
      columns: [{ field: '__rows' }, { field: 'totalIncl', agg: 'sum' }, { field: 'totalIncl', agg: 'avg' }],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'customer-ledger',
    name: 'Customer ledger',
    description: 'Every transaction on every account in the period.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'customerTransactions',
      columns: [
        { field: 'docDate' },
        { field: 'customerName' },
        { field: 'docType' },
        { field: 'docNumber' },
        { field: 'amountSigned' },
        { field: 'amountOutstanding' },
      ],
      sort: { key: 'docDate', dir: 'desc' },
    }),
  },

  /* ── Suppliers ───────────────────────────────────────────────────────────── */
  {
    id: 'purchases-by-supplier',
    name: 'Purchases by supplier',
    description: 'What was bought from whom in the period.',
    category: 'Suppliers',
    permission: 'purchasing.view',
    spec: spec({
      source: 'purchases',
      groupFields: ['supplierName'],
      columns: [{ field: '__rows' }, { field: 'subtotalExcl', agg: 'sum' }, { field: 'totalIncl', agg: 'sum' }],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'totalIncl_sum', dir: 'desc' },
    }),
  },
  {
    id: 'goods-received',
    name: 'Goods received',
    description: 'Every GRV line in the period — what arrived and what it cost.',
    category: 'Suppliers',
    permission: 'purchasing.view',
    spec: spec({
      source: 'purchaseLines',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'supplierName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'qtyReceived' },
        { field: 'unitCostExcl' },
        { field: 'lineTotalExcl' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'grv' },
      ],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'outstanding-orders',
    name: 'Outstanding purchase orders',
    description: 'Ordered but not yet received — what the supplier still owes you.',
    category: 'Suppliers',
    permission: 'purchasing.view',
    spec: spec({
      source: 'purchaseLines',
      period: { key: 'lastYear' },
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'supplierName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'qtyOrdered' },
        { field: 'qtyReceived' },
        { field: 'qtyOutstanding' },
      ],
      filters: [{ field: 'docType', op: 'eq', value: 'purchase_order' }],
      totalFilters: [{ key: 'qtyOutstanding', op: 'gt', value: '0' }],
      sort: { key: 'documentDate', dir: 'asc' },
    }),
  },
  {
    id: 'supplier-balances',
    name: 'Supplier balances',
    description: 'What is owed to each supplier right now.',
    category: 'Suppliers',
    permission: 'suppliers.view',
    spec: spec({
      source: 'suppliers',
      columns: [{ field: 'code' }, { field: 'name' }, { field: 'status' }, { field: 'termsDays' }, { field: 'balance' }],
      totalFilters: [{ key: 'balance', op: 'ne', value: '0' }],
      sort: { key: 'balance', dir: 'desc' },
    }),
  },

  /* ── Money ───────────────────────────────────────────────────────────────── */
  {
    id: 'expenses-by-category',
    name: 'Expenses by category',
    description: 'Where the money went, grouped by expense account.',
    category: 'Money',
    permission: 'cashbook.view',
    spec: spec({
      source: 'expenseLines',
      groupFields: ['categoryName'],
      columns: [{ field: '__rows' }, { field: 'lineExcl', agg: 'sum' }, { field: 'lineVat', agg: 'sum' }, { field: 'lineIncl', agg: 'sum' }],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'lineIncl_sum', dir: 'desc' },
      chartType: 'pie',
    }),
  },
  {
    id: 'gl-detail',
    name: 'Journal detail',
    description:
      'Every posted debit and credit in the period, with the journal that carried it. The ledger, line by line.',
    category: 'Money',
    permission: 'reports.financial',
    spec: spec({
      source: 'journalLines',
      columns: [
        { field: 'journalDate' },
        { field: 'journalNumber' },
        { field: 'source' },
        { field: 'accountCode' },
        { field: 'accountName' },
        { field: 'lineDescription' },
        { field: 'debit' },
        { field: 'credit' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'journalDate', dir: 'desc' },
    }),
  },
  {
    id: 'gl-by-account',
    name: 'Movement by account',
    description:
      'Each account’s debits, credits and net movement for the period — the figure between two trial balances.',
    category: 'Money',
    permission: 'reports.financial',
    spec: spec({
      source: 'journalLines',
      groupFields: ['accountCode', 'accountName', 'accountType'],
      columns: [
        { field: 'debit', agg: 'sum' },
        { field: 'credit', agg: 'sum' },
        { field: 'amount', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'accountCode', dir: 'asc' },
    }),
  },
  {
    id: 'account-balances',
    name: 'Account balances',
    description: 'The chart of accounts and where each balance stands right now.',
    category: 'Money',
    permission: 'reports.financial',
    spec: spec({
      source: 'glAccounts',
      columns: [
        { field: 'accountCode' },
        { field: 'name' },
        { field: 'accountType' },
        { field: 'subtype' },
        { field: 'balanceDisplay' },
      ],
      totalFilters: [{ key: 'balanceDisplay', op: 'ne', value: '0' }],
      sort: { key: 'accountCode', dir: 'asc' },
    }),
  },
  {
    id: 'expenses-detail',
    name: 'Expense detail',
    description: 'Every expense line in the period.',
    category: 'Money',
    permission: 'cashbook.view',
    spec: spec({
      source: 'expenseLines',
      columns: [
        { field: 'expenseDate' },
        { field: 'documentNumber' },
        { field: 'supplierName' },
        { field: 'categoryName' },
        { field: 'lineDescription' },
        { field: 'lineExcl' },
        { field: 'lineVat' },
        { field: 'lineIncl' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'expenseDate', dir: 'desc' },
    }),
  },

  /* ── Job cards ───────────────────────────────────────────────────────────────
   *
   * THREE, not fifteen. The builder is the answer to the other twelve, and a
   * catalogue of near-identical job reports is how somebody ends up scrolling past
   * the one they wanted. Each of these answers a question a service business
   * actually asks out loud, and between them they exercise both sources and the
   * cost gate.
   */
  {
    id: 'jobs-by-technician',
    name: 'Jobs by technician',
    description:
      'How many jobs each person carried in the period, and how long they took on average.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCards',
      groupFields: ['ownerName'],
      columns: [
        { field: '__rows' },
        { field: 'daysOpen', agg: 'avg' },
        { field: 'daysOverdue', agg: 'avg' },
      ],
      // Worst average turnaround first: the row somebody opened this for.
      sort: { key: 'daysOpen_avg', dir: 'desc' },
    }),
  },
  {
    id: 'job-cost-absorbed',
    name: 'Work we did not charge for',
    description:
      'Every job carrying internal, written-off or undecided cost — the figure that quietly eats a service margin.',
    category: 'Operations',
    permission: 'jobs.view',
    /*
     * No `financial: true` — the flag is declared on ReportTemplate but read by
     * nothing, so setting it would look like a guard and be none. The real gate is
     * per-field: the cost columns carry permission 'jobs.cost', so this opens for
     * a technician with those columns silently absent rather than refusing.
     */
    spec: spec({
      source: 'jobCards',
      columns: [
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'title' },
        { field: 'statusName' },
        { field: 'totalCost' },
        { field: 'absorbedCost' },
        { field: 'undecidedCost' },
      ],
      /*
       * Not filtered to "absorbed > 0": a total filter would hide the jobs where
       * the cost is still UNDECIDED, which are the ones somebody can still act on.
       * Sorting does the job without throwing rows away.
       */
      sort: { key: 'absorbedCost', dir: 'desc' },
    }),
  },
  {
    id: 'job-parts-used',
    name: 'Parts and labour used on jobs',
    description:
      'Every line on every job, grouped by what kind of thing it was and who pays for it.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCardLines',
      groupFields: ['lineKind', 'billingState'],
      columns: [
        { field: '__rows' },
        { field: 'qty', agg: 'sum' },
        { field: 'lineCost', agg: 'sum' },
        { field: 'intendedProfit', agg: 'sum' },
      ],
      sort: { key: 'lineCost_sum', dir: 'desc' },
      chartType: 'bar',
    }),
  },

  /* ── The Phase-1 job reports the new sources unlocked (22) ────────────────
   *
   * Still not fifteen, and deliberately. The PRD itself says "avoid building
   * too many specialised reports initially — a smaller set of reliable,
   * filterable reports will deliver more value", and templates.ts has argued
   * the same since phase 9.
   *
   * These five are the ones somebody would otherwise have to build from
   * scratch on a Monday morning: two protect money, two answer "did we turn
   * up", and one is the timesheet a payroll run needs.
   */
  {
    id: 'job-time-and-labour',
    name: 'Time and labour on jobs',
    description:
      'Hours booked against jobs, by person — what was worked, what was on break, and what is still running.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobTime',
      groupFields: ['userName'],
      columns: [
        { field: '__rows' },
        { field: 'hours', agg: 'sum' },
        { field: 'breakMinutes', agg: 'sum' },
      ],
      sort: { key: 'hours_sum', dir: 'desc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'job-travel',
    name: 'Travel on jobs',
    description:
      'Every trip with its expected, recorded and chargeable kilometres — and whether anybody checked it.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobTravel',
      columns: [
        { field: 'travelledOn' },
        { field: 'jobNumber' },
        { field: 'userName' },
        { field: 'expectedKm' },
        { field: 'recordedKm' },
        { field: 'chargeableKm' },
        { field: 'varianceKm' },
        { field: 'travelCharge' },
        { field: 'verified' },
      ],
      // Biggest overrun first — the row an approver is looking for.
      sort: { key: 'varianceKm', dir: 'desc' },
    }),
  },
  {
    id: 'job-travel-unverified',
    name: 'Travel nobody has checked',
    description:
      'Kilometres claimed and never approved. Each one is either money owed to a technician or money the business should not pay.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobTravel',
      filters: [{ field: 'verified', op: 'eq', value: 'No' }],
      columns: [
        { field: 'travelledOn' },
        { field: 'jobNumber' },
        { field: 'userName' },
        { field: 'recordedKm' },
        { field: 'varianceKm' },
        { field: 'travelCharge' },
        { field: 'toleranceBreached' },
      ],
      sort: { key: 'travelledOn', dir: 'asc' },
    }),
  },
  {
    id: 'job-visit-performance',
    name: 'Did we turn up on time',
    description:
      'Every booked visit by outcome — attended, late, cancelled or a no-show. On time means within fifteen minutes.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobVisits',
      groupFields: ['status'],
      columns: [
        { field: '__rows' },
        { field: 'minutesLate', agg: 'avg' },
        { field: 'onSiteMinutes', agg: 'avg' },
      ],
      /* The row-count column's OUTPUT key — '__rows' is the input marker, and
         a sort naming it was silently dropped by validateSpec. */
      sort: { key: 'rowCount', dir: 'desc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'job-visits-missed',
    name: 'Visits that did not happen',
    description:
      'Bookings cancelled or missed, with the reason recorded at the time. A customer whose name repeats here is one about to leave.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobVisits',
      filters: [{ field: 'attended', op: 'eq', value: 'No' }],
      columns: [
        { field: 'startsAt' },
        { field: 'jobNumber' },
        { field: 'customerName' },
        { field: 'status' },
        { field: 'outcomeReason' },
      ],
      sort: { key: 'startsAt', dir: 'desc' },
    }),
  },

  /* ── The rest of the PRD's Phase-1 job reports ────────────────────────────
   *
   * Seven specs, no new code. That is the point of the phase that made jobTime,
   * jobTravel and jobVisits catalog sources: what was twelve reports needing a
   * developer became a list of column choices, and anything else a business
   * wants is now a screen they build themselves.
   */
  {
    id: 'jobs-open-by-stage',
    name: 'Where the work is',
    description:
      'Every open job by the stage it has reached, oldest first. The one to read at a stand-up: a stage that is filling up is a bottleneck.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCards',
      groupFields: ['statusName'],
      /*
       * Deliberately NOT daysOverdue here.
       *
       * That field is DATEDIFF(now, due_at) with no clamp, so a job that is not
       * due yet is a NEGATIVE number — and MAX() over a stage where nothing is
       * late shows an empty or misleading figure rather than the "nothing is
       * overdue" it means. The oldest job in a stage answers the same question
       * honestly, and "Jobs past their date" reports lateness properly.
       */
      columns: [
        { field: '__rows' },
        { field: 'daysOpen', agg: 'avg' },
        { field: 'daysOpen', agg: 'max' },
      ],
      /* 'rowCount', not '__rows': outputKey() renames the synthetic row-count
         field, and validateSpec drops a sort whose key it cannot find — so the
         spec compiled fine and the report simply came back in the wrong order.
         test:report-templates catches exactly this. */
      sort: { key: 'rowCount', dir: 'desc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'jobs-overdue',
    name: 'Jobs past their date',
    description:
      'Anything promised for a day that has been and gone, worst first. Every row is a customer who was told something that did not happen.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCards',
      // A closed job cannot be late any more — closedLate reports that separately.
      filters: [{ field: 'daysOverdue', op: 'gt', value: '0' }],
      columns: [
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'title' },
        { field: 'statusName' },
        { field: 'ownerName' },
        { field: 'dueAt' },
        { field: 'daysOverdue' },
      ],
      sort: { key: 'daysOverdue', dir: 'desc' },
    }),
  },
  {
    id: 'jobs-by-customer',
    name: 'Work by customer',
    description:
      'How many jobs each customer has had and what they absorbed. The top of this list is who the business actually works for.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCards',
      groupFields: ['customerName'],
      columns: [
        { field: '__rows' },
        { field: 'totalCost', agg: 'sum' },
        { field: 'daysOpen', agg: 'avg' },
      ],
      // 'rowCount', not '__rows' — see jobs-open-by-stage above.
      sort: { key: 'rowCount', dir: 'desc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'jobs-sla-breaches',
    name: 'Promises that were missed',
    description:
      'Jobs answered or finished later than the service target said. Grouped by promise, so a target nobody ever meets shows up as the target rather than as the team.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCards',
      filters: [{ field: 'respondedLate', op: 'eq', value: 'Yes' }],
      columns: [
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'slaPolicy' },
        { field: 'respondBy' },
        { field: 'respondedAt' },
        { field: 'respondedByName' },
      ],
      sort: { key: 'respondBy', dir: 'desc' },
    }),
  },
  {
    id: 'job-work-not-decided',
    name: 'Costs nobody has decided about',
    description:
      'Lines still marked pending — work done that nobody has said is billable or absorbed. The commonest way a job leaks money, because it leaks quietly.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCardLines',
      filters: [{ field: 'billingState', op: 'eq', value: 'pending' }],
      columns: [
        { field: 'jobNumber' },
        { field: 'customerName' },
        { field: 'description' },
        { field: 'qty' },
        { field: 'lineCost' },
      ],
      sort: { key: 'lineCost', dir: 'desc' },
    }),
  },
  {
    id: 'job-write-offs',
    name: 'What was written off',
    description:
      'Work done and deliberately not charged, by customer. A customer who appears here repeatedly is being subsidised, which is a decision worth making on purpose.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCardLines',
      filters: [{ field: 'billingState', op: 'eq', value: 'written_off' }],
      groupFields: ['customerName'],
      columns: [
        { field: '__rows' },
        { field: 'lineCost', agg: 'sum' },
      ],
      sort: { key: 'lineCost_sum', dir: 'desc' },
      chartType: 'bar',
    }),
  },
  {
    id: 'job-billable-not-invoiced',
    name: 'Billable work not yet invoiced',
    description:
      'Lines the business intends to charge for that no invoice has taken. Straightforwardly money it has earned and not asked for.',
    category: 'Operations',
    permission: 'jobs.view',
    spec: spec({
      source: 'jobCardLines',
      filters: [
        { field: 'billingState', op: 'eq', value: 'quoted' },
        { field: 'invoicedQty', op: 'eq', value: '0' },
      ],
      columns: [
        { field: 'jobNumber' },
        { field: 'customerName' },
        { field: 'description' },
        { field: 'qty' },
        { field: 'intendedPriceIncl' },
      ],
      sort: { key: 'intendedPriceIncl', dir: 'desc' },
    }),
  },

  /* ── Operations ──────────────────────────────────────────────────────────── */
  {
    id: 'cashup-history',
    name: 'Cash-up history',
    description: 'Every shift closed in the period, with its drawer variance.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shifts',
      columns: [
        { field: 'openedAt' },
        { field: 'terminalCode' },
        { field: 'userName' },
        { field: 'expectedTotal' },
        { field: 'countedTotal' },
        { field: 'variance' },
      ],
      sort: { key: 'openedAt', dir: 'desc' },
    }),
  },
  {
    id: 'cash-variance-by-user',
    name: 'Drawer variance by person',
    description:
      'Ranked by how far out the drawer was, ignoring direction — a consistent R100 over is as worth asking about as R100 short.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shifts',
      groupFields: ['userName'],
      columns: [{ field: '__rows' }, { field: 'variance', agg: 'sum' }, { field: 'varianceAbs', agg: 'sum' }],
      sort: { key: 'varianceAbs_sum', dir: 'desc' },
    }),
  },
  {
    id: 'refund-history',
    name: 'Refund history',
    description:
      'Every credit note line — what was handed back, why, by whom, and what it cost in margin.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'userName' },
        /* The reason a report could not show until the codes existed: it lived
           in internal_note as free text, so it could be read one row at a time
           and never counted. */
        { field: 'returnReasonName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'qty' },
        { field: 'lineTotalIncl' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'docType', op: 'eq', value: 'credit_sale' },
      ],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    /* The ID keeps the old spelling on purpose.
     *
     * It is stored in report_favorites.report_id and in report_schedules, so
     * renaming it would orphan every favourite and silently stop a scheduled
     * email — for a change of wording. Ids are data; names are display. The
     * name and description below say "cancelled", which is the only word the
     * database has had since 022 merged the two states. */
    id: 'void-history',
    name: 'Cancellation history',
    description:
      'Documents that were cancelled, with the reason given. A run of the same reason on one till is the pattern to ask about.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'sales',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'userName' },
        { field: 'terminalCode' },
        { field: 'cancelReasonName' },
        /* The free text as well as the code. The code is what groups; this is
           where the detail lives on the reasons that allow a note, and it is
           the only column that reads at all on a cancellation raised before
           102. Its FIELD KEY is still voidReason for the same reason this
           report's id is — it is stored inside saved reports and schedules. */
        { field: 'voidReason' },
        { field: 'totalIncl' },
      ],
      /* 'cancelled' is the only value there is: 022 merged 'void' into it —
         "they always meant the same thing, and only 'void' was ever written". */
      filters: [{ field: 'status', op: 'eq', value: 'cancelled' }],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'discount-history',
    name: 'Discount history',
    description: 'Every discounted line, not a per-person total — the detail behind an outlier.',
    category: 'Operations',
    permission: 'reports.view',
    spec: spec({
      source: 'saleLines',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'userName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'lineDepartment' },
        { field: 'qty' },
        { field: 'discountPct' },
        { field: 'discountIncl' },
        { field: 'lineCostExcl' },
        { field: 'lineTotalExcl' },
        { field: 'lineTotalIncl' },
      ],
      filters: [
        { field: 'status', op: 'eq', value: 'finalised' },
        { field: 'discountIncl', op: 'gt', value: '0' },
      ],
      sort: { key: 'discountIncl', dir: 'desc' },
    }),
  },
  {
    id: 'clerk-shifts',
    name: 'Clerk time shifts',
    description: 'When each person opened and closed a till, and how long the shift ran.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shifts',
      columns: [
        { field: 'openedAt' },
        { field: 'closedAt' },
        { field: 'userName' },
        { field: 'terminalCode' },
        { field: 'closedByName' },
        { field: 'shiftHours' },
      ],
      sort: { key: 'openedAt', dir: 'desc' },
    }),
  },
  {
    id: 'activity-log',
    name: 'Activity log',
    description: 'Who changed what, and when.',
    category: 'Operations',
    permission: 'setup.view',
    spec: spec({
      source: 'activity',
      columns: [
        { field: 'createdAt' },
        { field: 'userName' },
        { field: 'action' },
        { field: 'entityType' },
        { field: 'entityLabel' },
        { field: 'detail' },
        /* The before-and-after values. This is the column that makes the log
           answer "who changed this price" — the one question v2 had a whole
           report for and this system could not answer at all. */
        { field: 'changes' },
      ],
      sort: { key: 'createdAt', dir: 'desc' },
    }),
  },

  /* ── Reports over the sources added alongside them ─────────────────────
   *
   * Each of these was a report v2 had and this system could not express, not
   * for want of data but for want of a source over the table holding it.
   */
  {
    id: 'cashup-by-tender',
    name: 'Cash-up by tender',
    description:
      'What each tender was expected to hold and what was counted. One tender short on one till is the pattern; every tender short is a counting habit.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shiftCounts',
      columns: [
        { field: 'openedAt' },
        { field: 'terminalCode' },
        { field: 'userName' },
        { field: 'tenderName' },
        { field: 'expected' },
        { field: 'counted' },
        { field: 'variance' },
      ],
      sort: { key: 'openedAt', dir: 'desc' },
    }),
  },
  {
    id: 'variance-by-tender',
    name: 'Variance by tender',
    description:
      'Where the drawer goes wrong, totalled by tender. Cash drifts; card should not.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shiftCounts',
      groupFields: ['tenderName'],
      columns: [
        { field: '__rows' },
        { field: 'expected', agg: 'sum' },
        { field: 'counted', agg: 'sum' },
        { field: 'variance', agg: 'sum' },
      ],
      sort: { key: 'variance_sum', dir: 'asc' },
    }),
  },
  {
    id: 'drawer-movements',
    name: 'Payouts and drops',
    description:
      'Money in and out of the drawer that was not a sale, with the reason given. v2 split this into three reports; the Kind column is the split.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'shiftMovements',
      columns: [
        { field: 'movedAt' },
        { field: 'terminalCode' },
        { field: 'userName' },
        { field: 'movementType' },
        { field: 'amount' },
        { field: 'reason' },
      ],
      sort: { key: 'movedAt', dir: 'desc' },
    }),
  },
  {
    id: 'tips-by-person',
    name: 'Tips by person',
    description: 'What each person was tipped, and how it reached them.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'tips',
      groupFields: ['userName'],
      columns: [
        { field: '__rows' },
        { field: 'amount', agg: 'sum' },
        { field: 'amount', agg: 'avg' },
      ],
      sort: { key: 'amount_sum', dir: 'desc' },
    }),
  },
  {
    id: 'tip-history',
    name: 'Tip history',
    description:
      'Every tip, with how it arrived and whether it was ever reassigned — the detail behind a disputed total.',
    category: 'Operations',
    permission: 'sales.cashup',
    spec: spec({
      source: 'tips',
      columns: [
        { field: 'takenAt' },
        { field: 'userName' },
        { field: 'documentNumber' },
        { field: 'source' },
        { field: 'tenderName' },
        { field: 'amount' },
        { field: 'reassignedByName' },
        { field: 'reassignReason' },
      ],
      sort: { key: 'takenAt', dir: 'desc' },
    }),
  },
  {
    id: 'stock-take-history',
    name: 'Stock take history',
    description:
      'Every counted line — what the book said, what was counted, and what the difference was worth.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'stockTakeLines',
      // A count sheet is worked through line by line; a truncated one is a
      // stocktake missing pages.
      limit: MAX_ROWS,
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'postedQtyBefore' },
        { field: 'countedQty' },
        { field: 'varianceQty' },
        { field: 'varianceValue' },
        { field: 'countedBy' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'count-accuracy',
    name: 'Count accuracy by person',
    description:
      'Who counts accurately. Lines counted against lines that came out wrong — a training figure, not a disciplinary one.',
    category: 'Operations',
    permission: 'stock.view',
    spec: spec({
      source: 'stockTakeLines',
      groupFields: ['countedBy'],
      columns: [
        { field: '__rows' },
        { field: 'varianceQty', agg: 'sum' },
        { field: 'varianceValue', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'varianceValue_sum', dir: 'asc' },
    }),
  },
  {
    id: 'adjustment-history',
    name: 'Adjustment history',
    description:
      'Every write-off and correction, with the reason it was given and what it cost.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'adjustmentLines',
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'reasonName' },
        { field: 'qtyBefore' },
        { field: 'qtyChange' },
        { field: 'qtyAfter' },
        { field: 'valueExcl' },
        { field: 'userName' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'documentDate', dir: 'desc' },
    }),
  },
  {
    id: 'shrinkage-by-reason',
    name: 'Shrinkage by reason',
    description:
      'What stock is being lost to, and what each cause costs. One reason far ahead of the rest is either a process problem or a person one.',
    category: 'Stock',
    permission: 'stock.view',
    spec: spec({
      source: 'adjustmentLines',
      groupFields: ['reasonName'],
      columns: [
        { field: '__rows' },
        { field: 'qtyChange', agg: 'sum' },
        { field: 'valueExcl', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'posted' }],
      sort: { key: 'valueExcl_sum', dir: 'asc' },
      chartType: 'pie',
    }),
  },
  {
    id: 'supplier-price-list',
    name: 'Supplier price list',
    description:
      'What each supplier charges for what — including products never yet ordered, which a purchase history cannot show.',
    category: 'Suppliers',
    permission: 'purchasing.view',
    spec: spec({
      source: 'productSuppliers',
      limit: MAX_ROWS,
      columns: [
        { field: 'supplierName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'supplierCode' },
        { field: 'packSize' },
        { field: 'supplierCost' },
        { field: 'currentSoh' },
        { field: 'sellingPriceIncl' },
        { field: 'marginPct' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      sort: { key: 'supplierName', dir: 'asc' },
    }),
  },
  {
    id: 'supplier-ledger',
    name: 'Supplier ledger',
    description:
      'Every invoice, payment and credit on a supplier account. The creditor twin of the customer ledger.',
    category: 'Suppliers',
    permission: 'suppliers.view',
    spec: spec({
      source: 'supplierTransactions',
      columns: [
        { field: 'docDate' },
        { field: 'supplierName' },
        { field: 'docNumber' },
        { field: 'docType' },
        { field: 'reference' },
        { field: 'amountSigned' },
        { field: 'amountOutstanding' },
      ],
      sort: { key: 'docDate', dir: 'desc' },
    }),
  },
  {
    id: 'supplier-ageing',
    name: 'What we owe, by age',
    description:
      'Unsettled supplier documents oldest first — what a payment run is built from.',
    category: 'Suppliers',
    permission: 'suppliers.view',
    spec: spec({
      source: 'supplierTransactions',
      columns: [
        { field: 'supplierName' },
        { field: 'docNumber' },
        { field: 'docDate' },
        { field: 'dueDate' },
        { field: 'daysOverdue' },
        { field: 'amountOutstanding' },
      ],
      /* Settled documents are history; this report is a list of what to pay.
         The ageing is on the total, so it filters after summarising. */
      totalFilters: [{ key: 'amountOutstanding', op: 'gt', value: '0' }],
      sort: { key: 'daysOverdue', dir: 'desc' },
    }),
  },
  {
    id: 'supplier-age-analysis-bucketed',
    name: 'Creditors ageing, bucketed',
    description:
      'One row per supplier with Current/30/60/90/120+ columns — what is owed and how late, aged from today.',
    category: 'Suppliers',
    permission: 'suppliers.view',
    spec: spec({
      source: 'supplierTransactions',
      period: { key: 'thisYear' },
      groupFields: ['supplierCode', 'supplierName'],
      columns: [
        { field: 'agedCurrent', agg: 'sum' },
        { field: 'aged30', agg: 'sum' },
        { field: 'aged60', agg: 'sum' },
        { field: 'aged90', agg: 'sum' },
        { field: 'aged120', agg: 'sum' },
        { field: 'amountOutstanding', agg: 'sum' },
      ],
      filters: [{ field: 'amountOutstanding', op: 'gt', value: '0' }],
      sort: { key: 'amountOutstanding_sum', dir: 'desc' },
    }),
  },
  {
    id: 'loyalty-activity',
    name: 'Loyalty activity',
    description:
      'Points earned and redeemed, and what they were earned against — what the programme costs and who uses it.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'loyaltyLedger',
      columns: [
        { field: 'happenedAt' },
        { field: 'customerName' },
        { field: 'entryType' },
        { field: 'documentNumber' },
        { field: 'tierName' },
        { field: 'basisAmount' },
        { field: 'points' },
      ],
      sort: { key: 'happenedAt', dir: 'desc' },
    }),
  },
  {
    id: 'loyalty-liability',
    name: 'Loyalty liability',
    description:
      'What the programme owes: points on the books and money in wallets. The wallet figure is a real debt; points are worth what redemption makes them.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'loyaltyMembers',
      groupFields: ['tierName'],
      columns: [
        { field: '__rows' },
        { field: 'pointsBalance', agg: 'sum' },
        { field: 'walletBalance', agg: 'sum' },
      ],
      sort: { key: 'walletBalance_sum', dir: 'desc' },
    }),
  },
  {
    id: 'loyalty-members',
    name: 'Loyalty members',
    description: 'Who is on the programme, in which tier, and when they were last seen.',
    category: 'Customers',
    permission: 'customers.view',
    spec: spec({
      source: 'loyaltyMembers',
      limit: MAX_ROWS,
      columns: [
        { field: 'customerCode' },
        { field: 'customerName' },
        { field: 'phone' },
        { field: 'tierName' },
        { field: 'pointsBalance' },
        { field: 'walletBalance' },
        { field: 'lastActivityAt' },
        { field: 'daysSinceActivity' },
      ],
      sort: { key: 'daysSinceActivity', dir: 'desc' },
    }),
  },
]

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]))

export function getTemplate(id: string): ReportTemplate | undefined {
  return BY_ID.get(id)
}

/** A template as a runnable spec, with its name filled in. */
export function templateSpec(t: ReportTemplate): CustomReportSpec {
  return { ...t.spec, name: t.name }
}

/** The templates a capability set may see. */
export function templatesFor(can: (c: Capability) => boolean): ReportTemplate[] {
  return TEMPLATES.filter((t) => can(t.permission))
}
