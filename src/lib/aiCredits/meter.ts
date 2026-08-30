import 'server-only'
import { randomUUID } from 'crypto'
import { accountForSite } from '@/lib/control/modules'
import { balanceMicros, recordUsage } from './ledger'
import { consume, fetchBalance, portalAvailable } from './creditsPortal'
import {
  FEATURE_ESTIMATE_MICROS,
  MODEL_LABEL,
  formatMicros,
  type AiFeature,
  type TokenUsage,
} from './pricing'

/**
 * The gate every metered AI feature goes through.
 *
 * Two calls, in this order:
 *
 *   1. assertBalance() BEFORE the Claude request. Throws when the wallet cannot
 *      cover the feature, so a call we cannot pay for is never started.
 *   2. meterCall() AROUND it. Runs the request, reads response.usage, writes the
 *      debit, and returns the response untouched.
 *
 * ── WHY THE CHECK AND THE CHARGE ARE SEPARATE ──────────────────────────────
 *
 * The real cost is only knowable afterwards — it is a function of how many
 * tokens the model actually used. So the check beforehand is an ESTIMATE
 * (./pricing sets them deliberately above typical), and the charge afterwards
 * is the truth. A shop that scrapes through the gate and then runs a call far
 * over estimate overdraws slightly, which the ledger records honestly.
 *
 * ── ONE TRANSPORT DECISION, MADE HERE ──────────────────────────────────────
 *
 * A desktop install asks the control panel over HTTPS; everything else queries
 * the control database directly. That choice lives in this file and nowhere
 * else, so a feature calling meterCall does not know or care which it got.
 */

/* ── Refusal ─────────────────────────────────────────────────────────────── */

/** Why an AI action was refused. The UI says something different for each. */
export type RefusalReason =
  /** The wallet is short. Someone has to top up. */
  | 'insufficient'
  /** No billing account for this store — nothing to spend from or bill to. */
  | 'no_account'
  /** The control panel could not be reached. Our problem, not the shop's. */
  | 'unreachable'
  /** The control panel answered, and the answer was no. */
  | 'refused'

/**
 * Thrown by assertBalance when an AI action may not run.
 *
 * ── IT CARRIES A MESSAGE, NOT JUST A CODE ──────────────────────────────────
 *
 * Four different situations end up here and they need four different sentences.
 * "Out of credits" sends someone to the billing screen; "cannot reach Odyssey"
 * sends them to check the internet. A single generic message would send both to
 * the wrong place, and the shop with a working balance and a dead line would
 * spend an afternoon topping up a wallet that was already full.
 */
export class AiCreditsError extends Error {
  readonly code = 'AI_CREDITS_REFUSED'
  readonly reason: RefusalReason
  /** Safe to show a user. Never a stack, never a database message. */
  readonly userMessage: string

  constructor(reason: RefusalReason, userMessage: string) {
    super(userMessage)
    this.name = 'AiCreditsError'
    this.reason = reason
    this.userMessage = userMessage
  }
}

/** For callers catching `unknown`, which is all of them. */
export function isAiCreditsError(e: unknown): e is AiCreditsError {
  return (
    e instanceof AiCreditsError ||
    (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'AI_CREDITS_REFUSED')
  )
}

/* ── The gate ────────────────────────────────────────────────────────────── */

/**
 * What a passed check hands to meterCall, so nothing is resolved twice.
 *
 * `viaPortal` is carried rather than re-derived: if the portal answered the
 * balance, the debit must go the same way. Re-asking portalAvailable() at debit
 * time could route a call's check and its charge to two different places.
 */
export type MeterTicket = {
  siteId: number
  accountId: number | null
  feature: AiFeature
  viaPortal: boolean
  currency: string
}

/**
 * May this AI action run?
 *
 * Throws AiCreditsError if not. Returns a ticket for meterCall if so.
 */
export async function assertBalance(siteId: number, feature: AiFeature): Promise<MeterTicket> {
  const needed = FEATURE_ESTIMATE_MICROS[feature]

  if (portalAvailable()) {
    const result = await fetchBalance()

    if (!result.ok) {
      /* No fallback to SQL, deliberately — see creditsPortal's header. A
         desktop install that cannot reach Odyssey cannot spend Odyssey's
         money, and failing open here would mean free AI for every offline shop
         at once, billed to us. */
      if (result.reason === 'unreachable') {
        throw new AiCreditsError(
          'unreachable',
          'AI features need a connection to Odyssey. Check the internet connection and try again.',
        )
      }
      throw new AiCreditsError('refused', result.error)
    }

    const { balanceMicros: balance, accountId, currency } = result.data
    if (balance < needed) throw shortfall(balance, currency)
    return { siteId, accountId, feature, viaPortal: true, currency }
  }

  const account = await accountForSite(siteId)
  if (!account) {
    throw new AiCreditsError(
      'no_account',
      'This store has no billing account set up, so AI features cannot be used yet.',
    )
  }

  const balance = await balanceMicros(account.id)
  if (balance < needed) throw shortfall(balance, account.currency)

  return { siteId, accountId: account.id, feature, viaPortal: false, currency: account.currency }
}

/**
 * The one refusal a shop can do something about, so it says what and how much.
 *
 * A bare "out of credits" invites "how much do I need" as the next question,
 * and the person reading it is usually not the person who can top up — hence
 * naming the screen rather than offering a button that half of them cannot use.
 */
function shortfall(balance: number, currency: string): AiCreditsError {
  const shown = formatMicros(Math.max(0, balance), currency)
  return new AiCreditsError(
    'insufficient',
    `Not enough AI credits to run this (${shown} left). Top up under Setup → Plan & billing to continue.`,
  )
}

/* ── The charge ──────────────────────────────────────────────────────────── */

/** Anything with a usage block, which is every Anthropic message response. */
interface HasUsage {
  usage?: TokenUsage | null
}

/**
 * Run a metered AI call and charge the wallet for it.
 *
 * `fn` performs the Claude request. Its response comes back unchanged.
 *
 * ── THE DEBIT NEVER THROWS ─────────────────────────────────────────────────
 *
 * The AI result is already in hand by the time we try to charge for it. If the
 * charge fails — a dropped connection, a portal that died in the four seconds
 * since it answered the balance — throwing would take a delivered result away
 * from the shop to punish a fault that is ours. That trade is never worth
 * making, so the failure is logged loudly and the result is returned.
 *
 * The loss is bounded by the gate: assertBalance already refused if the portal
 * was unreachable, so the window is a portal that answered moments ago and died
 * in between. If the logs ever say otherwise, the fix is a spool of unsent
 * debits — worth building then, and not before.
 */
export async function meterCall<T extends HasUsage>(
  ticket: MeterTicket,
  userId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  const response = await fn()

  try {
    const usage: TokenUsage = response.usage ?? {}

    if (ticket.viaPortal) {
      const result = await consume({
        feature: ticket.feature,
        model: MODEL_LABEL,
        usage,
        userId,
        /* Fresh per call. The post can be retried and a timeout does not say
           whether the write landed, so the portal needs something to recognise
           the second arrival by. */
        idempotencyKey: randomUUID(),
      })
      if (!result.ok) throw new Error(result.error)
    } else {
      if (ticket.accountId === null) throw new Error('no billing account resolved')
      await recordUsage({
        accountId: ticket.accountId,
        siteId: ticket.siteId,
        userId,
        feature: ticket.feature,
        model: MODEL_LABEL,
        usage,
      })
    }
  } catch (error) {
    /* Money we spent and did not charge for. Loud on purpose: this is the line
       that decides whether the spool queue above ever needs building. */
    console.error(
      `[ai-credits] UNCHARGED ${ticket.feature} call for site ${ticket.siteId}` +
        ` (account ${ticket.accountId ?? 'unknown'}):`,
      error,
    )
  }

  return response
}
