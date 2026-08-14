import 'server-only'
import type { Product } from '@/lib/site/products'
import type { Customer } from '@/lib/site/customers'
import type { SalesDocument } from '@/lib/site/salesDocuments'

/**
 * The public JSON shapes — HAND-PICKED fields, never a spread.
 *
 * An API key is standing access with no person behind it, so the shapes give
 * a key what its scopes say and nothing more: no costs, no margins, no
 * internal notes. Adding a field is a deliberate edit here, not a side effect
 * of the internal type growing one.
 */

export function publicProduct(p: Product, withStock: boolean) {
  return {
    id: p.id,
    code: p.code,
    barcode: p.barcode,
    description: p.description,
    extraDescription: p.extraDescription,
    productType: p.productType,
    departmentId: p.departmentId,
    brandId: p.brandId,
    sellingVatPercent: p.sellingVatPercent,
    isArchived: p.isArchived,
    // Price WITHOUT the derived margin block: gp/markup/profit reveal cost.
    prices: p.prices.map((price) => ({
      priceStructureId: price.priceStructureId,
      structureName: price.structureName,
      isDefault: price.isDefault,
      sellIncl: price.sellIncl,
      sellExcl: price.sellExcl,
    })),
    ...(withStock ? { stockOnHand: p.stockOnHand, belowMinimum: p.belowMinimum } : {}),
  }
}

export function publicCustomer(c: Customer) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    status: c.status,
    accountType: c.accountType,
    contactName: c.contactName,
    email: c.email,
    phone: c.phone,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    postalCode: c.postalCode,
    vatNumber: c.vatNumber,
    groupId: c.groupId,
    groupName: c.groupName,
    category: c.category,
    paymentTermsDays: c.paymentTermsDays,
    creditLimit: c.creditLimit,
    balance: c.balance,
  }
}

export function publicSalesDocument(d: SalesDocument, withLines: boolean) {
  return {
    id: d.id,
    docType: d.docType,
    status: d.status,
    documentNumber: d.documentNumber,
    documentDate: d.documentDate,
    dueDate: d.dueDate,
    customerId: d.customerId,
    customerCode: d.customerCode,
    customerName: d.customerName,
    origin: d.origin,
    subtotalExcl: d.subtotalExcl,
    vatTotal: d.vatTotal,
    discountTotal: d.discountTotal,
    totalIncl: d.totalIncl,
    reference: d.reference,
    ...(withLines
      ? {
          lines: d.lines.map((l) => ({
            id: l.id,
            productId: l.productId,
            productCode: l.productCode,
            description: l.description,
            qty: l.qty,
            unitPriceIncl: l.unitPriceIncl,
            discountPct: l.discountPct,
            vatRatePct: l.vatRatePct,
            lineTotalIncl: l.lineTotalIncl,
          })),
        }
      : {}),
  }
}
