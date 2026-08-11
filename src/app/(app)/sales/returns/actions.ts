'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, requireSiteUser, actorFor, actorForOrThrow } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { createCreditNote } from '@/lib/site/salesReversal'
import { searchForTill, type TillProduct } from '@/lib/site/tillSearch'

/**
 * Returns with no receipt.
 *
 * Half of real returns arrive without an invoice — the customer lost it, or it
 * was a gift. The engine has always supported it (`invoiceId: null`); this is
 * the way in.
 *
 * Two things make it different from crediting an invoice, and both are guards
 * rather than conveniences:
 *
 *   1. **There is no original line to copy a cost from.** The cost basis is the
 *      product's current average cost, which is the honest answer — it is what
 *      the shop values that unit at today.
 *
 *   2. **Nothing caps the quantity.** Crediting an invoice can never exceed
 *      what was sold; here the customer's word is the only limit. That is
 *      exactly where shrinkage hides, so the capability is checked, a reason is
 *      mandatory, and the result shows up on the by-cashier exception report.
 */

export type ReturnLineInput = {
  productId: number
  productCode: string
  description: string
  productType: string
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  vatRatePct: number
  unitCostExcl: number
}

export async function searchReturnProductsAction(term: string): Promise<TillProduct[]> {
  const ctx = await actorForOrThrow('sales.credit_note')
  const { siteId } = ctx
  return searchForTill(siteId, term, null)
}

export async function createNoReceiptReturnAction(input: {
  reasonId: number
  note?: string | null
  customerId?: number | null
  customerName?: string | null
  lines: ReturnLineInput[]
  refunds?: { tenderTypeId: number; amount: number; reference?: string | null }[]
}): Promise<
  { ok: true; documentId: number; documentNumber: string; total: number } | { ok: false; error: string }
> {
  const { site, user, capabilities } = await requireSiteUser()
  const actor = { userId: user.id, userName: user.name }

  if (!can(capabilities, 'sales.credit_note')) {
    return {
      ok: false,
      error: `Your role${user.roleName ? ` (${user.roleName})` : ''} cannot credit a sale. An owner can grant this in Setup → Users & roles.`,
    }
  }

  if (!input.reasonId) {
    return { ok: false, error: 'Choose a reason — a return with no receipt has nothing else to explain it.' }
  }
  if (input.lines.length === 0) {
    return { ok: false, error: 'Add at least one item to return.' }
  }

  const result = await createCreditNote(site.id, actor, {
    // The whole point: no invoice behind it.
    invoiceId: null,
    customerId: input.customerId ?? null,
    customerName: input.customerName?.trim() || 'Walk-in',
    reasonId: input.reasonId,
    note: input.note,
    // Kept as a caption rather than folded into the reason: the CODE has to stay
    // the same one a receipted return uses, or the two cannot be grouped
    // together — and "no receipt" is a property of the return, not a reason
    // goods came back.
    reasonPrefix: 'No receipt',
    lines: input.lines,
    refunds: input.refunds,
  })

  if (!result.ok) return result

  revalidatePath('/sales/invoicing')
  revalidatePath('/reports')

  return result
}
