import type { StepKey } from '@/lib/site/gettingStarted'
import type { CategoryTone } from '@/components/ui'

/**
 * The steps a new shop is walked through, in the order they should be done.
 *
 * ── WHY THE ORDER IS WHAT IT IS ───────────────────────────────────────────
 *
 * Not "easiest first" and not the order the menu happens to be in. Each step is
 * placed where its OUTPUT is first needed:
 *
 *   store info → every document printed from here carries it
 *   departments → a product asks for one when you create it
 *   products    → the till has nothing to sell without them
 *   stock       → a product with no stock sells at zero on hand
 *   users       → somebody other than the owner has to be able to serve
 *   sale        → the point of all of it, and the thing that proves it works
 *
 * Somebody who works straight down this list never hits a screen that asks for
 * something they have not made yet, which is the single most common way a
 * setup wizard wastes an afternoon.
 *
 * ── WHY THE LATER STEPS ARE OPTIONAL ──────────────────────────────────────
 *
 * A shop can trade after the sixth. Everything below it — suppliers, customer
 * accounts, extra tenders, a second location — is real setup, but a shop that
 * sells for cash over a counter genuinely never needs any of it, and a
 * checklist that demands eleven things before it will say "ready" is a
 * checklist that gets abandoned at four. `essential` splits the two, and the
 * progress bar counts only the first group.
 */

export type Step = {
  key: StepKey
  title: string
  /** What this step is FOR, in the shop's words — not the screen's name. */
  blurb: string
  href: string
  /** The label on the button when the step has not been done. */
  cta: string
  icon: string
  tone: CategoryTone
  /** Roughly how long it takes, so nobody opens a step expecting five minutes. */
  minutes: number
  /** Counts towards "ready to trade". The rest are worth doing, not required. */
  essential: boolean
  capability?: string
  /** The module the shop must have bought. Omitted means the base package. */
  module?: string
  /** Opens beside the back office rather than replacing it — the till only. */
  newWindow?: boolean
}

export const STEPS: Step[] = [
  {
    key: 'storeInfo',
    title: 'Tell us about the shop',
    blurb:
      'Your name, address and phone number. Every invoice, quote and receipt you print carries these, so this comes first.',
    href: '/setup/store-info',
    cta: 'Add your details',
    icon: 'Store',
    tone: 'indigo',
    minutes: 2,
    essential: true,
    capability: 'setup.edit',
  },
  {
    key: 'departments',
    title: 'Group what you sell',
    blurb:
      'Departments are how the product file is grouped and how every sales report adds up. Two or three is plenty to start.',
    href: '/departments',
    cta: 'Add a department',
    icon: 'LayoutGrid',
    tone: 'violet',
    minutes: 3,
    essential: true,
    capability: 'products.edit',
  },
  {
    key: 'products',
    title: 'Add what you sell',
    blurb:
      'The till has nothing to ring up until this has something in it. Add a few by hand, or bring a whole catalogue in from a spreadsheet.',
    href: '/products/new',
    cta: 'Add a product',
    icon: 'Package',
    tone: 'emerald',
    minutes: 10,
    essential: true,
    capability: 'products.edit',
  },
  {
    key: 'stock',
    title: 'Say what you have on hand',
    blurb:
      'Opening balances tell the system what is on the shelf today. Without them everything sells at zero on hand and your stock reports start wrong.',
    href: '/setup/opening-balances',
    cta: 'Enter opening stock',
    icon: 'Boxes',
    tone: 'amber',
    minutes: 10,
    essential: true,
    capability: 'stock.adjust',
  },
  {
    key: 'users',
    title: 'Let your staff in',
    blurb:
      'Everyone who serves gets their own login and PIN, so every sale, refund and discount has a name against it.',
    href: '/setup/users',
    cta: 'Add a user',
    icon: 'Users',
    tone: 'sky',
    minutes: 5,
    essential: true,
    capability: 'setup.users',
  },
  {
    key: 'sales',
    title: 'Ring up your first sale',
    blurb:
      'The one that proves the rest of it works. Open the till, scan something, take the money — you can void it straight afterwards.',
    href: '/pos',
    cta: 'Open the till',
    icon: 'ShoppingCart',
    tone: 'rose',
    minutes: 2,
    essential: true,
    capability: 'sales.till',
    newWindow: true,
  },

  /* ── Worth doing, not required to trade ──────────────────────────────── */

  {
    key: 'roles',
    title: 'Decide who may do what',
    blurb:
      'Roles say who can discount, who can void a sale and who sees the takings. Name them after the jobs people actually do.',
    href: '/setup/roles',
    cta: 'Set up roles',
    icon: 'ShieldCheck',
    tone: 'teal',
    minutes: 5,
    essential: false,
    capability: 'setup.users',
  },
  {
    key: 'suppliers',
    title: 'Add who you buy from',
    blurb:
      'Suppliers let you raise orders, receive stock against them and keep costs up to date automatically.',
    href: '/suppliers/new',
    cta: 'Add a supplier',
    icon: 'Truck',
    tone: 'orange',
    minutes: 4,
    essential: false,
    capability: 'suppliers.edit',
  },
  {
    key: 'customers',
    title: 'Open customer accounts',
    blurb:
      'For anyone who buys on account rather than paying at the counter. Statements, credit limits and ageing all follow from this.',
    href: '/customers/new',
    cta: 'Add a customer',
    icon: 'Contact',
    tone: 'cyan',
    minutes: 4,
    essential: false,
    capability: 'customers.edit',
    module: 'customers',
  },
  {
    key: 'tenders',
    title: 'Choose how you get paid',
    blurb:
      'Cash, card, account and EFT are ready to go. Add the rest — vouchers, mobile money, whatever your shop takes.',
    href: '/setup/tender-types',
    cta: 'Add a payment type',
    icon: 'CreditCard',
    tone: 'slate',
    minutes: 3,
    essential: false,
    capability: 'setup.edit',
  },
  {
    key: 'locations',
    title: 'Add a second location',
    blurb:
      'A storeroom, a back shop or a second branch. Stock is counted per location, and you can move it between them.',
    href: '/setup/locations',
    cta: 'Add a location',
    icon: 'Warehouse',
    tone: 'indigo',
    minutes: 3,
    essential: false,
    capability: 'setup.edit',
  },
]

/**
 * The things worth knowing about that are not steps.
 *
 * Deliberately separate from the checklist. These have no "done" state — a shop
 * does not finish looking at its reports — and mixing them into a list of tasks
 * would mean either a tick that never appears or a task that cannot be
 * completed. Both make the checklist above less trustworthy.
 */
export type Pointer = {
  title: string
  blurb: string
  href: string
  icon: string
  tone: CategoryTone
  capability?: string
  module?: string
  newWindow?: boolean
}

export const POINTERS: Pointer[] = [
  {
    title: 'See how the shop is trading',
    blurb: 'Takings, top sellers and what needs attention — the screen to open each morning.',
    href: '/dashboard',
    icon: 'LayoutDashboard',
    tone: 'emerald',
    capability: 'dashboard.view',
  },
  {
    title: 'Run a report',
    blurb: 'Sales by day, stock on hand, what is not moving. Ask a question in plain English if you would rather.',
    href: '/reports',
    icon: 'BarChart',
    tone: 'violet',
    capability: 'reports.view',
  },
  {
    title: 'Bring in a spreadsheet',
    blurb: 'Products, customers and suppliers from a CSV — far faster than typing a catalogue in by hand.',
    href: '/setup/import',
    icon: 'Upload',
    tone: 'sky',
    capability: 'setup.edit',
  },
  {
    title: 'Lay out the till',
    blurb: 'Quick keys put your best sellers one press away, so a cashier never hunts for them.',
    href: '/setup/quick-keys',
    icon: 'LayoutGrid',
    tone: 'amber',
    capability: 'setup.edit',
  },
  {
    title: 'Dress up your documents',
    blurb: 'Put your logo on invoices, quotes and statements, and say what the small print reads.',
    href: '/setup/stationery',
    icon: 'Stamp',
    tone: 'rose',
    capability: 'setup.stationery',
  },
  {
    title: 'Sell online',
    blurb: 'A storefront that shares this product file, so stock and prices are never entered twice.',
    href: '/online-store',
    icon: 'Globe',
    tone: 'teal',
    capability: 'online.edit',
    module: 'online_store',
  },
]
