import { NextResponse, type NextRequest } from 'next/server'
import { readCallbackToken, readCallbackPath } from '@/lib/callbackToken'
import { verifyItn } from '@/lib/payfast/itn'
import { getGateway, getIntent, settleIntent } from '@/lib/site/payments'
import { invoicePaidOrder, markOrderPayment } from '@/lib/site/paidOrders'
import { settlePaidInvoice } from '@/lib/site/paidInvoices'
import {
  settleAccountPayment,
  settleLaybyPayment,
  settleDocumentDeposit,
  settleJobDeposit,
} from '@/lib/site/paidLinks'

/**
 * PayFast ITN — the server-to-server callback that says a payment happened.
 *
 * THIS IS THE ONLY ENDPOINT THAT MAY MARK AN ORDER PAID. The shopper's return
 * URL cannot: it is under their control and can simply be typed into a browser.
 *
 * ── THE ORDER OF OPERATIONS IS THE SECURITY MODEL ────────────────────────
 *
 *   1. Resolve the store from OUR OWN signed token. Verification needs that
 *      store's passphrase, so the store cannot be established by verifying.
 *   2. Load the intent — an amount WE recorded, to check the payload against.
 *   3. Verify: signature, source IP, post-back to PayFast, merchant, amount.
 *   4. Settle, guarded by `WHERE status = 'pending'` so replays do nothing.
 *   5. Only then invoice the order.
 *
 * ── WHY THIS ALWAYS RETURNS 200 ──────────────────────────────────────────
 *
 * PayFast retries anything that is not a 200, and a retry cannot fix a forged
 * signature or an unknown reference. Returning 500 to a bad payload would earn
 * an endless retry loop over a request we have already correctly rejected. So
 * the endpoint acknowledges receipt and the DECISION lives in the database,
 * not in the status code.
 */

export const dynamic = 'force-dynamic'

/** Acknowledge. See the note above on why failures are still 200. */
const ack = () => new NextResponse('OK', { status: 200 })

function sourceIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip')
}

/**
 * Name what was paid, and ring the bell.
 *
 * The lookup is per purpose because `target_id` means a different table in each
 * case — the same reason the settlement branch above is a switch. A notification
 * saying "R575 received — #9" would be useless; it has to say the document
 * NUMBER, which is the only thing a person recognises.
 *
 * Every read is best-effort. This runs after the money is recorded, so a failed
 * lookup costs a good title and nothing else — the notification still goes out
 * naming what it can.
 */
async function announce(
  siteId: number,
  purpose: string,
  targetId: number,
  amount: number,
  providerRef: string,
): Promise<void> {
  const { announcePayment } = await import('@/lib/site/paidLinks')

  let what = `#${targetId}`
  let href: string | null = null
  let customerId: number | null = null

  try {
    if (purpose === 'debtor_invoice' || purpose === 'document_deposit') {
      const { getDocument } = await import('@/lib/site/salesDocuments')
      const doc = await getDocument(siteId, targetId)
      if (doc) {
        what = doc.documentNumber ?? `${doc.docLabel} #${targetId}`
        customerId = doc.customerId
        href = `/invoicing/${targetId}`
      }
    } else if (purpose === 'customer_account') {
      const { getCustomer } = await import('@/lib/site/customers')
      const customer = await getCustomer(siteId, targetId)
      if (customer) {
        what = `account ${customer.code}`
        customerId = customer.id
        href = `/customers/${targetId}`
      }
    } else if (purpose === 'layby') {
      const { getLayby } = await import('@/lib/site/laybys')
      const layby = await getLayby(siteId, targetId)
      if (layby) {
        what = `lay-by ${layby.laybyNumber ?? `#${targetId}`}`
        customerId = layby.customerId
        href = `/invoicing/laybys/${targetId}`
      }
    } else if (purpose === 'job_deposit') {
      what = `job #${targetId}`
      href = `/job-cards/${targetId}`
    } else if (purpose === 'online_order') {
      what = `online order #${targetId}`
      href = `/online-store/orders/${targetId}`
    }
  } catch {
    /* A title is worth having, not worth failing for. */
  }

  await announcePayment(siteId, { purpose, what, amount, providerRef, href, customerId })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  /*
   * 1. Which store, which payment — from a value we minted, never from the body.
   *
   * TWO SHAPES ACCEPTED, and the order matters. The short `<site36>-<reference>`
   * path is what is minted now (see callbackToken.ts: the JWT made a notify_url
   * 296 characters long, past PayFast's 255-character limit, so the callback was
   * simply never sent). The JWT is still read because one may be sitting in
   * PayFast's retry queue against a payment already taken — dropping it would
   * turn a settled payment into money nobody can account for.
   */
  const claim = readCallbackPath(token) ?? (await readCallbackToken(token))
  if (!claim) return ack()

  // The raw body, unparsed: the ITN signature is built over the fields in the
  // order they arrive, so anything that reorders them breaks verification.
  const rawBody = await req.text()

  try {
    const gateway = await getGateway(claim.siteId)
    if (!gateway || !gateway.credentialsUsable) return ack()

    // 2. What we EXPECTED this payment to be.
    const intent = await getIntent(claim.siteId, claim.reference)
    if (!intent) return ack()

    // A payload whose own reference disagrees with the token is either a
    // mix-up or an attempt to redirect a real payment at another order.
    const bodyReference = new URLSearchParams(rawBody).get('m_payment_id')
    if (bodyReference && bodyReference !== claim.reference) return ack()

    // 3. The four checks, against THIS store's credentials.
    const verified = await verifyItn(
      rawBody,
      sourceIp(req),
      {
        merchantId: gateway.merchantId,
        passphrase: gateway.passphrase,
        sandbox: gateway.isSandbox,
      },
      intent.amountIncl,
    )

    if (!verified.valid) {
      // Recorded as failed so staff can see a payment was attempted and
      // rejected, rather than the order silently sitting unpaid for ever.
      await settleIntent(claim.siteId, claim.reference, {
        paid: false,
        failureReason: verified.reason,
        rawPayload: rawBody,
      })
      return ack()
    }

    const complete = verified.data.paymentStatus === 'COMPLETE'

    // 4. Settle. The status guard makes a replayed callback a no-op.
    const outcome = await settleIntent(claim.siteId, claim.reference, {
      paid: complete,
      providerRef: verified.data.providerRef,
      failureReason: complete ? '' : `PayFast reported ${verified.data.paymentStatus}`,
      rawPayload: rawBody,
    })

    if (outcome.outcome !== 'settled') {
      // already_settled, failed, or unknown — nothing more to do. In
      // particular a duplicate must NOT invoice the order a second time.
      return ack()
    }

    // 5. The money is confirmed in. What that MEANS depends on what was being
    //    paid for — a shop order becomes an invoice, an already-raised invoice
    //    gets a receipt, a statement pays down a balance, and the three deposit
    //    kinds simply hold the money against what it was paid for.
    //    Branching here rather than in settleIntent keeps the intent table
    //    ignorant of what its targets are, which is what lets a further purpose
    //    be added without touching the settling code.
    //
    //    THE PAPERWORK MAY FAIL AND THE PAYMENT STILL STANDS. Every branch
    //    below logs rather than throws, because the money really did arrive:
    //    unwinding a settled payment over a failed posting would lose a fact
    //    that is true. A person fixes the posting; nobody can un-take the cash.
    const actor = {
      // There is nobody signed in at a callback. The rows record where the
      // money came from rather than pretending a person keyed it.
      userId: 0,
      userName: 'Online payment',
    }
    const targetId = outcome.intent.targetId
    const amount = verified.data.amountGross
    const providerRef = verified.data.providerRef || claim.reference

    const settle = async (): Promise<{ ok: boolean; error?: string }> => {
      switch (outcome.intent.purpose) {
        case 'debtor_invoice':
          return settlePaidInvoice(claim.siteId, actor, targetId, amount, providerRef)

        case 'customer_account':
          // target_id is a CUSTOMER id here, not a document id — a statement is
          // a balance. See paidLinks.ts for why this must not be receipted
          // against any single invoice.
          return settleAccountPayment(claim.siteId, actor, targetId, amount, providerRef)

        case 'layby':
          return settleLaybyPayment(claim.siteId, actor, targetId, amount, providerRef)

        case 'document_deposit':
          return settleDocumentDeposit(claim.siteId, actor, targetId, amount, providerRef)

        case 'job_deposit':
          return settleJobDeposit(claim.siteId, actor, targetId, amount, providerRef)

        case 'online_order': {
          await markOrderPayment(claim.siteId, targetId, 'paid')
          return invoicePaidOrder(claim.siteId, targetId, amount, providerRef)
        }
      }
    }

    const posted = await settle()
    if (!posted.ok) {
      console.error(
        `[payfast] settled ${claim.reference} but could not post ${outcome.intent.purpose} ${targetId}: ${posted.error}`,
      )
    }

    /*
     * 6. Tell somebody. LAST, and it cannot fail the callback.
     *
     * Until this, an online payment was entirely silent: the receipt landed on
     * the account and the deposit on the document, and nothing announced
     * either — so a customer could pay overnight and the shop would find out by
     * happening to open the right screen.
     *
     * After the posting rather than instead of it, and swallowing its own
     * errors: the money has arrived and been recorded by now, and a failure to
     * ring a bell must not make this endpoint report an error PayFast would
     * answer by retrying a payment that is already settled.
     */
    await announce(claim.siteId, outcome.intent.purpose, targetId, amount, providerRef).catch(
      (error) => console.error('[payfast] announce failed', error),
    )

    return ack()
  } catch (error) {
    // Never leak internals to a public endpoint. The intent stays pending and
    // PayFast's own retry gets another go.
    console.error('[payfast] callback failed', error)
    return ack()
  }
}

/**
 * PayFast occasionally probes the notify URL with a GET. Answering plainly
 * keeps it from reporting the endpoint as unreachable.
 */
export async function GET() {
  return new NextResponse('OK', { status: 200 })
}
