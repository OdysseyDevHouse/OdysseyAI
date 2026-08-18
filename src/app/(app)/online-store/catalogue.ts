import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * Everything under the Online Store, grouped by the job it does.
 *
 * Eleven rows in the menu, of which three were operational and eight were
 * configuration — the widest mismatch in the app between how a section was
 * listed and how it is used. It is also a section most shops never switch on,
 * so it was costing every one of them a permanent group in the menu.
 *
 * Grouped by WHAT SOMEBODY IS TRYING TO DO — take an order, decide what is
 * listed, change how the site looks, see whether it is working.
 */

/** An online store route, narrowed so a tile cannot point outside this hub. */
export type OnlineStoreHref = Extract<SubpageHref, `/online-store/${string}`>

const DECLARED: DeclaredGroup<OnlineStoreHref>[] = [
  {
    label: 'Selling',
    description: 'Orders as they come in, and everything that decides how they are paid for.',
    tone: 'emerald',
    icon: 'ShoppingBag',
    items: [
      {
        href: '/online-store/orders',
        description: 'What has been bought online, and where each order has got to.',
        keywords: 'sales web orders shipping fulfilment collect delivery',
        icon: 'Receipt',
        tone: 'emerald',
        capability: 'online.view',
      },
      {
        href: '/online-store/trading',
        description: 'When the shop is open, and whether it is taking orders right now.',
        keywords: 'hours open closed holidays busy pause sold out collection times',
        icon: 'Clock',
        tone: 'amber',
        capability: 'online.edit',
      },
      {
        href: '/online-store/statuses',
        description: 'The steps an order moves through, from paid to collected.',
        keywords: 'workflow stages pipeline packing shipped fulfilment',
        icon: 'ListOrdered',
        tone: 'sky',
        capability: 'online.edit',
      },
      {
        href: '/online-store/payments',
        description: 'How shoppers may pay, and the gateway that takes the money.',
        keywords: 'payfast yoco ozow gateway card eft checkout',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'online.edit',
      },
      {
        href: '/online-store/discounts',
        description: 'Codes a shopper can type at checkout, and what each takes off.',
        keywords: 'promo coupon voucher promotion sale code',
        icon: 'Tag',
        tone: 'rose',
        capability: 'online.edit',
      },
    ],
  },
  {
    label: 'What is listed',
    description: 'Which products the site shows, how they are filed, and what shoppers say.',
    tone: 'teal',
    icon: 'Boxes',
    items: [
      {
        href: '/online-store/products',
        description: 'Which products appear online, with their pictures and copy.',
        keywords: 'catalogue listings images photos descriptions publish',
        icon: 'Package',
        tone: 'teal',
        capability: 'online.edit',
      },
      {
        href: '/online-store/departments',
        description: 'How the shop is filed, and the order the menus show.',
        keywords: 'categories navigation menu browse collections',
        icon: 'LayoutGrid',
        tone: 'violet',
        capability: 'online.edit',
      },
      {
        href: '/online-store/listing',
        description: 'How many products a row shows, what each tile says, and the order.',
        keywords: 'grid columns tiles layout sort order per page filters facets badges',
        icon: 'LayoutGrid',
        tone: 'violet',
        capability: 'online.edit',
      },
      {
        href: '/online-store/reviews',
        description: 'What shoppers said about a product, and what is shown.',
        keywords: 'ratings stars feedback comments moderation approve',
        icon: 'MessageSquare',
        tone: 'amber',
        capability: 'online.view',
      },
    ],
  },
  {
    label: 'The site',
    description: 'What the shop looks like, and the pages beyond the catalogue.',
    tone: 'violet',
    icon: 'Palette',
    items: [
      {
        href: '/online-store/builder',
        description: 'Lay out the home page — banners, rows of products, what leads.',
        keywords: 'design theme layout homepage banners sections blocks',
        icon: 'Palette',
        tone: 'violet',
        capability: 'online.edit',
      },
      {
        href: '/online-store/pages',
        description: 'About us, delivery, returns — the pages that are not products.',
        keywords: 'content cms about contact terms policy delivery faq',
        icon: 'FileText',
        tone: 'sky',
        capability: 'online.edit',
      },
    ],
  },
  {
    label: 'Is it working?',
    description: 'Where shoppers arrive, and where they give up.',
    tone: 'indigo',
    icon: 'BarChart',
    items: [
      {
        href: '/online-store/funnel',
        description: 'How many looked, how many added to a basket, how many paid.',
        keywords: 'analytics conversion abandoned basket cart traffic stats',
        icon: 'BarChart',
        tone: 'indigo',
        capability: 'online.view',
      },
    ],
  },
  {
    label: 'Settings',
    description: 'The shop’s own details — its address, its delivery rules, whether it is open.',
    tone: 'slate',
    icon: 'Settings',
    items: [
      {
        href: '/online-store/setup',
        description: 'The name, the domain, delivery charges, and whether the shop is live.',
        keywords: 'domain url delivery fees shipping open closed launch go live',
        icon: 'Settings',
        tone: 'slate',
        capability: 'online.edit',
      },
    ],
  },
]

export const ONLINE_STORE_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The catalogue as one user sees it — empty groups dropped. */
export function onlineStoreGroupsFor(granted: (capability: string) => boolean): HubGroup[] {
  return groupsFor(ONLINE_STORE_GROUPS, granted)
}
