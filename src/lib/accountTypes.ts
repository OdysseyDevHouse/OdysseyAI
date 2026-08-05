/**
 * How a customer's account behaves.
 *
 * Pure — no database, no `server-only` — so the customer form and the till can
 * both read these without dragging a connection pool into the browser bundle.
 * The same split that `serialStatus.ts` and `productTypes.ts` use.
 *
 * ── WHAT ACTUALLY DIFFERS ────────────────────────────────────────────────
 *
 * Only two things: whether credit is granted at all, and who decides where a
 * payment goes. Everything else — the open-item ledger underneath, per-document
 * ageing, statements — is identical for all four.
 */

export const ACCOUNT_TYPES = ['open_item', 'balance_fwd', 'cash', 'lay_by'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const DEFAULT_ACCOUNT_TYPE: AccountType = 'open_item'

export type AccountTypeOption = {
  id: AccountType
  name: string
  description: string
  /** May buy on account at all. */
  allowsCredit: boolean
  /** A payment settles the oldest invoice first, with nobody choosing. */
  autoAllocates: boolean
}

export const ACCOUNT_TYPE_OPTIONS: AccountTypeOption[] = [
  {
    id: 'open_item',
    name: 'Open item',
    description:
      'Buys on account. When a payment comes in, the unpaid invoices are listed and you choose what it settles — R300 against one, R200 against another.',
    allowsCredit: true,
    autoAllocates: false,
  },
  {
    id: 'balance_fwd',
    name: 'Balance brought forward',
    description:
      'Buys on account. A payment is applied to the oldest unpaid invoice first and works forward until it is used up. Nobody allocates anything by hand.',
    allowsCredit: true,
    autoAllocates: true,
  },
  {
    id: 'cash',
    name: 'Cash',
    description:
      'Never buys on account — pays at the till every time. Different from on hold: this account was never granted credit, a held one had it withdrawn.',
    allowsCredit: false,
    autoAllocates: false,
  },
  {
    id: 'lay_by',
    name: 'Lay-by',
    description:
      'Goods are put aside and paid off in instalments. Nothing is invoiced and no stock moves until it is paid in full; the deposits sit on the account as credit meanwhile.',
    allowsCredit: false,
    autoAllocates: false,
  },
]

const BY_ID = new Map(ACCOUNT_TYPE_OPTIONS.map((o) => [o.id, o]))

export function accountTypeOption(type: AccountType): AccountTypeOption {
  return BY_ID.get(type) ?? BY_ID.get(DEFAULT_ACCOUNT_TYPE)!
}

export function accountTypeLabel(type: AccountType): string {
  return accountTypeOption(type).name
}

/**
 * Whether this account may be sold to on credit.
 *
 * A lay-by is deliberately NOT credit: the shop still holds the goods, so
 * nothing is owed for something the customer already has. That is the whole
 * difference between a lay-by and an account sale, and conflating them would
 * let a lay-by consume a credit limit it should never touch.
 */
export function allowsCredit(type: AccountType): boolean {
  return accountTypeOption(type).allowsCredit
}

/** Whether a payment should be allocated automatically, oldest invoice first. */
export function autoAllocates(type: AccountType): boolean {
  return accountTypeOption(type).autoAllocates
}

export function toAccountType(value: unknown): AccountType {
  const raw = String(value ?? '')
  return (ACCOUNT_TYPES as readonly string[]).includes(raw)
    ? (raw as AccountType)
    : DEFAULT_ACCOUNT_TYPE
}
