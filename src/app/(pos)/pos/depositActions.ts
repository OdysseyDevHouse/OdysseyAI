'use server'

import { actorFor, withTillOperator } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getTenderType } from '@/lib/site/tenderTypes'
import {
  takeDeposit,
  depositSummary,
  refundDeposit,
  type DepositSummary,
} from '@/lib/site/deposits'

/**
 * Taking a deposit at the till.
 *
 * ── WHY THIS IS NOT tillCustomerReceiptAction ─────────────────────────────
 *
 * That one puts money against an ACCOUNT: it needs a debtor, it writes the
 * cashbook and the general ledger, and it settles something the customer owes.
 * A deposit does none of that. The money is held against a DOCUMENT, the
 * customer may be a walk-in with no account at all, and under CPA s62(1)(a) it
 * is still their money until the goods are handed over — so posting it to the
 * ledger would record a debt neither side has.
 *
 * The two look similar at the counter and are different events underneath,
 * which is exactly why they are separate actions rather than one with a flag.
 *
 * ── SAME RIGHT AS SELLING ─────────────────────────────────────────────────
 *
 * `sales.till`, following the reasoning in receiptActions: if a cashier can
 * take R500 for goods they can take R500 to hold against goods. What they
 * cannot do is anything else in the cashbook, and this reaches none of it.
 */

export type DepositResult =
  | { ok: true; held: number; stillToPay: number }
  | { ok: false; error: string }

export async function takeDepositAction(input: {
  documentId: number | null
  basketUid?: string | null
  amount: number
  tenderTypeId: number
  reference?: string | null
  terminalId?: number | null
}): Promise<DepositResult> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const ctx = await withTillOperator(base)
  const { siteId, actor } = ctx

  if (!can(ctx.capabilities, 'sales.till')) {
    return { ok: false, error: 'Taking a deposit needs the till right.' }
  }

  const tender = await getTenderType(siteId, input.tenderTypeId)
  if (!tender || !tender.isActive) {
    return { ok: false, error: 'Choose how they are paying.' }
  }
  /*
   * An ACCOUNT tender would be "paying" a deposit with credit the shop extends
   * — no money arrives, yet the sale would post as settled. Refused here as
   * well as in the pad, because this is a public endpoint and the pad is only a
   * screen.
   */
  if (tender.postsToDebtor) {
    return { ok: false, error: `${tender.name} cannot be used for a deposit.` }
  }
  /* The DEPOSIT tender itself is how a held deposit reaches a posted sale. A
     deposit paid BY deposit is a loop with no money in it. */
  if (tender.code === 'DEPOSIT') {
    return { ok: false, error: 'A deposit cannot be paid with another deposit.' }
  }
  if (tender.requiresReference && !input.reference?.trim()) {
    return { ok: false, error: `${tender.referenceLabel ?? 'A reference'} is required.` }
  }

  const result = await takeDeposit(siteId, actor, {
    documentId: input.documentId,
    basketUid: input.basketUid ?? null,
    amount: input.amount,
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: input.reference ?? null,
    terminalId: input.terminalId ?? null,
  })

  if (!result.ok) return result
  return { ok: true, held: result.held, stillToPay: result.stillToPay }
}

/** What is held against the document on screen, for the till to show. */
export async function depositSummaryAction(
  documentId: number,
): Promise<DepositSummary | { ok: false; error: string }> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const ctx = await withTillOperator(base)
  return depositSummary(ctx.siteId, documentId)
}

/**
 * Hand a held deposit back.
 *
 * At the till rather than only in the back office, because the customer who
 * changed their mind is standing at the counter and the money is in the drawer
 * in front of the cashier.
 */
export async function refundDepositAction(input: {
  documentId: number
  amount: number
  tenderTypeId: number
  reference?: string | null
  terminalId?: number | null
}): Promise<DepositResult> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const ctx = await withTillOperator(base)
  const { siteId, actor } = ctx

  if (!can(ctx.capabilities, 'sales.till')) {
    return { ok: false, error: 'Refunding a deposit needs the till right.' }
  }

  const tender = await getTenderType(siteId, input.tenderTypeId)
  if (!tender || !tender.isActive) {
    return { ok: false, error: 'Choose how the money is going back.' }
  }

  const result = await refundDeposit(siteId, actor, {
    documentId: input.documentId,
    amount: input.amount,
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: input.reference ?? null,
    terminalId: input.terminalId ?? null,
  })

  if (!result.ok) return result
  return { ok: true, held: result.held, stillToPay: 0 }
}
