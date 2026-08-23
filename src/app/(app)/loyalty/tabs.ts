import type { TabItem } from '@/components/ui'

export type LoyaltyTab = 'programme' | 'tiers' | 'cards'

/**
 * The loyalty SETUP screens, in the order somebody sets them up.
 *
 * Members is deliberately NOT a tab any more. The three below are reached
 * through Loyalty › Setup and decide how the programme works; the members list
 * is its own menu row and is opened daily. Keeping them in one strip made the
 * hub tile for 'Setup' land on a screen whose first tab left it again.
 *
 * Shared by every screen under /loyalty/setup so the strip cannot drift.
 */
export const LOYALTY_TABS: readonly (TabItem<LoyaltyTab> & { href: string })[] = [
  { value: 'programme', label: 'Programme', href: '/loyalty/programme' },
  { value: 'tiers', label: 'Tiers', href: '/loyalty/tiers' },
  { value: 'cards', label: 'Punch cards', href: '/loyalty/cards' },
]
