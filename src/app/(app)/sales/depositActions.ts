'use server'

import { revalidatePath } from 'next/cache'
import { actorForOrThrow } from '@/lib/auth'
import { getTenderType, listTenderTypes } from '@/lib/site/tenderTypes'
import { getSettings } from '@/lib/site/settings'
import {
  takeDeposit,
  refundDeposit,
  depositSummary,
  type DepositSummary,
} from '@/lib/site/deposits'

/**
 * Deposits from the back office — the invoicing and quote screens.
 *
 * ── WHY NOT THE TILL'S ACTIONS ────────────────────────────────────────────
 *
 * `(pos)/pos/depositActions.ts` gates on `sales.till` and resolves the shift
 * from the terminal the cashier is standing at. Neither applies here: a person
 * capturing an invoice at a desk holds `sales.edit`, and there is no terminal,
 * so the money belongs to no drawer. `shiftToBankInto` already treats a null
 * terminal as "no shift", which is the honest answer rather than a special case.
 *
 * The arithmetic and the writes are the same `deposits.ts` either way. This is
 * only about what a back-office user may ask for.
 */

export type DepositActionResult =
  | { ok: true; held: number; stillToPay: number }
  | { ok: false; error: string }

export async function takeDocumentDepositAction(input: {
  documentId: number
  amount: number
  tenderTypeId: number
  reference?: string | null
}): Promise<DepositActionResult> {
  const { siteId, actor } = await actorForOrThrow('sales.edit')

  const tender = await getTenderType(siteId, input.tenderTypeId)
  if (!tender || !tender.isActive) {
    return { ok: false, error: 'Choose how the money is arriving.' }
  }
  if (tender.postsToDebtor) {
    return { ok: false, error: `${tender.name} cannot be used for a deposit.` }
  }
  if (tender.code === 'DEPOSIT') {
    return { ok: false, error: 'A deposit cannot be paid with another deposit.' }
  }
  if (tender.requiresReference && !input.reference?.trim()) {
    return { ok: false, error: `${tender.referenceLabel ?? 'A reference'} is required.` }
  }

  const result = await takeDeposit(siteId, actor, {
    documentId: input.documentId,
    amount: input.amount,
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: input.reference ?? null,
    /* No terminal, so no shift. A deposit captured at a desk belongs to no
       drawer, and inventing one would make somebody's cash-up wrong. */
    terminalId: null,
  })
  if (!result.ok) return result

  revalidatePath(`/invoicing/${input.documentId}`)
  revalidatePath(`/invoicing/quotes/${input.documentId}`)
  return { ok: true, held: result.held, stillToPay: result.stillToPay }
}

export async function refundDocumentDepositAction(input: {
  documentId: number
  amount: number
  tenderTypeId: number
  reference?: string | null
}): Promise<DepositActionResult> {
  const { siteId, actor } = await actorForOrThrow('sales.edit')

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
    terminalId: null,
  })
  if (!result.ok) return result

  revalidatePath(`/invoicing/${input.documentId}`)
  revalidatePath(`/invoicing/quotes/${input.documentId}`)
  return { ok: true, held: result.held, stillToPay: 0 }
}

/** What is held, for a screen that needs it after a change. */
export async function documentDepositsAction(documentId: number): Promise<DepositSummary> {
  const { siteId } = await actorForOrThrow('sales.view')
  return depositSummary(siteId, documentId)
}

/**
 * The tenders a deposit may arrive on, and the store's deposit rules.
 *
 * One call rather than three, because the panel needs all of it before it can
 * render a single control and three round trips would paint it in stages.
 */
export async function depositOptionsAction(): Promise<{
  tenders: { id: number; name: string; requiresReference: boolean; referenceLabel: string | null }[]
  minPct: number
  allowWalkin: boolean
}> {
  const { siteId } = await actorForOrThrow('sales.view')

  const [tenders, settings] = await Promise.all([
    listTenderTypes(siteId),
    getSettings(siteId, ['deposit_min_pct', 'deposit_allow_walkin']),
  ])

  return {
    tenders: tenders
      .filter((t) => t.isActive && !t.postsToDebtor && t.code !== 'DEPOSIT')
      .map((t) => ({
        id: t.id,
        name: t.name,
        requiresReference: t.requiresReference,
        referenceLabel: t.referenceLabel,
      })),
    minPct: Number(settings.deposit_min_pct ?? '0') || 0,
    allowWalkin: String(settings.deposit_allow_walkin ?? '1') !== '0',
  }
}
