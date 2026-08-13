import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * Everything under Accounting, grouped by the job it does.
 *
 * Accounting was the longest section in the menu — thirteen rows deep, ordered
 * by a comment apologising for the order. `src/lib/nav.ts` records why Setup
 * stopped being a flat group of fourteen, and the same argument applies with
 * more force here: "Unallocated", "Write-offs", "Interest" and "Periods" are
 * precisely the screens somebody cannot choose between from the name alone.
 *
 * Grouped by WHAT SOMEBODY IS TRYING TO DO — see what the business made, chase
 * what it is owed, find where the cash went, prove the books add up — because
 * that is the question people arrive with. Nobody opens this section wanting
 * "the ledger"; they want to know whether a customer has paid.
 *
 * Called MONEY in places rather than Accounting, deliberately: half of what is
 * in here — age analysis, expenses, collection runs — is not accounting, and
 * the person chasing an overdue invoice does not think of themselves as doing
 * accounts.
 */

/** An accounting route, narrowed so a tile cannot point outside this hub. */
export type AccountingHref = Extract<
  SubpageHref,
  | `/accounting/${string}`
  | `/cashbook${string}`
  | `/expenses${string}`
  | `/suppliers/${string}`
  | `/credit/${string}`
  | '/sales/offline'
>

const DECLARED: DeclaredGroup<AccountingHref>[] = [
  {
    label: 'The statements',
    description: 'What the business made, what it owns, and what it owes the taxman.',
    tone: 'indigo',
    icon: 'LineChart',
    items: [
      {
        href: '/accounting/income-statement',
        description: 'What was earned and what it cost, over any period you pick.',
        keywords: 'p&l profit loss income statement earnings revenue',
        icon: 'LineChart',
        tone: 'indigo',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/balance-sheet',
        description: 'What the business owns and owes on a given day.',
        keywords: 'assets liabilities equity net worth position',
        icon: 'Scale',
        tone: 'violet',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/cash-flow',
        description: 'The profit was made — this shows where the money went.',
        keywords: 'cash flow statement operating investing financing movements liquidity',
        icon: 'Coins',
        tone: 'indigo',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/trial-balance',
        description: 'Every account and its balance — the check that the books add up.',
        keywords: 'tb ledger balances debits credits',
        icon: 'BarChart',
        tone: 'sky',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/vat',
        description: 'What is owed to SARS this period, and the sales behind it.',
        keywords: 'tax sars return vat201 output input',
        icon: 'Percent',
        tone: 'amber',
        capability: 'reports.financial',
      },
    ],
  },
  {
    label: 'Owed and owing',
    description: 'What customers still owe, and what the business owes its suppliers.',
    tone: 'orange',
    icon: 'Bell',
    items: [
      {
        href: '/suppliers/age-analysis',
        description: 'How far behind the business is with each supplier.',
        keywords: 'creditors payables ageing overdue 30 60 90 days',
        icon: 'Truck',
        tone: 'orange',
        capability: 'suppliers.view',
      },
      {
        href: '/suppliers/remittances',
        description: 'Tell suppliers what was paid, and against which invoices.',
        keywords: 'payment advice remittance advice email suppliers paid',
        icon: 'Mail',
        tone: 'teal',
        capability: 'purchasing.pay',
      },
      {
        href: '/credit/runs',
        description: 'Past chasing runs — who was contacted, and what it recovered.',
        keywords: 'collections dunning chasing reminders campaign history',
        icon: 'Bell',
        tone: 'rose',
        capability: 'customers.view',
      },
      {
        href: '/accounting/interest',
        description: 'Charge interest on accounts that have run late.',
        keywords: 'finance charges late payment penalty overdue',
        icon: 'Percent',
        tone: 'amber',
        capability: 'customers.credit',
      },
      {
        href: '/accounting/write-offs',
        description: 'Give up on a debt, and take the loss where it belongs.',
        keywords: 'bad debt written off irrecoverable forgive',
        icon: 'Reverse',
        tone: 'rose',
        capability: 'customers.credit',
      },
    ],
  },
  {
    label: 'Cash and spending',
    description: 'Where the money actually went, and what came in.',
    tone: 'emerald',
    icon: 'Landmark',
    items: [
      {
        href: '/cashbook',
        description: 'Every payment in and out of the bank, matched to what it settled.',
        keywords: 'bank account deposits payments reconcile statement',
        icon: 'Landmark',
        tone: 'emerald',
        capability: 'cashbook.view',
      },
      {
        href: '/cashbook/import',
        description: 'Load a bank statement instead of typing it in line by line.',
        keywords: 'csv ofx upload bank feed import statement',
        icon: 'FileText',
        tone: 'sky',
        capability: 'cashbook.view',
      },
      {
        href: '/expenses',
        description: 'Everything the business spends on that is not stock.',
        keywords: 'overheads costs bills spending suppliers rent',
        icon: 'Receipt',
        tone: 'amber',
        capability: 'cashbook.view',
      },
      {
        href: '/expenses/recurring',
        description: 'Bills that arrive every month, raised without asking.',
        keywords: 'rent subscriptions monthly standing order repeat',
        icon: 'Repeat',
        tone: 'violet',
        capability: 'cashbook.view',
      },
      {
        href: '/accounting/unallocated',
        description: 'Money received that is not yet against an invoice.',
        keywords: 'unmatched suspense on account payments floating',
        icon: 'Coins',
        tone: 'orange',
        capability: 'cashbook.view',
      },
    ],
  },
  {
    label: 'The ledger',
    description: 'The machinery underneath — accounts, journals and what the business owns.',
    tone: 'slate',
    icon: 'ListOrdered',
    items: [
      {
        href: '/accounting/accounts',
        description: 'Every account the books post to, and what each one is for.',
        keywords: 'chart of accounts coa general ledger codes',
        icon: 'ListOrdered',
        tone: 'slate',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/journals',
        description: 'Corrections and entries made by hand, with their reasons.',
        keywords: 'journal entries adjustments manual postings corrections',
        icon: 'FileText',
        tone: 'indigo',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/budgets',
        description: 'What each account is expected to do, month by month.',
        keywords: 'budget budgets targets forecast variance plan',
        icon: 'BarChart',
        tone: 'indigo',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/assets',
        description: 'What the business owns and uses — vehicles, fittings, equipment.',
        keywords: 'fixed assets register equipment vehicles capital',
        icon: 'Warehouse',
        tone: 'teal',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/assets/depreciation',
        description: 'Turn what was bought into a cost over the years it is used.',
        keywords: 'depreciation wear and tear write down amortisation',
        icon: 'BarChart',
        tone: 'violet',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/periods',
        description: 'Close a month so nobody can change what has been reported.',
        keywords: 'lock period close month end year end freeze',
        icon: 'Lock',
        tone: 'rose',
        capability: 'setup.edit',
      },
    ],
  },
  {
    label: 'Does it add up?',
    description: 'The checks that catch a figure going wrong before a statement does.',
    tone: 'sky',
    icon: 'Check',
    items: [
      {
        href: '/sales/offline',
        description: 'Sales rung up with no connection — and whether they are on the books.',
        keywords: 'offline queued unsynced till disconnected pending',
        icon: 'CloudOff',
        tone: 'sky',
        capability: 'sales.view',
      },
    ],
  },
]

export const ACCOUNTING_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The catalogue as one user sees it — empty groups dropped. */
export function accountingGroupsFor(granted: (capability: string) => boolean): HubGroup[] {
  return groupsFor(ACCOUNTING_GROUPS, granted)
}
