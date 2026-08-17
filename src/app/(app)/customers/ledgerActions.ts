'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorForModule } from '@/lib/auth'
import {
  postTransaction,
  allocate,
  unallocate,
  autoAllocate,
  reverseTransaction,
  toDocType,
} from '@/lib/site/customerLedger'

/**
 * Ledger actions for the customer account screen.
 *
 * Separate from actions.ts because these move money and that file edits a
 * master record — different guards, different blast radius, and a reviewer
 * should be able to see everything that can change a balance in one file.
 *
 * They return their result rather than redirecting: the Transactions tab is a
 * client component that reports the outcome in a toast and refreshes in place.
 */

export type LedgerActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function postTransactionAction(input: {
  customerId: number
  docType: string
  amount: number
  docDate?: string
  docNumber?: string
  reference?: string
  description?: string
  vatRatePct?: number
  autoAllocate?: boolean
}): Promise<LedgerActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const docType = toDocType(input.docType)
  if (!docType) return { ok: false, error: 'Choose a document type.' }

  const result = await postTransaction(siteId, actor, {
    customerId: input.customerId,
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

  revalidatePath(`/customers/${input.customerId}`)
  revalidatePath('/customers')
  return { ok: true, message: 'Posted.' }
}

export async function allocateAction(
  customerId: number,
  debitId: number,
  creditId: number,
  amount: number,
): Promise<LedgerActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await allocate(siteId, actor, debitId, creditId, amount)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: `Allocated ${result.allocated.toFixed(2)}.` }
}

export async function unallocateAction(
  customerId: number,
  debitId: number,
  creditId: number,
): Promise<LedgerActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await unallocate(siteId, actor, debitId, creditId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Allocation removed.' }
}

export async function autoAllocateAction(
  customerId: number,
  creditId: number,
): Promise<LedgerActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await autoAllocate(siteId, actor, creditId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/customers/${customerId}`)
  return {
    ok: true,
    message:
      result.allocated > 0
        ? `Applied ${result.allocated.toFixed(2)} to the oldest invoices.`
        : 'Nothing to apply — no open invoices.',
  }
}

export async function reverseTransactionAction(
  customerId: number,
  transactionId: number,
  reason: string,
): Promise<LedgerActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await reverseTransaction(siteId, actor, transactionId, reason)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/customers/${customerId}`)
  revalidatePath('/customers')
  return { ok: true, message: 'Reversed.' }
}
