import { Icons } from '@/components/ui'
import type { CategoryTone } from '@/components/ui'
import type { ReactNode } from 'react'

/**
 * How each report category and dataset is identified — one hue and one glyph.
 *
 * Kept in ONE place so a category looks the same on the hub, in the builder's
 * source picker and anywhere else it appears. A subject that changes colour
 * between screens stops being an identifier and becomes decoration.
 *
 * The mapping is by MEANING rather than by aesthetics: money is indigo,
 * anything counting stock is teal/emerald, people are sky/amber. Adding a
 * category without an entry falls back to slate, which is correct rather than
 * broken — it just carries no identity yet.
 */

/**
 * The Popular shelf's key.
 *
 * A VIEW over the catalogue rather than a category — the hub's own `POPULAR`
 * sentinel, repeated here because the grid and list sections take a category
 * string and would otherwise fall through to the slate "no identity" default
 * with a database glyph. Underscored so it can never collide with a real
 * category name.
 */
const POPULAR = '__popular'

export const CATEGORY_TONE: Record<string, CategoryTone> = {
  /* Amber, the same hue the favourites shelf wears — both are shortcuts past
     the catalogue rather than subjects within it, and reading as one family is
     the point. Operations also claims amber; they are never adjacent, since
     Popular sits alone on its own tab. */
  [POPULAR]: 'amber',
  Sales: 'indigo',
  /* Cyan, added to the ramp for this: the nine existing tones were all spoken
     for, and the two candidates for sharing both sit on this same unfiltered
     hub — violet on Saved, indigo on Sales, which is the tab Performance sits
     directly beside. A subject whose hue is another subject's is not an
     identifier, so it got its own. */
  Performance: 'cyan',
  Stock: 'teal',
  Customers: 'sky',
  Suppliers: 'rose',
  Money: 'emerald',
  Operations: 'amber',
  /* Shares Customers' hue, because the nine tones were already spoken for and
     the alternative was slate — the "no identity yet" fallback — on a category
     that has its own menu entry. Safe here in a way a third claim on indigo
     would not be: the Job cards reports live behind their OWN screen, where
     Customers is filtered out entirely, so the two hues are never read side by
     side. The glyph is what tells them apart on the unfiltered hub. */
  'Job cards': 'sky',
  'Multi-store': 'orange',
  Saved: 'violet',
}

export function categoryTone(category: string): CategoryTone {
  return CATEGORY_TONE[category] ?? 'slate'
}

/**
 * What each category answers, in one line.
 *
 * The hub's group headings carry these for the same reason Setup's and
 * Accounting's do: a heading that only names a category tells somebody who has
 * not run any of these reports nothing about which one to open. A category with
 * no entry simply renders without a line, rather than with a made-up one.
 */
const CATEGORY_DESCRIPTION: Record<string, string> = {
  /* Says outright that these are duplicates, so nobody wonders why invoice
     history is missing from Sales — it is not, and this is the same tile. */
  [POPULAR]: 'The ones most shops run. Each is also filed under its own subject.',
  Sales: 'What was sold, by whom, and what it came to.',
  Performance: 'Who and what is earning — product, department, clerk, till or customer.',
  Stock: 'What is on hand, what moved, and what is running out.',
  Customers: 'Who buys, who owes, and how long they take to pay.',
  Suppliers: 'What was bought in, from whom, and what it cost.',
  Money: 'Takings, expenses and what the day added up to.',
  Operations: 'How the shop ran — shifts, tills and who did what.',
  'Job cards': 'Work booked in, who did it, and what it earned.',
  'Multi-store': 'Every linked store together, and what they came to.',
  Saved: 'Reports this shop built or had generated.',
}

export function categoryDescription(category: string): string {
  return CATEGORY_DESCRIPTION[category] ?? ''
}

export function categoryIcon(category: string, size = 18): ReactNode {
  switch (category) {
    case POPULAR:
      return <Icons.Flame size={size} strokeWidth={1.7} />
    case 'Sales':
      return <Icons.BarChart size={size} strokeWidth={1.7} />
    /* A LINE against Sales' bars: the two tabs sit next to each other and are
       the pair most easily confused, so they are told apart by shape as well as
       hue. A rising line is also the right drawing for "how are we doing". */
    case 'Performance':
      return <Icons.LineChart size={size} strokeWidth={1.7} />
    case 'Stock':
      return <Icons.Boxes size={size} strokeWidth={1.7} />
    case 'Customers':
      return <Icons.Contact size={size} strokeWidth={1.7} />
    case 'Suppliers':
      return <Icons.Truck size={size} strokeWidth={1.7} />
    case 'Money':
      return <Icons.Coins size={size} strokeWidth={1.7} />
    case 'Operations':
      return <Icons.Settings size={size} strokeWidth={1.7} />
    /* The same wrench the Job cards section wears in the sidebar — the menu
       entry and the category heading it opens must read as one thing. */
    case 'Job cards':
      return <Icons.Wrench size={size} strokeWidth={1.7} />
    case 'Multi-store':
      return <Icons.Store size={size} strokeWidth={1.7} />
    case 'Saved':
      return <Icons.Star size={size} strokeWidth={1.7} />
    default:
      return <Icons.FileText size={size} strokeWidth={1.7} />
  }
}

/**
 * The builder's datasets get their own glyphs — a source is a narrower thing
 * than a category ("sales lines" vs "Sales"), and the picker is the one screen
 * where telling them apart at a glance actually matters.
 */
export function sourceIcon(sourceKey: string, size = 18): ReactNode {
  switch (sourceKey) {
    case 'sales':
      return <Icons.Receipt size={size} strokeWidth={1.7} />
    case 'saleLines':
      return <Icons.ListOrdered size={size} strokeWidth={1.7} />
    case 'tenders':
      return <Icons.CreditCard size={size} strokeWidth={1.7} />
    case 'products':
      return <Icons.Boxes size={size} strokeWidth={1.7} />
    case 'stockMovements':
      return <Icons.ArrowLeftRight size={size} strokeWidth={1.7} />
    case 'customers':
      return <Icons.Contact size={size} strokeWidth={1.7} />
    case 'customerTransactions':
      return <Icons.Wallet size={size} strokeWidth={1.7} />
    case 'suppliers':
      return <Icons.Truck size={size} strokeWidth={1.7} />
    case 'purchases':
      return <Icons.PackageOpen size={size} strokeWidth={1.7} />
    case 'purchaseLines':
      return <Icons.Package size={size} strokeWidth={1.7} />
    case 'expenseLines':
      return <Icons.Coins size={size} strokeWidth={1.7} />
    case 'shifts':
      return <Icons.Banknote size={size} strokeWidth={1.7} />
    case 'activity':
      return <Icons.History size={size} strokeWidth={1.7} />
    /* The five job datasets. Without these the Job cards screen was fifteen
       tiles wearing the same fallback database glyph — which is no identifier
       at all on a screen where every report is a job report. */
    case 'jobCards':
      return <Icons.Wrench size={size} strokeWidth={1.7} />
    case 'jobCardLines':
      return <Icons.ListOrdered size={size} strokeWidth={1.7} />
    case 'jobTime':
      return <Icons.Clock size={size} strokeWidth={1.7} />
    case 'jobTravel':
      return <Icons.Truck size={size} strokeWidth={1.7} />
    case 'jobVisits':
      return <Icons.CalendarClock size={size} strokeWidth={1.7} />
    default:
      return <Icons.Database size={size} strokeWidth={1.7} />
  }
}

/** A dataset's own hue, so the picker is not one colour repeated thirteen times. */
const SOURCE_TONE: Record<string, CategoryTone> = {
  sales: 'indigo',
  saleLines: 'violet',
  tenders: 'emerald',
  products: 'teal',
  stockMovements: 'emerald',
  customers: 'sky',
  customerTransactions: 'amber',
  suppliers: 'rose',
  purchases: 'orange',
  purchaseLines: 'orange',
  expenseLines: 'emerald',
  shifts: 'amber',
  activity: 'slate',
  jobCards: 'sky',
  jobCardLines: 'violet',
  jobTime: 'amber',
  jobTravel: 'orange',
  jobVisits: 'teal',
}

export function sourceTone(sourceKey: string): CategoryTone {
  return SOURCE_TONE[sourceKey] ?? 'slate'
}
