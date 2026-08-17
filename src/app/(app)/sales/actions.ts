'use server'

import { revalidatePath } from 'next/cache'
import {
  requireActor,
  requireSiteId,
  requireSiteUser,
  actorFor,
  actorForAny,
  actorForOrThrow,
  withTillOperator,
} from '@/lib/auth'
import { can, type Capability, type CapabilitySet } from '@/lib/site/permissions'
import { checkPricing } from '@/lib/site/priceGuard'
import { verifyOverrideToken } from '@/lib/overrideToken'
import { createCreditNote, creditableLines, type CreditNoteInput } from '@/lib/site/salesReversal'
import {
  saveDraft,
  saveForLaterDocument,
  recallDocument,
  discardDocument,
  getDocument,
  attributeTo,
  toDocType,
  type LineInput,
  type SalesDocType,
} from '@/lib/site/salesDocuments'
import { requireLicensedDevice } from '@/lib/control/requireDevice'
import { finaliseDocument, voidDocument, recordPrint } from '@/lib/site/salesPosting'
import { setOrderDetails } from '@/lib/site/salesOrders'
import { searchForTill, browseForTill, resolveScan, type TillProduct } from '@/lib/site/tillSearch'
import { listDepartments, flattenTree } from '@/lib/site/departments'
import {
  searchCustomersForTill,
  getTillCustomer,
  type TillCustomer,
} from '@/lib/site/tillCustomers'
import { headers } from 'next/headers'
import { isEmail } from '@/lib/site/customerLookups'
import { emailInvoiceDocument, issuingSiteFor } from '@/lib/site/invoiceEmail'

/**
 * Till actions.
 *
 * Everything that changes a sale goes through here, and everything returns its
 * outcome rather than redirecting: the capture screen is a client component
 * that keeps the basket in state, and a redirect mid-sale would lose it.
 */

export type SaleResult = { ok: true; documentId: number } | { ok: false; error: string }

export type FinaliseSaleResult =
  | { ok: true; documentId: number; documentNumber: string; change: number; roundingAdj: number }
  | { ok: false; error: string }

export async function searchProductsAction(
  term: string,
  priceStructureId: number | null,
): Promise<TillProduct[]> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return searchForTill(siteId, term, priceStructureId)
}

/**
 * Products for a tile grid — a department's whole subtree, or the top of the file.
 *
 * Guarded by `sales.till` like every other action here. The guard is the real
 * boundary: a server action is a public endpoint, so hiding the till screen from
 * somebody changes what is easy rather than what is possible.
 */
export async function browseProductsAction(options: {
  term?: string
  departmentId?: number | null
  priceStructureId?: number | null
  limit?: number
}): Promise<TillProduct[]> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return browseForTill(siteId, options)
}

/**
 * The department list for a product picker's filter.
 *
 * Flattened with a depth marker so a plain <option> can indent, which is the
 * only way a nested list reads correctly in a select. Guarded by `sales.till`
 * like everything else here — the action is the boundary.
 */
export async function listProductDepartmentsAction(): Promise<
  { id: number; name: string; depth: number }[]
> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  const all = await listDepartments(siteId)
  return flattenTree(all).map(({ department, depth }) => ({
    id: department.id,
    name: department.name,
    depth,
  }))
}

/** Resolves a scan, including weighed-goods barcodes. */
export async function scanAction(
  code: string,
  priceStructureId: number | null,
): Promise<TillProduct | null> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return resolveScan(siteId, code, priceStructureId)
}

export async function searchCustomersAction(term: string): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return searchCustomersForTill(siteId, term)
}

/**
 * Re-reads a customer's credit position.
 *
 * Called when a customer is attached and again before tendering: a basket can
 * sit on screen for ten minutes while someone else settles the same account,
 * and the till should not offer credit that has since been used up.
 */
export async function refreshCustomerAction(customerId: number): Promise<TillCustomer | null> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return getTillCustomer(siteId, customerId)
}

export async function saveSaleAction(
  documentId: number | null,
  input: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    /**
     * Covers and visit type, set by the hospitality till when a tab is parked.
     * They reach `saveDraft` on the `...input` spread below, with everything
     * else — see sql/site/125_sale_covers.sql for why they live on the bill.
     */
    personCount?: number | null
    visitTypeId?: number | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    /**
     * What KIND of document this basket is.
     *
     * Absent means `invoice`, which is what the till has always written and what
     * every existing caller means — a quote and an order are the same lines at an
     * earlier moment in their life, so the basket does not change shape, only this.
     * The value is validated below rather than trusted: it arrives from a client.
     */
    docType?: SalesDocType
    lines: LineInput[]
  },
  /** A supervisor's authorisation for a price/discount beyond the operator's rights. */
  overrideToken?: string,
): Promise<SaleResult> {
  const denied = await actorFor('sales.till')
  if ('ok' in denied) return denied
  /* The PIN operator, not the browser session — they are different people on a
     shared machine, and this actor's id is what commission gets paid on. */
  const ctx = await withTillOperator(denied)
  const { siteId, actor } = ctx

  // Checked here, not only where the input was greyed out: this action is a
  // public endpoint and the price arrives from the client.
  const refused = await checkPricing(
    siteId,
    await withOverride(siteId, ctx.capabilities, overrideToken, [
      'sales.discount_override',
      'sales.price_override',
    ]),
    input.priceStructureId ?? null,
    input.lines,
  )
  if (refused) return { ok: false, error: refused }

  /* Validated, not trusted: `docType` arrives from a client, and an unrecognised
     value must not reach saveDraft as a doc type nobody posts. Absent is the
     ordinary case and means an invoice. */
  const docType = input.docType ? toDocType(input.docType) : 'invoice'
  if (!docType) return { ok: false, error: 'That is not a document type this till can save.' }

  const result = await saveDraft(
    siteId,
    actor,
    { ...input, docType, lines: attributeTo(input.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, documentId: result.id }
}

/**
 * The operator's capabilities, widened by a verified supervisor token.
 *
 * The token is a manager's PIN turned into a two-minute, single-capability
 * authorisation (see overrideToken.ts). It is tried against each capability the
 * caller could need — a token carries exactly one, so at most one union
 * happens, and a token for a void cannot widen a discount. A bad, expired or
 * revoked token widens nothing and the ordinary refusal stands, which is the
 * right failure: the cashier asks the manager again.
 */
async function withOverride(
  siteId: number,
  capabilities: CapabilitySet,
  overrideToken: string | undefined,
  accepts: readonly Capability[],
): Promise<CapabilitySet> {
  if (!overrideToken) return capabilities
  for (const capability of accepts) {
    if (can(capabilities, capability)) continue
    const authorised = await verifyOverrideToken(siteId, overrideToken, capability)
    if (authorised) {
      return { isOwner: capabilities.isOwner, granted: new Set([...capabilities.granted, capability]) }
    }
  }
  return capabilities
}

/**
 * Turns the basket on screen into a sales order rather than a sale.
 *
 * Same lines, same prices, same customer — only the doc type differs, because
 * an order IS an invoice at an earlier moment in its life. It posts nothing:
 * no stock movement, no ledger entry, no number. What it does do is reserve
 * the stock, so the goods stop being available to the next person through the
 * door.
 *
 * A customer is required. An order is a promise to a specific someone, and a
 * walk-in who is not coming back cannot hold stock off the shelf.
 */
export async function saveAsOrderAction(
  documentId: number | null,
  input: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
  details?: { deliveryDate?: string | null; customerOrderNo?: string | null },
): Promise<SaleResult> {
  const denied = await actorFor('sales.edit')
  if ('ok' in denied) return denied
  /*
   * The PIN operator where there is one, not the browser session.
   *
   * This used to resolve the browser user alone, which was harmless while only
   * the back office called it — one person, their own session. The till calls it
   * now, and on a shared counter machine the browser user is whoever opened it
   * that morning. `sales_document_lines.sales_rep_user_id` is what commission
   * pays on, so without this every order raised at a shared till would pay the
   * wrong person. Falls back to the browser session off the till, which is what
   * the back office wants.
   */
  const ctx = await withTillOperator(denied)
  const { siteId, actor } = ctx

  if (!input.customerId) {
    return { ok: false, error: 'Attach a customer before saving an order — an order is a promise to someone.' }
  }
  if (input.lines.length === 0) {
    return { ok: false, error: 'Add at least one line before saving an order.' }
  }

  const result = await saveDraft(
    siteId,
    actor,
    { ...input, docType: 'sales_order', lines: attributeTo(input.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!result.ok) return { ok: false, error: result.error }

  const attached = await setOrderDetails(siteId, result.id, {
    deliveryDate: details?.deliveryDate ?? null,
    customerOrderNo: details?.customerOrderNo ?? null,
    reservesStock: true,
  })
  if (!attached.ok) return { ok: false, error: attached.error }

  revalidatePath('/sales/orders')
  return { ok: true, documentId: result.id }
}

/**
 * Sets a basket aside so the counter can serve someone else.
 *
 * Not `saveSaleAction` — that already means "persist the draft's lines", which
 * this calls first. Two different operations, two names.
 */
export async function saveForLaterAction(documentId: number): Promise<SaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await saveForLaterDocument(siteId, documentId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/invoicing')
  return { ok: true, documentId: result.id }
}

export async function recallSaleAction(documentId: number): Promise<SaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await recallDocument(siteId, documentId)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, documentId: result.id }
}

export async function discardSaleAction(
  documentId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await discardDocument(siteId, documentId)
  revalidatePath('/sales/invoicing')
  return result
}

/**
 * Saves and posts in one call.
 *
 * Deliberately one round trip: the basket is saved and finalised together so
 * there is no window where a sale exists as a draft nobody meant to keep. If
 * the post is refused, the draft is left behind for the cashier to fix rather
 * than discarded — they have a customer standing there.
 */
export async function finaliseSaleAction(
  documentId: number | null,
  sale: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    /**
     * The machine ringing this up, for the licence check below.
     *
     * Optional so every existing caller keeps compiling and trading — an absent
     * serial is a till build that predates licensing, not a refusal. See
     * `requireLicensedDevice`.
     */
    deviceSerial?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
  tenders: { tenderTypeId: number; amount: number; reference?: string | null }[],
  /** Loyalty reward codes the cashier applied. Priced and spent server-side. */
  voucherCodes: string[] = [],
  /**
   * Tips, from the tender pad.
   *
   * Defaulted so every existing caller is unchanged. `declaredTips` is what a cashier said
   * of an ambiguous cash over-tender; `serviceCharge` is the tier amount the pad showed the
   * customer, already zero if a manager waived it.
   *
   * Both are re-derived or re-checked server-side by `finaliseDocument`'s own `planTips`
   * call — this is what was CHARGED, not a claim the server trusts.
   */
  tips: { declaredTips?: Record<number, number>; serviceCharge?: number } = {},
  /** A supervisor's authorisation for a price/discount beyond the operator's rights. */
  overrideToken?: string,
  /** A discount code the till validated — the lines already carry its money. */
  discountCode: { codeId: number; code: string; amountIncl: number } | null = null,
): Promise<FinaliseSaleResult> {
  const denied = await actorFor('sales.till')
  if ('ok' in denied) return denied
  /* The PIN operator, not the browser session. This actor lands on the sale
     header, on every line's commission attribution, and — in `user` cash-up
     mode — decides whose shift the money banks into. */
  const ctx = await withTillOperator(denied)
  const { siteId, actor } = ctx

  /* IS THIS MACHINE LICENSED TO SELL?
     Checked here rather than only on the screen: this is a public endpoint, and
     the till-side gate can be skipped by anyone calling it directly. */
  const licensed = await requireLicensedDevice(siteId, sale.deviceSerial)
  if (!licensed.ok) return { ok: false, error: licensed.error }

  // The one that takes money. Same check as the draft path, repeated rather
  // than assumed: a basket can be saved by one person and finalised by another.
  const refusedPrice = await checkPricing(
    siteId,
    await withOverride(siteId, ctx.capabilities, overrideToken, [
      'sales.discount_override',
      'sales.price_override',
    ]),
    sale.priceStructureId ?? null,
    sale.lines,
  )
  if (refusedPrice) return { ok: false, error: refusedPrice }

  /* INVOICE, deliberately, and not a parameter like the draft path's.
     This is the action that takes money, and the other document types are
     precisely the ones no money is taken against: a quote is an offer and an
     order is a promise. Either becomes an invoice when it is delivered and
     paid for, and that conversion is where the doc type changes — not here. */
  const saved = await saveDraft(
    siteId,
    actor,
    { ...sale, docType: 'invoice', lines: attributeTo(sale.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!saved.ok) return { ok: false, error: saved.error }

  const posted = await finaliseDocument(siteId, actor, {
    documentId: saved.id,
    tenders,
    customerId: sale.customerId ?? null,
    voucherCodes,
    declaredTips: tips.declaredTips,
    serviceCharge: tips.serviceCharge,
    discountCode,
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  revalidatePath('/sales/invoicing')
  revalidatePath('/products')
  return posted
}

export async function voidSaleAction(
  documentId: number,
  reason: { reasonId: number; note?: string | null },
  /** A supervisor's authorisation, for a cashier without sales.void. */
  overrideToken?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Voiding reverses stock and a debtor's balance, so the check that counts is
  // here — hiding the button only changes what is EASY. The right belongs to
  // whoever is ACTING: the PIN operator when a till session exists (widened by
  // a verified supervisor token), else the browser session. The entry gate is
  // any-of so a till cashier reaches the operator check at all.
  const denied = await actorForAny('sales.void', 'sales.till')
  if ('ok' in denied) return denied
  /* Identity as well as rights: `voided_by` on the document must name the person
     who actually voided it, which on a shared machine is the PIN operator. */
  const ctx = await withTillOperator(denied)
  const { siteId, actor } = ctx

  const effective = await withOverride(siteId, ctx.capabilities, overrideToken, ['sales.void'])
  if (!can(effective, 'sales.void')) {
    return { ok: false, error: 'Voiding a sale needs a supervisor. Ask a manager to approve it.' }
  }

  const result = await voidDocument(siteId, actor, documentId, reason)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/invoicing')
  revalidatePath(`/sales/${documentId}`)
  revalidatePath('/products')
  return { ok: true }
}

export async function recordPrintAction(documentId: number): Promise<void> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  await recordPrint(siteId, documentId)
}

export type CreditNoteActionResult =
  | { ok: true; documentId: number; documentNumber: string; total: number }
  | { ok: false; error: string }

/**
 * Raises a credit note.
 *
 * Permission is re-checked here rather than trusted from the screen that
 * offered the button — a server action is a public endpoint, and the only place
 * a capability check counts is the one the client cannot skip.
 */
export async function createCreditNoteAction(
  input: CreditNoteInput,
): Promise<CreditNoteActionResult> {
  const { site, user, capabilities } = await requireSiteUser()

  if (!can(capabilities, 'sales.credit_note')) {
    return { ok: false, error: 'You do not have permission to credit a sale.' }
  }

  const result = await createCreditNote(site.id, { userId: user.id, userName: user.name }, input)
  if (!result.ok) return result

  revalidatePath('/sales/invoicing')
  revalidatePath(`/sales/${input.invoiceId ?? ''}`)
  revalidatePath('/products')
  if (input.customerId) revalidatePath(`/customers/${input.customerId}`)

  return result
}

/**
 * Credits a whole sale in one step.
 *
 * The common case by a distance: the customer brings back everything they
 * bought. Making that a per-line form with a quantity box on every row is
 * ceremony — the answer is always "all of it".
 *
 * The lines are read on the SERVER from what is still creditable, never sent
 * up by the browser. A client that miscounted, or a second credit raised in
 * another tab between opening this screen and pressing the button, would
 * otherwise credit more than was sold. The partial screen still exists for
 * when only some of it comes back.
 */
export async function creditWholeSaleAction(
  invoiceId: number,
  reason: { reasonId: number; note?: string | null },
  refunds?: { tenderTypeId: number; amount: number; reference?: string | null }[],
): Promise<CreditNoteActionResult> {
  const { site, user, capabilities } = await requireSiteUser()

  if (!can(capabilities, 'sales.credit_note')) {
    return { ok: false, error: 'You do not have permission to credit a sale.' }
  }
  // The reason itself is validated by createCreditNote, which resolves the id
  // against the live list rather than trusting what the client sent.

  const lines = await creditableLines(site.id, invoiceId)
  if (!lines) return { ok: false, error: 'That sale no longer exists.' }

  const outstanding = lines.filter((line) => line.creditable > 0)
  if (outstanding.length === 0) {
    return { ok: false, error: 'Every line on this sale has already been credited.' }
  }

  const result = await createCreditNote(site.id, { userId: user.id, userName: user.name }, {
    invoiceId,
    reasonId: reason.reasonId,
    note: reason.note,
    lines: outstanding.map((line) => ({
      sourceLineId: line.id,
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType,
      departmentId: line.departmentId,
      qty: line.creditable,
      unitPriceIncl: line.unitPriceIncl,
      vatRatePct: line.vatRatePct,
      // From the original line. Re-reading the product would credit at today's
      // cost and manufacture margin that was never earned.
      unitCostExcl: line.unitCostExcl,
    })),
    refunds,
  })
  if (!result.ok) return result

  revalidatePath('/sales/invoicing')
  revalidatePath(`/sales/${invoiceId}`)
  revalidatePath('/products')

  return result
}

/** Reloads a saved sale's lines into the till. */
export async function loadSaleAction(documentId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  return getDocument(siteId, documentId)
}

/**
 * Emails a finalised invoice or credit note to an address the user confirmed.
 *
 * Resends are allowed on purpose — the audit trail records every one, and the
 * dialog shows the last, so a second copy is an informed act. The document is
 * never touched: same number, same ledger entry, PDF re-rendered from stored
 * figures.
 */
export async function emailInvoiceAction(
  documentId: number,
  input: { to: string; message?: string },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  /* Any-of: the back office emails under sales.edit, and the TILL emails the
     receipt of the sale it just rang under sales.till — same engine, same
     audit trail, and a settled sale's email carries no pay link (invoiceEmail
     reads what is actually outstanding). */
  const ctx = await actorForAny('sales.edit', 'sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  if (!isEmail(input.to.trim())) {
    return { ok: false, error: 'That does not look like an email address.' }
  }

  const site = await issuingSiteFor(siteId)
  if (!site) return { ok: false, error: 'This site’s details could not be read.' }

  const result = await emailInvoiceDocument(siteId, site, actor, documentId, {
    to: input.to,
    message: input.message ?? null,
    origin: await emailOrigin(),
  })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/sales/${documentId}`)
  return { ok: true, message: `Emailed to ${result.to}.` }
}

/** The origin an emailed pay-link should point at — same rule as contracts. */
async function emailOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
