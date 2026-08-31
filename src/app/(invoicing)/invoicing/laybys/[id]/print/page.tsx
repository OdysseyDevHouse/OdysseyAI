import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { taxLabel } from '@/lib/site/taxIdentity'
import { getLayby } from '@/lib/site/laybys'
import { getSettings } from '@/lib/site/settings'
import { payLinkUrl } from '@/lib/site/payLinks'
import { LaybyAgreement } from '@/components/laybys/LaybyAgreement'
import PrintButton from './PrintButton'

export const dynamic = 'force-dynamic'

/**
 * The printable lay-by agreement.
 *
 * Its own route rather than a modal, so the browser prints the document and
 * not the application around it — the same reason the statement has one.
 */
export default async function LaybyPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('sales.view')
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const [layby, settings] = await Promise.all([
    getLayby(site.id, id),
    getSettings(site.id, ['layby_terms_text']),
  ])
  if (!layby) notFound()

  /*
   * The "pay an instalment" square, or null.
   *
   * Only on an OPEN lay-by with something left to pay. A completed one has been
   * collected and a cancelled one put back on the shelf — both keep their Print
   * button so the customer can have a copy of what happened, and neither should
   * carry a code that takes money for a debt that no longer exists.
   *
   * Never allowed to break the print: an agreement is a document the CPA
   * requires the customer to have, and failing to produce it because a link
   * could not be minted would be trading one duty for a convenience.
   */
  const payUrl =
    layby.status === 'open' && layby.outstanding > 0.005
      ? await payLinkUrl(site.id, 'layby', layby.id).catch(() => null)
      : null

  return (
    <div className="px-6 py-6">
      <PrintButton laybyId={layby.id} />
      <LaybyAgreement
        layby={layby}
        site={{ name: site.displayName, vatNumber: site.vatNumber, taxLabel: await taxLabel(site.id) }}
        terms={settings.layby_terms_text ?? ''}
        payUrl={payUrl}
      />
    </div>
  )
}
