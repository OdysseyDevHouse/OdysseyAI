import { NextResponse, type NextRequest } from 'next/server'
import { readCallbackToken } from '@/lib/callbackToken'
import { verifyItn } from '@/lib/payfast/itn'
import { getGateway, getIntent, settleIntent } from '@/lib/site/payments'
import { invoicePaidOrder, markOrderPayment } from '@/lib/site/paidOrders'

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  // 1. Which store, which payment — from a value we minted, never from the body.
  const claim = await readCallbackToken(token)
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

    // 5. The money is confirmed in. Now the order becomes a real invoice.
    await markOrderPayment(claim.siteId, outcome.intent.targetId, 'paid')

    const invoiced = await invoicePaidOrder(
      claim.siteId,
      outcome.intent.targetId,
      verified.data.amountGross,
      verified.data.providerRef || claim.reference,
    )

    if (!invoiced.ok) {
      // The payment stands — the money really did arrive. Only the paperwork
      // failed, and that is a job for a person, not a reason to unwind a
      // settled payment.
      console.error(
        `[payfast] settled ${claim.reference} but could not invoice order ${outcome.intent.targetId}: ${invoiced.error}`,
      )
    }

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
