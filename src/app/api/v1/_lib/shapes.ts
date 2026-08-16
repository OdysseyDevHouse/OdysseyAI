import 'server-only'
import type { Product } from '@/lib/site/products'
import type { Customer } from '@/lib/site/customers'
import type { SalesDocument } from '@/lib/site/salesDocuments'
import type { Supplier } from '@/lib/site/suppliers'
import type { PurchaseDocument } from '@/lib/site/purchaseDocuments'
import type { JournalBatch } from '@/lib/site/journals'
import type { GiftCard } from '@/lib/site/giftCards'

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
    // The sync cursor: poll ?updatedSince= with the largest value seen so far.
    updatedAt: (p.lastEditDate ?? p.createdAt)?.toISOString() ?? null,
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
    // Zero means no cap, unlike creditLimit where zero means no credit.
    dailyLimit: c.dailyLimit,
    monthlyLimit: c.monthlyLimit,
    autoEmailInvoices: c.autoEmailInvoices,
    balance: c.balance,
    // The sync cursor: poll ?updatedSince= with the largest value seen so far.
    updatedAt: c.updatedAt.toISOString(),
  }
}

export function publicSupplier(s: Supplier) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    status: s.status,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    postalCode: s.postalCode,
    vatNumber: s.vatNumber,
    accountNumber: s.accountNumber,
    paymentTermsDays: s.paymentTermsDays,
    settlementDiscountDays: s.settlementDiscountDays,
    settlementDiscountPct: s.settlementDiscountPct,
    leadTimeDays: s.leadTimeDays,
    category: s.category,
    balance: s.balance,
    // The sync cursor: poll ?updatedSince= with the largest value seen so far.
    updatedAt: s.updatedAt.toISOString(),
    // Bank details deliberately absent: a leaked read-only key must never be
    // the seed of a payment-redirection fraud.
  }
}

/**
 * Purchase documents carry cost prices because that is what they ARE — the
 * purchases:read scope grants exactly this and the mint screen says so.
 */
export function publicPurchaseDocument(d: PurchaseDocument, withLines: boolean) {
  return {
    id: d.id,
    docType: d.docType,
    status: d.status,
    documentNumber: d.documentNumber,
    documentDate: d.documentDate,
    dueDate: d.dueDate,
    supplierId: d.supplierId,
    supplierCode: d.supplierCode,
    supplierName: d.supplierName,
    supplierInvoiceNo: d.supplierInvoiceNo,
    subtotalExcl: d.subtotalExcl,
    vatTotal: d.vatTotal,
    totalIncl: d.totalIncl,
    chargesExcl: d.chargesExcl,
    discountExcl: d.discountExcl,
    reference: d.reference,
    fulfilmentStatus: d.fulfilmentStatus,
    expectedDate: d.expectedDate,
    supplierOrderNo: d.supplierOrderNo,
    finalisedAt: d.finalisedAt ? d.finalisedAt.toISOString() : null,
    ...(withLines
      ? {
          lines: d.lines.map((l) => ({
            id: l.id,
            lineNumber: l.lineNumber,
            productId: l.productId,
            productCode: l.productCode,
            supplierCode: l.supplierCode,
            description: l.description,
            qtyOrdered: l.qtyOrdered,
            qtyReceived: l.qtyReceived,
            qtyBonus: l.qtyBonus,
            qtyArrived: l.qtyArrived,
            qtyOutstanding: l.qtyOutstanding,
            unitCostExcl: l.unitCostExcl,
            discountPct: l.discountPct,
            discountAmount: l.discountAmount,
            vatRatePct: l.vatRatePct,
            lineTotalExcl: l.lineTotalExcl,
            lineVat: l.lineVat,
            lineTotalIncl: l.lineTotalIncl,
            locationId: l.locationId,
          })),
        }
      : {}),
  }
}

/** The accounting export: signed amounts split into the debit/credit pair. */
export function publicJournalBatch(b: JournalBatch, withLines: boolean) {
  return {
    id: b.id,
    journalNumber: b.journalNumber,
    journalDate: b.journalDate,
    status: b.status,
    source: b.source,
    sourceDocId: b.sourceDocId,
    description: b.description,
    reference: b.reference,
    totalDebit: b.totalDebit,
    totalCredit: b.totalCredit,
    reversesId: b.reversesId,
    postedAt: b.postedAt ? b.postedAt.toISOString() : null,
    ...(withLines
      ? {
          lines: b.lines.map((l) => ({
            lineNumber: l.lineNumber,
            accountId: l.accountId,
            accountCode: l.accountCode,
            accountName: l.accountName,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            departmentId: l.departmentId,
            customerId: l.customerId,
            supplierId: l.supplierId,
          })),
        }
      : {}),
  }
}

/** Just enough for a partner site to answer "what is on this card". */
export function publicGiftCard(c: GiftCard) {
  return {
    code: c.code,
    status: c.status,
    initialValue: c.initialValue,
    balance: c.balance,
    expiresOn: c.expiresOn,
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
