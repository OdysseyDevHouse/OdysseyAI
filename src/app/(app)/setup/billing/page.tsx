import { requireCapability, requireSite, requireSession } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import {
  accountForSite,
  currentPrices,
  holdingsForSites,
  sitesForAccount,
  deviceOrdersFor,
  MODULE_KEYS,
} from '@/lib/control/modules'
import { nextBillingDate, safeBillingDay } from '@/lib/billing/period'
import { subscriptionForAccount, paymentsForAccount } from '@/lib/control/subscriptions'
import { platformPayFastStatus } from '@/lib/payfast/platformConfig'
import { balanceMicros, recentEntries, type LedgerEntry } from '@/lib/aiCredits/ledger'
import {
  FEATURE_LABELS,
  currencySymbol,
  formatMicros,
  topupPresets,
  type AiFeature,
} from '@/lib/aiCredits/pricing'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody, Card, CardBody, Callout } from '@/components/ui'
import BillingClient from './BillingClient'
import AiCreditsCard from './AiCreditsCard'

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
  const [holdings, prices, devices, subscription, payments, aiBalance, aiEntries] =
    await Promise.all([
      holdingsForSites(visibleIds),
      currentPrices(),
      deviceOrdersFor(visibleIds),
      account ? subscriptionForAccount(account.id) : Promise.resolve(null),
      account ? paymentsForAccount(account.id, 12) : Promise.resolve([]),
      account ? balanceMicros(account.id) : Promise.resolve(0),
      account ? recentEntries(account.id, 25) : Promise.resolve([]),
    ])

  /* Only the stores this user may open. A usage row for one of the others shows
     its spend with no store name rather than naming a shop they were never
     shown — the same intersection the store list above makes, for the same
     reason. */
  const siteNames = new Map(visibleSites.map((s) => [s.siteId, s.displayName]))

  /* Asked rather than assumed, so the screen can say "not set up yet" instead
     of offering a Subscribe button that throws when pressed. */
  const payfast = platformPayFastStatus()

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
            billingDay={billingDay}
            nextBillingOn={nextBillingDate(today, billingDay)}
            today={today}
            sites={visibleSites}
            hiddenStoreCount={hiddenStoreCount}
            holdings={holdings}
            prices={prices}
            devices={devices}
            /* The manual confirm survives ONLY while PayFast is unconfigured.
               Once the gateway is set up the callback provisions licences by
               itself, and leaving a button that does the same thing without a
               payment would be a way to licence tills for free. */
            canConfirmPayment={!payfast.ok}
            payfastReady={payfast.ok}
            payfastProblems={payfast.ok ? [] : payfast.missing}
            subscription={
              subscription
                ? {
                    status: subscription.status,
                    amountIncl: subscription.amountIncl,
                    lastPaidOn: subscription.lastPaidOn,
                    synced: subscription.syncedAt !== null,
                  }
                : null
            }
            payments={payments.map((p) => ({
              id: p.id,
              amountGross: p.amountGross,
              paymentStatus: p.paymentStatus,
              verified: p.verified,
              rejectReason: p.rejectReason,
              receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
            }))}
          />
        ) : (
          <Card>
            <CardBody className="text-sm text-muted">
              Once a billing account exists, this screen will show every store on it, what each
              one has, and what the account pays each month.
            </CardBody>
          </Card>
        )}

        {/* Below the plan, deliberately. The plan is what the account pays every
            month and is why most people open this screen; credit is a top-up
            they come looking for only when something told them to. */}
        <AiCreditsCard
          balance={formatMicros(aiBalance, account?.currency ?? 'ZAR')}
          empty={aiBalance <= 0}
          hasAccount={account !== null}
          presets={topupPresets(account?.currency ?? 'ZAR').map((amount) => ({
            amount,
            label: formatMoney(amount, currencySymbol(account?.currency ?? 'ZAR')),
          }))}
          entries={aiEntries.map((e) => ({
            id: e.id,
            amountMicros: e.amountMicros,
            entryType: e.entryType,
            feature: e.feature,
            siteName: e.siteId ? (siteNames.get(e.siteId) ?? null) : null,
            when: e.createdAt ? e.createdAt.toISOString().slice(0, 10) : '',
            amount: formatMicros(e.amountMicros, account?.currency ?? 'ZAR'),
            description: describeEntry(e),
          }))}
          payfastReady={payfast.ok}
          payfastProblems={payfast.ok ? [] : payfast.missing}
        />
      </PageBody>
    </>
  )
}

/**
 * One line saying what an entry was.
 *
 * A feature key is what the ledger stores, because it has to stay stable across
 * renames; this is where it becomes something a shop owner recognises. An
 * unknown key falls back to the key itself rather than to "Unknown" — a row
 * nobody can explain is worse than one with a developer's word on it.
 */
function describeEntry(e: LedgerEntry): string {
  if (e.entryType === 'topup') return 'Top-up'
  if (e.entryType === 'manual') return e.note || 'Credit added'
  if (e.entryType === 'adjustment') return e.note || 'Adjustment'
  const feature = e.feature as AiFeature | null
  return feature && feature in FEATURE_LABELS ? FEATURE_LABELS[feature] : (e.feature ?? 'AI usage')
}
