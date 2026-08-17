import { requireCapability, requireSite, requireSession } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import {
  accountForSite,
  currentPrices,
  holdingsForSites,
  sitesForAccount,
  MODULE_KEYS,
  MODULE_LABELS,
} from '@/lib/control/modules'
import { billableDeviceCount } from '@/lib/control/devices'
import { MODULE_DESCRIPTIONS } from '@/lib/control/moduleMessages'
import { nextBillingDate, safeBillingDay } from '@/lib/billing/period'
import { PageHeader, PageBody, Card, CardBody, Callout } from '@/components/ui'
import BillingClient from './BillingClient'

export const dynamic = 'force-dynamic'

/**
 * Plan & billing.
 *
 * ── WHY IT LIVES IN SETUP ───────────────────────────────────────────────────
 *
 * Opened rarely, by one person, and never mid-service — which is the test for
 * what belongs behind the Setup hub rather than in the main navigation.
 *
 * ── WHAT IT IS GUARDED ON, AND WHAT IT IS NOT ───────────────────────────────
 *
 * `setup.edit`, the same capability as linked stores and tills. Deliberately
 * NOT guarded on any module: this is the screen where modules are bought, so
 * gating it on one would be a door locked with its own key inside.
 *
 * It must also render when the entitlement read is degraded, which is why the
 * degraded banner is a first-class part of the page rather than an error state.
 */
export default async function BillingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()
  const session = await requireSession()

  const account = await accountForSite(site.id)

  /* Every store on the account, intersected with the stores this user may
     actually open.

     An account is a billing fact, not an access grant. Without this
     intersection a manager given one store of a ten-store group would see the
     other nine here — names, codes and all — which is the same leak the linked
     stores picker guards against. */
  const [accountSites, permitted] = await Promise.all([
    account ? sitesForAccount(account.id) : Promise.resolve([]),
    listSitesForUser(session.userId),
  ])
  const permittedIds = new Set(permitted.map((s) => s.id))

  const visibleSites = account
    ? accountSites.filter((s) => permittedIds.has(s.siteId))
    : [{ siteId: site.id, siteCode: site.code, displayName: site.displayName }]

  /* Stores on the bill that this user may not open still COUNT — they are what
     the account pays for. They are reported as a number, never as a list. */
  const hiddenStoreCount = account ? accountSites.length - visibleSites.length : 0

  const visibleIds = visibleSites.map((s) => s.siteId)
  const [holdings, prices, deviceCounts] = await Promise.all([
    holdingsForSites(visibleIds),
    currentPrices(),
    Promise.all(visibleIds.map((id) => billableDeviceCount(id))),
  ])

  const devicesBySite: Record<number, number> = {}
  visibleIds.forEach((id, i) => {
    devicesBySite[id] = deviceCounts[i] ?? 0
  })

  const today = new Date().toISOString().slice(0, 10)
  const billingDay = safeBillingDay(account?.billingDay ?? 1)

  /* Every price is still zero — the migration seeds the catalogue unpriced on
     purpose, so nobody invoices a guessed number. Say so on the screen rather
     than rendering a plausible-looking R0.00 bill. */
  const unpriced = MODULE_KEYS.every((k) => !prices[k]) && !prices.pos_device

  return (
    <>
      <PageHeader
        title="Plan & billing"
        subtitle={
          account
            ? `What ${account.name} pays for, across every store on the account.`
            : 'What this store pays for.'
        }
      />

      <PageBody>
        {!account ? (
          <Callout tone="warning" title="No billing account">
            This store is not attached to a billing account yet, so nothing can be added or
            removed here. Contact Odyssey to set one up.
          </Callout>
        ) : null}

        {unpriced ? (
          <Callout tone="warning" title="The price list has not been set">
            Every module is currently priced at zero, so the totals below are not real. Set the
            prices in <span className="numeric">cp2_module_prices</span> before quoting anyone.
          </Callout>
        ) : null}

        {account ? (
          <BillingClient
            accountName={account.name}
            accountStatus={account.status}
            billingContact={account.billingContact}
            billingEmail={account.billingEmail}
            vatNumber={account.vatNumber}
            billingDay={billingDay}
            nextBillingOn={nextBillingDate(today, billingDay)}
            today={today}
            sites={visibleSites}
            hiddenStoreCount={hiddenStoreCount}
            holdings={holdings}
            prices={prices}
            devicesBySite={devicesBySite}
            moduleKeys={[...MODULE_KEYS]}
            moduleLabels={MODULE_LABELS}
            moduleDescriptions={MODULE_DESCRIPTIONS}
          />
        ) : (
          <Card>
            <CardBody className="text-sm text-muted">
              Once a billing account exists, this screen will show every store on it, what each
              one has, and what the account pays each month.
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
