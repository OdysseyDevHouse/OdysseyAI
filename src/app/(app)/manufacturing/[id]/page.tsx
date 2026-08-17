import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getBuild } from '@/lib/site/manufacturing'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Callout,
  Card,
  CardHeader,
  CardBody,
  StatStrip,
  StatTile,
  Icons,
} from '@/components/ui'
import UnbuildButton from './UnbuildButton'
import BuildLinesTable, { type BuildLineRow } from './BuildLinesTable'

export const dynamic = 'force-dynamic'

export default async function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const buildId = Number(id)
  if (!Number.isFinite(buildId) || buildId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'products.edit')
  const build = await getBuild(siteId, buildId)
  if (!build) notFound()

  const lines: BuildLineRow[] = build.lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    productCode: l.productCode,
    description: l.description,
    qtyPerUnit: l.qtyPerUnit,
    qtyConsumed: l.qtyConsumed,
    unitCostExcl: l.unitCostExcl,
    lineCostExcl: l.lineCostExcl,
  }))

  const totalCost = build.componentCost + build.overheadCost
  const sameRoom = build.fromLocationId === build.toLocationId

  return (
    <>
      <PageHeader
        title={build.documentNumber ?? `Build #${build.id}`}
        subtitle={`${formatQty(build.qty)} × ${build.description} · ${build.documentDate}`}
        backHref="/manufacturing"
        backLabel="Manufacturing"
        action={
          build.status === 'posted' ? (
            <UnbuildButton
              id={build.id}
              number={build.documentNumber ?? `#${build.id}`}
              qty={formatQty(build.qty)}
              description={build.description}
            />
          ) : undefined
        }
      />
      <PageBody>
        {build.status === 'cancelled' && (
          <Callout tone="danger" title="Unbuilt">
            Reversed{build.cancelReason ? `: ${build.cancelReason}` : '.'} The ingredients went
            back to {build.fromLocationName} and the finished goods came off{' '}
            {build.toLocationName}.
          </Callout>
        )}

        <StatStrip columns={4}>
          <StatTile label="Built" value={formatQty(build.qty)} />
          <StatTile label="Ingredients" value={formatMoney(build.componentCost)} />
          <StatTile label="Extra costs" value={formatMoney(build.overheadCost)} />
          {/* The figure this whole document exists to produce: what one made
              unit cost, and therefore what it is worth in stock. */}
          <StatTile label="Cost of one" value={formatMoney(build.unitCostExcl)} />
        </StatStrip>

        <Card>
          <CardHeader
            title="What it used"
            description={
              build.status === 'posted'
                ? 'Snapshotted when this build posted — editing the recipe since does not change what was consumed.'
                : 'This build has been reversed. Its movements remain, with their reversals beside them.'
            }
          />
          {/* The lines are plain data; the columns' functions live in the
              client component, where they are allowed to. */}
          <BuildLinesTable rows={lines} />
        </Card>

        {build.overheads.length > 0 && (
          <Card>
            <CardHeader
              title="Extra costs"
              description="Added to what the finished item cost. These moved no stock."
            />
            <CardBody>
              <dl className="flex flex-col gap-2 text-sm">
                {build.overheads.map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-4">
                    <dt className="text-ink-2">{o.description}</dt>
                    <dd className="numeric text-ink">{formatMoney(o.amountExcl)}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
        )}

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail label="Ingredients from" value={`${build.fromLocationCode} — ${build.fromLocationName}`} />
            <Detail label="Finished into" value={`${build.toLocationCode} — ${build.toLocationName}`} />
            <Detail label="Reference" value={build.reference ?? '—'} />
            <Detail label="Built by" value={build.userName || '—'} />
          </dl>
          {build.note && <p className="mt-3 text-sm text-muted">{build.note}</p>}
        </Card>

        <Callout tone="neutral" icon={<Icons.Factory size={18} />}>
          {formatQty(build.qty)} {build.description} made from {build.lines.length} ingredient
          {build.lines.length === 1 ? '' : 's'} costing {formatMoney(totalCost)}
          {sameRoom ? '' : `, moved from ${build.fromLocationCode} into ${build.toLocationCode}`}.
          Unlike a transfer, a build does change what the business owns — the ingredients became
          something else.
        </Callout>
      </PageBody>
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
