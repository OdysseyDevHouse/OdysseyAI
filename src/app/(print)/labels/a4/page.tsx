import './labels-a4.css'
import { notFound } from 'next/navigation'
import { requireCapability, requireSite } from '@/lib/auth'
import { labelItems } from '@/lib/site/labels'
import { formatMoney } from '@/lib/decimals'
import { Code128 } from '@/lib/labels/BarcodeSvg'
import LabelsPrintButton from '../LabelsPrintButton'
import { parseLabelSource } from '../parseSource'

export const dynamic = 'force-dynamic'

/**
 * Shelf labels on an A4 sheet — 3 × 8 = 24 per page (70 × 36 mm cells, a
 * stock label-sheet size). In the bare (print) group; this segment's CSS
 * overrides the group's 80mm @page with A4.
 *
 * A product with no barcode still gets a label (code text in its place) —
 * dropping rows from a print run is the silent failure mode.
 */
export default async function LabelsA4Page({
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

  // qty expands here: three of one label is three cells.
  const cells = items.flatMap((item) => Array.from({ length: item.qty }, () => item))

  return (
    <div className="p-4">
      <LabelsPrintButton count={cells.length} />
      <div
        className="grid"
        style={{ gridTemplateColumns: 'repeat(3, 70mm)', gridAutoRows: '36mm' }}
      >
        {cells.map((item, i) => (
          <div
            key={i}
            className="flex flex-col justify-between overflow-hidden border border-border p-2 text-ink"
            style={{ breakInside: 'avoid' }}
          >
            <p className="line-clamp-2 text-[11px] leading-tight">{item.description}</p>
            <p className="numeric text-[20px] font-bold leading-none">
              {formatMoney(item.priceIncl)}
            </p>
            <div className="flex flex-col items-center">
              {item.barcode ? (
                <>
                  <Code128 value={item.barcode} heightMm={8} />
                  <span className="numeric text-[8px] text-muted">{item.barcode}</span>
                </>
              ) : (
                <span className="numeric text-[10px] text-muted">{item.code}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
