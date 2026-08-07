import type { TabItem } from '@/components/ui'

export type LoyaltyTab = 'members' | 'programme' | 'tiers' | 'cards'

/**
 * The loyalty sections, in the order an owner thinks about them.
 *
 * People first: the screen someone opens thinking "loyalty" is the one showing
 * who is on the programme and what they are holding. The rates and the ladder
 * are set up once and then rarely touched, so they come after.
 *
 * Shared by every page under /loyalty so the tab strip cannot drift between
 * them.
 */
export const LOYALTY_TABS: readonly (TabItem<LoyaltyTab> & { href: string })[] = [
  { value: 'members', label: 'Members', href: '/loyalty' },
  { value: 'programme', label: 'Programme', href: '/loyalty/programme' },
  { value: 'tiers', label: 'Tiers', href: '/loyalty/tiers' },
  { value: 'cards', label: 'Punch cards', href: '/loyalty/cards' },
]
