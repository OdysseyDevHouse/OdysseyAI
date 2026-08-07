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

export const CATEGORY_TONE: Record<string, CategoryTone> = {
  Sales: 'indigo',
  Stock: 'teal',
  Customers: 'sky',
  Suppliers: 'rose',
  Money: 'emerald',
  Operations: 'amber',
  Saved: 'violet',
}

export function categoryTone(category: string): CategoryTone {
  return CATEGORY_TONE[category] ?? 'slate'
}

export function categoryIcon(category: string, size = 18): ReactNode {
  switch (category) {
    case 'Sales':
      return <Icons.BarChart size={size} strokeWidth={1.7} />
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
}

export function sourceTone(sourceKey: string): CategoryTone {
  return SOURCE_TONE[sourceKey] ?? 'slate'
}
