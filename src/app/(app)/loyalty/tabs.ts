import type { TabItem } from '@/components/ui'

export type LoyaltyTab = 'programme' | 'tiers' | 'cards'

/**
 * The loyalty SETUP screens, in the order somebody sets them up.
 *
 * All three are menu rows in their own right now — the Setup hub that used to
 * list them was a landing page for three tiles, which is a click that gives
 * nothing back. The strip stays anyway: these three are configured in one
 * sitting, and moving between them through the sidebar means crossing the
 * whole screen to switch between screens that belong together.
 *
 * Members is deliberately NOT a tab. It is the operational screen, opened
 * daily and for a different reason; putting it here would make a tab strip
 * that mixes "who is on the programme" with "how the programme works".
 *
 * Shared by all three so the strip cannot drift.
 */
export const LOYALTY_TABS: readonly (TabItem<LoyaltyTab> & { href: string })[] = [
  { value: 'programme', label: 'Programme', href: '/loyalty/programme' },
  { value: 'tiers', label: 'Tiers', href: '/loyalty/tiers' },
  { value: 'cards', label: 'Punch cards', href: '/loyalty/cards' },
]
