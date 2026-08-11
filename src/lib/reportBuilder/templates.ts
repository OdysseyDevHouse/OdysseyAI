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
  category: 'Sales' | 'Stock' | 'Customers' | 'Suppliers' | 'Money' | 'Operations'
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
      groupFields: ['productCode', 'description'],
      columns: [
        { field: 'qty', agg: 'sum' },
        { field: 'lineTotalIncl', agg: 'sum' },
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
      columns: [
        { field: 'qty', agg: 'sum' },
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
      columns: [
        { field: '__rows' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'totalIncl', agg: 'avg' },
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
      groupFields: ['vatRatePct'],
      columns: [
        { field: 'lineTotalExcl', agg: 'sum' },
        { field: 'lineVat', agg: 'sum' },
        { field: 'lineTotalIncl', agg: 'sum' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
      sort: { key: 'vatRatePct', dir: 'asc' },
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
      columns: [
        { field: 'documentNumber' },
        { field: 'documentDate' },
        { field: 'docType' },
        { field: 'customerName' },
        { field: 'userName' },
        { field: 'discountTotal' },
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
      columns: [
        { field: 'documentDate' },
        { field: 'documentNumber' },
        { field: 'customerName' },
        { field: 'productCode' },
        { field: 'description' },
        { field: 'qty' },
        { field: 'unitPriceIncl' },
        { field: 'discountIncl' },
        { field: 'lineTotalIncl' },
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
    id: 'discounts-and-voids',
    name: 'Discounts and voids by cashier',
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
    id: 'voids-by-reason',
    name: 'Voids by reason',
    description:
      'What voiding is costing, and why. One reason far ahead of the rest is either a training problem or a process one — the split says which.',
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
      columns: [
        { field: 'code' },
        { field: 'description' },
        { field: 'department' },
        { field: 'stockOnHand' },
        { field: 'minStock' },
        { field: 'lastSoldDate' },
      ],
      filters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
      sort: { key: 'description', dir: 'asc' },
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
      columns: [
        { field: 'code' },
        { field: 'barcode' },
        { field: 'description' },
        { field: 'department' },
        { field: 'sellingPriceIncl' },
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
      groupFields: ['productCode', 'productDescription'],
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
        { field: 'daysSinceSold' },
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
      groupFields: ['userName', 'movementType'],
      columns: [{ field: '__rows' }, { field: 'qtyChange', agg: 'sum' }, { field: 'movementValue', agg: 'sum' }],
      filters: [{ field: 'movementType', op: 'eq', value: 'adjustment' }],
      sort: { key: 'movementValue_sum', dir: 'asc' },
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
    id: 'void-history',
    name: 'Void history',
    description:
      'Documents that were voided, with the reason given. A run of the same reason on one till is the pattern to ask about.',
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
           the only column that reads at all on a void raised before 102. */
        { field: 'voidReason' },
        { field: 'totalIncl' },
      ],
      /* 'cancelled', not 'void': 022 renamed the status value and this filter was
         never updated, so this report has been returning nothing since. */
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
        { field: 'discountPct' },
        { field: 'discountIncl' },
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
      ],
      sort: { key: 'createdAt', dir: 'desc' },
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
