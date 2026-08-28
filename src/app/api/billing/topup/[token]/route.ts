import { NextResponse, type NextRequest } from 'next/server'
import { readAiTopupToken } from '@/lib/aiTopupToken'
import { platformPayFast } from '@/lib/payfast/platformConfig'
import { verifyItn, parseItnBody } from '@/lib/payfast/itn'
import { pendingByReference, settleTopup } from '@/lib/aiCredits/ledger'

/**
 * PayFast ITN for an AI-CREDITS TOP-UP — Odyssey selling credit to a tenant.
 *
 * The third PayFast callback in this codebase, and the sibling of
 * /api/billing/payfast/[token], which settles the monthly subscription. Both
 * collect on the platform's merchant credentials; this one is a once-off charge
 * that adds to a wallet, and that one is a recurring mandate.
 *
 * They are kept apart by their token audiences — a subscription token verifies
 * to null here and a top-up token verifies to null there — so neither route can
 * settle the other's money even if a notify URL were misconfigured.
 *
 * ── THIS IS THE ONLY THING THAT MAY CREDIT A WALLET ────────────────────────
 *
 * Not the customer's browser landing on a return URL: that URL is under their
 * control and can simply be typed.
 *
 * ── 200 FOR A DECISION, 500 FOR A FAILURE TO RECORD ────────────────────────
 *
 * Copied deliberately from the subscription route, whose header argues it in
 * full. In short: PayFast retries anything that is not a 200, and a retry
 * cannot fix a forged signature or an unknown reference — so every DECISION
 * answers 200. A failure to WRITE is the opposite: the retry is precisely what
 * saves it, and answering 200 throws real money away permanently. So a write
 * failure answers 500.
 */

export const dynamic = 'force-dynamic'

/** Acknowledged. The decision lives in the database, not the status code. */
const ack = () => new NextResponse('OK', { status: 200 })
/** Not recorded — please retry. */
const retry = () => new NextResponse('Could not record', { status: 500 })

function sourceIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('x-real-ip')
}

/**
 * Skip the post-back to PayFast, for the end-to-end suite only.
 *
 * Identical to the subscription route's, and safe for the same three reasons:
 * never in production, never against the live gateway, and never unless the
 * variable is explicitly set — which nothing but the test command does. The
 * signature is still verified either way; this skips corroboration, not
 * authentication.
 */
function postBackDisabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.PAYFAST_SANDBOX !== 'false' &&
    process.env.ALLOW_UNVERIFIED_ITN === '1'
  )
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  // 1. Which account and which checkout — from a value WE minted and signed,
  //    never from the body.
  const claim = await readAiTopupToken(token)
  if (!claim) {
    console.warn('[payfast-topup] callback with an unreadable token')
    return ack()
  }

  // The RAW body. The ITN signature is built over the fields in the order they
  // arrive, so anything that parses into an object first breaks verification.
  const rawBody = await req.text()
  const fields = Object.fromEntries(parseItnBody(rawBody))
  const pfPaymentId = (fields.pf_payment_id ?? '').trim()

  /* 2. No payment id, no idempotency key. The unique index would accept
        unlimited NULLs, so a payload without one cannot be made replay-safe and
        is refused before anything is written. */
  if (!pfPaymentId) {
    console.warn('[payfast-topup] payload with no pf_payment_id', {
      accountId: claim.accountId,
      reference: claim.reference,
    })
    return ack()
  }

  try {
    const pending = await pendingByReference(claim.reference)

    if (!pending) {
      console.warn('[payfast-topup] no pending top-up for reference', {
        accountId: claim.accountId,
        reference: claim.reference,
        pfPaymentId,
      })
      return ack()
    }

    /* 3. The token said which account; the row must agree. A mismatch means a
          token and a reference from different checkouts have been combined,
          which is not something an honest notification can do. */
    if (pending.accountId !== claim.accountId) {
      console.warn('[payfast-topup] reference belongs to another account', {
        tokenAccountId: claim.accountId,
        rowAccountId: pending.accountId,
        reference: claim.reference,
      })
      return ack()
    }

    /* 4. Verify, checking the amount against what WE recorded when the form was
          built. Unlike a subscription — where later collections are deliberately
          not amount-checked, because an escalation PayFast applied and we failed
          to persist would turn bookkeeping drift into refused money — a top-up
          is charged exactly once, at a figure this server chose from its own
          preset list moments ago. There is no drift to tolerate, so the check
          always applies. */
    const config = platformPayFast()
    const verified = await verifyItn(
      rawBody,
      sourceIp(req),
      { merchantId: config.merchantId, passphrase: config.passphrase, sandbox: config.sandbox },
      pending.amountPay,
      postBackDisabled() ? { postBack: async () => true } : {},
    )

    // 5. Write it down. settleTopup stamps the payment id and inserts the
    //    credit in one transaction — see its docblock for why both or neither.
    const outcome = await settleTopup({
      pending,
      paymentStatus: (fields.payment_status ?? '').trim() || 'UNKNOWN',
      pfPaymentId,
      rawPayload: rawBody,
      verified: verified.valid,
    })

    if (outcome === 'rejected') {
      console.warn('[payfast-topup] rejected', {
        accountId: claim.accountId,
        reference: claim.reference,
        pfPaymentId,
        reason: verified.valid ? 'unknown' : verified.reason,
      })
    } else if (outcome === 'failed') {
      console.warn('[payfast-topup] payment did not complete', {
        accountId: claim.accountId,
        reference: claim.reference,
        status: fields.payment_status,
      })
    } else if (outcome === 'credited') {
      console.info('[payfast-topup] credited', {
        accountId: claim.accountId,
        reference: claim.reference,
        amountMicros: pending.amountMicros,
      })
    }
    // 'duplicate' is silent. A retry of something already settled is routine,
    // not an event.

    return ack()
  } catch (error) {
    /* The one case that must NOT be acknowledged. Something failed to write, so
       the payment is real and unrecorded — and PayFast's retry is what saves
       it. */
    console.error('[payfast-topup] could not record', {
      accountId: claim.accountId,
      reference: claim.reference,
      pfPaymentId,
      error,
    })
    return retry()
  }
}

/**
 * PayFast probes a notify URL with GET before it will accept it.
 *
 * Answering 200 to nothing in particular is what makes the URL configurable at
 * their end; the POST above is where anything actually happens.
 */
export async function GET() {
  return ack()
}
