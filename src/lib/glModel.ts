/*
 * Deliberately NOT `server-only`.
 *
 * Double-entry vocabulary and arithmetic, shared by the GL screens and the
 * server modules that write them. The journal form runs in the browser and must
 * apply the same balance rule the server enforces. Same split as
 * expenseModel.ts and periodLockModel.ts.
 */
import { round } from './decimals'

/**
 * The rules double entry obeys, as PURE functions.
 *
 * ── THE SIGN CONVENTION, STATED ONCE ─────────────────────────────────────
 *
 *   amount  positive = DEBIT
 *           negative = CREDIT
 *
 * One signed number rather than two columns. Two columns means every aggregate
 * is SUM(debit) - SUM(credit), every insert must decide which column gets the
 * zero, and a row with values in both is expressible and meaningless. One
 * signed column makes "does this balance" a plain sum against zero — the check
 * the entire ledger rests on.
 *
 * ── WHAT DEBIT AND CREDIT ACTUALLY MEAN ──────────────────────────────────
 *
 * Not "good" and "bad" — they are just the two sides. What a debit DOES
 * depends on the account type, which is what `normalBalance` below encodes:
 *
 *   Assets and expenses INCREASE on the debit side.
 *   Liabilities, equity and income INCREASE on the credit side.
 *
 * So a sale credits income and debits the bank; both are increases, on
 * opposite sides, and that is why the entry balances.
 */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
}

export const ACCOUNT_TYPE_HINTS: Record<AccountType, string> = {
  asset: 'What the business owns — bank, stock, debtors, equipment.',
  liability: 'What it owes — creditors, VAT, loans.',
  equity: "The owners' stake, including profit kept in the business.",
  income: 'Revenue earned.',
  expense: 'Costs incurred, including cost of sales.',
}

/**
 * Which side an account type increases on.
 *
 * 'debit' means a positive amount increases it. This single fact drives the
 * sign of every balance shown on a statement — a liability with a credit
 * balance is stored negative and must be DISPLAYED positive, because "we owe
 * R12 000" is not a negative quantity to a reader.
 */
export const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
}

/** Which statement an account appears on. */
export function statementFor(type: AccountType): 'income_statement' | 'balance_sheet' {
  return type === 'income' || type === 'expense' ? 'income_statement' : 'balance_sheet'
}

/**
 * Whether this type closes off at year end.
 *
 * Income and expense accounts are TEMPORARY: they measure a period, so they
 * reset to zero and their net result moves to retained earnings. Assets,
 * liabilities and equity are PERMANENT — they describe a position at a moment
 * and carry forward.
 */
export function closesAtYearEnd(type: AccountType): boolean {
  return statementFor(type) === 'income_statement'
}

/**
 * The balance as a reader expects to see it.
 *
 * Stored balances are signed by the debit convention, so a liability of
 * R12 000 sits as -12 000. Showing that on a balance sheet is wrong twice over:
 * it reads as negative, and it makes the statement fail to add up against its
 * own subtotals. This flips the credit-normal types so every figure on a
 * statement is a positive quantity of the thing it names.
 */
export function displayBalance(type: AccountType, storedBalance: number): number {
  return NORMAL_BALANCE[type] === 'credit' ? round(-storedBalance, 2) : round(storedBalance, 2)
}

/* ── Journal lines ───────────────────────────────────────────────────────── */

export type JournalLineInput = {
  accountId: number
  /** Signed: positive debit, negative credit. */
  amount: number
  description?: string | null
  departmentId?: number | null
  customerId?: number | null
  supplierId?: number | null
}

export type JournalTotals = {
  totalDebit: number
  totalCredit: number
  /** Zero when the batch balances. Anything else and it must not post. */
  difference: number
  balanced: boolean
}

/**
 * Totals for a batch.
 *
 * `difference` is an exact zero test to the cent, not a tolerance. A journal
 * that is "nearly balanced" is one that has absorbed a real error, and every
 * report built on it inherits that error silently. There is no acceptable
 * rounding here: the posting code that produces the lines is responsible for
 * making them sum, and if it cannot, the entry is wrong.
 */
export function journalTotals(lines: readonly JournalLineInput[]): JournalTotals {
  let totalDebit = 0
  let totalCredit = 0

  for (const line of lines) {
    const amount = round(line.amount, 2)
    if (amount > 0) totalDebit = round(totalDebit + amount, 2)
    else totalCredit = round(totalCredit - amount, 2)
  }

  const difference = round(totalDebit - totalCredit, 2)
  return { totalDebit, totalCredit, difference, balanced: difference === 0 }
}

/**
 * Why this journal cannot be posted. Null means it can.
 *
 * Pure, so the journal form shows the same refusal the server would give while
 * the user is still typing rather than after they press Post.
 */
export function refuseJournal(input: {
  journalDate?: string
  description?: string | null
  lines: readonly JournalLineInput[]
}): string | null {
  if (input.journalDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.journalDate)) {
    return 'That date is not valid.'
  }
  if (!input.description?.trim()) return 'Describe what this journal is for.'
  if (input.lines.length < 2) {
    // One line cannot balance against anything. Two is the minimum entry.
    return 'A journal needs at least two lines — one debit and one credit.'
  }
  if (input.lines.some((l) => !l.accountId)) return 'Every line needs an account.'
  if (input.lines.some((l) => !Number.isFinite(l.amount) || round(l.amount, 2) === 0)) {
    return 'Every line needs an amount.'
  }

  const totals = journalTotals(input.lines)
  if (totals.totalDebit === 0 || totals.totalCredit === 0) {
    return 'A journal needs both a debit and a credit side.'
  }
  if (!totals.balanced) {
    return `Debits are ${totals.totalDebit.toFixed(2)} and credits are ${totals.totalCredit.toFixed(2)} — a journal must balance. It is out by ${Math.abs(totals.difference).toFixed(2)}.`
  }
  return null
}

/** A line's magnitude on the side it falls, for a two-column display. */
export function splitSides(amount: number): { debit: number; credit: number } {
  const value = round(amount, 2)
  return value > 0 ? { debit: value, credit: 0 } : { debit: 0, credit: -value }
}

/* ── Statement shapes ────────────────────────────────────────────────────── */

/**
 * Subtype grouping, for statement subtotals.
 *
 * The order matters: it is the order these appear on a statement, which is
 * conventional and which readers expect. Current assets before fixed; current
 * liabilities before long-term.
 */
export const SUBTYPE_ORDER: string[] = [
  'current_asset',
  'fixed_asset',
  'current_liability',
  'long_term_liability',
  'equity',
  'revenue',
  'other_income',
  'cost_of_sales',
  'operating',
  'financial',
]

export const SUBTYPE_LABELS: Record<string, string> = {
  current_asset: 'Current assets',
  fixed_asset: 'Fixed assets',
  current_liability: 'Current liabilities',
  long_term_liability: 'Long-term liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  other_income: 'Other income',
  cost_of_sales: 'Cost of sales',
  operating: 'Operating expenses',
  financial: 'Financial costs',
}

export function subtypeLabel(subtype: string | null, type: AccountType): string {
  if (subtype && SUBTYPE_LABELS[subtype]) return SUBTYPE_LABELS[subtype]
  return ACCOUNT_TYPE_LABELS[type]
}

export function subtypeRank(subtype: string | null): number {
  const index = subtype ? SUBTYPE_ORDER.indexOf(subtype) : -1
  return index === -1 ? SUBTYPE_ORDER.length : index
}

/* ── Budgets ─────────────────────────────────────────────────────────────── */

/**
 * An annual figure spread across twelve months, cents landing on December.
 *
 * Pure and shared, so the grid's client-side preview and the server's save
 * produce the same twelve numbers — an annual R100 000 must come out as
 * 8 333.33 eleven times and 8 333.37 once, in both places, or the preview
 * lies by a few cents.
 */
export function spreadAnnual(total: number): number[] {
  const annual = round(total, 2)
  const monthly = round(Math.floor((annual / 12) * 100) / 100, 2)
  const months = Array.from({ length: 12 }, () => monthly)
  months[11] = round(annual - monthly * 11, 2)
  return months
}

/* ── Cash flow classification ────────────────────────────────────────────── */

/**
 * Where an account's movement lands on the cash flow statement.
 *
 * 'cash' is the money itself — the statement explains its movement, so cash
 * accounts appear only as the opening and closing figures. Everything else is
 * classified by SUBTYPE, because that is the fact the chart already carries:
 * working capital is the current stuff, investing is fixed assets, financing
 * is long-term debt and equity.
 *
 * An unrecognised subtype lands in 'other' — shown as its own group, never
 * silently dropped, because a statement that quietly omits an account is a
 * statement that no longer reconciles and cannot say why.
 */
export type CashFlowSection = 'cash' | 'operating' | 'investing' | 'financing' | 'other'

export const CASH_FLOW_SECTION_BY_SUBTYPE: Record<string, CashFlowSection> = {
  current_asset: 'operating',
  current_liability: 'operating',
  fixed_asset: 'investing',
  long_term_liability: 'financing',
  equity: 'financing',
}

export const CASH_FLOW_SECTION_LABELS: Record<Exclude<CashFlowSection, 'cash'>, string> = {
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
  other: 'Other movements',
}

export function cashFlowSection(
  type: AccountType,
  subtype: string | null,
  controlType: string | null,
): CashFlowSection {
  if (controlType === 'bank') return 'cash'
  // Income and expenses never reach here on the statement itself — they are
  // the net-result input — but classifying them keeps the function total.
  if (type === 'income' || type === 'expense') return 'operating'
  return (subtype && CASH_FLOW_SECTION_BY_SUBTYPE[subtype]) || 'other'
}

/* ── Control accounts ────────────────────────────────────────────────────── */

export const CONTROL_TYPES = [
  'debtors',
  'creditors',
  'bank',
  'stock',
  'vat_input',
  'vat_output',
] as const
export type ControlType = (typeof CONTROL_TYPES)[number]

export const CONTROL_TYPE_LABELS: Record<ControlType, string> = {
  debtors: 'Debtors (customers)',
  creditors: 'Creditors (suppliers)',
  bank: 'Bank account',
  stock: 'Stock on hand',
  vat_input: 'VAT input',
  vat_output: 'VAT output',
}

/**
 * What a control account is controlled BY, in words.
 *
 * Shown on the chart of accounts so it is obvious why the account cannot be
 * posted to by hand — "it is maintained by the customer ledger" is an answer;
 * a greyed-out button is not.
 */
export const CONTROL_SOURCE_HINTS: Record<ControlType, string> = {
  debtors: 'Maintained by the customer ledger. Post a customer transaction instead.',
  creditors: 'Maintained by the supplier ledger. Post a supplier transaction instead.',
  bank: 'Maintained by the cashbook. Capture a movement on the account instead.',
  stock: 'Maintained by stock movements. Receive or adjust stock instead.',
  vat_input: 'Maintained by purchases and expenses.',
  vat_output: 'Maintained by sales.',
}
