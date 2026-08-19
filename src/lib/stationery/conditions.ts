import type { TokenValues } from './render'

/**
 * "Show this block only when…" — a closed set of questions about a document.
 *
 * ── THIS IS NOT `{#if}` ───────────────────────────────────────────────────
 *
 * The plan for this designer excluded `{#if}` deliberately, and that exclusion
 * still stands: a conditional with an expression on the right-hand side is a
 * template language, and a template language is a second thing to support
 * forever — its own parser, its own precedence, its own error messages, and its
 * own security surface where a shop's typing becomes something we execute.
 *
 * This is the other thing. A block names ONE rule out of a list this file
 * owns, and the rule is a TypeScript predicate. There is no expression, no
 * operator, no nesting and no composition, so it cannot grow into a language:
 * there is nothing to compose with. Adding a question means adding a function
 * here, which is a code change with a review, not a feature a shop can improvise
 * into something we did not intend.
 *
 * ── WHY A DOCUMENT NEEDS THEM AT ALL ──────────────────────────────────────
 *
 * A statement that is overdue wants firmer words than one that is not. Payment
 * terms belong on an account customer's invoice and nowhere else. "PAID —
 * thank you" is either the most useful line on the page or actively wrong,
 * depending on one number.
 *
 * Without this, a shop's only answer is a second design and a person choosing
 * between them at print time — which is the mistake the whole designer exists
 * to remove.
 *
 * ── EVERY RULE IS FALSE WHEN IT CANNOT TELL ───────────────────────────────
 *
 * A rule reads values that may be missing: a document type without a due date
 * has no answer to "is this overdue". Every predicate below returns FALSE in
 * that case rather than guessing, so an unanswerable question hides the block.
 *
 * That direction is deliberate. A block that fails to appear is a shop asking
 * why; a block that appears when it should not is a customer reading "PAID" on
 * an invoice they still owe. Only one of those is recoverable.
 */

export type ConditionRule =
  | 'always'
  | 'hasBalance'
  | 'isPaid'
  | 'docOverdue'
  | 'customerOnAccount'
  | 'hasDiscount'
  | 'isVendor'

export type ConditionDef = {
  rule: ConditionRule
  /** Shown in the inspector's dropdown. */
  label: string
  /** One line, for where the label alone leaves the boundary unclear. */
  hint: string
}

/**
 * The list the designer offers, in the order it offers them.
 *
 * `always` is first and is the default: a block with no rule prints, which is
 * what every design saved before this existed means.
 */
export const CONDITIONS: readonly ConditionDef[] = [
  {
    rule: 'always',
    label: 'Always',
    hint: 'On every document.',
  },
  {
    rule: 'hasBalance',
    label: 'When money is owed',
    hint: 'The amount due is more than zero.',
  },
  {
    rule: 'isPaid',
    label: 'When nothing is owed',
    hint: 'Settled in full — for a "paid, thank you" line.',
  },
  {
    rule: 'docOverdue',
    label: 'When it is overdue',
    hint: 'Past the due date and still owing.',
  },
  {
    rule: 'customerOnAccount',
    label: 'For account customers',
    hint: 'Not a cash sale — for payment terms and banking details.',
  },
  {
    rule: 'hasDiscount',
    label: 'When a discount was given',
    hint: 'For a "you saved" line that is silent at full price.',
  },
  {
    rule: 'isVendor',
    label: 'When VAT registered',
    hint: 'The business has a VAT number.',
  },
] as const

const RULE_SET = new Set<string>(CONDITIONS.map((c) => c.rule))

export function isConditionRule(value: unknown): value is ConditionRule {
  return typeof value === 'string' && RULE_SET.has(value)
}

/* ── reading values ──────────────────────────────────────────────────────── */

/**
 * A token's value as a number, or null when it is not one.
 *
 * `TokenValues` is `Record<string, unknown>` — the RAW values, before any
 * formatting — so money arrives as a number and comparing it is honest. Reading
 * the formatted string instead would mean parsing "R1 234.56" back, which is a
 * locale bug waiting for a shop that formats differently.
 *
 * A string that happens to hold a number is accepted, because an adapter that
 * has already stringified a value should not silently disable a rule.
 */
function numberAt(values: TokenValues, key: string): number | null {
  const raw = values[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    // Strip spaces and currency symbols, keep sign and decimal point.
    const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(/,/g, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A token's value as non-empty text, or null. */
function textAt(values: TokenValues, key: string): string | null {
  const raw = values[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A token's value as a date, or null.
 *
 * Dates reach here as either a Date or an ISO-ish string. A DATETIME read out
 * of the pool is parsed as UTC by design, so comparing it against a UTC "today"
 * keeps the two on the same footing — see the note on the pool's timezone.
 */
function dateAt(values: TokenValues, key: string): Date | null {
  const raw = values[key]
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/* ── the rules ───────────────────────────────────────────────────────────── */

/**
 * The amount still owed, from whichever token this document type carries.
 *
 * Asked in one place so a rule about money does not have to know which document
 * it is standing on.
 */
function amountDue(values: TokenValues): number | null {
  /*
   * VERIFIED AGAINST THE CATALOG, not guessed. A statement carries
   * `totals.dueNow` ("everything already due") and `totals.closing`; a sales
   * document carries `totals.totalIncl` and nothing else, because an invoice's
   * total IS what is owed — there is no separate amount-due token, and a rule
   * naming one would simply never fire.
   *
   * Order matters: the figure to pay wins over the closing balance, which wins
   * over the document total. A statement asked "is money owed" must answer
   * about what is due now, not about everything that ever passed through.
   */
  for (const key of ['totals.dueNow', 'totals.closing', 'totals.totalIncl']) {
    const n = numberAt(values, key)
    if (n !== null) return n
  }
  return null
}

type Predicate = (values: TokenValues) => boolean

const PREDICATES: Record<ConditionRule, Predicate> = {
  always: () => true,

  hasBalance: (v) => {
    const due = amountDue(v)
    // Rounding: a half-cent residue is not money owed.
    return due !== null && due > 0.005
  },

  isPaid: (v) => {
    const due = amountDue(v)
    /*
     * NOT `!hasBalance`. A document with no amount-due token at all cannot
     * claim to be paid — that is the unanswerable case, and it hides. Only a
     * real zero says "settled".
     */
    return due !== null && due <= 0.005
  },

  docOverdue: (v) => {
    const dueDate = dateAt(v, 'doc.dueDate')
    if (!dueDate) return false
    const due = amountDue(v)
    // Overdue means BOTH past the date and still owing. A settled invoice
    // whose due date has passed is not overdue, it is finished.
    if (due === null || due <= 0.005) return false
    return dueDate.getTime() < Date.now()
  },

  customerOnAccount: (v) => {
    /*
     * An account customer is one the document can name — which it knows as
     * `customer.code` (verified: the catalog has no `accountCode`). A cash
     * sale carries no customer, so the code is empty and the rule is false.
     */
    return textAt(v, 'customer.code') !== null
  },

  hasDiscount: (v) => {
    const d = numberAt(v, 'totals.discountExcl') ?? numberAt(v, 'totals.discountIncl')
    // Discounts are carried positive on some documents and negative on others,
    // so the question is whether there is one, not which way it points.
    return d !== null && Math.abs(d) > 0.005
  },

  isVendor: (v) => textAt(v, 'site.vatNumber') !== null,
}

/**
 * Whether a block carrying this rule should print.
 *
 * An unrecognised rule prints — the same direction `parseSpec` takes with an
 * unknown field. A design saved against a rule this build has since retired
 * should lose the CONDITION, not the block: the words a shop wrote are the part
 * worth keeping, and a silently vanished paragraph is the harder bug to find.
 */
export function conditionHolds(rule: string | undefined, values: TokenValues): boolean {
  if (!rule) return true
  const predicate = PREDICATES[rule as ConditionRule]
  if (!predicate) return true
  return predicate(values)
}

/** The catalog entry for a rule, for the designer's inspector. */
export function conditionDef(rule: string | undefined): ConditionDef | null {
  if (!rule) return null
  return CONDITIONS.find((c) => c.rule === rule) ?? null
}

/* ── the slip asks a shorter set of questions ────────────────────────────── */

/**
 * The rules a TILL SLIP can honestly answer.
 *
 * A slip is handed over at the moment of payment, so most of the list above has
 * no meaning on one: nothing is owed, nothing is overdue, and a walk-in has no
 * account. Offering those anyway would give a shop four settings that quietly
 * never fire — worse than not offering them, because they look like they work.
 *
 * So the slip designer shows these two, and they are the two a slip really
 * varies on.
 */
export const SLIP_CONDITIONS: readonly ConditionDef[] = CONDITIONS.filter(
  (c) => c.rule === 'always' || c.rule === 'hasDiscount' || c.rule === 'isVendor',
)

/**
 * The same questions, asked of a receipt.
 *
 * `ReceiptData` is its own shape rather than a token bag, so the values are
 * lifted across here instead of the receipt being made to pretend it is a
 * document. Two small mappings beat one leaky abstraction.
 */
export function slipConditionHolds(
  rule: string | undefined,
  data: { discountTotal?: number; vatNumber?: string | null },
): boolean {
  if (!rule || rule === 'always') return true
  switch (rule) {
    case 'hasDiscount':
      return Math.abs(data.discountTotal ?? 0) > 0.005
    case 'isVendor':
      return typeof data.vatNumber === 'string' && data.vatNumber.trim() !== ''
    default:
      /*
       * A rule that means nothing on a slip SHOWS the block, matching the
       * "unrecognised rule keeps the words" direction everywhere else. A shop
       * that somehow saved `docOverdue` on a slip line gets the line, not a
       * silent hole in the receipt.
       */
      return true
  }
}
