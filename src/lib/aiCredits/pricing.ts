/**
 * What an AI call costs, and what a shop pays for it.
 *
 * Pure arithmetic — no database, no network, no session. Everything the wallet
 * charges is decided here, so the two numbers worth arguing about (the markup
 * and the per-feature estimates) are in one file and can be changed without
 * reading any of the rest.
 *
 * ── THE UNIT IS MICRO-USD ──────────────────────────────────────────────────
 *
 * 1 USD = 1,000,000 µ$. See sql/tickets/021_ai_credits.sql for why USD and why
 * micro; briefly, Anthropic bills us in USD wherever the shop trades, and a
 * short report question costs a fraction of a US cent, which in cents rounds to
 * free.
 *
 * Currency appears at exactly two edges, both in this file: localToMicros when
 * a shop buys credit, and formatMicros when a balance is shown. Nothing in
 * between knows what a rand is.
 */

/* ── What Anthropic charges us ────────────────────────────────────────────────
 *
 * claude-opus-5, the model both AI features run. Per MTok: $5 input, $25
 * output, cache reads at 0.1x input, cache writes at 1.25x input. Checked
 * against the published price list on 2026-08-28.
 *
 * These are OUR cost, not the shop's — the markup below is what stands between
 * the two. If the model changes, these change with it; MODEL_LABEL exists so a
 * mismatch is visible on the row rather than inferred from the date.
 */
export const MODEL_LABEL = 'claude-opus-5'

const USD_PER_MTOK_INPUT = 5
const USD_PER_MTOK_OUTPUT = 25
const USD_PER_MTOK_CACHE_READ = 0.5
const USD_PER_MTOK_CACHE_WRITE = 6.25

const MICROS_PER_USD = 1_000_000
const TOKENS_PER_MTOK = 1_000_000

/** Micro-USD per single token, which is what the arithmetic below actually uses. */
const MICROS_PER_INPUT_TOKEN = (USD_PER_MTOK_INPUT * MICROS_PER_USD) / TOKENS_PER_MTOK
const MICROS_PER_OUTPUT_TOKEN = (USD_PER_MTOK_OUTPUT * MICROS_PER_USD) / TOKENS_PER_MTOK
const MICROS_PER_CACHE_READ_TOKEN = (USD_PER_MTOK_CACHE_READ * MICROS_PER_USD) / TOKENS_PER_MTOK
const MICROS_PER_CACHE_WRITE_TOKEN = (USD_PER_MTOK_CACHE_WRITE * MICROS_PER_USD) / TOKENS_PER_MTOK

/**
 * What the shop pays over what the call cost us.
 *
 * ── WHY IT IS THIS HIGH, AND WHY THAT IS FINE ──────────────────────────────
 *
 * Three real costs sit between Anthropic's invoice and ours, and none of them
 * appear in a token count: the exchange rate moves between a top-up and the
 * calls it pays for, a cache miss can multiply the input cost of a call we
 * priced assuming a hit, and PayFast takes a percentage of every top-up.
 *
 * The absolute numbers stay small either way — a supplier PDF is a few cents of
 * real cost, so a shop sees a few cents times this and still not a number worth
 * complaining about. Being generous here is cheaper than being wrong.
 */
export const MARKUP = 3

/* ── Token usage ─────────────────────────────────────────────────────────── */

/**
 * The usage block on an Anthropic response.
 *
 * Every field optional because it is read off a live API response rather than
 * constructed here, and a missing field must cost zero rather than NaN.
 */
export interface TokenUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Non-negative integer, whatever the API sent. */
function count(value: number | null | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Cache tokens as ONE number for the ledger row — read and write together. */
export function cacheTokensOf(usage: TokenUsage): number {
  return count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
}

/** What the call cost Odyssey, in micro-USD, before markup. */
export function rawCostMicros(usage: TokenUsage): number {
  return (
    count(usage.input_tokens) * MICROS_PER_INPUT_TOKEN +
    count(usage.output_tokens) * MICROS_PER_OUTPUT_TOKEN +
    count(usage.cache_read_input_tokens) * MICROS_PER_CACHE_READ_TOKEN +
    count(usage.cache_creation_input_tokens) * MICROS_PER_CACHE_WRITE_TOKEN
  )
}

/**
 * What to debit the wallet for one call, in micro-USD.
 *
 * Rounded UP, and that is deliberate: rounding down means a call cheap enough
 * to floor at zero is free, and the cheapest AI feature here is also the one a
 * shop would run hundreds of times a day.
 */
export function usageCostMicros(usage: TokenUsage): number {
  return Math.ceil(rawCostMicros(usage) * MARKUP)
}

/* ── Features ────────────────────────────────────────────────────────────── */

/**
 * The metered AI features.
 *
 * A string union rather than an enum column (see the migration): adding one is
 * a deploy, not an ALTER on a shared database.
 */
export type AiFeature = 'doc_scan' | 'ask_report'

export const FEATURE_LABELS: Record<AiFeature, string> = {
  doc_scan: 'Scanned a supplier document',
  ask_report: 'Built a report from a question',
}

/**
 * What a feature must have in the wallet before it is allowed to start.
 *
 * ── AN ESTIMATE, NOT A PRICE ───────────────────────────────────────────────
 *
 * The real debit is computed from actual usage after the call. This is only the
 * gate beforehand, and its job is to stop a call we cannot pay for — so it is
 * set ABOVE a typical call rather than at it. Being too low means starting work
 * that overdraws the wallet; being too high means refusing a shop that could
 * afford it. The first is a bill, the second is an inconvenience.
 *
 * ── THESE ARE DERIVED, NOT GUESSED ─────────────────────────────────────────
 *
 * Each is the arithmetic below run against the feature's own max_tokens and a
 * realistic input, then rounded up. Written down because the first version of
 * this file carried numbers inherited from an older, cheaper model and they
 * were four to five times too low — a shop could pass the gate holding a fifth
 * of what the call went on to cost.
 *
 * doc_scan   max_tokens 16000, and a scanned multi-page invoice is a large
 *            input. 40k in + 16k out = 1_200_000. A page of PDF is roughly
 *            2-3k tokens, so this covers a fifteen-page delivery note.
 *
 * ask_report TWO calls, not one — it picks a dataset (max 2000), then builds a
 *            spec over it (max 4000) — and the estimate covers both, because a
 *            per-call figure would pass a shop through the gate on call one and
 *            overdraw on call two. 3k in + 2k out, then 3k in + 4k out, both
 *            maxed = 540_000.
 *
 * Both are ceilings on a bad case rather than averages. A typical scan settles
 * near 750_000 and a typical question near 135_000, so an ordinary shop is
 * refused only when it genuinely could not have afforded the worst case.
 */
export const FEATURE_ESTIMATE_MICROS: Record<AiFeature, number> = {
  doc_scan: 1_200_000, // ~$1.20 at the ceiling; ~$0.75 typical.
  ask_report: 540_000, // ~$0.54 for the pair at the ceiling; ~$0.14 typical.
}

/* ── Currency ────────────────────────────────────────────────────────────── */

/**
 * How many units of a currency one US dollar buys.
 *
 * ── HARDCODED, AND HONEST ABOUT IT ─────────────────────────────────────────
 *
 * A live FX feed is a network call on the path of every balance render, with a
 * failure mode (stale or unreachable) that would have to be designed for. The
 * markup above already absorbs more drift than these rates will see, so the
 * cost of being approximate is smaller than the cost of being live.
 *
 * Unknown currency falls back to 1, which treats it as USD. A wrong balance in
 * the shop's own currency would be worse than an honest one in dollars.
 */
const RATE_PER_USD: Record<string, number> = {
  USD: 1,
  ZAR: 19,
  NAD: 19,
  BWP: 13.5,
  ZMW: 27,
  GBP: 0.79,
  EUR: 0.92,
  AUD: 1.52,
  NZD: 1.65,
  CAD: 1.37,
}

const SYMBOLS: Record<string, string> = {
  USD: '$',
  ZAR: 'R',
  NAD: 'N$',
  BWP: 'P',
  ZMW: 'K',
  GBP: '£',
  EUR: '€',
  AUD: '$',
  NZD: '$',
  CAD: '$',
}

/** Normalise whatever cp2_billing_accounts.currency holds. */
function code(currency: string | null | undefined): string {
  const c = (currency ?? '').trim().toUpperCase()
  return c.length === 3 ? c : 'ZAR'
}

export function currencySymbol(currency: string | null | undefined): string {
  return SYMBOLS[code(currency)] ?? ''
}

/** Micro-USD -> an amount in the shop's currency. */
export function microsToLocal(micros: number, currency: string | null | undefined): number {
  const rate = RATE_PER_USD[code(currency)] ?? 1
  return (micros / MICROS_PER_USD) * rate
}

/**
 * An amount in the shop's currency -> the credit it buys, in micro-USD.
 *
 * Called once per top-up, at checkout, and the result is stored on the pending
 * row — so a rate that moves between paying and the notification arriving
 * cannot change what was bought.
 */
export function localToMicros(amount: number, currency: string | null | undefined): number {
  const rate = RATE_PER_USD[code(currency)] ?? 1
  return Math.round((amount / rate) * MICROS_PER_USD)
}

/**
 * A balance or a spend, ready for a screen: "R347.20", "-R2.15".
 *
 * Two decimals always, including for a debit of a fraction of a cent, which
 * shows as R0.00 — correct, and better than inventing precision the shop does
 * not think in. A usage LIST is where small numbers become legible, by summing.
 */
export function formatMicros(micros: number, currency: string | null | undefined): string {
  const local = microsToLocal(micros, currency)
  const body = Math.abs(local)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${local < 0 ? '-' : ''}${currencySymbol(currency)}${body}`
}

/* ── Top-up amounts ──────────────────────────────────────────────────────── */

/**
 * What a shop may buy, in its own currency.
 *
 * ── FIXED, AND VALIDATED SERVER-SIDE ───────────────────────────────────────
 *
 * A free-text box would let a client post any number it liked, and the checkout
 * signs whatever it is given. Presets mean the server can check the amount
 * against a list it owns before signing, so a tampered request is refused
 * rather than charged. This is the same rule startSubscriptionAction follows by
 * deriving its amount from the quote instead of the request.
 */
const TOPUP_PRESETS: Record<string, number[]> = {
  ZAR: [250, 500, 1000],
  USD: [15, 30, 60],
  GBP: [15, 30, 60],
  EUR: [15, 30, 60],
  CAD: [20, 40, 80],
  AUD: [25, 50, 100],
  NZD: [25, 50, 100],
  NAD: [250, 500, 1000],
  BWP: [200, 400, 800],
  ZMW: [400, 800, 1600],
}

export function topupPresets(currency: string | null | undefined): number[] {
  return TOPUP_PRESETS[code(currency)] ?? TOPUP_PRESETS.USD
}

/** Is this an amount we offered? The guard the checkout route runs. */
export function isValidTopupAmount(amount: number, currency: string | null | undefined): boolean {
  return Number.isFinite(amount) && topupPresets(currency).includes(amount)
}
