/**
 * PayFast's own published sandbox account.
 *
 * These are not secrets and never were: PayFast documents them so anybody can
 * post a test payment without registering. Hard-coding them is the point — a
 * shop switching on Test mode should not have to go and find them.
 *
 * ── WHY THIS FILE IS NOT checkout.ts ──────────────────────────────────────
 *
 * It belongs beside PAYFAST_PROCESS_URL: "how you talk to PayFast's test
 * environment" is one fact, and splitting it across files is how the URL and
 * the credentials drift apart. But every other module in this folder is
 * `server-only`, and the setup form that needs these is a client component —
 * importing checkout.ts there would pull server code into the browser bundle
 * and fail the build. So the constant lives here, with no imports at all, and
 * checkout.ts re-exports it to keep the two findable together.
 *
 * ── THE PASSPHRASE IS SET, AND MUST BE SENT ───────────────────────────────
 *
 * This said empty, on the reasoning that a fresh sandbox account has none — and
 * that a passphrase PayFast is not expecting fails every signature. Both halves
 * were true once. PayFast's shared sandbox account now HAS one, so the empty
 * value produced the opposite failure: a perfectly well-formed md5 rejected as
 * "Generated signature does not match submitted signature", which names nothing
 * and sends you looking at the encoding, the field order and the key first.
 *
 * VERIFIED by posting to https://sandbox.payfast.co.za/eng/process: the blank
 * passphrase returns 400 with that message, and this value returns 302 to a
 * real payment page. Do not "simplify" it back to empty without repeating that
 * test — the value below is the only thing separating the two outcomes.
 *
 * A shop that sets its own passphrase in the sandbox dashboard types it in,
 * which overwrites this.
 */
export const PAYFAST_SANDBOX_CREDENTIALS = {
  merchantId: '10000100',
  merchantKey: '46f0cd694581a',
  passphrase: 'jt7NOE43FZPn',
} as const
