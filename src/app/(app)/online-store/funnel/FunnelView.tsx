'use client'

import { useRouter } from 'next/navigation'
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Icons,
  SegmentedControl,
  StatTile,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { FunnelReport } from '@/lib/site/storefrontEvents'

/**
 * The funnel, drawn.
 *
 * ── ONE HUE, NOT FOUR ────────────────────────────────────────────────────
 *
 * The four stages are the SAME measure at different depths, not four
 * identities — so they take one sequential ramp (the brand hue, fading as the
 * funnel narrows) rather than four categorical colours. Four hues would imply
 * the stages are unrelated things being compared, which is the opposite of
 * what a funnel says.
 *
 * ── BARS, NOT A TAPERING FUNNEL SHAPE ────────────────────────────────────
 *
 * The classic trapezoid encodes each stage's value as an AREA, and area is the
 * one channel people read worst — a stage half as wide looks a quarter as big.
 * Bars share a baseline and one axis, so the comparison is a length, which is
 * the channel people read best.
 *
 * ── EVERY NUMBER IS ALSO TEXT ────────────────────────────────────────────
 *
 * The bar is the glance; the count and both percentages sit beside it as
 * figures. Nothing here is encoded in colour alone, so the panel survives being
 * printed, read by someone colourblind, or scanned by someone who just wants
 * the number.
 */

export default function FunnelView({
  report,
  products,
  days,
}: {
  report: FunnelReport
  products: { productId: number; description: string; views: number; adds: number }[]
  days: number
}) {
  const router = useRouter()

  const top = report.stages[0]?.sessions ?? 0
  const bought = report.stages[report.stages.length - 1]?.sessions ?? 0
  // The headline: of everyone who looked, what share ordered. The one number a
  // shop would quote, so it gets said plainly rather than left to be derived.
  const conversion = top > 0 ? (bought / top) * 100 : 0

  const nothingYet = report.stages.every((s) => s.sessions === 0)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={String(days)}
          onChange={(value) => router.push(`/online-store/funnel?days=${value}`)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>

      {nothingYet ? (
        <Card>
          <EmptyState
            icon={<Icons.BarChart size={22} />}
            title="Nothing measured yet"
            hint="Once shoppers browse your storefront, this shows how many of them go on to order."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Shoppers who looked" value={String(top)} />
            <StatTile
              label="Went on to order"
              value={`${conversion.toFixed(1)}%`}
              // The exception worth marking. Below 1% is not a slow week, it is
              // usually something broken — a delivery fee nobody expected, or a
              // checkout that refuses.
              tone={top >= 25 && conversion < 1 ? 'warning' : 'default'}
            />
            <StatTile label="Taken online" value={formatMoney(report.revenueIncl)} />
          </div>

          <Card>
            <CardHeader
              title="Where shoppers drop out"
              description="Each bar is the share of everyone who looked. The figure beside it is how many carried on from the step above."
            />
            <CardBody>
              <ol className="flex flex-col gap-3">
                {report.stages.map((stage, index) => (
                  <li key={stage.kind} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{stage.label}</span>
                      <span className="flex items-baseline gap-3">
                        <span className="numeric text-sm text-ink-2">{stage.sessions}</span>
                        {/* Not on the first stage: "100% of the people who got
                            here got here" is noise. */}
                        {index > 0 && (
                          <span className="numeric w-16 text-right text-xs text-muted">
                            {stage.ofPrevious.toFixed(0)}% on
                          </span>
                        )}
                      </span>
                    </div>

                    {/* The track is always full width, so a short bar reads as
                        a small share rather than as a small chart. */}
                    <div className="h-2.5 w-full overflow-hidden rounded-pill bg-surface-2">
                      <div
                        className={`h-full rounded-pill ${SHADE[index] ?? SHADE[SHADE.length - 1]}`}
                        style={{ width: `${Math.min(Math.max(stage.ofTop, 0), 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>

          {products.length > 0 && (
            <Card>
              <CardHeader
                title="Most looked at"
                description="A product seen often and added rarely usually has a photograph or a price problem."
              />
              <DataTable
                rows={products}
                getRowKey={(row) => row.productId}
                columns={[
                  {
                    key: 'description',
                    header: 'Product',
                    sortValue: (row) => row.description,
                    cell: (row) => <span className="text-ink">{row.description}</span>,
                  },
                  {
                    key: 'views',
                    header: 'Looked at',
                    numeric: true,
                    sortValue: (row) => row.views,
                    cell: (row) => <span className="numeric text-ink-2">{row.views}</span>,
                  },
                  {
                    key: 'adds',
                    header: 'Added',
                    numeric: true,
                    sortValue: (row) => row.adds,
                    cell: (row) => <span className="numeric text-ink-2">{row.adds}</span>,
                  },
                  {
                    key: 'rate',
                    header: 'Added / looked',
                    numeric: true,
                    sortValue: (row) => (row.views > 0 ? row.adds / row.views : 0),
                    cell: (row) => (
                      <span className="numeric text-ink-2">
                        {row.views > 0 ? `${((row.adds / row.views) * 100).toFixed(0)}%` : '—'}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </>
  )
}

/**
 * One hue, fading as the funnel narrows.
 *
 * Written as full class strings rather than built from an index, because
 * Tailwind scans source text and would not emit a name it never sees spelled
 * out.
 */
const SHADE = ['bg-brand', 'bg-brand', 'bg-brand-ink', 'bg-brand-ink']
