'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  DateRangeField,
  FavoriteToggle,
  Icons,
  Select,
  SegmentedControl,
  useToast,
} from '@/components/ui'
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  type ChartType,
  type CustomReportSpec,
  type PeriodKey,
  type ReportColumn,
} from '@/lib/reportBuilder/spec'
import { toggleFavoriteAction } from '../actions'
import ReportGrid from '../ReportGrid'
import ReportChart from '../ReportChart'
import ScheduleModal from '../schedules/ScheduleModal'

/**
 * One report on screen.
 *
 * The chrome is roomy and the grid is dense, per the craft guidance: the
 * toolbar is touched once per visit, the rows are scanned hundreds of times.
 */
export default function ReportView({
  reportId,
  name,
  description,
  columns,
  rows,
  totals,
  range,
  truncated,
  hiddenColumns,
  periodKey,
  spec,
  savedId,
  kind,
  starred,
  canBuild,
  canSchedule,
  chartType,
  scheduleUsers,
}: {
  reportId: string
  name: string
  description: string
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  range: { from: string; to: string }
  truncated: boolean
  hiddenColumns: string[]
  periodKey: PeriodKey
  spec: CustomReportSpec
  savedId: number | null
  kind: 'builtin' | 'builder' | 'ask'
  starred: boolean
  canBuild: boolean
  canSchedule: boolean
  chartType: ChartType
  /** Who this report could be emailed to. Empty when scheduling is not allowed. */
  scheduleUsers: { id: number; name: string; email: string }[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  const toast = useToast()
  const [, startTransition] = useTransition()
  const [fav, setFav] = useState(starred)
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [scheduling, setScheduling] = useState(false)

  // A chart needs one label column and at least one number to plot.
  const chartable =
    spec.groupFields.length > 0 && columns.some((c) => c.numeric) && rows.length > 0

  function setPeriod(key: PeriodKey) {
    const next = new URLSearchParams(params.toString())
    if (key === 'custom') {
      next.set('period', key)
      // Seed the custom range with what is already on screen, so the two date
      // boxes are never empty when they appear.
      if (!next.get('from')) next.set('from', range.from)
      if (!next.get('to')) next.set('to', range.to)
    } else {
      next.set('period', key)
      next.delete('from')
      next.delete('to')
    }
    router.push(`?${next.toString()}`)
  }

  function setCustomRange(next: { from: string; to: string }) {
    const q = new URLSearchParams(params.toString())
    q.set('period', 'custom')
    q.set('from', next.from)
    q.set('to', next.to)
    router.push(`?${q.toString()}`)
  }

  function onToggleFavorite() {
    const nowFav = !fav
    setFav(nowFav)
    startTransition(async () => {
      const result = await toggleFavoriteAction(reportId)
      if (!result.ok) {
        setFav(!nowFav)
        toast.error(result.error)
      }
    })
  }

  const exportHref = `/api/reports/export?id=${encodeURIComponent(reportId)}&period=${periodKey}&from=${range.from}&to=${range.to}`

  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {name}
              {kind === 'ask' && (
                <Badge tone="brand">
                  <Icons.Sparkles size={11} />
                  AI generated
                </Badge>
              )}
            </span>
          }
          description={description || undefined}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <FavoriteToggle starred={fav} onToggle={onToggleFavorite} label={name} size={18} />

              {chartable && (
                <SegmentedControl
                  aria-label="View as"
                  value={view}
                  onChange={(v) => setView(v as typeof view)}
                  options={[
                    { value: 'table', label: 'Table' },
                    { value: 'chart', label: 'Chart' },
                  ]}
                />
              )}

              <Select
                aria-label="Period"
                value={periodKey}
                onChange={(e) => setPeriod(e.target.value as PeriodKey)}
              >
                {PERIOD_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {PERIOD_LABELS[k]}
                  </option>
                ))}
              </Select>

              {periodKey === 'custom' && (
                <DateRangeField
                  label=""
                  value={{ from: range.from, to: range.to }}
                  onChange={setCustomRange}
                />
              )}

              {canSchedule && (
                <Button variant="ghost" onClick={() => setScheduling(true)}>
                  <Icons.Clock size={16} />
                  Schedule
                </Button>
              )}

              <ButtonLink href={exportHref} variant="ghost" prefetch={false}>
                <Icons.Download size={16} />
                Export
              </ButtonLink>

              {canBuild && (
                <ButtonLink
                  href={
                    savedId
                      ? `/reports/builder?saved=${savedId}`
                      : `/reports/builder?from=${encodeURIComponent(reportId)}`
                  }
                  variant="secondary"
                >
                  <Icons.Pencil size={16} />
                  {savedId ? 'Edit' : 'Customise'}
                </ButtonLink>
              )}
            </div>
          }
        />

        {hiddenColumns.length > 0 && (
          <div className="px-4 pb-3">
            <Callout tone="neutral" title="Some columns are hidden">
              Your role does not include {hiddenColumns.join(', ')}. The rest of the report is
              shown as normal.
            </Callout>
          </div>
        )}

        {truncated && (
          <div className="px-4 pb-3">
            <Callout tone="warning" title="This report was cut short">
              Only the first {rows.length.toLocaleString()} rows are shown. Narrow the period or
              add a filter to see the whole picture.
            </Callout>
          </div>
        )}

        {view === 'chart' && chartable ? (
          <div className="p-4">
            <ReportChart
              columns={columns}
              rows={rows}
              labelKey={spec.groupFields[0]}
              type={chartType}
            />
          </div>
        ) : (
          <ReportGrid
            columns={columns}
            rows={rows}
            totals={totals}
            emptyHint={`Nothing matched between ${range.from} and ${range.to}. Try a wider period.`}
          />
        )}
      </Card>

      {scheduling && (
        <ScheduleModal
          reportId={reportId}
          reportName={name}
          defaultPeriod={periodKey}
          users={scheduleUsers}
          onClose={() => setScheduling(false)}
        />
      )}
    </>
  )
}
