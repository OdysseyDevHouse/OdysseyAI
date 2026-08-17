import 'server-only'
import { buildApiSignature } from './signature'
import type { PlatformPayFastConfig } from './platformConfig'

/**
 * PayFast's subscription management API — pause, cancel, change the amount.
 *
 * ── THE HOST IS THE SAME IN BOTH MODES ─────────────────────────────────────
 *
 * There is no sandbox.api.payfast.co.za. Sandbox is signalled by a `testing`
 * query parameter against the same host, so inventing a sandbox hostname gives
 * DNS errors that read like an outage.
 *
 * ── NOTHING HERE THROWS ────────────────────────────────────────────────────
 *
 * Every call returns a result object. Each caller has to decide what a failed
 * PayFast call means locally — usually "keep the local change and reconcile
 * later" — and an exception pushes that decision into a catch block where it
 * gets swallowed.
 */

export const PAYFAST_API_URL = 'https://api.payfast.co.za'

export type ApiResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

/**
 * PayFast wants `YYYY-MM-DDTHH:mm:ss+HH:MM` with a real offset.
 *
 * Not `toISOString()`: that ends in `Z`, which PayFast rejects. The offset is
 * the server's own, so a machine with a wrong clock produces rejections that
 * surface only as a failed management call — worth knowing when one of these
 * starts failing for no visible reason.
 */
function timestamp(now: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`
  )
}

type Deps = {
  /** Injected so every branch is testable without the network. */
  fetchImpl?: typeof fetch
  now?: () => Date
}

async function call<T>(
  config: PlatformPayFastConfig,
  method: 'GET' | 'PUT' | 'PATCH',
  path: string,
  body: Record<string, string | number> | undefined,
  deps: Deps,
): Promise<ApiResult<T>> {
  const doFetch = deps.fetchImpl ?? fetch
  const now = (deps.now ?? (() => new Date()))()

  const headers: Record<string, string> = {
    'merchant-id': config.merchantId,
    version: 'v1',
    timestamp: timestamp(now),
  }

  const query: Record<string, string> = {}
  if (config.sandbox) query.testing = 'true'

  /* The signature covers headers, query and body together — and is computed
     BEFORE content-type is added, because content-type is not part of it. */
  headers.signature = buildApiSignature({ ...headers, ...query, ...(body ?? {}) }, config.passphrase)

  const qs = new URLSearchParams(query).toString()
  const url = `${PAYFAST_API_URL}/${path}${qs ? `?${qs}` : ''}`

  const init: RequestInit = {
    method,
    headers,
    // A hung gateway must not hold a server action open. The ITN path already
    // works to a 10s budget; a management call gets a little more.
    signal: AbortSignal.timeout(15_000),
  }
  if (body) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  try {
    const response = await doFetch(url, init)
    const text = await response.text()

    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {
      /* Some endpoints answer in plain text; keep it as-is. */
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: text.slice(0, 300) || response.statusText }
    }
    return { ok: true, data: data as T }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'PayFast could not be reached',
    }
  }
}

export type SubscriptionSnapshot = {
  status?: number
  run_date?: string
  amount?: number
  cycles?: number
  frequency?: number
}

/** What PayFast currently believes about this mandate. */
export function fetchSubscription(
  config: PlatformPayFastConfig,
  pfToken: string,
  deps: Deps = {},
): Promise<ApiResult<SubscriptionSnapshot>> {
  return call(config, 'GET', `subscriptions/${pfToken}/fetch`, undefined, deps)
}

/** Skip `cycles` collections. Access is a separate question — see modules.ts. */
export function pauseSubscription(
  config: PlatformPayFastConfig,
  pfToken: string,
  cycles = 1,
  deps: Deps = {},
): Promise<ApiResult> {
  return call(config, 'PUT', `subscriptions/${pfToken}/pause`, { cycles }, deps)
}

export function unpauseSubscription(
  config: PlatformPayFastConfig,
  pfToken: string,
  deps: Deps = {},
): Promise<ApiResult> {
  return call(config, 'PUT', `subscriptions/${pfToken}/unpause`, undefined, deps)
}

export function cancelSubscription(
  config: PlatformPayFastConfig,
  pfToken: string,
  deps: Deps = {},
): Promise<ApiResult> {
  return call(config, 'PUT', `subscriptions/${pfToken}/cancel`, undefined, deps)
}

/**
 * Change what PayFast collects from the next billing date onward.
 *
 * ── THE API TAKES CENTS, THE CHECKOUT TAKES RANDS ──────────────────────────
 *
 * That asymmetry is real and it is how a subscription accidentally becomes
 * R1.79 instead of R179.00 — a hundredfold undercharge that errors nowhere and
 * looks fine on every screen. The conversion happens HERE and nowhere else, so
 * every caller passes rands like the rest of the codebase.
 */
export function updateSubscriptionAmount(
  config: PlatformPayFastConfig,
  pfToken: string,
  amountIncl: number,
  deps: Deps = {},
): Promise<ApiResult> {
  return call(
    config,
    'PATCH',
    `subscriptions/${pfToken}/update`,
    { amount: Math.round(amountIncl * 100) },
    deps,
  )
}
