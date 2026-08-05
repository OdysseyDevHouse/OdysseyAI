'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId } from '@/lib/auth'
import {
  createLayby,
  takePayment,
  completeLayby,
  cancelLayby,
  expireStaleLaybys,
  type LaybyLineInput,
} from '@/lib/site/laybys'
import type { FeeWaiverReason } from '@/lib/laybyRules'

/**
 * Lay-by actions.
 *
 * Everything returns its outcome rather than redirecting, in keeping with the
 * rest of the sales screens: a lay-by payment is taken at a counter with a
 * customer standing there, and a redirect that loses the entered amount is a
 * conversation nobody wants to have twice.
 */

type Result<T = unknown> = ({ ok: true; message: string } & T) | { ok: false; error: string }

export async function createLaybyAction(input: {
  customerId: number
  lines: LaybyLineInput[]
  deposit?: { amount: number; tenderTypeId: number; tenderName: string }
  dueDate?: string | null
  terminalId?: number | null
  note?: string | null
}): Promise<Result<{ laybyId: number; laybyNumber: string }>> {
  const { siteId, actor } = await requireActor()

  const result = await createLayby(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/sales/laybys')
  // The goods are now spoken for, so anything showing available-to-sell is
  // stale.
  revalidatePath('/products')

  return {
    ok: true,
    laybyId: result.laybyId,
    laybyNumber: result.laybyNumber,
    message: `${result.laybyNumber} opened. ${result.outstanding.toFixed(2)} still to pay.`,
  }
}

export async function takePaymentAction(
  laybyId: number,
  input: {
    amount: number
    tenderTypeId: number
    tenderName: string
    reference?: string | null
    terminalId?: number | null
  },
): Promise<Result<{ settled: boolean; outstanding: number }>> {
  const { siteId, actor } = await requireActor()

  const result = await takePayment(siteId, actor, laybyId, input)
  if (!result.ok) return result

  revalidatePath(`/sales/laybys/${laybyId}`)
  revalidatePath('/sales/laybys')

  return {
    ok: true,
    settled: result.settled,
    outstanding: result.outstanding,
    message: result.settled
      ? 'Paid in full. Hand the goods over to finish.'
      : `${result.outstanding.toFixed(2)} still to pay.`,
  }
}

export async function completeLaybyAction(
  laybyId: number,
  tenderTypeId: number,
): Promise<Result<{ documentId: number; documentNumber: string }>> {
  const { siteId, actor } = await requireActor()

  const result = await completeLayby(siteId, actor, laybyId, tenderTypeId)
  if (!result.ok) return result

  revalidatePath(`/sales/laybys/${laybyId}`)
  revalidatePath('/sales/laybys')
  revalidatePath('/sales')
  revalidatePath('/products')

  return {
    ok: true,
    documentId: result.documentId,
    documentNumber: result.documentNumber,
    message: `${result.documentNumber} raised. The goods are the customer's.`,
  }
}

export async function cancelLaybyAction(
  laybyId: number,
  input: {
    reason: string
    waiverReason?: FeeWaiverReason | null
    tenderTypeId?: number | null
    tenderName?: string | null
  },
): Promise<Result> {
  const { siteId, actor } = await requireActor()

  const result = await cancelLayby(siteId, actor, laybyId, input)
  if (!result.ok) return result

  revalidatePath(`/sales/laybys/${laybyId}`)
  revalidatePath('/sales/laybys')
  revalidatePath('/products')

  return {
    ok: true,
    message:
      result.fee > 0
        ? `Cancelled. ${result.refund.toFixed(2)} refunded, ${result.fee.toFixed(2)} kept as the disclosed fee.`
        : `Cancelled. ${result.refund.toFixed(2)} refunded in full.`,
  }
}

export async function expireStaleAction(): Promise<Result> {
  const siteId = await requireSiteId()

  const expired = await expireStaleLaybys(siteId)
  revalidatePath('/sales/laybys')
  revalidatePath('/products')

  return {
    ok: true,
    message:
      expired.length === 0
        ? 'Nothing has been left long enough to expire.'
        : `${expired.length} lay-by${expired.length === 1 ? '' : 's'} marked expired. The money is still held — cancel each one to refund it.`,
  }
}
