import { requireModuleCapability, requireSiteId } from '@/lib/auth'
import { tradingExceptions, tradingRules } from '@/lib/site/branchTrading'
import { openState } from '@/lib/tradingHours'
import { PageHeader, PageBody } from '@/components/ui'
import TradingForm from './TradingForm'

/**
 * Online store — Trading hours.
 *
 * Its own screen rather than another card on Setup: Setup is what the shop
 * SELLS and how the link works, configured once. This is what the shop is doing
 * TODAY, and somebody reaches for it mid-service on a phone.
 */

export const dynamic = 'force-dynamic'

export default async function TradingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireModuleCapability('online_store', 'online.edit')
  const siteId = await requireSiteId()

  const [rules, exceptions] = await Promise.all([
    tradingRules(siteId),
    tradingExceptions(siteId),
  ])

  // What the storefront is telling shoppers at this moment, so the screen can
  // say it rather than making a manager work it out from the week below.
  const now = new Date()
  const state = openState(rules, now)
  const label =
    state.state === 'open'
      ? state.closesAt
        ? `Open until ${state.closesAt}`
        : 'Open'
      : state.state === 'closed'
        ? 'Closed right now'
        : 'Not taking orders'

  return (
    <>
      <PageHeader
        title="Trading hours"
        subtitle="When this shop is open for online orders, and the times a shopper can collect."
      />
      <PageBody>
        <TradingForm
          initialHours={rules.hours ?? {}}
          acceptingOrders={rules.acceptingOrders}
          acceptingNote={rules.acceptingNote}
          horizonDays={rules.horizonDays}
          leadTimeMinutes={rules.leadTimeMinutes}
          exceptions={exceptions}
          openNow={{ state: state.state, label }}
        />
      </PageBody>
    </>
  )
}
