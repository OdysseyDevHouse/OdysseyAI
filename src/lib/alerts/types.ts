/**
 * Alerts & automations — the shape of a rule, and the rules for reading one back.
 *
 * An alert is a CONDITION + a WHEN + a WHO + optionally an ACTION. Nothing
 * about the condition's data lives here: the check re-runs fresh on every
 * firing, recipients re-resolve out of `users`, and the rule runs under its
 * stored owner's capabilities. Same doctrine — and deliberately the same
 * timing vocabulary — as scheduled reports, whose pure lastDueAt() and
 * describeSchedule() this feature imports rather than copies.
 *
 * CLIENT-SAFE: pure data and pure functions, no database, no server-only
 * import. The modal and the server validate through the same code, so a rule
 * the screen accepted cannot be one the action rejects for a different reason.
 *
 * See sql/site/186_alerts.sql for the tables and the reasoning behind them.
 */

/**
 * The scheduling vocabulary, declared here rather than imported from
 * site/reportSchedules — that module is `server-only`, and this one is the half
 * the modal renders. Structurally identical on purpose: the same three words,
 * evaluated by the same lastDueAt(), so the two features can never disagree
 * about when "07:00 daily" is.
 */
export type Frequency = 'daily' | 'weekly' | 'monthly'

/* ── the registry of things the engine knows how to watch ─────────────────── */

export type AlertKind =
  | 'low_stock'
  | 'negative_stock'
  | 'price_below_cost'
  | 'dead_stock'
  | 'cashup_variance'
  | 'missing_cashup'
  | 'credit_limit'
  | 'unprocessed_grvs'

/** Display order in the kind picker: what people ask for first, first. */
export const ALERT_KINDS: readonly AlertKind[] = [
  'low_stock',
  'negative_stock',
  'price_below_cost',
  'dead_stock',
  'cashup_variance',
  'missing_cashup',
  'credit_limit',
  'unprocessed_grvs',
]

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  low_stock: 'Low stock',
  negative_stock: 'Negative stock',
  price_below_cost: 'Selling below cost',
  dead_stock: 'Dead stock',
  cashup_variance: 'Cash-up variance',
  missing_cashup: 'Missing cash-up',
  credit_limit: 'Customer credit limits',
  unprocessed_grvs: 'Unprocessed deliveries',
}

/** The full explanation, shown under the picker once a kind is chosen. */
export const ALERT_KIND_DESCRIPTIONS: Record<AlertKind, string> = {
  low_stock:
    'Finds every product at or below its minimum, works out what to order, and can draft the supplier orders for you.',
  negative_stock:
    'Finds products whose stock on hand has gone below zero — almost always a delivery nobody captured or a barcode on the wrong product.',
  price_below_cost:
    'Finds products whose selling price has slipped below cost, or under the margin you set — usually after a cost increase nobody re-priced.',
  dead_stock:
    "Finds products holding stock that haven't sold in a long time — money sitting on a shelf.",
  cashup_variance:
    'Checks the drawers that were counted and flags any short (or over) by more than your threshold.',
  missing_cashup:
    'Finds shifts that traded but were never cashed up — a drawer nobody counted.',
  credit_limit:
    'Finds account customers at or over their credit limit, before the awkward moment at the till.',
  unprocessed_grvs:
    "Finds deliveries received but never posted. The stock is on the shelf and the system doesn't know, so stock figures and margins stay wrong until somebody finishes them.",
}

/** The same idea in a few words, for the picker's own one-line options. */
export const ALERT_KIND_SUMMARIES: Record<AlertKind, string> = {
  low_stock: 'at or below minimum, with draft orders',
  negative_stock: 'stock on hand that has gone below zero',
  price_below_cost: 'selling price under cost or your margin',
  dead_stock: "stock on hand that hasn't sold in months",
  cashup_variance: 'drawers short or over by more than a threshold',
  missing_cashup: 'shifts that traded but were never counted',
  credit_limit: 'account customers at or over their limit',
  unprocessed_grvs: 'deliveries received but never posted',
}

/** Seeded into the name field when a kind is picked. */
export const ALERT_KIND_DEFAULT_NAMES: Record<AlertKind, string> = {
  low_stock: 'Low stock check',
  negative_stock: 'Negative stock check',
  price_below_cost: 'Margin check',
  dead_stock: 'Dead stock review',
  cashup_variance: 'Cash-up variance check',
  missing_cashup: 'Missing cash-up check',
  credit_limit: 'Credit limit check',
  unprocessed_grvs: 'Unprocessed delivery check',
}

export function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value)
}

/* ── per-kind configuration ────────────────────────────────────────────────── */

/**
 * Every knob any kind can carry, in one object.
 *
 * One merged config rather than a discriminated union per kind: every key has a
 * safe default, unknown keys are dropped on read, and each evaluator reads only
 * the keys it owns — which keeps a `switch (kind)` out of every consumer that
 * merely wants to store or display a rule.
 */
export type AlertConfig = {
  /** low_stock: draft one purchase order per supplier for what is short. */
  createOrders: boolean
  /** low_stock: round suggested quantities up to the product's pack size. */
  roundToPack: boolean
  /** dead_stock: no sale in this many days counts as dead. */
  days: number
  /** dead_stock: ignore anything holding less than this much value. */
  minValue: number
  /** price_below_cost: flag anything under this GP%. 0 = only truly below cost. */
  minGpPct: number
  /** cashup_variance: the rand variance that is worth mentioning. */
  threshold: number
  /** cashup_variance: when true, an overage is not reported. */
  shortagesOnly: boolean
  /** credit_limit: warn once the balance reaches this % of the limit. */
  warnAtPct: number
}

/**
 * `days` means something different per kind, so its default does too. Kinds
 * that do not use it fall through and simply ignore the value.
 */
const DAYS_DEFAULT: Partial<Record<AlertKind, number>> = {
  dead_stock: 90,
  // Two days: long enough that somebody still capturing yesterday's delivery is
  // never flagged, short enough that stock is not invisible for a week.
  unprocessed_grvs: 2,
}

export const ALERT_CONFIG_DEFAULTS: AlertConfig = {
  createOrders: false,
  roundToPack: true,
  days: 90,
  minValue: 0,
  minGpPct: 0,
  threshold: 50,
  shortagesOnly: true,
  warnAtPct: 90,
}

/**
 * A stored config_json → a config that is safe to run.
 *
 * Malformed JSON, missing keys and wrong types all degrade to the default
 * rather than throwing: this is read inside a sweep over every rule on every
 * site, and one bad row must not stop the others from being checked.
 */
export function readConfig(kind: AlertKind, raw: string | null | undefined): AlertConfig {
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  const o = (parsed ?? {}) as Record<string, unknown>
  return {
    createOrders: o.createOrders === true,
    roundToPack: o.roundToPack !== false,
    days: clamp(o.days, 1, 3650, DAYS_DEFAULT[kind] ?? ALERT_CONFIG_DEFAULTS.days),
    minValue: clamp(o.minValue, 0, 10_000_000, ALERT_CONFIG_DEFAULTS.minValue),
    minGpPct: clamp(o.minGpPct, -100, 99, ALERT_CONFIG_DEFAULTS.minGpPct),
    threshold: clamp(o.threshold, 0, 1_000_000, ALERT_CONFIG_DEFAULTS.threshold),
    shortagesOnly: o.shortagesOnly !== false,
    warnAtPct: clamp(o.warnAtPct, 1, 200, ALERT_CONFIG_DEFAULTS.warnAtPct),
  }
}

/** The starting config for a newly picked kind, with its own `days` default. */
export function defaultConfigFor(kind: AlertKind): AlertConfig {
  return readConfig(kind, null)
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* ── the stored rule ───────────────────────────────────────────────────────── */

export type AlertRunStatus = 'claimed' | 'sent' | 'failed' | 'skipped'

export type AlertRule = {
  id: number
  kind: AlertKind
  name: string
  isActive: boolean
  frequency: Frequency
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
  config: AlertConfig
  notifyBell: boolean
  notifyEmail: boolean
  notifyWhatsapp: boolean
  notifySms: boolean
  /** `users.id` values — bell rows, and addresses resolved fresh at send time. */
  recipientUserIds: number[]
  /** Hand-typed addresses, for a recipient who is not a system user. */
  recipientEmails: string[]
  whatsappNumbers: string[]
  smsNumbers: string[]
  /** Whose capabilities the unattended run answers to. */
  ownerUserId: number | null
  createdByName: string
  lastRunAt: Date | null
  lastRunStatus: string
  lastRunError: string
}

/** What the create/update actions accept — a rule without its server-owned bits. */
export type AlertRuleInput = Omit<
  AlertRule,
  'id' | 'ownerUserId' | 'createdByName' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError'
>

/* ── validation ────────────────────────────────────────────────────────────── */

export const MAX_NAME = 120
export const MAX_RECIPIENTS = 50
export const MAX_NUMBERS = 10

export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Check a rule somebody composed — or one read back out of the database. A
 * stored row is treated exactly as sceptically as client input, because the
 * only difference between them is how long ago somebody typed it.
 *
 * Returns the FIRST problem rather than a map: the modal shows one message at
 * a time, and an action can only return one error.
 */
export function validateAlertRule(input: Partial<AlertRuleInput>): ValidationResult {
  const name = String(input.name ?? '').trim()
  if (!name) return fail('Give the alert a name.')
  if (name.length > MAX_NAME) return fail(`Keep the name under ${MAX_NAME} characters.`)
  if (!input.kind || !isAlertKind(input.kind)) return fail('Choose what to watch.')

  if (!isValidTime(input.sendTime)) return fail('Enter a time as HH:MM.')
  if (!['daily', 'weekly', 'monthly'].includes(String(input.frequency))) {
    return fail('Choose how often it checks.')
  }
  if (input.frequency === 'weekly') {
    if (!/^[01]{7}$/.test(String(input.daysOfWeek ?? ''))) return fail('Pick the days to check on.')
    if (!String(input.daysOfWeek).includes('1')) return fail('Pick at least one day.')
  }
  if (input.frequency === 'monthly') {
    const d = Number(input.dayOfMonth)
    if (!Number.isInteger(d) || d < 1 || d > 31) return fail('Pick a day between 1 and 31.')
  }

  const users = input.recipientUserIds ?? []
  const emails = input.recipientEmails ?? []
  const whatsapp = input.whatsappNumbers ?? []
  const sms = input.smsNumbers ?? []

  if (!input.notifyBell && !input.notifyEmail && !input.notifyWhatsapp && !input.notifySms) {
    return fail('Choose at least one way to be told.')
  }

  // Per channel, because "who" means something different for each: a bell row
  // needs a user, an email needs an address, a message needs a number. A rule
  // with a channel switched on and nobody to send it to would run every
  // morning, find things, and tell no one.
  if (input.notifyBell && users.length === 0) {
    return fail('Pick at least one person to notify in the app.')
  }
  if (input.notifyEmail && users.length + emails.length === 0) {
    return fail('Add at least one email recipient.')
  }
  if (input.notifyWhatsapp && whatsapp.length === 0) {
    return fail('Add at least one WhatsApp number.')
  }
  if (input.notifySms && sms.length === 0) {
    return fail('Add at least one SMS number.')
  }

  if (users.length + emails.length > MAX_RECIPIENTS) {
    return fail(`That is more than ${MAX_RECIPIENTS} recipients.`)
  }
  if (emails.some((e) => !isValidEmail(e))) {
    return fail("One of the email addresses doesn't look right.")
  }
  if (whatsapp.length > MAX_NUMBERS || sms.length > MAX_NUMBERS) {
    return fail(`That is more than ${MAX_NUMBERS} numbers.`)
  }
  if ([...whatsapp, ...sms].some((n) => !isValidPhone(n))) {
    return fail("One of the phone numbers doesn't look right.")
  }

  return { ok: true }
}

function fail(error: string): ValidationResult {
  return { ok: false, error }
}

/** Deliberately loose — the mail server is the real judge of an address. */
export function isValidEmail(value: string): boolean {
  const v = String(value ?? '').trim()
  return v.length >= 5 && v.length <= 190 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v)
}

/** 9–15 digits, optional +. A comma would split one number into two. */
export function isValidPhone(value: string): boolean {
  const raw = String(value ?? '')
  if (raw.includes(',')) return false
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 9 && digits.length <= 15
}

function isValidTime(value: unknown): boolean {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}
