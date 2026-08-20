import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listBatches, type BatchListOptions } from '@/lib/site/batches'
import { listReasons } from '@/lib/site/stockAdjustments'
import { PageHeader, PageBody } from '@/components/ui'
import BatchesClient from './BatchesClient'

export const dynamic = 'force-dynamic'

/**
 * The lot book: which batches are on the shelf, what is running out of time,
 * and — through the drawer — where every lot came from and went. Lots are
 * born at goods receipt and consumed earliest-expiry-first automatically, so
 * this screen is for looking, chasing expiry, and the recall write-off.
 */
export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string; days?: string }>
}) {
  const { siteId, capabilities } = await requireModuleCapability('inventory_advanced', 'stock.view')
  const params = await searchParams

  const filter = (['all', 'open', 'expiring', 'expired', 'untracked'] as const).includes(
    params.filter as never,
  )
    ? (params.filter as NonNullable<BatchListOptions['filter']>)
    : 'open'
  const days = Math.min(Math.max(Number(params.days) || 30, 1), 365)

  /*
   * The write-off posts an ordinary adjustment, and an adjustment refuses a
   * blank reason — so the drawer has to offer the codes. Only the ones that
   * can face outward: a lot write-off is always stock leaving, and offering an
   * 'in' reason would let someone file a recall under "found on count".
   */
  const [{ items }, reasons] = await Promise.all([
    listBatches(siteId, {
      q: params.q,
      filter,
      expiringDays: days,
      limit: 500,
    }),
    listReasons(siteId),
  ])
  const writeOffReasons = reasons.filter((r) => r.direction === 'out' || r.direction === 'both')

  return (
    <>
      <PageHeader
        title="Batches"
        subtitle="Which lots are on the shelf and when they expire. Sales take the earliest expiry first, automatically."
      />
      <PageBody>
        <BatchesClient
          batches={items.map((b) => ({
            id: b.id,
            productCode: b.productCode,
            productDescription: b.productDescription,
            locationCode: b.locationCode,
            batchNo: b.batchNo,
            expiryDate: b.expiryDate,
            qtyRemaining: b.qtyRemaining,
            qtyReceived: b.qtyReceived,
            receivedDocNumber: b.receivedDocNumber,
            supplierName: b.supplierName,
          }))}
          filter={filter}
          days={days}
          q={params.q ?? ''}
          canAdjust={can(capabilities, 'stock.adjust')}
          reasons={writeOffReasons.map((r) => ({ id: r.id, name: r.name }))}
        />
      </PageBody>
    </>
  )
}
