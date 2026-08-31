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
      /* ── THE GATEWAY MOVED TO SETUP → PAYMENTS ─────────────────────────────
       *
       * No tile here any more, and not by oversight. OnlineStoreSetupHref
       * narrows a tile to `/online-store/*` precisely so this hub cannot grow
       * links out of itself, and that rule is worth more than the convenience
       * of a cross-reference.
       *
       * It moved because the gateway is not a storefront feature: an emailed
       * invoice's pay link, a statement QR and a lay-by instalment all need the
       * same connected account, and a shop that never bought this module needs
       * it just as much. Behind the module gate, such a shop could not reach the
       * screen at all — so its pay links silently never appeared.
       *
       * `/online-store/setup` still SHOWS whether an account is connected, which
       * is the fact a storefront actually cares about. */
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
