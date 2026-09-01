import 'server-only'
import { portalConfig, send } from '@/lib/control/portalApi'
import type { AiFeature, TokenUsage } from './pricing'
import type { LedgerEntry } from './ledger'

/**
 * The AI wallet, asked over HTTPS instead of a MySQL socket.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * A desktop install reaches the control database today by opening port 3306 to
 * it with credentials baked into the installer — which works in an office whose
 * IP is whitelisted and nowhere else, and means every installer carries
 * credentials that read every shop on the platform. lib/control/devices.ts says
 * so in its own header; the portal is the answer, and the wallet is new code
 * that should never have needed the socket in the first place.
 *
 * ── HOW THIS DIFFERS FROM devicesPortal.ts, AND WHY ────────────────────────
 *
 * devicesPortal returns null when the portal cannot answer, and its caller asks
 * MySQL instead. That is right for a till: a licence check runs inside a
 * finalised sale, and a shop must keep trading through a bad line.
 *
 * The wallet must NOT do that, for two reasons that point the same way.
 *
 *   · Falling back to MySQL would keep the socket this exists to remove. The
 *     licence path has that debt already and is paying it down; new code should
 *     not take it on.
 *   · Failing OPEN is worse. An unreadable balance that lets the call run means
 *     free AI on Odyssey's own Anthropic account for the length of the outage,
 *     billed to us, for every shop at once.
 *
 * So there is no fallback on the SPENDING path. `unreachable` is surfaced to
 * the caller, which refuses the AI call and says why. A shop that cannot reach
 * Odyssey cannot spend Odyssey's money, which is the honest answer and the safe
 * one.
 *
 * ── DISPLAYING A BALANCE IS NOT SPENDING ───────────────────────────────────
 *
 * fetchWallet below is the exception, and it proves the rule rather than
 * bending it. Nothing is spent by DRAWING a balance, so refusing to draw one
 * protects nothing — it would only replace a working billing screen with an
 * error for a shop that came to check its modules. It returns null and lets the
 * caller read the database, exactly as devicesPortal does.
 *
 * The distinction is the direction of the failure: the meter must fail CLOSED
 * because failing open costs money, and the screen must fail SOFT because
 * failing hard costs a page.
 *
 * ── THE SERVER HALF IS NOT IN THIS REPOSITORY ──────────────────────────────
 *
 * /ai/credits/balance and /ai/credits/consume live on the control-panel
 * application, alongside the licence endpoints portalApi already calls. They
 * run the same code as lib/aiCredits/ledger.ts against the same tables.
 */

/** Is there a portal to ask? Read per call so a test can flip the env. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/* ── Balance ─────────────────────────────────────────────────────────────── */

export type PortalBalance = {
  /** Micro-USD. May be negative — see ledger.balanceMicros. */
  balanceMicros: number
  /** Which billing account answered. Recorded on the debit that follows. */
  accountId: number
  /** The account's currency, so a refusal can name a figure the shop knows. */
  currency: string
}

/**
 * What the site's account has left.
 *
 * The portal resolves site -> account itself, from the site id it already
 * authenticates with, so this asks a question rather than asserting an answer:
 * a machine cannot name someone else's wallet.
 */
export async function fetchBalance(): Promise<PortalOutcome<PortalBalance>> {
  const res = await send<PortalBalance>('GET', '/ai/credits/balance')
  if (res.ok) return { ok: true, data: res.data }
  return toFailure('ai/credits/balance', res)
}

/* ── The wallet, for the billing screen ──────────────────────────────────── */

/**
 * The balance AND the recent rows, in one call.
 *
 * ── WHY THIS IS NOT fetchBalance ────────────────────────────────────────────
 *
 * Same endpoint, different question. fetchBalance is the METER's: asked before
 * every AI call, hundreds of times a day, and it wants nothing but a number.
 * This is the SCREEN's, asked when somebody opens Plan & billing, and it wants
 * the history beside the balance — one card, whose figures must agree.
 *
 * The `entries` parameter is opt-in precisely so the meter's call stays exactly
 * as cheap as it was; the portal reads no rows unless this asks for them.
 *
 * ── WHY THIS ONE DOES FALL BACK, WHEN THE METER DOES NOT ────────────────────
 *
 * The header above explains why spending must never fail open: an unreadable
 * balance that lets a call run is free AI on Odyssey's account.
 *
 * DISPLAYING a balance is the opposite case. Nothing is spent by drawing it, so
 * refusing to draw it protects nothing — it just replaces a working billing
 * screen with an error on a shop that may only want to check its modules. So
 * null here means "read the database yourself", exactly as devicesPortal does,
 * and the caller degrades instead of failing.
 */
export type WalletView = {
  balanceMicros: number
  accountId: number
  currency: string
  entries: RawLedgerEntry[]
}

/** A ledger row as JSON carries it — `createdAt` is a string on this wire. */
export type RawLedgerEntry = Omit<LedgerEntry, 'createdAt'> & { createdAt: string }

export async function fetchWallet(limit: number): Promise<WalletView | null> {
  if (!portalAvailable()) return null

  const res = await send<WalletView>('GET', `/ai/credits/balance?entries=${Math.max(1, Math.min(500, Math.floor(limit)))}`)
  if (res.ok) return { ...res.data, entries: res.data.entries ?? [] }

  /* Logged, then degraded. A refusal here is worth reading — it usually means
     the store has no billing account, which the screen already has a banner
     for — but it is never a reason to refuse to draw the page. */
  if (res.reason === 'refused') {
    console.error(`[portal] ai/credits/balance refused (${res.code}): ${res.error}`)
  }
  return null
}

/* ── Usage ───────────────────────────────────────────────────────────────── */

export type ConsumeInput = {
  feature: AiFeature
  model: string
  usage: TokenUsage
  userId: number | null
  /**
   * One id per metered call, minted by the caller before the debit is sent.
   *
   * The post can be retried — a timeout does not say whether the write landed —
   * and without a key the retry charges twice. The portal keys on this the way
   * a top-up keys on pf_payment_id: the second arrival is a no-op, not a second
   * debit.
   */
  idempotencyKey: string
}

export type ConsumeResult = {
  /** What was charged, micro-USD. Recomputed by the portal from `usage`. */
  costMicros: number
  /** What is left afterwards, so a caller can warn without a second call. */
  balanceMicros: number
}

/** Charge one AI call to the wallet. */
export async function consume(input: ConsumeInput): Promise<PortalOutcome<ConsumeResult>> {
  const res = await send<ConsumeResult>('POST', '/ai/credits/consume', input)
  if (res.ok) return { ok: true, data: res.data }
  return toFailure('ai/credits/consume', res)
}

/* ── Opening a top-up ─────────────────────────────────────────────────────── */

export type TopupIntent = {
  /** What to sign as m_payment_id. */
  reference: string
  accountId: number
  /** The amount to charge, and the currency to charge it in. */
  amountPay: number
  payCurrency: string
  /** The credit it buys, fixed at checkout so a moving rate cannot change it. */
  amountMicros: number
}

/**
 * Mint the pending row for a top-up checkout.
 *
 * ── ONLY THE ROW, NOT THE FORM ──────────────────────────────────────────────
 *
 * The PayFast form is signed with the PLATFORM's merchant credentials, which
 * live in this server's environment and must never travel to a shop's machine.
 * So the caller still builds and signs the form itself; what it cannot do on a
 * firewalled desktop is write the pending row, and that is exactly what this
 * fetches.
 *
 * The portal re-derives everything from the amount: the currency comes from the
 * account, the credit is computed from both, and an amount that was never
 * offered is refused. Nothing here can name its own price.
 *
 * null means no portal, no line, or not an answer — try SQL. A refusal is
 * carried back, because "choose one of the listed amounts" is something the
 * person who clicked needs to read.
 */
export async function startTopup(
  amount: number,
): Promise<{ ok: true; intent: TopupIntent } | { ok: false; error: string } | null> {
  if (!portalAvailable()) return null

  const res = await send<TopupIntent>('POST', '/ai/credits/topup', { amount })
  if (res.ok) return { ok: true, intent: res.data }

  if (res.reason === 'refused') {
    console.error(`[portal] ai/credits/topup refused (${res.code}): ${res.error}`)
    return { ok: false, error: res.error }
  }
  return null
}

/* ── Outcomes ────────────────────────────────────────────────────────────── */

/**
 * What a portal call can end as.
 *
 * `unreachable` and `refused` are kept apart all the way up to the caller, and
 * deliberately: the first is our problem and reads as an outage, the second is
 * an answer — a suspended account, a signature that did not verify — and reads
 * as a refusal a person can act on. Flattening them into one error would leave
 * a shop retrying a network they cannot fix, or phoning support about a network
 * that is fine.
 */
export type PortalOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unreachable'; error: string }
  | { ok: false; reason: 'refused'; error: string; code: string }

function toFailure<T>(
  what: string,
  res: Exclude<Awaited<ReturnType<typeof send>>, { ok: true }>,
): PortalOutcome<T> {
  if (res.reason === 'refused') {
    console.error(`[portal] ${what} refused (${res.code}): ${res.error}`)
    return { ok: false, reason: 'refused', error: res.error, code: res.code }
  }
  /* Not logged as an error. A shop with no line will produce one of these for
     every AI action it attempts, and filling the log with them would bury the
     refusals above, which are the ones worth reading. */
  return { ok: false, reason: 'unreachable', error: res.error }
}
