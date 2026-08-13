import 'server-only'
import { truncateSms, type SmsProvider, type SmsSendResult } from './types'

/**
 * SMSPortal, over their REST API (https://rest.smsportal.com).
 *
 * Kept deliberately thin: authenticate with the client id/secret pair for a
 * bearer token, post one message, map anything that is not a 2xx to an error
 * string. Verify shapes against docs.smsportal.com if their API moves — this
 * was written against the v1 flow: GET /v1/Authentication with Basic auth,
 * then POST /v1/bulkmessages.
 *
 * The token is cached per credentials for a few minutes rather than per
 * process forever: a rotated secret must take effect without a restart, and
 * a token request per message would double every send.
 */

const BASE = 'https://rest.smsportal.com/v1'
const TOKEN_TTL_MS = 5 * 60_000

let cachedToken: { key: string; token: string; expiresAt: number } | null = null

async function bearerToken(clientId: string, secret: string): Promise<string> {
  const key = `${clientId}:${secret}`
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token
  }

  const response = await fetch(`${BASE}/Authentication`, {
    headers: { Authorization: `Basic ${Buffer.from(key).toString('base64')}` },
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`SMSPortal refused the credentials (HTTP ${response.status}).`)
  }
  const body = (await response.json()) as { token?: string }
  if (!body.token) throw new Error('SMSPortal returned no token.')

  cachedToken = { key, token: body.token, expiresAt: Date.now() + TOKEN_TTL_MS }
  return body.token
}

export function smsPortalProvider(clientId: string, secret: string): SmsProvider {
  return {
    name: 'smsportal',
    async send(to, body): Promise<SmsSendResult> {
      try {
        const token = await bearerToken(clientId, secret)
        const response = await fetch(`${BASE}/bulkmessages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [{ content: truncateSms(body), destination: to }],
          }),
          cache: 'no-store',
        })

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          return {
            ok: false,
            error: `SMSPortal refused the message (HTTP ${response.status})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
          }
        }

        const result = (await response.json().catch(() => ({}))) as {
          eventId?: number | string
        }
        return { ok: true, id: result.eventId !== undefined ? String(result.eventId) : undefined }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'SMSPortal could not be reached.',
        }
      }
    },
  }
}
