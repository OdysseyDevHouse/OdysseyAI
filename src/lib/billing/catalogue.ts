import type { ModuleKey } from '@/lib/control/modules'

/**
 * What each module IS, in the words used to sell it.
 *
 * ── WHY THIS IS NOT IN control/modules.ts ───────────────────────────────────
 *
 * That file is the entitlement authority and imports `server-only` — it decides
 * what a site holds. This is sales copy, and the billing screen renders it in a
 * client component, so it has to cross the boundary. Keeping them apart also
 * keeps the two jobs apart: a price or a bullet changes here without touching
 * the code that decides access.
 *
 * ── THE BULLETS ARE THE POINT ───────────────────────────────────────────────
 *
 * A module name and a price do not tell a shop owner whether they need it.
 * "Advanced Inventory · R249" means nothing; "recipes, goods received, stock
 * takes, variance" is the actual question. The legacy screen led with these and
 * it is the main reason it reads as something to buy rather than a settings
 * page — so the wording below is carried over verbatim where it existed.
 */

export type ModuleCard = {
  key: ModuleKey
  name: string
  /** One line under the name — what the module is for. */
  description: string
  /** The ticked list. Present tense, one capability each. */
  features: string[]
  /** A ceiling or an allowance worth stating, shown under a divider. */
  limitNote?: string
  /** Always on, cannot be removed, rendered with a locked tick. */
  required?: boolean
}

export const MODULE_CARDS: readonly ModuleCard[] = [
  {
    key: 'starter',
    name: 'Starter Pack',
    required: true,
    description:
      'Everything a single store needs to start selling — products, stock and reporting in one place.',
    features: [
      'Normal, returnable & service items.',
      'Stock adjustments.',
      'Core back-office & dashboard.',
      /* Invoicing and quotations were a separate "Sales Module" in the old
         system. They are part of the base package now — a shop that cannot
         raise an invoice is not a shop — so they are listed here. */
      'Full invoicing & quotations.',
      'Standard sales & stock reporting.',
    ],
    limitNote: 'Up to 5,000 products.',
  },
  {
    key: 'inventory_advanced',
    name: 'Advanced Inventory',
    description:
      'Full control of complex stock — recipes, ordering, stock takes and supplier accounts.',
    features: [
      'Recipe, refer-code & serial items.',
      'Stock takes & variance tracking.',
      'Inter-store transfers & adjustments.',
      'Batch & expiry tracking.',
      'Advanced inventory reporting.',
    ],
    limitNote: 'Raises your limit to 15,000 products.',
  },
  {
    key: 'multi_branch',
    name: 'Multi-Branch',
    description:
      'Run every branch from one portal — shared data, group reporting and inter-store transfers.',
    features: [
      'Manage products across all stores in one portal.',
      'Group reporting across every store.',
      'Manage users & clerks for every store.',
      'Inter-store transfers & sales to GRV.',
      'Centralised customer & supplier files.',
    ],
  },
  {
    key: 'customers',
    name: 'Customers',
    description:
      'Sell on account and manage debtors — payments, statements and recurring billing.',
    features: [
      'Customer accounts & account sales.',
      'Customer payments & journals.',
      'Batch payments & allocations.',
      'Credit limits & collections.',
      'Bulk statement runs.',
    ],
    limitNote: 'Up to 5,000 customer accounts.',
  },
  {
    key: 'online_store',
    name: 'Online Store',
    description: 'Sell online from the same product file — orders land in the back office.',
    features: [
      'Public storefront & product catalogue.',
      'Online orders into the back office.',
      'Online payments & delivery options.',
      'Store pages & content.',
      'Discount codes & reviews.',
    ],
  },
  {
    key: 'loyalty',
    name: 'Loyalty',
    description: 'Keep customers coming back with points, tiers and punch cards.',
    features: [
      'Points earned and redeemed at the till.',
      'Bronze, silver & gold tiers.',
      'Punch cards — buy nine, get the tenth free.',
      'Member balances & expiry runs.',
    ],
  },
  {
    key: 'job_cards',
    name: 'Job Cards',
    description:
      'Run service and repair work from request to invoice — scheduling, parts and SLAs.',
    features: [
      'Job cards from request to invoice.',
      'Scheduling & the job board.',
      'Parts requests & equipment history.',
      'SLAs & recurring jobs.',
      'Technician time & job reporting.',
    ],
  },
  {
    key: 'accounting',
    name: 'Accounting',
    description: 'Keep the books properly — a full general ledger and the financial statements.',
    features: [
      'Chart of accounts & journals.',
      'Income statement & balance sheet.',
      'Cash flow & trial balance.',
      'Budgets & fixed assets.',
      'Period closing.',
    ],
    /* Says what is NOT in it, because "Accounting" reads as "everything about
       money" and the cashbook is what a shop actually opens every day. */
    limitNote: 'The cashbook, expenses and VAT return are part of the Starter Pack.',
  },
]

export function cardFor(key: ModuleKey): ModuleCard | undefined {
  return MODULE_CARDS.find((c) => c.key === key)
}

/**
 * The multi-store discount, by how many stores are on the account.
 *
 * Carried over from the old system, which applied one flat rate to the whole
 * group subtotal rather than a different rate per store. Kept that way: a
 * per-store ladder means the fifth store costs less than the second, which
 * nobody can explain on a phone call.
 */
export function multiStoreDiscountRate(storeCount: number): number {
  const n = Math.max(1, Math.floor(storeCount))
  if (n <= 1) return 0
  if (n === 2) return 0.15
  if (n === 3) return 0.17
  if (n === 4) return 0.19
  return 0.22
}

/** The first till at each store is included; extras are charged. */
export const FREE_DEVICES_PER_STORE = 1
