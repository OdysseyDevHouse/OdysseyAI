'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import {
  postSupplierTransaction,
  allocateSupplier,
  unallocateSupplier,
  autoAllocateSupplier,
  reverseSupplierTransaction,
} from '@/lib/site/supplierLedger'
import { toDocType } from '@/lib/site/customerLedger'

/** Creditors ledger actions. See customers/ledgerActions.ts — same contract. */

export type LedgerActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function postSupplierTransactionAction(input: {
  supplierId: number
  docType: string
  amount: number
  docDate?: string
  docNumber?: string
  reference?: string
  description?: string
  vatRatePct?: number
  autoAllocate?: boolean
}): Promise<LedgerActionResult> {
  const ctx = await actorFor('purchasing.pay')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const docType = toDocType(input.docType)
  if (!docType) return { ok: false, error: 'Choose a document type.' }

  const result = await postSupplierTransaction(siteId, actor, {
    supplierId: input.supplierId,
    docType,
    amount: input.amount,
    docDate: input.docDate,
    docNumber: input.docNumber,
    reference: input.reference,
    description: input.description,
    vatRatePct: input.vatRatePct,
    autoAllocate: input.autoAllocate,
  })

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/suppliers/${input.supplierId}`)
  revalidatePath('/suppliers')
  return { ok: true, message: 'Posted.' }
}

export async function allocateSupplierAction(
  supplierId: number,
  debitId: number,
  creditId: number,
  amount: number,
): Promise<LedgerActionResult> {
  const ctx = await actorFor('purchasing.pay')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await allocateSupplier(siteId, actor, debitId, creditId, amount)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/suppliers/${supplierId}`)
  return { ok: true, message: `Allocated ${result.allocated.toFixed(2)}.` }
}

export async function unallocateSupplierAction(
  supplierId: number,
  debitId: number,
  creditId: number,
): Promise<LedgerActionResult> {
  const ctx = await actorFor('purchasing.pay')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await unallocateSupplier(siteId, actor, debitId, creditId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/suppliers/${supplierId}`)
  return { ok: true, message: 'Allocation removed.' }
}

export async function autoAllocateSupplierAction(
  supplierId: number,
  creditId: number,
): Promise<LedgerActionResult> {
  const ctx = await actorFor('purchasing.pay')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await autoAllocateSupplier(siteId, actor, creditId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/suppliers/${supplierId}`)
  return {
    ok: true,
    message:
      result.allocated > 0
        ? `Applied ${result.allocated.toFixed(2)} to the oldest invoices.`
        : 'Nothing to apply — no open invoices.',
  }
}

export async function reverseSupplierTransactionAction(
  supplierId: number,
  transactionId: number,
  reason: string,
): Promise<LedgerActionResult> {
  const ctx = await actorFor('purchasing.pay')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await reverseSupplierTransaction(siteId, actor, transactionId, reason)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/suppliers/${supplierId}`)
  revalidatePath('/suppliers')
  return { ok: true, message: 'Reversed.' }
}
