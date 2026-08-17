import { NextResponse, type NextRequest } from 'next/server'
import { readBillingCallbackToken } from '@/lib/billingCallbackToken'
import { platformPayFast } from '@/lib/payfast/platformConfig'
import { verifyItn, parseItnBody } from '@/lib/payfast/itn'
import { recordItnPayment, subscriptionForAccount } from '@/lib/control/subscriptions'
import { sitesForAccount } from '@/lib/control/modules'
import { provisionDevices } from '@/lib/control/modules'
import { toNum } from '@/lib/decimals'

/**
 * PayFast ITN for a PLATFORM subscription — Odyssey collecting from a tenant.
 *
 * Not to be confused with /api/payments/payfast/[token], which is a tenant
 * shop collecting from its own shoppers with that shop's own credentials. The
 * two are kept apart by their token audiences: a store token verifies to null
 * here and a billing token verifies to null there, so neither route can ever
 * settle the other's money.
 *
 * ── THIS IS THE ONLY THING THAT MAY ACTIVATE A SUBSCRIPTION ────────────────
 *
 * Not the customer's browser landing on a return URL — that URL is under their
 * control and can simply be typed.
 *
 * ── 200 FOR A DECISION, 500 FOR A FAILURE TO RECORD ────────────────────────
 *
 * PayFast retries anything that is not a 200, so the store route answers 200
 * to everything: a retry cannot fix a forged signature, and returning 500
 * would buy an endless loop over a request already correctly refused.
 *
 * That reasoning holds for every DECISION here too — rejected, duplicate,
 * unknown account, all 200. But it does NOT hold for a failure to WRITE. If
 * the payment cannot be recorded, the retry is precisely the thing that saves
 * it, and answering 200 throws real money away permanently with nothing but a
 * log line to show for it. So a write failure answers 500 and lets PayFast try
 * again. That distinction is the one thing in this file worth defending.
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

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  // 1. Which account — from a value WE minted, never from the body.
  const claim = await readBillingCallbackToken(token)
  if (!claim) {
    console.warn('[payfast-sub] callback with an unreadable token')
    return ack()
  }

  // The RAW body. The ITN signature is built over the fields in the order they
  // arrive, so anything that parses into an object first breaks verification.
  const rawBody = await req.text()
  const fields = Object.fromEntries(parseItnBody(rawBody))
  const pfPaymentId = (fields.pf_payment_id ?? '').trim()
  const mPaymentId = (fields.m_payment_id ?? '').trim() || null

  /* 2. No payment id, no idempotency key — so there is nothing safe to store
        and nothing to be idempotent about. Refused before the insert rather
        than stored with a NULL, which the unique index would happily accept
        over and over. */
  if (!pfPaymentId) {
    console.warn('[payfast-sub] payload with no pf_payment_id', {
      accountId: claim.accountId,
      mPaymentId,
    })
    return ack()
  }

  try {
    const config = platformPayFast()
    const sub = await subscriptionForAccount(claim.accountId)

    if (!sub) {
      console.warn('[payfast-sub] no subscription for account', {
        accountId: claim.accountId,
        pfPaymentId,
      })
      return ack()
    }

    /* 3. The expected amount is checked ONLY for the first collection.

          For renewals it is deliberately not passed. An escalation or a plan
          change that PayFast applied but we failed to persist would otherwise
          make every later collection "fail" the amount check and be refused —
          turning a bookkeeping drift into refused money. The real figure is
          recorded on the payment row either way, and a mismatch is a report
          for a person rather than a reason to turn money away. */
    const expectedAmount = sub.status === 'pending' ? (sub.pendingAmount ?? undefined) : undefined

    const verified = await verifyItn(
      rawBody,
      sourceIp(req),
      { merchantId: config.merchantId, passphrase: config.passphrase, sandbox: config.sandbox },
      expectedAmount,
    )

    const status = (fields.payment_status ?? '').toUpperCase()

    // 4. Write it down. The unique key on pf_payment_id is what makes a replay
    //    a no-op — see recordItnPayment.
    const result = await recordItnPayment({
      accountId: claim.accountId,
      pfPaymentId,
      mPaymentId,
      pfToken: (fields.token ?? '').trim() || null,
      amountGross: toNum(fields.amount_gross),
      amountFee: Math.abs(toNum(fields.amount_fee)),
      amountNet: toNum(fields.amount_net),
      paymentStatus: status || 'UNKNOWN',
      verified: verified.valid,
      rejectReason: verified.valid ? null : verified.reason.slice(0, 190),
      billingDate: (fields.billing_date ?? '').slice(0, 10) || null,
      rawPayload: rawBody,
      sourceIp: sourceIp(req),
    })

    if (result.outcome === 'duplicate') {
      // Seen before. The subscription was never read, locked or touched.
      return ack()
    }

    if (result.outcome === 'rejected') {
      /* Every rejection names the account and both references, because the
         alternative is a support call nobody can investigate. The raw body is
         on the row rather than in the log — logs rotate, rows do not. */
      console.warn('[payfast-sub] rejected', {
        accountId: claim.accountId,
        pfPaymentId,
        mPaymentId,
        reason: verified.valid ? 'subscription state moved' : verified.reason,
      })
      return ack()
    }

    if (result.outcome === 'failed') {
      console.warn('[payfast-sub] collection did not complete', {
        accountId: claim.accountId,
        pfPaymentId,
        status,
      })
      return ack()
    }

    /* 5. The money is confirmed. Provision the till licences that were ordered
          and paid for.

          OUTSIDE the transaction above: provisionDevices opens its own, and
          nesting would deadlock against the subscription row lock. It is also
          idempotent — it reconciles to the requested count — so running it on
          every renewal is safe and quietly self-heals a site whose
          provisioning failed last month. */
    const sites = await sitesForAccount(claim.accountId)
    for (const site of sites) {
      const provisioned = await provisionDevices(site.siteId, {
        // Nobody is signed in at a callback. The audit trail records where it
        // came from rather than pretending a person keyed it.
        name: 'PayFast',
        email: null,
      })
      if (!provisioned.ok) {
        /* The payment stands — the money really did arrive. Only the
           paperwork failed, and that is a job for a person, not a reason to
           unwind a settled payment. */
        console.error('[payfast-sub] provisioning failed after payment', {
          accountId: claim.accountId,
          siteId: site.siteId,
          pfPaymentId,
          error: provisioned.error,
        })
      }
    }

    console.info('[payfast-sub] settled', {
      accountId: claim.accountId,
      pfPaymentId,
      outcome: result.outcome,
    })
    return ack()
  } catch (error) {
    /* We could not write it down. This is the one case where a retry helps, so
       ask for one — answering 200 here would discard a real payment for good. */
    console.error('[payfast-sub] could not record callback', {
      accountId: claim.accountId,
      pfPaymentId,
      error,
    })
    return retry()
  }
}

/** PayFast probes notify URLs with a GET; answering keeps it from complaining. */
export async function GET() {
  return new NextResponse('OK', { status: 200 })
}
