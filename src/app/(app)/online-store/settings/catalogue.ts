import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * How the shop runs, as opposed to what it is selling today.
 *
 * These five screens were mixed into the operational hub — four of them sat in
 * "Selling" beside the order list — and were ALSO cross-referenced from the
 * general Setup hub, which is two front doors that could disagree. They are
 * listed here now, under the Online Store section's own Setup row.
 *
 * Grouped by the question somebody arrives with: is the shop open for business,
 * and what happens after a shopper has paid.
 */

/** An online store route, narrowed so a tile cannot point outside this hub. */
export type OnlineStoreSetupHref = Extract<SubpageHref, `/online-store/${string}`>

const DECLARED: DeclaredGroup<OnlineStoreSetupHref>[] = [
  {
    label: 'Open for business',
    description: 'The shop’s own details, when it trades, and how a shopper pays.',
    tone: 'sky',
    icon: 'ShoppingBag',
    items: [
      {
        href: '/online-store/setup',
        description:
          'The name, the domain, delivery charges, and whether the shop is live. A chain also sets up one shop for the whole group here.',
        keywords:
          'domain url delivery fees shipping open closed launch go live group branches one shop nearest branch pins map coordinates',
        icon: 'Settings',
        tone: 'slate',
        capability: 'online.edit',
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
        href: '/online-store/payments',
        description: 'How shoppers may pay, and the gateway that takes the money.',
        keywords: 'payfast yoco ozow gateway card eft checkout',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'online.edit',
      },
    ],
  },
  {
    label: 'After the order',
    description: 'What happens once somebody has paid, and what they can knock off the price.',
    tone: 'emerald',
    icon: 'ListOrdered',
    items: [
      {
        href: '/online-store/statuses',
        description: 'The steps an order moves through, from paid to collected.',
        keywords: 'workflow stages pipeline packing shipped fulfilment',
        icon: 'ListOrdered',
        tone: 'sky',
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
]

/** Every tile, for the search index. */
export const ONLINE_STORE_SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The groups this user may see, with tiles they may not open dropped. */
export function onlineStoreSetupGroupsFor(allow: (capability: string) => boolean): HubGroup[] {
  return groupsFor(ONLINE_STORE_SETUP_GROUPS, allow)
}
