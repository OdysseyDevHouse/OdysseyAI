import type { CustomReportSpec } from './spec'
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
