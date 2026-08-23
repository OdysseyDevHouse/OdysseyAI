import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import type { SubpageHref } from '@/lib/nav'

/**
 * How the loyalty programme works, as opposed to who is on it.
 *
 * These three screens were tiles in the general Setup hub, which put them
 * behind a section a shop without the module never opens — and made loyalty the
 * only feature whose settings lived somewhere other than the feature itself.
 * They are listed here instead, under Loyalty's own Setup row.
 *
 * One group, not three: there are only three screens and they answer one
 * question between them. A hub earns its groups when browsing it is a chore,
 * and three tiles is not that.
 */

/** A loyalty route, narrowed so a tile cannot point outside this hub. */
export type LoyaltySetupHref = Extract<SubpageHref, `/loyalty/${string}`>

const DECLARED: DeclaredGroup<LoyaltySetupHref>[] = [
  {
    label: 'The programme',
    description: 'What a rand earns, what a point is worth, and what keeps somebody coming back.',
    tone: 'violet',
    icon: 'Gem',
    items: [
      {
        href: '/loyalty/programme',
        description: 'Whether points are earned, at what rate, and what they redeem for.',
        keywords: 'points rewards earn rate redemption programme rules',
        icon: 'Settings',
        tone: 'violet',
        capability: 'loyalty.view',
      },
      {
        href: '/loyalty/tiers',
        description: 'Bronze, silver, gold — what it takes to get there and what it gives.',
        keywords: 'tiers levels vip bronze silver gold status benefits',
        icon: 'Gem',
        tone: 'amber',
        capability: 'loyalty.view',
      },
      {
        href: '/loyalty/cards',
        description: 'Buy nine, get the tenth free — punch cards and what fills them.',
        keywords: 'punch card stamps buy x get y free coffee',
        icon: 'Stamp',
        tone: 'orange',
        capability: 'loyalty.view',
      },
    ],
  },
]

/** Every tile, for the search index. */
export const LOYALTY_SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The groups this user may see, with tiles they may not open dropped. */
export function loyaltySetupGroupsFor(allow: (capability: string) => boolean): HubGroup[] {
  return groupsFor(LOYALTY_SETUP_GROUPS, allow)
}
