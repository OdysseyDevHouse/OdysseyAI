import { requireCapability, requireSite } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import PrintingClient from './PrintingClient'

export const dynamic = 'force-dynamic'

/**
 * Printing.
 *
 * Two very different halves on one screen, each labelled as what it is: the
 * slip FOOTER is the site's (every till prints it), while the BRIDGE and
 * printers are this machine's — a property of what is physically plugged in,
 * stored in this browser, set once per till.
 */
export default async function PrintingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()

  const footerText = await getSetting(site.id, 'receipt_footer_text')

  return (
    <>
      <PageHeader
        title="Printing"
        subtitle="The slip's footer, and the thermal printer plugged into this till."
      />
      <PageBody>
        <PrintingClient siteName={site.displayName} footerText={footerText ?? ''} />
      </PageBody>
    </>
  )
}
