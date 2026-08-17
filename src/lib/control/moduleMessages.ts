import { MODULE_LABELS, type ModuleKey } from './modules'

/**
 * What to tell somebody who reached a feature their shop has not bought.
 *
 * Kept out of `modules.ts` so a client component can import it without dragging
 * `server-only` and the database pool with it — the same split as
 * deviceMessages.ts.
 *
 * ── THIS IS NOT A PERMISSION REFUSAL, AND MUST NOT READ LIKE ONE ────────────
 *
 * "You do not have permission" sends the reader to whoever manages roles, who
 * will look at their permissions, find nothing wrong, and send them back. The
 * honest sentence names the real obstacle — the plan — and the real fix: an
 * owner adding it under Setup → Plan & billing.
 *
 * That distinction is why /upgrade and /not-allowed are two pages rather than
 * one with a flag.
 */

/** What the module is, in the words a shop owner would use. */
export const MODULE_DESCRIPTIONS: Record<ModuleKey, string> = {
  starter:
    'The base package: the till, invoicing and quotations, products, purchasing, cash-up and the standard reports.',
  inventory_advanced:
    'Stock takes and variance, inter-store transfers, adjustments, batch tracking and manufacturing.',
  multi_branch:
    'Share one product file across your stores, report across all of them together, and move stock between them.',
  customers:
    'Customer accounts and account sales, statements, age analysis, credit limits and payment allocations.',
  online_store: 'Your public web shop: catalogue, orders and the storefront your customers browse.',
  loyalty: 'A points programme with tiers, member cards, and redemption at the till.',
  job_cards:
    'Job cards from request to invoice: scheduling, the job board, parts, equipment history and SLAs.',
  /* Deliberately says what it is NOT, because the obvious reading of
     "Accounting" is "everything about money" — and the cashbook, expenses and
     the VAT return stay in the base package. What is sold here is the
     double-entry layer on top of them. */
  accounting:
    'The general ledger and the financial statements: chart of accounts, journals, budgets, fixed assets and period closing. The cashbook, expenses and VAT return are part of the base package.',
}

/** The sentence shown where the feature would have been. */
export function moduleLabelFor(key: ModuleKey, canManageBilling: boolean): string {
  const name = MODULE_LABELS[key]
  return canManageBilling
    ? `${name} is not part of this store’s plan. You can add it under Setup → Plan & billing.`
    : `${name} is not part of this store’s plan. An owner can add it under Setup → Plan & billing.`
}

/** The short version, for a chip or a table cell. */
export function moduleStateLabel(key: ModuleKey): string {
  return `${MODULE_LABELS[key]} not in plan`
}

/**
 * The sentence for a module the customer has cancelled but still holds.
 *
 * Worth its own wording: the feature works today and stops on a known date, and
 * somebody who reads "not in your plan" while it is plainly still working will
 * assume the message is broken.
 */
export function moduleEndingLabel(key: ModuleKey, endsOn: string): string {
  return `${MODULE_LABELS[key]} ends on ${endsOn}. It keeps working until then.`
}
