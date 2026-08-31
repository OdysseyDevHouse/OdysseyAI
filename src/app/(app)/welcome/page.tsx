import { requireCapability, requireSite } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { listVatRatesForSetup, listPriceStructuresForSetup } from '@/lib/site/pricingSetup'
import { logoFileName } from '@/lib/site/documentLogo'
import { onboardingProgress } from '@/lib/site/onboarding'
import { PageHeader, PageBody } from '@/components/ui'
import WelcomeWizard from './WelcomeWizard'

export const dynamic = 'force-dynamic'

/**
 * Setting up your store — the first-run wizard.
 *
 * ── WHY A WIZARD WHEN EVERY ONE OF THESE HAS A SETUP SCREEN ─────────────────
 *
 * Because the setup hub answers "where do I change X" and cannot answer "what
 * should I have decided before I start". A new owner does not know that the
 * costing basis is expensive to change later, or that price types are what
 * products get captured against — those are not discoverable by reading a grid
 * of forty tiles, and the ones that matter are indistinguishable from the ones
 * that do not.
 *
 * So this asks the handful of questions whose answers get BAKED IN — the tax
 * rates stamped onto every document, the price tiers products are captured
 * against, the basis every margin figure is computed on — while the shop is
 * still cheap to change. It is a running order, not a new place to configure
 * things: every step writes through the same function its setup screen calls.
 *
 * ── AND WHY IT DOES NOT OWN THE FIRST-LOGIN REDIRECT ────────────────────────
 *
 * `/getting-started` does — see `landingFor()`, which sign-in and the store
 * picker both route through. That screen counts what the shop has actually
 * done; this one asks what it has decided. Two screens competing to be the
 * first thing after a password is one too many, so this is reached FROM that
 * checklist and from the setup hub rather than by racing it.
 */
export default async function WelcomePage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  /* requireSite() rather than getSite(): on a local install it is the mirror
     that answers, which is what keeps this screen working offline. */
  const site = await requireSite()

  const [settings, vatRates, structures, logo, progress] = await Promise.all([
    getSettings(siteId, [
      'currency_code',
      'currency_symbol',
      'tax_label',
      'cost_basis',
      'qty_decimals',
      'cost_decimals',
    ]),
    listVatRatesForSetup(siteId),
    listPriceStructuresForSetup(siteId),
    logoFileName(siteId),
    onboardingProgress(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Set up your store"
        subtitle="A few decisions that are much easier to make now than after you have been trading for a month."
      />
      <PageBody>
        <WelcomeWizard
          /* The details the form starts from. Sent as the same shape
             `updateSiteDetails` takes, so the client never has to reassemble it. */
          details={{
            companyName: site.companyName,
            tradingName: site.tradingName,
            registrationNumber: site.registrationNumber,
            vatNumber: site.vatNumber,
            address1: site.address1,
            address2: site.address2,
            address3: site.address3,
            postalCode: site.postalCode,
            phone: site.phone,
            email: site.email,
            contactName: site.contactName,
          }}
          /* Decided on the server from the site's own row. The client uses it to
             disable what a local store may not edit — a courtesy, with the real
             check re-made in the action. */
          detailsEditable={site.connectionType === 'cloud'}
          hasLogo={logo !== ''}
          settings={settings}
          /* Sales rates only. A purchase rate is a buying-side concern that
             belongs on the pricing screen, and putting both in a first-run
             wizard turns one clear question into a table nobody reads. */
          vatRates={vatRates
            .filter((r) => r.vatType === 'sales' && r.isActive)
            .map((r) => ({
              id: r.id,
              code: r.code,
              name: r.name,
              rate: r.rate,
              isDefault: r.isDefault,
              productCount: r.productCount,
            }))}
          priceTypes={structures
            .filter((s) => s.isActive)
            .map((s) => ({
              id: s.id,
              name: s.name,
              isDefault: s.isDefault,
              priceCount: s.priceCount,
            }))}
          doneSteps={progress.done}
        />
      </PageBody>
    </>
  )
}
