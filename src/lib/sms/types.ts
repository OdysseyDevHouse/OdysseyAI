/**
 * The SMS seam — one interface, pluggable providers.
 *
 * Report-don't-throw, exactly mail.ts's contract and for the same reason: a
 * dunning run is a batch of independent sends, and one dead number must mark
 * ONE row failed rather than abort the run.
 *
 * V1 SCOPE, stated so nobody hunts for the missing half: outbound only. No
 * inbound messages, no delivery webhooks — `ok` means the PROVIDER ACCEPTED
 * the message, which is the strongest claim a send response can make. What
 * happened after that lives in the provider's own portal.
 *
 * Deliberately NOT `server-only`: the shapes and the length rule are needed
 * by the setup screen's live character count.
 */

export type SmsSendResult = { ok: true; id?: string } | { ok: false; error: string }

export type SmsProvider = {
  name: string
  /** `to` must already be normalised — see phone.ts. */
  send(to: string, body: string): Promise<SmsSendResult>
}

/**
 * Two GSM segments. A template is capped here at SEND time rather than
 * refused, because a dunning message cut at 320 characters still dunned —
 * the editor shows a live count so it never comes to that.
 */
export const SMS_MAX_LENGTH = 320

export function truncateSms(body: string): string {
  const trimmed = body.trim()
  return trimmed.length <= SMS_MAX_LENGTH ? trimmed : `${trimmed.slice(0, SMS_MAX_LENGTH - 1)}…`
}

/**
 * What the setup screen shows in place of a stored secret. An unchanged mask
 * round-trips as "leave it alone", so opening the page and pressing Save can
 * never corrupt working credentials.
 */
export const SMS_SECRET_MASK = '••••••••'
