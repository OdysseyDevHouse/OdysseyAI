import 'server-only'
import { promises as dns } from 'node:dns'
import { verifyItnSignature } from './signature'

/**
 * ITN (Instant Transaction Notification) — the server-to-server callback
 * PayFast posts when a payment completes.
 *
 * THIS IS THE ONLY THING THAT MAY MARK AN ORDER PAID. Not the shopper's
 * browser landing back on a return URL: that URL is under the shopper's
 * control and can be visited directly, so treating it as proof of payment
 * means handing over goods for money that never arrived.
 *
 * PayFast publish a four-step verification and we do all four:
 *
 *   1. the signature matches, rebuilt with THIS STORE's passphrase
 *   2. the source IP belongs to PayFast
 *   3. posting the body back to PayFast returns VALID
 *   4. business checks — the merchant is ours, the amount is what we expected
 *
 * Any one of them failing means the callback is not acted on. Steps 1 and 3
 * are the substantive ones; 2 and 4 are defence in depth and cost nothing.
 */

export type PayFastConfig = {
  merchantId: string
  passphrase: string
  sandbox: boolean
}

export type ItnData = {
  reference: string
  providerRef: string
  paymentStatus: string
  amountGross: number
  raw: Record<string, string>
}

export type ItnResult =
  | { valid: true; data: ItnData }
  | { valid: false; reason: string; data?: ItnData }

/**
 * PayFast publish hostnames rather than a fixed IP list, so the documented
 * approach is to resolve them at check time.
 */
const PAYFAST_HOSTS = [
  'www.payfast.co.za',
  'sandbox.payfast.co.za',
  'w1w.payfast.co.za',
  'w2w.payfast.co.za',
]

async function payfastIps(): Promise<Set<string>> {
  const ips = new Set<string>()
  await Promise.all(
    PAYFAST_HOSTS.map(async (host) => {
      try {
        for (const addr of await dns.lookup(host, { all: true })) ips.add(addr.address)
      } catch {
        /* a host that will not resolve simply contributes nothing */
      }
    }),
  )
  return ips
}

/**
 * Parse the urlencoded body into ORDERED entries.
 *
 * Order is not incidental: the ITN signature is built over the fields in the
 * order PayFast sent them, so an unordered object cannot reproduce it. This is
 * also why the route must read the RAW body rather than letting a framework
 * parse it into a map.
 */
export function parseItnBody(body: string): [string, string][] {
  return body
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=')
      const key = at === -1 ? pair : pair.slice(0, at)
      const value = at === -1 ? '' : pair.slice(at + 1)
      // PayFast encodes spaces as '+', which decodeURIComponent does not undo.
      return [
        decodeURIComponent(key.replace(/\+/g, ' ')),
        decodeURIComponent(value.replace(/\+/g, ' ')),
      ] as [string, string]
    })
}

function validateUrl(sandbox: boolean): string {
  return sandbox
    ? 'https://sandbox.payfast.co.za/eng/query/validate'
    : 'https://www.payfast.co.za/eng/query/validate'
}

/** Step 3: hand the payload back to PayFast and require VALID. */
async function postBack(body: string, sandbox: boolean): Promise<boolean> {
  try {
    const response = await fetch(validateUrl(sandbox), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    return (await response.text()).trim().startsWith('VALID')
  } catch {
    // A network failure is NOT a pass. Better to leave a real payment pending
    // and let the retry settle it than to bank one we could not confirm.
    return false
  }
}

/**
 * Run the full verification.
 *
 * `config` supplies the credentials to verify AGAINST — specifically the
 * passphrase the signature is rebuilt with. A callback for store A must be
 * checked with store A's passphrase and must fail against anyone else's.
 *
 * Note the ordering this forces on callers: the store has to be resolved
 * BEFORE verification, because verification needs its secret. That is what the
 * signed callback token on the notify URL is for — see lib/callbackToken.ts.
 */
export async function verifyItn(
  rawBody: string,
  sourceIp: string | null,
  config: PayFastConfig,
  expectedAmount?: number,
  /** Injectable so tests can exercise every branch without the network. */
  deps: { postBack?: typeof postBack; resolveIps?: typeof payfastIps } = {},
): Promise<ItnResult> {
  const entries = parseItnBody(rawBody)
  const map = Object.fromEntries(entries) as Record<string, string>

  const data: ItnData = {
    reference: map.m_payment_id ?? '',
    providerRef: map.pf_payment_id ?? '',
    paymentStatus: (map.payment_status ?? '').toUpperCase(),
    amountGross: Number(map.amount_gross ?? '0'),
    raw: map,
  }

  // 1. Signature — the substantive check. Everything else is corroboration.
  if (!verifyItnSignature(entries, map.signature ?? '', config.passphrase)) {
    return { valid: false, reason: 'signature mismatch', data }
  }

  // 2. Source IP. Skipped in sandbox, where tunnels and local testing rewrite
  //    the source and the check would only ever produce false negatives.
  if (!config.sandbox && sourceIp) {
    const allowed = await (deps.resolveIps ?? payfastIps)()
    if (allowed.size > 0 && !allowed.has(sourceIp)) {
      return { valid: false, reason: `source IP ${sourceIp} is not PayFast`, data }
    }
  }

  // 3. Post-back.
  if (!(await (deps.postBack ?? postBack)(rawBody, config.sandbox))) {
    return { valid: false, reason: 'PayFast did not confirm this payload', data }
  }

  // 4. The callback must name the merchant we expect. A correct signature
  //    already proves the sender holds this account's passphrase, so this is
  //    belt-and-braces — but it is what stops a payload for merchant A ever
  //    settling against store B's intent, whatever routing mistake a future
  //    refactor might introduce.
  const claimed = (map.merchant_id ?? '').trim()
  if (config.merchantId && claimed && claimed !== config.merchantId) {
    return { valid: false, reason: 'this payment belongs to a different merchant', data }
  }

  // The amount is checked against what we RECORDED when the intent was
  // created, never against what the payload says about itself.
  if (expectedAmount !== undefined && Math.abs(data.amountGross - expectedAmount) > 0.01) {
    return {
      valid: false,
      reason: `amount mismatch: got ${data.amountGross}, expected ${expectedAmount}`,
      data,
    }
  }

  return { valid: true, data }
}
