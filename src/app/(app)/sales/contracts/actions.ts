'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { actorFor } from '@/lib/auth'
import {
  saveContract,
  setContractActive,
  setAutoSend,
  deleteContract,
  billNow,
  postContractInvoice,
  type ContractInput,
} from '@/lib/site/contracts'
import { emailContractInvoice } from '@/lib/site/contractSend'
import { siteExecute } from '@/lib/siteDb'
import { queryOne } from '@/lib/db'
import { formatMoney } from '@/lib/decimals'
import type { IssuingSite } from '@/lib/invoices/build'

/**
 * Contract actions.
 *
 * Billing and sending are SEPARATE actions rather than one with a flag. They
 * have different blast radii — one moves a customer's balance, the other only
 * tells them about it — and a reviewer should be able to tell them apart at a
 * glance. The same split expenses/actions.ts makes between save and finalise.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateContracts(id?: number): void {
  revalidatePath('/sales/contracts')
  if (id) revalidatePath(`/sales/contracts/${id}`)
}

export async function saveContractAction(
  input: ContractInput,
  existingId?: number,
): Promise<ActionResult & { id?: number }> {
  const ctx = await actorFor('contracts.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // Turning on automatic sending is its own decision — it means invoices post
  // and reach a customer with nobody in the loop. Checked here rather than only
  // in the UI, because a server action is the real boundary.
  if (input.autoSend) {
    const canAuto = await actorFor('contracts.auto_send')
    if ('ok' in canAuto) {
      return {
        ok: false,
        error: 'You do not have permission to let a contract bill and send itself.',
      }
    }
  }

  const result = await saveContract(siteId, actor, input, existingId)
  if (!result.ok) return result

  revalidateContracts(result.id)
  return {
    ok: true,
    message: existingId ? 'Contract updated.' : 'Contract created.',
    id: result.id,
  }
}

export async function setContractActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const ctx = await actorFor('contracts.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setContractActive(siteId, actor, id, active)
  if (!result.ok) return result

  revalidateContracts(id)
  return { ok: true, message: active ? 'Contract resumed.' : 'Contract paused.' }
}

export async function setAutoSendAction(id: number, autoSend: boolean): Promise<ActionResult> {
  const ctx = await actorFor('contracts.auto_send')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setAutoSend(siteId, actor, id, autoSend)
  if (!result.ok) return result

  revalidateContracts(id)
  return {
    ok: true,
    message: autoSend
      ? 'This contract will now bill and email itself.'
      : 'Automatic sending is off — invoices will wait for review.',
  }
}

export async function deleteContractAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('contracts.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteContract(siteId, actor, id)
  if (!result.ok) return result

  revalidateContracts()
  return { ok: true, message: 'Contract deleted. The invoices it raised have been kept.' }
}

/**
 * Bills one contract now, without waiting for the nightly run.
 *
 * Bills every period that is DUE, not an arbitrary extra one — a contract that
 * is up to date bills nothing and says so. Letting this raise an unscheduled
 * invoice would make the billing history stop matching the schedule.
 */
export async function billNowAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('contracts.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await billNow(siteId, actor, id)
  revalidateContracts(id)
  revalidatePath('/sales/invoicing')
  revalidatePath('/customers')

  if (result.generated.length === 0) {
    const why = result.skipped[0]?.reason ?? 'Nothing is due to be billed yet.'
    return { ok: false, error: why }
  }

  const total = result.generated.reduce((sum, g) => sum + g.totalIncl, 0)
  const posted = result.generated.filter((g) => g.posted).length
  const raised = `${result.generated.length} invoice${result.generated.length === 1 ? '' : 's'} for ${formatMoney(total)}`

  return {
    ok: true,
    message:
      posted === result.generated.length
        ? `Billed ${raised}, posted to the account.`
        : `Raised ${raised} as ${result.generated.length === 1 ? 'a draft' : 'drafts'} for review.`,
  }
}

/**
 * Posts a draft contract invoice to the customer's account.
 *
 * The manual counterpart of auto_send: this is what "review and release" means
 * on the due screen. Posts only — the email follows separately, so a mail
 * failure never leaves the ledger half-done.
 */
export async function postContractInvoiceAction(
  documentId: number,
  customerId: number,
  contractId: number,
): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postContractInvoice(siteId, actor, documentId, customerId)
  if (!result.ok) return result

  // Record that this period is now posted, so the due screen stops offering it.
  // The invoice IS posted either way — this only updates the contract's own
  // view of it, so a failure here must not report the posting as failed.
  await siteExecute(
    siteId,
    `UPDATE contract_invoices SET status = 'posted', error = NULL WHERE document_id = ?`,
    [documentId],
  ).catch(() => null)

  revalidateContracts(contractId)
  revalidatePath('/sales/invoicing')
  return { ok: true, message: `Posted as ${result.documentNumber}.` }
}

/**
 * Emails one contract invoice, or sends it again.
 *
 * A resend re-renders and re-sends the SAME document. Nothing on the ledger
 * moves and the invoice keeps its number — which is what makes this safe to
 * offer as a button next to a failed send.
 */
export async function sendContractInvoiceAction(
  contractInvoiceId: number,
  contractId: number,
): Promise<ActionResult> {
  const ctx = await actorFor('contracts.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const site = await issuingSite(siteId)
  if (!site) return { ok: false, error: 'This site’s details could not be read.' }

  const result = await emailContractInvoice(siteId, site, actor, contractInvoiceId, {
    origin: await publicOrigin(),
    // Explicit resend: the caller pressed a button, so an already-sent invoice
    // should go again rather than silently doing nothing.
    force: true,
  })

  revalidateContracts(contractId)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, message: `Emailed to ${result.to}.` }
}

/** Everything the invoice letterhead needs, from the control database. */
async function issuingSite(siteId: number): Promise<IssuingSite | null> {
  const row = await queryOne<{
    company_name: string
    trading_name: string | null
    vat_number: string | null
    registration_number: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postal_code: string | null
    phone: string | null
    email: string | null
  }>(
    `SELECT company_name, trading_name, vat_number, registration_number,
            address1, address2, address3, postal_code, phone, email
       FROM cp2_sites WHERE id = ? LIMIT 1`,
    [siteId],
  )
  if (!row) return null

  return {
    displayName: row.trading_name?.trim() || row.company_name,
    vatNumber: row.vat_number,
    registrationNumber: row.registration_number,
    address1: row.address1,
    address2: row.address2,
    address3: row.address3,
    postalCode: row.postal_code,
    phone: row.phone,
    email: row.email,
  }
}

/** The origin an emailed pay-link should point at. */
async function publicOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

export type { ContractInput }
