'use client'

import { useState } from 'react'
import { SegmentedControl, Skeleton } from '@/components/ui'
import type { SalesKpis } from '@/lib/site/salesDashboard'
import type { DayBucket } from '@/lib/site/salesDashboard'
import { money } from './format'
import { perDayTakeaway } from './insights'
import { NOTE_TONE, pctDelta } from './KpiStrip'
import { PerDayBars } from './Charts'

/**
 * The headline: what the shop took, and the shape of the days behind it.
 *
 * ── WHY ONE FIGURE IS ENORMOUS AND THE REST ARE NOT ─────────────────────────
 *
 * The desktop opens with six figures on a common baseline, which is right for a
 * screen somebody studies. A phone gets glanced at — often one-handed, often
 * mid-conversation — and a glance can only carry one number. So turnover is
 * given the size and everything else is arranged underneath it, in a grid that
 * rewards a second look rather than competing for the first.
 *
 * ── EXCL OR INCL IS A TOGGLE, NOT TWO TILES ─────────────────────────────────
 *
 * The desktop shows both, side by side, because it has room and because the
 * pair read together is the point. At 390px two headline figures at this size
 * is two headlines, and a reader who has to work out which of two large numbers
 * is the one they meant has been given no headline at all.
 *
 * So one is shown and the other named underneath: "R1 196 000 incl VAT" is the
 * whole of what the second tile was for, at a fifth of the room. The toggle is
 * for the shop that thinks in the other figure — which is most of them, one way
 * or the other, and never both at once.
 *
 * The figures and their notes come from KPI_DEFS by way of `pctDelta`, so the
 * comparison sentence here is the same sentence the desktop tile prints. Two
 * implementations of "how much better than last month" is two answers.
 */

type Basis = 'excl' | 'incl'

const BASES = [
  { value: 'excl' as const, label: 'Excl' },
  { value: 'incl' as const, label: 'Incl' },
]

export function PhoneHero({
  kpis,
  compareKpis,
  compareShort,
  perDay,
  periodLabel,
  loading,
}: {
  kpis: SalesKpis
  compareKpis: SalesKpis | null
  compareShort: string
  perDay: DayBucket[]
  periodLabel: string
  loading: boolean
}) {
  /*
   * Excl first, because it is the figure a shop is measured on: VAT is money
   * the shop is holding for somebody else, and gross profit, margin and every
   * comparison below are all struck against it. A dashboard opening on the
   * bigger number would be flattering the reader with the one figure that is
   * not theirs.
   */
  const [basis, setBasis] = useState<Basis>('excl')

  const shown = basis === 'excl' ? kpis.turnoverExcl : kpis.turnoverIncl
  const other = basis === 'excl' ? kpis.turnoverIncl : kpis.turnoverExcl
  const otherLabel = basis === 'excl' ? 'incl VAT' : 'excl VAT'

  const delta = pctDelta((k) => (basis === 'excl' ? k.turnoverExcl : k.turnoverIncl))({
    kpis,
    compare: compareKpis,
    compareShort,
  })

  const takeaway = perDayTakeaway(perDay)

  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-muted">
            Turnover {basis === 'excl' ? 'excl' : 'incl'} VAT
          </div>
          <div className="truncate text-xs text-faint">{periodLabel}</div>
        </div>
        <SegmentedControl
          options={BASES}
          value={basis}
          onChange={setBasis}
          aria-label="Show turnover excluding or including VAT"
        />
      </div>

      {loading ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          {/* The one number on the screen allowed to be this loud. */}
          <div className="numeric mt-2 text-4xl font-semibold tracking-tight text-ink">
            {money(shown)}
          </div>

          {/* The comparison and the other basis on one line, divided by a
              middot rather than stacked: they are two riders on the figure
              above, and two lines of grey under a headline reads as a
              paragraph nobody finishes. */}
          <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
            <span className={NOTE_TONE[delta.tone]}>{delta.text}</span>
            <span className="text-faint" aria-hidden="true">
              ·
            </span>
            <span className="numeric text-muted">
              {money(other)} {otherLabel}
            </span>
          </div>

          <div className="mt-3">
            <PerDayBars data={perDay} />
          </div>

          {/* What the bars would have needed an axis to say. */}
          {takeaway && <div className="mt-1.5 text-xs text-muted">{takeaway}</div>}
        </>
      )}
    </section>
  )
}
