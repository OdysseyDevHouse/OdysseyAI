import 'server-only'
import { getSettings } from './site/settings'

/**
 * WhatsApp messages, via the Meta WhatsApp Business Cloud API.
 *
 * Per SITE, not per deployment: the number belongs to the shop, so its phone
 * number id and access token are settings rows the owner pastes in, never env
 * vars that would force every site to share one sender.
 *
 * ── IT NEVER THROWS ──────────────────────────────────────────────────────
 *
 * Same contract as mail.ts and the SMS seam, and here it matters more. An alert
 * fans out over several channels at once; a WhatsApp token that expired last
 * night must cost the shop its WhatsApp message, not the email that was going
 * out beside it — and must certainly not fail the run and have it retried,
 * re-sending every email three times over.
 *
 * ── THE 24-HOUR WINDOW ───────────────────────────────────────────────────
 *
 * Baked into the Cloud API, not into this code: free-text messages deliver only
 * inside a 24-hour window opened by the recipient messaging the business.
 * Outside it, Meta requires a pre-approved template and rejects plain text.
 *
 * For alerts this is usually fine — the recipients are the shop's own staff,
 * who reply to their own alerts. It is not GUARANTEED fine, which is why a
 * rejection surfaces as a note on the run rather than being swallowed: the
 * screen can say "WhatsApp to 082… failed" and somebody can act on it.
 */

export type WhatsAppResult = {
  sent: boolean
  /** The number the message went to, in the form the API accepted. */
  to?: string
  skipped?: 'not-configured' | 'no-number'
  error?: string
}

/**
 * A local number to the digits the API wants: '082 123 4567' → '27821234567'.
 *
 * Meta wants no '+' and no separators. A number already carrying a country code
 * passes through, so a shop with foreign staff types the full international
 * form and it works.
 */
export function toWhatsAppNumber(raw: string, countryCode = '27'): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('0')) return countryCode + digits.slice(1)
  return digits
}

type WhatsAppConfig = { phoneId: string; token: string }

/** The site's credentials, or null when WhatsApp is off or half-configured. */
async function config(siteId: number): Promise<WhatsAppConfig | null> {
  const s = await getSettings(siteId, ['whatsapp_enabled', 'whatsapp_phone_id', 'whatsapp_token'])
  if (s.whatsapp_enabled !== '1') return null
  const phoneId = (s.whatsapp_phone_id ?? '').trim()
  const token = (s.whatsapp_token ?? '').trim()
  if (!phoneId || !token) return null
  return { phoneId, token }
}

export async function isWhatsAppConfigured(siteId: number): Promise<boolean> {
  try {
    return (await config(siteId)) !== null
  } catch {
    // A settings read that fails is not "configured" — and is certainly not a
    // reason to throw at whoever asked.
    return false
  }
}

/** How long to wait on Meta before giving up on one message. */
const TIMEOUT_MS = 15_000

/** Send one plain-text WhatsApp message. Never throws. */
export async function sendWhatsAppText(
  siteId: number,
  rawNumber: string,
  text: string,
): Promise<WhatsAppResult> {
  try {
    const cfg = await config(siteId)
    if (!cfg) return { sent: false, skipped: 'not-configured' }

    const to = toWhatsAppNumber(rawNumber)
    if (!to) return { sent: false, skipped: 'no-number' }

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        // A hung request must not hold the tick open behind it: every other
        // rule on this site is waiting for the sweep to finish.
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      },
    )

    if (!response.ok) {
      // Meta's error body carries the reason a support call actually needs
      // ("token expired", "outside the 24-hour window"), so it is reported
      // rather than replaced with a status code.
      const detail = await readError(response)
      return { sent: false, to, error: detail }
    }

    return { sent: true, to }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The message could not be sent.'
    return { sent: false, error: message.slice(0, 300) }
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    const message = body?.error?.message
    if (message) return String(message).slice(0, 300)
  } catch {
    // Not JSON, or the body was already consumed — the status is what is left.
  }
  return `WhatsApp returned ${response.status}.`
}
