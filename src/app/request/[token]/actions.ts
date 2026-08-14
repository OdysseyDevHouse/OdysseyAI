'use server'

import { headers } from 'next/headers'
import { verifyPublicIntakeToken } from '@/lib/publicIntakeToken'
import { submitRequest, type SubmitResult } from '@/lib/site/jobIntake'

/**
 * A stranger asks for work to be done.
 *
 * ── THE TOKEN IS RE-VERIFIED HERE ──────────────────────────────────────────
 *
 * A server action is a public HTTP endpoint. The page's check protected the
 * page; this is a separate request anybody can make with any arguments, so the
 * siteId comes from the signature and never from a parameter.
 *
 * ── WHAT THIS CAN DO AT WORST ──────────────────────────────────────────────
 *
 * Write one row to job_requests. No job, no customer, no address, no document
 * number, no stock, no ledger. Nothing it writes appears in any figure until a
 * person in the business accepts it — which is the actual defence, and the
 * reason a honeypot and a daily cap are proportionate rather than thin.
 */

/** The visitor's IP, for abuse triage on a form with no login. */
async function clientIp(): Promise<string> {
  const head = await headers()
  const forwarded = head.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? ''
  return head.get('x-real-ip') ?? ''
}

export async function submitRequestAction(
  token: string,
  input: {
    contactName: string
    contactPhone: string
    contactEmail: string
    title: string
    description: string
    addressText: string
    headlineId: number | null
    /** Honeypot. A human never fills this in. */
    website?: string
  },
): Promise<SubmitResult> {
  const siteId = await verifyPublicIntakeToken(token)
  // Deliberately the same message a switched-off form gets: a bad token must not
  // be distinguishable from a business that is not taking requests.
  if (siteId === null) {
    return { ok: false, error: 'This form is not accepting requests at the moment.' }
  }

  return submitRequest(siteId, {
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    contactEmail: input.contactEmail.trim() || null,
    title: input.title,
    description: input.description.trim() || null,
    addressText: input.addressText.trim() || null,
    headlineId: input.headlineId,
    honeypot: input.website ?? null,
    ip: await clientIp(),
  })
}
