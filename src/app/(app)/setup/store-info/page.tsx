import { requireCapability, requireSite } from '@/lib/auth'
import { logoFileName } from '@/lib/site/documentLogo'
import { readSiteProfile } from '@/lib/site/siteProfile'
import { refreshSiteProfile } from '@/lib/sites'
import { taxIdentity } from '@/lib/site/taxIdentity'
import { PageHeader, PageBody } from '@/components/ui'
import StoreInfoClient, { type StoreDetails } from './StoreInfoClient'

export const dynamic = 'force-dynamic'

/**
 * My store information — the shop's own name, numbers and address.
 *
 * ── WHY IT READS requireSite() AND NOT cp2_sites ITSELF ─────────────────────
 *
 * The details live in the control database, and a direct query for them would
 * 500 this page on exactly the machine it most needs to serve: a local install
 * whose line is down. requireSite() already answers from the offline mirror in
 * that case — every authenticated page in the app depends on it doing so — so
 * reading through it means this screen inherits that behaviour rather than
 * reimplementing it slightly differently.
 *
 * ── WHO MAY CHANGE WHAT ─────────────────────────────────────────────────────
 *
 * Cloud stores edit their details; local ones read them. The reason is the
 * mirror: it is a copy that flows one way, control panel → shop, and a local
 * shop writing back would make "did my edit stick" depend on whether the line
 * happened to be up.
 *
 * Three things sit outside that bargain, for three different reasons:
 *
 *   THE LOGO is a file on this machine's own disk, so nothing about changing it
 *   leaves the building.
 *
 *   THE TAX LABEL is a row in this site's own settings, for the same reason —
 *   and it has to be readable by a till with no line, which a control-panel
 *   value would not be.
 *
 *   THE VAT NUMBER is the exception that is not about where it lives. It is in
 *   cp2_sites like every other detail, and a local store may still change it
 *   because without one it cannot put a product on a tax rate at all. It is
 *   gated on being ONLINE instead — see LOCAL_EDITABLE in actions.ts.
 *
 * This is a courtesy, not the boundary. actions.ts re-decides it server-side.
 */
export default async function StoreInfoPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const seen = await requireSite()

  const editable = seen.connectionType === 'cloud'

  /*
   * How old the offline copy is, and only where one is actually being read. A
   * store editing its own details is talking to the control panel directly, so
   * there is no staleness to report and nothing useful to say.
   */
  let mirrored = editable ? null : await readSiteProfile(seen.id).catch(() => null)

  /*
   * ── THE ONE SCREEN THAT WAITS FOR THE MIRROR ──────────────────────────────
   *
   * Everywhere else in the app the offline copy is refreshed in the background
   * and the render in hand uses whatever it already had — see
   * refreshProfileInBackground. A page showing a stock list must not stop to
   * ask the control panel what the shop is called.
   *
   * This page is the exception, because these details ARE its subject. Somebody
   * opening it has usually just been told their address or VAT number was
   * corrected, and showing them the old one — under a note saying when the copy
   * was last confirmed — is the screen answering a question with the very
   * staleness it is reporting.
   *
   * ── BUT NOT ON EVERY RENDER, AND THAT MATTERS MOST WHEN IT FAILS ──────────
   *
   * The call is awaited, so its cost is paid by somebody looking at the screen.
   * When the portal ANSWERS that is a fraction of a second; when it cannot, it
   * is the full four-second timeout — and a shop with no line would have paid
   * that on every single load of this page, including every reload after a save
   * and every 404 from a portal that has not been deployed with the route yet.
   * A screen that got slower the more broken things were is the wrong shape.
   *
   * So a copy confirmed within the last minute is taken as current. That is far
   * shorter than the fifteen-minute background window because this screen has a
   * person waiting on it, and long enough that reloading, saving, or coming
   * straight back does not pay the wait again.
   */
  const MAX_AGE_MS = 60_000
  const stale = !mirrored || Date.now() - mirrored.mirroredAt.getTime() > MAX_AGE_MS

  /*
   * Null when the portal could not be asked, and then the mirror stands: this
   * page must still draw with no line at all, which is most of the reason the
   * mirror exists.
   */
  const fresh = !editable && stale ? await refreshSiteProfile(seen.id).catch(() => null) : null
  const site = fresh ?? seen
  /* Re-read only when something was actually written, so "last confirmed" shows
     the moment this render refreshed it rather than the previous one. */
  if (fresh) mirrored = (await readSiteProfile(site.id).catch(() => null)) ?? mirrored

  const logoFile = await logoFileName(site.id)

  /* What this shop calls its tax. A site setting rather than part of the
     details above, and therefore editable by every store — see taxIdentity.ts
     for why the two halves of the tax identity live in different places. */
  const { label: currentTaxLabel } = await taxIdentity(site.id)

  /* Nulls become '' at the edge: an input's value must never be null, and the
     actions turn empty back into null on the way in. */
  const initial: StoreDetails = {
    companyName: site.companyName ?? '',
    tradingName: site.tradingName ?? '',
    registrationNumber: site.registrationNumber ?? '',
    vatNumber: site.vatNumber ?? '',
    address1: site.address1 ?? '',
    address2: site.address2 ?? '',
    address3: site.address3 ?? '',
    postalCode: site.postalCode ?? '',
    phone: site.phone ?? '',
    email: site.email ?? '',
    contactName: site.contactName ?? '',
  }

  return (
    <>
      <PageHeader
        title="My store information"
        subtitle="What this business is called, how it is reached, and the logo on its documents"
      />
      <PageBody>
        <StoreInfoClient
          initial={initial}
          initialTaxLabel={currentTaxLabel}
          logoFile={logoFile}
          siteCode={site.code}
          editable={editable}
          lockedReason={
            editable
              ? null
              : 'This store keeps its own database, so its details are held in the control panel ' +
                'and changed there. Your VAT number and your logo can still be changed here — ' +
                'the VAT number needs an internet connection, because it is saved with your ' +
                'store details in the control panel.'
          }
          /* Formatted on the server: a date rendered in the browser's locale
             would differ from every other date in the app. */
          mirroredAt={
            mirrored
              ? mirrored.mirroredAt.toLocaleString('en-ZA', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })
              : null
          }
        />
      </PageBody>
    </>
  )
}
