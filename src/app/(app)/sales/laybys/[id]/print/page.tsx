import { notFound } from 'next/navigation'
import { requireSite } from '@/lib/auth'
import { getLayby } from '@/lib/site/laybys'
import { getSettings } from '@/lib/site/settings'
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
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const [layby, settings] = await Promise.all([
    getLayby(site.id, id),
    getSettings(site.id, ['layby_terms_text']),
  ])
  if (!layby) notFound()

  return (
    <div className="px-6 py-6">
      <PrintButton laybyId={layby.id} />
      <LaybyAgreement
        layby={layby}
        site={{ name: site.displayName, vatNumber: site.vatNumber }}
        terms={settings.layby_terms_text ?? ''}
      />
    </div>
  )
}
