import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getInbound } from '@/lib/site/storeTransfers'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import ReceiveTransferScreen from './ReceiveTransferScreen'

export const dynamic = 'force-dynamic'

export default async function ReceiveInboundPage({
  params,
}: {
  params: Promise<{ peer: string; id: string }>
}) {
  const { peer, id } = await params
  const peerSiteId = Number(peer)
  const transferId = Number(id)
  if (!Number.isFinite(peerSiteId) || peerSiteId <= 0) notFound()
  if (!Number.isFinite(transferId) || transferId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.transfer')

  // getInbound refuses a store this one is not linked to, so a typed URL cannot
  // read another business's documents.
  const [inbound, locations] = await Promise.all([
    getInbound(siteId, peerSiteId, transferId),
    listLocations(siteId, false, true),
  ])
  if (!inbound) notFound()

  return (
    <>
      <PageHeader
        title={`Receive ${inbound.documentNumber ?? `#${inbound.id}`}`}
        subtitle={`From ${inbound.peerSiteName ?? 'another store'} · dispatched ${inbound.documentDate}`}
        backHref="/transfers/inbound"
        backLabel="On its way here"
      />
      <ReceiveTransferScreen
        peerSiteId={peerSiteId}
        peerSiteName={inbound.peerSiteName ?? 'the sending store'}
        transferId={transferId}
        documentNumber={inbound.documentNumber ?? `#${inbound.id}`}
        reference={inbound.reference}
        note={inbound.note}
        status={inbound.status}
        lines={inbound.lines.map((l) => ({
          id: l.id,
          productCode: l.productCode,
          description: l.description,
          qty: l.qty,
        }))}
        locations={locations.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          isMain: l.isMain,
        }))}
      />
    </>
  )
}
