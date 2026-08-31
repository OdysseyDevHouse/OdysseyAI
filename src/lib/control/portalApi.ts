import 'server-only'
import { createHash, createHmac } from 'node:crypto'

/**
 * The control panel over HTTPS, signed as this shop.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Everything under lib/control/ reaches the control database through a raw
 * MySQL socket on port 3306. On our own servers that is right. On a customer's
 * Windows machine it is the wall the setup wizard hit: it works from a
 * whitelisted office network and nowhere else, and it means every installer
 * carries credentials that read the device register of every shop on the
 * platform.
 *
 * The portal's POS API replaces the transport for the calls a machine has to
 * make on its own. One POST over TLS, through any firewall that allows ordinary
 * web traffic, answering only for the shop that signed the request.
 *
 * ── HOW A MACHINE PROVES WHICH SHOP IT IS ───────────────────────────────────
 *
 * Two credentials, neither of which is a person's:
 *
 *   · the BUILD — client id and secret, baked by scripts/make-build-defaults.
 *     A customer can unpack these from an asar and the portal's own
 *     documentation says so; they are the outer lock, not the answer.
 *   · the SHOP — an HMAC over the request, keyed with a per-site key the portal
 *     issues through /login and OdysseyAI Database Setup stores on the machine.
 *
 * The signature covers the method, the path, a timestamp and a digest of the
 * body. Method and path are in there so a signature captured from one endpoint
 * cannot be replayed against another; the body is hashed rather than
 * concatenated so a value containing a newline cannot forge a line.
 *
 * ── WHY THE BODY IS SERIALISED EXACTLY ONCE ─────────────────────────────────
 *
 * `send()` signs the string it is about to transmit, and transmits that same
 * string. Signing an object and re-serialising it for the wire is the classic
 * way to build a client that passes its own tests and fails in the field: two
 * encoders disagree about key order and whitespace, and the server hashes what
 * actually arrived.
 */

export type PortalConfig = {
  baseUrl: string
  clientId: string
  clientSecret: string
  siteId: number
  key: string
  keyId: string
}

/**
 * Is this machine set up to call the portal as its shop?
 *
 * Null is the ordinary answer, not an error: a cloud install, the web build, a
 * developer checkout, or a machine provisioned before the portal issued site
 * keys. Every caller falls back to the direct connection it used before, which
 * is why nothing here throws when the answer is no.
 */
export function portalConfig(): PortalConfig | null {
  const key = process.env.ODYSSEY_SITE_API_KEY?.trim()
  const keyId = process.env.ODYSSEY_SITE_API_KEY_ID?.trim()
  const siteId = Number(process.env.ODYSSEY_SITE_ID)
  if (!key || !keyId || !Number.isFinite(siteId) || siteId <= 0) return null

  const clientId = process.env.POS_API_CLIENT_ID?.trim()
  const clientSecret = process.env.POS_API_CLIENT_SECRET?.trim()
  const raw = process.env.POS_API_URL?.trim()
  if (!clientId || !clientSecret || !raw) return null

  return { baseUrl: normaliseUrl(raw), clientId, clientSecret, siteId, key, keyId }
}

/**
 * Accept whatever form the URL was configured in.
 *
 * `portal.example.co.za`, `https://portal.example.co.za` and the full
 * `https://portal.example.co.za/api/pos/v1` all mean the same thing, and the
 * person setting it should not have to know which one this code wanted. A
 * missing scheme is https rather than http — there is no version of this call
 * that should travel in the clear. Deliberately identical to the rule in
 * electron/posApi.js, because one value configures both.
 */
function normaliseUrl(value: string): string {
  let url = value.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!/\/api\/pos\/v\d+$/i.test(url)) url = `${url}/api/pos/v1`
  return url
}

/**
 * How long to wait before deciding the portal is not going to answer.
 *
 * ── SHORT, AND THAT IS THE WHOLE POINT ──────────────────────────────────────
 *
 * The licence check runs inside a finalised sale. Its caller fails open, so a
 * timeout costs nothing but the wait — and the wait is paid by a cashier with a
 * customer in front of them. Four seconds matches SITE_DB_CONNECT_TIMEOUT_MS,
 * which was chosen for the same reason on the same machines.
 *
 * A slow answer here is worse than a fast failure: the fallback is honest and
 * instant, and a shop that never notices the portal is down is the shop this
 * design is for.
 */
const TIMEOUT_MS = Number(process.env.PORTAL_API_TIMEOUT_MS || 4000)

/**
 * The exact string both ends sign.
 *
 * ── PINNED, NOT DESCRIBED ───────────────────────────────────────────────────
 *
 * The portal computes this independently, in its own repository, from the same
 * four lines documented in POS_API.md §6.2. If the two ever disagree by a
 * character, every signed call from every shop fails at once — so this is
 * exported and asserted literally by scripts/test-portal-signing.ts rather than
 * left as an implementation detail of send().
 *
 * The body is HASHED rather than appended: a large body must not make the
 * signing string grow without bound, and a body containing a newline must not
 * be able to forge a fifth line.
 */
export function signingString(
  method: string,
  path: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHash('sha256').update(rawBody ?? '', 'utf8').digest('hex')
  return [method.toUpperCase(), path, timestamp, digest].join('\n')
}

/** HMAC-SHA256 of the signing string, keyed with the site key's raw bytes. */
export function signatureFor(
  keyB64: string,
  method: string,
  path: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac('sha256', Buffer.from(keyB64, 'base64'))
    .update(signingString(method, path, timestamp, rawBody), 'utf8')
    .digest('base64')
}

export type PortalResult<T> =
  | { ok: true; data: T }
  /**
   * Unreachable, timed out, or answered with something that is not an answer.
   * The caller decides what to do about it, and on this API that is always
   * "fall back" rather than "fail" — see requireDevice.ts for why.
   */
  | { ok: false; reason: 'unreachable'; error: string }
  /** The portal answered, and the answer was a refusal. Not a transport fault. */
  | { ok: false; reason: 'refused'; error: string; code: string; status: number }

/**
 * One signed call.
 *
 * `path` is relative to the API root — `/licence/check`. The signature covers
 * the FULL path the request is sent to, because that is what the server sees.
 */
export async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  serial?: string | null,
): Promise<PortalResult<T>> {
  const cfg = portalConfig()
  if (!cfg) return { ok: false, reason: 'unreachable', error: 'This machine has no portal key.' }

  /* Serialised once, here, and both signed and sent. See the header. */
  const raw = body === undefined ? '' : JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const url = `${cfg.baseUrl}${path}`
  const signedPath = new URL(url).pathname

  const signature = signatureFor(cfg.key, method, signedPath, timestamp, raw)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Client-Id': cfg.clientId,
    'X-Api-Client-Secret': cfg.clientSecret,
    'X-Site-Id': String(cfg.siteId),
    'X-Key-Id': cfg.keyId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  }
  /* A claim about which machine is asking, never proof of anything. The portal
     records it and does not gate on it. */
  if (serial) headers['X-Device-Serial'] = serial.slice(0, 190)

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      /* Never a cached licence. Next would otherwise happily serve a previous
         answer to a question whose whole value is that it is current. */
      cache: 'no-store',
    })

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* A proxy error page, or an empty body. Treated as unreachable rather
         than refused: the portal did not decide anything. */
    }

    if (response.ok) return { ok: true, data: payload as T }

    const error = payload as { error?: string; message?: string } | null
    const code = String(error?.error ?? `http_${response.status}`)

    /* ── A CLOCK PROBLEM IS THE MACHINE'S, AND IS SAID SO ───────────────────
     *
     * The portal discloses this one refusal deliberately, because it is the
     * only auth failure the customer can fix themselves. Passed through with
     * its own message rather than flattened into "unreachable", which would
     * leave a shop staring at a network error while the answer is on the
     * taskbar in front of them. */
    return {
      ok: false,
      reason: 'refused',
      code,
      status: response.status,
      error: String(error?.message ?? `The control panel refused the request (${response.status}).`),
    }
  } catch (err) {
    /* No line, DNS gone, TLS refused, or the four seconds ran out. All the same
       thing to a caller: the portal cannot answer right now. */
    return { ok: false, reason: 'unreachable', error: err instanceof Error ? err.message : String(err) }
  }
}
