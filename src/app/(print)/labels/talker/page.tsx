import { notFound } from 'next/navigation'
import { requireCapability, requireSite } from '@/lib/auth'
import { labelItems } from '@/lib/site/labels'
import { formatMoney } from '@/lib/decimals'
import { Code128 } from '@/lib/labels/BarcodeSvg'
import LabelsPrintButton from '../LabelsPrintButton'
import { parseLabelSource } from '../parseSource'

export const dynamic = 'force-dynamic'

/**
 * Shelf talkers — one 80mm slip per product, on the group's default @page.
 * Big price, "was" strike-through when the source knows the old price (a
 * schedule run), barcode at the bottom.
 */
export default async function ShelfTalkerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  await requireCapability('products.view')
  const site = await requireSite()
  const params = await searchParams

  const source = parseLabelSource(params)
  if (!source) notFound()

  const structureId = Number(params.structure) > 0 ? Number(params.structure) : null
  const items = await labelItems(site.id, source, structureId)
  if (items.length === 0) notFound()

  return (
    <div className="p-4">
      <LabelsPrintButton count={items.length} auto={params.auto === '1'} />
      <div className="flex flex-col items-center gap-4">
        {items.map((item, i) => (
          <article
            key={i}
            className="w-full max-w-[72mm] border border-border p-4 text-center text-ink"
            style={{ breakAfter: i < items.length - 1 ? 'page' : 'auto' }}
          >
            <p className="text-[14px] font-semibold leading-tight">{item.description}</p>
            {item.wasPriceIncl !== null && item.wasPriceIncl !== item.priceIncl && (
              <p className="numeric mt-2 text-[14px] text-muted line-through">
                {formatMoney(item.wasPriceIncl)}
              </p>
            )}
            <p className="numeric my-2 text-[40px] font-extrabold leading-none">
              {formatMoney(item.priceIncl)}
            </p>
            {item.barcode && (
              <div className="mx-auto mt-3 w-4/5">
                <Code128 value={item.barcode} heightMm={10} />
                <span className="numeric text-[9px] text-muted">{item.barcode}</span>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
