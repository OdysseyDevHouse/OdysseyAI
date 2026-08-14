'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession, clearCustomerCookie } from '@/lib/customerSession'
import { requestLink, portalSettings } from '@/lib/site/portalAuth'
import { portalComment, payLinkFor, ownsQuote, portalUpload } from '@/lib/site/portalData'
import { acceptQuote } from '@/lib/site/jobQuotes'
import { revalidatePath } from 'next/cache'

/**
 * Everything a customer can DO from the portal.
 *
 * ── EVERY ACTION RE-DERIVES THE CUSTOMER ───────────────────────────────────
 *
 * A server action is a public HTTP endpoint that anybody can call with any
 * arguments. So no action here takes a customerId: it comes from the session
 * cookie, checked against the site the path token names, on every single call.
 * The only ids that cross the wire are the job or document being acted on, and
 * each is checked for ownership before anything is written.
 */

async function clientIp(): Promise<string> {
  const head = await headers()
  const forwarded = head.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? ''
  return head.get('x-real-ip') ?? ''
}

/** The signed-in customer for this portal, or null. Never trusts an argument. */
async function customerFor(
  token: string,
): Promise<{ siteId: number; customerId: number; name: string } | null> {
  const siteId = await verifyPortalToken(token)
  if (siteId === null) return null
  const settings = await portalSettings(siteId)
  if (!settings.isEnabled) return null
  const session = await getCustomerSession(siteId)
  if (!session) return null
  return { siteId, customerId: session.customerId, name: session.name }
}

/**
 * Ask for a sign-in link.
 *
 * Answers the same way whatever happens — see the module header in portalAuth.
 * This form must not be usable to find out who is a customer of this business.
 */
export async function requestLinkAction(
  token: string,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const siteId = await verifyPortalToken(token)
  if (siteId === null) return { ok: false, error: 'This link is not valid.' }

  const head = await headers()
  const origin = head.get('origin') ?? process.env.APP_URL ?? ''
  return requestLink(siteId, email, { ip: await clientIp(), baseUrl: origin })
}

export async function signOutAction(token: string): Promise<void> {
  await clearCustomerCookie()
  redirect(`/portal/${token}`)
}

export async function portalCommentAction(
  token: string,
  jobId: number,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await customerFor(token)
  if (!me) return { ok: false, error: 'Please sign in again.' }

  const result = await portalComment(me.siteId, me.customerId, me.name, jobId, body)
  if (result.ok) revalidatePath(`/portal/${token}/jobs/${jobId}`)
  return result
}

/**
 * Accept a quote from the portal.
 *
 * ── IT RECORDS THAT IT CAME FROM THE PORTAL ────────────────────────────────
 *
 * acceptQuote already takes a method, because who accepted and HOW is what a
 * dispute turns on. A staff member accepting on somebody's behalf and the
 * customer accepting it themselves are different facts, and this is the one that
 * makes the difference recordable.
 */
export async function acceptQuoteAction(
  token: string,
  quoteId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await customerFor(token)
  if (!me) return { ok: false, error: 'Please sign in again.' }

  const settings = await portalSettings(me.siteId)
  if (!settings.allowQuoteAccept) {
    return { ok: false, error: 'Quotes are accepted by the business, not online.' }
  }

  // Ownership first. An accepted quote sets what was agreed and for how much.
  const owned = await ownsQuote(me.siteId, me.customerId, quoteId)
  if (!owned) return { ok: false, error: 'That quote could not be found.' }

  const result = await acceptQuote(
    me.siteId,
    // The customer is not a user of this system. Recorded as themselves, by
    // name, so the audit trail says who really pressed it.
    { userId: 0, userName: me.name },
    quoteId,
    {
      // 'link' is the secure-link case the quoting phase already anticipated —
      // the customer themselves, not somebody accepting on their behalf.
      method: 'link',
      acceptedBy: me.name,
      reference: 'Accepted in the customer portal',
    },
  )
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/portal/${token}/jobs/${owned.jobId}`)
  return { ok: true }
}

/** A link to pay one invoice. Ownership is checked inside payLinkFor. */
export async function payInvoiceAction(
  token: string,
  documentId: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const me = await customerFor(token)
  if (!me) return { ok: false, error: 'Please sign in again.' }
  return payLinkFor(me.siteId, me.customerId, documentId)
}

/**
 * A customer sends a photo of their own job.
 *
 * FormData rather than typed arguments, because a File cannot cross a server
 * action boundary any other way. Everything about the file — its type, its size,
 * how many are already there — is checked inside portalUpload, on the server.
 */
export async function portalUploadAction(
  token: string,
  jobId: number,
  form: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await customerFor(token)
  if (!me) return { ok: false, error: 'Please sign in again.' }

  const file = form.get('file')
  if (!(file instanceof File)) return { ok: false, error: 'Choose a file first.' }

  const result = await portalUpload(me.siteId, me.customerId, me.name, jobId, file)
  if (result.ok) revalidatePath(`/portal/${token}/jobs/${jobId}`)
  return result
}
