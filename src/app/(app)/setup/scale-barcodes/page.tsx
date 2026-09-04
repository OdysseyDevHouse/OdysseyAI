import { PageBody, PageHeader } from '@/components/ui'
import { requireCapability } from '@/lib/auth'
import { listScaleRules } from '@/lib/site/scaleBarcodes'
import ScaleBarcodesClient from './ScaleBarcodesClient'

/**
 * Scale barcodes — its own screen, not a corner of system settings.
 *
 * ── WHY IT MOVED ─────────────────────────────────────────────────────────
 *
 * It used to be three rows on the Stock tracking settings tab, next to lot
 * capture, which put a shop-floor question behind a system-plumbing screen. It
 * is now a LIST a shop maintains — several scales, several shapes — and a list
 * with an Add button is not a settings row. It belongs beside tender types and
 * numbering: things a shop sets up once and comes back to.
 *
 * `force-dynamic` because the rules decide what the till charges. A cached
 * page showing yesterday's shapes is a page somebody would edit against, and
 * the save would then be built on a stale reading.
 */
export const dynamic = 'force-dynamic'

export default async function ScaleBarcodesPage() {
  const { siteId } = await requireCapability('setup.view')
  const rules = await listScaleRules(siteId)

  return (
    <>
      <PageHeader
        title="Scale barcodes"
        subtitle="How the till reads a weighed label — the price or weight printed into the barcode."
      />
      <PageBody>
        {/* A client wrapper, not a table built here: DataTable's columns carry
            cell renderers, and a server component cannot hand functions across
            the boundary. Doing so type-checks and builds, then throws at
            request time. */}
        <ScaleBarcodesClient rules={rules} />
      </PageBody>
    </>
  )
}
