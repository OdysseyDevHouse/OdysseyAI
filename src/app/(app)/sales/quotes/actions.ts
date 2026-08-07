'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actorFor } from '@/lib/auth'
import {
  issueQuote,
  convertToInvoice,
  declineQuote,
  reopenQuote,
  setValidUntil,
  defaultValidUntil,
} from '@/lib/site/quotes'
import { saveDraft } from '@/lib/site/salesDocuments'

/**
 * Quote actions.
 *
 * Capture and editing are the INVOICING actions, used unchanged — a quote is a
 * sales document and the editor is shared. Only the things a quote has that an
 * invoice does not live here: validity, an outcome, and conversion.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateQuotes(id?: number): void {
  revalidatePath('/sales/quotes')
  if (id) revalidatePath(`/sales/quotes/${id}`)
}

/**
 * Starts a quote.
 *
 * The validity date is set from the site's default at creation rather than at
 * issue: a quote dated today is valid for thirty days from today, and deciding
 * that later would mean the date moves every time somebody opens the draft.
 */
export async function newQuoteAction(): Promise<void> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return
  const { siteId, actor } = ctx

  const draft = await saveDraft(siteId, actor, {
    docType: 'quote',
    customerName: '',
    lines: [],
  })
  if (!draft.ok) return

  const validUntil = await defaultValidUntil(siteId)
  if (validUntil) {
    await setValidUntil(siteId, actor, draft.id, validUntil)
  }

  revalidateQuotes()
  redirect(`/sales/quotes/${draft.id}`)
}

/**
 * Issues a quote to the customer.
 *
 * Marks it issued and gives it its QUO number. Posts NOTHING — no stock, no
 * ledger, no VAT — because a quote is an offer rather than a tax document.
 * finaliseGuards() in salesPosting.ts refuses to post one, so this is a status
 * change and a number rather than a call into the posting engine.
 */
export async function issueQuoteAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await issueQuote(siteId, actor, id)
  if (!result.ok) return result

  revalidateQuotes(id)
  return { ok: true, message: `Issued as ${result.documentNumber}.` }
}

export async function setValidUntilAction(
  id: number,
  validUntil: string | null,
): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setValidUntil(siteId, actor, id, validUntil)
  if (!result.ok) return result

  revalidateQuotes(id)
  return { ok: true, message: validUntil ? `Valid until ${validUntil}.` : 'Expiry removed.' }
}

export async function declineQuoteAction(id: number, reason: string): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await declineQuote(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateQuotes(id)
  return { ok: true, message: 'Recorded as lost.' }
}

export async function reopenQuoteAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await reopenQuote(siteId, actor, id)
  if (!result.ok) return result

  revalidateQuotes(id)
  return { ok: true, message: 'Reopened.' }
}

/**
 * Accepts a quote and creates the invoice.
 *
 * Returns the warnings rather than swallowing them: an expired quote, a price
 * that has moved, or stock that will not cover it are all things the person
 * converting must see BEFORE they finalise the invoice, and a toast that
 * disappears is not where that belongs.
 */
export async function convertQuoteAction(
  id: number,
): Promise<(ActionResult & { invoiceId?: number; warnings?: string[] })> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await convertToInvoice(siteId, actor, id)
  if (!result.ok) return result

  revalidateQuotes(id)
  revalidatePath('/sales/invoicing')

  return {
    ok: true,
    invoiceId: result.invoiceId,
    warnings: result.warnings,
    message:
      result.warnings.length > 0
        ? 'Converted to a draft invoice — check the warnings before finalising.'
        : 'Converted to a draft invoice.',
  }
}
