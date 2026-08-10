import type { CategoryTone } from '@/components/ui'
import { SUBPAGE_LABELS } from '@/lib/nav'

/**
 * Every setup screen, grouped by the job it does.
 *
 * This is the ONLY list of the setup screens. The sidebar used to name all
 * fourteen as well — a flat menu that said nothing about what any of them did,
 * and gave every setting two front doors that could disagree. It is now a
 * single "Setup" link to the hub this file describes, so a new setting is added
 * here and appears in the one place people look.
 *
 * Grouped by WHAT SOMEBODY IS TRYING TO DO — let a person in, decide what a
 * sale costs, get the shop's own details right — and each carries the one line
 * that says what it decides, which is what makes an unfamiliar setting
 * choosable by someone who has not opened it before.
 *
 * The `capability` on each entry mirrors the guard on the page it points at.
 * That is deliberate duplication: it hides a tile somebody may not open, but it
 * is NOT the boundary. Every one of these pages checks for itself, because a
 * hidden tile is still a URL anyone can type.
 *
 * Labels come from `SUBPAGE_LABELS` in `src/lib/nav.ts`, which the breadcrumb
 * also reads — so a screen can never be called one thing on its tile and
 * another in the trail above it.
 */

/**
 * A setup route. Typed off `SUBPAGE_LABELS` so a tile pointing at a screen the
 * breadcrumb has never heard of is a compile error rather than a page that
 * renders with no trail.
 */
export type SetupHref = keyof typeof SUBPAGE_LABELS

/** A setting as written below — no label, because the href already implies it. */
type DeclaredItem = {
  href: SetupHref
  /** What this screen decides, in one line. */
  description: string
  /** Words someone might search for that are not in the label. */
  keywords?: string
  icon: SetupIconName
  /**
   * The tile's own hue. Set per SETTING rather than inherited from the group,
   * so a row of five is five distinguishable things rather than one colour
   * repeated — the tile then works as an identifier when someone is scanning
   * for the shape they used last time, which is the whole point of having one.
   */
  tone: CategoryTone
  capability: string
}

/** A setting as the hub renders it, with its name resolved. */
export type SetupItem = DeclaredItem & { label: string }

type DeclaredGroup = {
  label: string
  /** Why these belong together — shown under the group heading. */
  description: string
  tone: CategoryTone
  icon: SetupIconName
  items: DeclaredItem[]
}

export type SetupGroup = Omit<DeclaredGroup, 'items'> & { items: SetupItem[] }

/**
 * Icons are named rather than imported as components, because this module is
 * read by a server component and a Lucide component cannot cross the
 * server/client boundary as a prop. `SetupHub` maps the name back to the glyph
 * on its own side.
 */
export type SetupIconName =
  | 'Users'
  | 'KeyRound'
  | 'Store'
  | 'Warehouse'
  | 'Percent'
  | 'CreditCard'
  | 'Terminal'
  | 'LayoutGrid'
  | 'Hash'
  | 'Check'
  | 'FileText'
  | 'Package'
  | 'Scale'
  | 'Database'
  | 'Palette'
  | 'Settings'
  | 'ShieldCheck'
  | 'Coins'

const DECLARED: DeclaredGroup[] = [
  {
    label: 'People & access',
    description: 'Who may sign in, and what each of them is allowed to do.',
    tone: 'sky',
    icon: 'ShieldCheck',
    items: [
      {
        href: '/setup/users',
        description: 'Who may sign in, at the till and in the back office.',
        keywords: 'staff logins pin passwords accounts sales rep',
        icon: 'Users',
        tone: 'sky',
        capability: 'setup.users',
      },
      {
        href: '/setup/roles',
        description: 'What each role may do — name them after the jobs people actually do.',
        keywords: 'security capabilities rights access control',
        icon: 'KeyRound',
        tone: 'indigo',
        capability: 'setup.users',
      },
    ],
  },
  {
    label: 'Money & pricing',
    description: 'What a line costs, and how a sale can be paid for.',
    tone: 'emerald',
    icon: 'Coins',
    items: [
      {
        href: '/setup/pricing',
        description: 'Retail, wholesale and the rates they charge — plus bulk repricing.',
        keywords: 'tax rates price structures markup reprice vat',
        icon: 'Percent',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/tender-types',
        description: 'How sales are paid for. Some stores have four, some have ten.',
        keywords: 'cash card eft payment methods vouchers',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        href: '/setup/laybys',
        description: 'What a customer agrees to when they put something aside.',
        keywords: 'deposit cancellation fee terms instalments',
        icon: 'Package',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/setup/expense-categories',
        description: 'What the business spends on, and where each one posts in the ledger.',
        keywords: 'chart of accounts spending overheads account codes',
        icon: 'Scale',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/opening-balances',
        description: 'Carry in what is already owed on the day you switch over.',
        keywords: 'import migration debtors creditors go live',
        icon: 'FileText',
        tone: 'orange',
        capability: 'setup.edit',
      },
    ],
  },
  {
    label: 'Store & stock',
    description: 'The shop itself — its tills, its stock rooms, its branches.',
    tone: 'teal',
    icon: 'Store',
    items: [
      {
        href: '/setup/locations',
        description: 'The places stock is kept. Sales come from the main one.',
        keywords: 'warehouse storeroom bins branches',
        icon: 'Warehouse',
        tone: 'teal',
        capability: 'setup.edit',
      },
      {
        href: '/setup/terminals',
        description: 'Which register rang up a sale, and which machine is which.',
        keywords: 'terminals registers pos devices',
        icon: 'Terminal',
        tone: 'sky',
        capability: 'setup.edit',
      },
      {
        href: '/setup/quick-keys',
        description: 'The buttons on the till — the things this shop sells most.',
        keywords: 'quick keys buttons tiles favourites shortcuts till pos grid',
        icon: 'LayoutGrid',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/setup/tables',
        description: 'The floor a waiter sees — and whether the till shows it at all.',
        keywords: 'tables restaurant hospitality floor sections covers waiter bills',
        icon: 'LayoutGrid',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/linked-stores',
        description: 'Branches that share products, customers or loyalty with this one.',
        keywords: 'multi store group branches sharing',
        icon: 'Store',
        tone: 'violet',
        capability: 'setup.edit',
      },
    ],
  },
  {
    label: 'System',
    description: 'The plumbing — document numbers, databases, and whether it all adds up.',
    tone: 'slate',
    icon: 'Settings',
    items: [
      {
        href: '/setup/numbering',
        description: 'The prefixes and next numbers for invoices, quotes and codes.',
        keywords: 'sequences document numbers prefix autocode',
        icon: 'Hash',
        tone: 'slate',
        capability: 'setup.edit',
      },
      {
        href: '/setup/reconciliation',
        description: 'Does the system still add up? Stock, balances and document numbers.',
        keywords: 'drift integrity check invariants audit',
        icon: 'Check',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/databases',
        description: 'This shop’s details, and the health of every database behind it.',
        keywords: 'connection health server site details',
        icon: 'Database',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        href: '/setup/style-guide',
        description: 'Every component the app is built from, rendered live.',
        keywords: 'design system components reference ui kit',
        icon: 'Palette',
        tone: 'rose',
        capability: 'setup.view',
      },
    ],
  },
]

/**
 * The catalogue, with every tile's name filled in from `SUBPAGE_LABELS`.
 *
 * Resolved here rather than typed out on each entry so that renaming a screen
 * is one edit in `nav.ts` and the tile, the breadcrumb and the search all
 * follow. A tile whose href is not in the map cannot be written — `SetupHref`
 * makes it a compile error — so the fallback is unreachable and exists only to
 * keep the type honest.
 */
export const SETUP_GROUPS: SetupGroup[] = DECLARED.map((group) => ({
  ...group,
  items: group.items.map((item) => ({ ...item, label: SUBPAGE_LABELS[item.href] ?? item.href })),
}))

/** The whole catalogue flat — for searching and counting. */
export const SETUP_ITEMS: SetupItem[] = SETUP_GROUPS.flatMap((g) => g.items)

/**
 * The catalogue as one user sees it.
 *
 * A group disappears once every tile in it is hidden, rather than rendering an
 * empty heading — a "Money & pricing" heading over nothing reads as a broken
 * screen rather than a restricted one.
 */
export function setupGroupsFor(granted: (capability: string) => boolean): SetupGroup[] {
  return SETUP_GROUPS.flatMap((group) => {
    const items = group.items.filter((item) => granted(item.capability))
    return items.length ? [{ ...group, items }] : []
  })
}
