'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSite } from '@/lib/auth'
import {
  createPaymentRun,
  postPaymentRun,
  cancelPaymentRun,
  payableInvoicesFor,
  type CreateRunInput,
} from '@/lib/site/paymentRuns'
import { buildRemittance } from '@/lib/statements/remittance'
import { renderStatementPdf } from '@/lib/statements/pdf'
import { listPaymentItems } from '@/lib/site/paymentRuns'
import { send, isConfigured } from '@/lib/mail'
import { formatMoney } from '@/lib/decimals'
import { siteExecute } from '@/lib/siteDb'

export type PaymentActionResult =
  | { ok: true; runId: number; message: string }
  | { ok: false; error: string }

export async function createRunAction(input: CreateRunInput): Promise<PaymentActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await createPaymentRun(siteId, actor, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/suppliers/remittances')
  return {
    ok: true,
    runId: result.runId,
    message: 'Run prepared. Nothing has been paid yet — review it before posting.',
  }
}

export async function postRunAction(runId: number): Promise<PaymentActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await postPaymentRun(siteId, actor, runId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/suppliers/remittances')
  revalidatePath(`/suppliers/remittances/${runId}`)
  revalidatePath('/suppliers')
  return {
    ok: true,
    runId,
    message: `Paid ${result.paid} supplier${result.paid === 1 ? '' : 's'}, ${formatMoney(result.total)} in total.`,
  }
}

export async function cancelRunAction(runId: number): Promise<PaymentActionResult> {
  const siteId = (await requireSite()).id
  const result = await cancelPaymentRun(siteId, runId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/suppliers/remittances')
  return { ok: true, runId, message: 'Run cancelled.' }
}

export async function invoicesForSupplierAction(supplierId: number) {
  const siteId = (await requireSite()).id
  return payableInvoicesFor(siteId, supplierId)
}

/**
 * Emails the remittance advice to each supplier in a posted run.
 *
 * Sent one at a time with the outcome recorded per supplier — the same shape as
 * a statement run, and for the same reason: one bad address must not stop the
 * others. The money has already moved, so a failure here is a communication
 * problem, not a financial one, and the run says which.
 */
export async function sendRemittancesAction(runId: number): Promise<PaymentActionResult> {
  const site = await requireSite()

  if (!isConfigured()) {
    return { ok: false, error: 'Email is not set up — SMTP_HOST and MAIL_FROM are missing.' }
  }

  const items = await listPaymentItems(site.id, runId)
  let sent = 0
  let failed = 0

  for (const item of items) {
    if (!item.email) {
      await siteExecute(
        site.id,
        "UPDATE supplier_payment_items SET remittance_status = 'failed', remittance_error = ? WHERE id = ?",
        ['No email address on file.', item.id],
      )
      failed++
      continue
    }

    try {
      const data = await buildRemittance(site.id, site.displayName, site.vatNumber, runId, item.supplierId)
      if (!data) throw new Error('The remittance could not be built.')

      const pdf = await renderStatementPdf(data, 'remittance')
      const result = await send({
        to: item.email,
        subject: `Remittance advice — ${formatMoney(item.amount)}`,
        text: [
          `Dear ${item.supplierName},`,
          '',
          `We have paid ${formatMoney(item.amount)} against ${item.allocations.length} invoice${item.allocations.length === 1 ? '' : 's'}.`,
          'The attached advice shows exactly which ones, so it can be matched against your open items.',
          '',
          'Kind regards,',
          site.displayName,
        ].join('\n'),
        attachments: [
          {
            filename: `remittance-${item.supplierCode}-${data.period.to}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          },
        ],
      })

      if (!result.ok) throw new Error(result.error)

      await siteExecute(
        site.id,
        "UPDATE supplier_payment_items SET remittance_status = 'sent', remittance_error = NULL, remittance_sent_at = NOW() WHERE id = ?",
        [item.id],
      )
      sent++
    } catch (error) {
      await siteExecute(
        site.id,
        "UPDATE supplier_payment_items SET remittance_status = 'failed', remittance_error = ? WHERE id = ?",
        [(error instanceof Error ? error.message : 'Send failed.').slice(0, 400), item.id],
      )
      failed++
    }
  }

  revalidatePath(`/suppliers/remittances/${runId}`)
  return {
    ok: true,
    runId,
    message: failed === 0 ? `Sent ${sent} remittance advice${sent === 1 ? '' : 's'}.` : `${sent} sent, ${failed} failed.`,
  }
}
