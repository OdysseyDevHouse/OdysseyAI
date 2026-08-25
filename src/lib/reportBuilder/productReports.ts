import type { Capability } from '../site/permissions'
import { MAX_ROWS, type CustomReportSpec } from './spec'

/**
 * The reports offered on a product's own Reporting tab.
 *
 * ── WHY SPECS AND NOT QUERIES ─────────────────────────────────────────────
 *
 * Every one of these is a builder spec run by the ordinary engine, exactly as
 * the built-in catalogue is. That is not a shortcut — it is the same decision
 * templates.ts documents: one engine means a fix to totalling, permissions or
 * VAT lands everywhere at once, and any of these can be opened in the builder
 * and adjusted rather than being a black box that only this screen can render.
 *
 * The only thing that makes them "product reports" is a pinned filter. Each
 * source already carries the product's code on the line — denormalised there so
 * a report need not join products, which is also why a code and not an id is
 * what these filter on.
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────
 *
 * "Product Undos" was asked for and is deliberately absent. `pos_void_events`
 * records void_type ENUM('item','line','sale') and nothing else that resembles
 * an undo, so shipping it would mean either a second Voids report wearing a
 * different name or an empty table with no explanation. Both are worse than
 * asking what the old system meant by the word.
 */

export type ProductReport = {
  /** Stable id — appears in the tab's URL state. Never reuse one. */
  id: string
  name: string
  description: string
  /** Capability the underlying source demands. The engine re-checks it. */
  permission: Capability
  /**
   * The spec, given the product being viewed.
   *
   * A function rather than a literal because the pin is part of the spec: the
   * filter naming this product IS the report, so there is nothing to define
   * until the product is known.
   */
  spec: (product: { id: number; code: string }) => CustomReportSpec
}

/** Every product report reads a wide window: a product's history is the point. */
const PERIOD = { key: 'last90' } as const

/** The pinned filter — one product, by the code carried on the line. */
function pin(code: string) {
  return { field: 'productCode', op: 'eq' as const, value: code }
}

function base(
  name: string,
  source: string,
  rest: Partial<CustomReportSpec>,
): CustomReportSpec {
  return {
    version: 1,
    name,
    source,
    period: PERIOD,
    columns: [],
    filters: [],
    groupFields: [],
    totalFilters: [],
    /* Far below MAX_ROWS: this renders in a dialog over the product, and a
       reader scrolling past a few hundred lines wanted the full report screen,
       not this. */
    limit: Math.min(500, MAX_ROWS),
    ...rest,
  }
}

export const PRODUCT_REPORTS: ProductReport[] = [
  {
    id: 'product-performance',
    name: 'Performance',
    description: 'What it sold, and what it made.',
    permission: 'sales.view',
    spec: ({ code }) =>
      base('Product performance', 'saleLines', {
        groupFields: ['reference'],
        columns: [
          { field: 'qty', agg: 'sum' },
          { field: 'lineTotalExcl', agg: 'sum' },
          { field: 'lineVat', agg: 'sum' },
          { field: 'lineTotalIncl', agg: 'sum' },
          { field: 'discountIncl', agg: 'sum' },
        ],
        /* A draft is not a sale. Without this the figures count baskets that
           were never tendered — the same filter every sales built-in carries. */
        filters: [pin(code), { field: 'status', op: 'eq', value: 'finalised' }],
        sort: { key: 'lineTotalIncl_sum', dir: 'desc' },
      }),
  },
  {
    id: 'product-movement',
    name: 'Movement',
    description: 'Everything that moved this product, in or out.',
    permission: 'stock.view',
    spec: ({ code }) =>
      base('Product movement', 'stockMovements', {
        columns: [
          { field: 'movedAt' },
          { field: 'movementType' },
          { field: 'qtyChange' },
          { field: 'qtyAfter' },
          { field: 'movementValue' },
          { field: 'userName' },
          { field: 'note' },
        ],
        filters: [pin(code)],
        sort: { key: 'movedAt', dir: 'desc' },
      }),
  },
  {
    id: 'product-adjustments',
    name: 'Adjustments',
    description: 'Every stock adjustment, with its reason.',
    permission: 'stock.view',
    spec: ({ code }) =>
      base('Product adjustments', 'adjustmentLines', {
        columns: [
          { field: 'documentDate' },
          { field: 'documentNumber' },
          { field: 'reasonName' },
          { field: 'qtyBefore' },
          { field: 'qtyChange' },
          { field: 'qtyAfter' },
          { field: 'valueExcl' },
          { field: 'locationName' },
          { field: 'userName' },
        ],
        filters: [pin(code)],
        sort: { key: 'documentDate', dir: 'desc' },
      }),
  },
  {
    id: 'product-voids',
    name: 'Voids',
    description: 'Rung up at the till, then taken off.',
    permission: 'sales.cashup',
    spec: ({ code }) =>
      base('Product voids', 'posVoids', {
        columns: [
          { field: 'voidedAt' },
          { field: 'voidType' },
          { field: 'reasonName' },
          { field: 'qty' },
          { field: 'value' },
          { field: 'userName' },
          { field: 'terminalCode' },
          { field: 'note' },
        ],
        filters: [pin(code)],
        sort: { key: 'voidedAt', dir: 'desc' },
      }),
  },
  {
    id: 'product-refunds',
    name: 'Refunds',
    description: 'Sold and then given back.',
    permission: 'sales.view',
    spec: ({ code }) =>
      base('Product refunds', 'saleLines', {
        columns: [
          { field: 'reference' },
          { field: 'qty' },
          { field: 'unitPriceIncl' },
          { field: 'lineTotalIncl' },
        ],
        /* A refund is a NEGATIVE line on a finalised document — the same shape
           the posting engine records it as, which is why this is a qty filter
           rather than a document type. */
        filters: [
          pin(code),
          { field: 'status', op: 'eq', value: 'finalised' },
          { field: 'qty', op: 'lt', value: '0' },
        ],
        sort: { key: 'lineTotalIncl', dir: 'asc' },
      }),
  },
  {
    id: 'product-discount',
    name: 'Discounts',
    description: 'Where it went out below list.',
    permission: 'sales.view',
    spec: ({ code }) =>
      base('Product discounts', 'saleLines', {
        columns: [
          { field: 'reference' },
          { field: 'qty' },
          { field: 'unitPriceIncl' },
          { field: 'discountIncl' },
          { field: 'discountPct' },
          { field: 'lineTotalIncl' },
        ],
        filters: [
          pin(code),
          { field: 'status', op: 'eq', value: 'finalised' },
          /* Only the discounted lines. Without this it is the sales list again
             with two mostly-zero columns on the end. */
          { field: 'discountIncl', op: 'gt', value: '0' },
        ],
        sort: { key: 'discountIncl', dir: 'desc' },
      }),
  },
  {
    id: 'product-activity',
    name: 'Activity log',
    description: 'Who changed this product, and what they changed.',
    permission: 'setup.view',
    spec: ({ id }) =>
      base('Product activity log', 'activity', {
        columns: [
          { field: 'createdAt' },
          { field: 'action' },
          { field: 'userName' },
          { field: 'changes' },
          { field: 'detail' },
        ],
        /*
         * The one report NOT pinned by product code: activity_log keys on
         * (entity, entity_id), so this pins on the pair — which is exactly what
         * ix_activity_entity indexes. entityId was added to the catalog for
         * this; without it the log could only be filtered to "every product".
         */
        filters: [
          { field: 'entityType', op: 'eq', value: 'product' },
          { field: 'entityId', op: 'eq', value: String(id) },
        ],
        sort: { key: 'createdAt', dir: 'desc' },
      }),
  },
  {
    id: 'product-stock-takes',
    name: 'Stock takes',
    description: 'Every count, and what the variance was.',
    permission: 'stock.view',
    spec: ({ code }) =>
      base('Product stock takes', 'stockTakeLines', {
        columns: [
          { field: 'documentDate' },
          { field: 'documentNumber' },
          { field: 'snapshotQty' },
          { field: 'countedQty' },
          { field: 'varianceQty' },
          { field: 'varianceValue' },
          { field: 'locationName' },
          { field: 'countedBy' },
        ],
        filters: [pin(code)],
        sort: { key: 'documentDate', dir: 'desc' },
      }),
  },
  {
    id: 'product-invoices',
    name: 'Invoices',
    description: 'Every document this product appeared on.',
    permission: 'sales.view',
    spec: ({ code }) =>
      base('Product invoice list', 'saleLines', {
        columns: [
          { field: 'reference' },
          { field: 'qty' },
          { field: 'unitPriceIncl' },
          { field: 'lineTotalExcl' },
          { field: 'lineTotalIncl' },
        ],
        filters: [pin(code), { field: 'status', op: 'eq', value: 'finalised' }],
        sort: { key: 'reference', dir: 'desc' },
      }),
  },
  {
    id: 'product-grv',
    name: 'GRV list',
    description: 'Goods received, and what they cost.',
    permission: 'purchasing.view',
    spec: ({ code }) =>
      base('Product GRV list', 'purchaseLines', {
        columns: [
          { field: 'documentDate' },
          { field: 'documentNumber' },
          { field: 'supplierName' },
          { field: 'qtyOrdered' },
          { field: 'qtyReceived' },
          { field: 'unitCostExcl' },
          { field: 'lineTotalExcl' },
        ],
        filters: [pin(code)],
        sort: { key: 'documentDate', dir: 'desc' },
      }),
  },
]

/** The reports this user may actually run. The engine re-checks each one. */
export function productReportsFor(can: (c: Capability) => boolean): ProductReport[] {
  return PRODUCT_REPORTS.filter((r) => can(r.permission))
}
