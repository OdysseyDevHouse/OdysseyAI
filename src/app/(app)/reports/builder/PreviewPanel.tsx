'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Callout,
  Card,
  CardHeader,
  Icons,
  SegmentedControl,
  Select,
  TableSkeleton,
  Badge,
} from '@/components/ui'
import {
  PREVIEW_ROWS,
  type CustomReportSpec,
  type ReportColumn,
} from '@/lib/reportBuilder/spec'
import { clientOutputColumns, type ClientSource } from '@/lib/reportBuilder/clientTypes'
import ReportChart from '../ReportChart'
import ReportGrid from '../ReportGrid'
import { previewReportAction } from './actions'

/**
 * The live preview.
 *
 * Debounced rather than run-on-demand: the whole point of a builder is that you
 * see the consequence of a choice while you are still making it. A "run" button
 * turns every experiment into a decision, and people stop experimenting.
 *
 * Only PREVIEW_ROWS come back — enough to see the shape and check the numbers
 * look sane, few enough that a mistimed keystroke cannot ask the database for
 * twenty thousand rows.
 */
export default function PreviewPanel({
  spec,
  source,
  onChange,
}: {
  spec: CustomReportSpec
  source: ClientSource
  onChange: (changes: Partial<CustomReportSpec>) => void
}) {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    columns: ReportColumn[]
    rows: Record<string, unknown>[]
    totals: Record<string, number>
    range: { from: string; to: string } | null
    hiddenColumns: string[]
  }>({
    loading: true,
    error: null,
    columns: [],
    rows: [],
    totals: {},
    range: null,
    hiddenColumns: [],
  })

  const [view, setView] = useState<'table' | 'chart'>('table')

  // The request in flight, so a slow early response cannot overwrite a fast
  // later one — the classic way a preview ends up showing the wrong report.
  const requestRef = useRef(0)

  useEffect(() => {
    const id = ++requestRef.current
    setState((s) => ({ ...s, loading: true }))

    const timer = setTimeout(async () => {
      const result = await previewReportAction(spec)
      if (id !== requestRef.current) return

      if (result.ok) {
        setState({
          loading: false,
          error: null,
          columns: result.columns,
          rows: result.rows,
          totals: result.totals,
          range: result.range,
          hiddenColumns: result.hiddenColumns,
        })
      } else {
        setState((s) => ({ ...s, loading: false, error: result.error }))
      }
    }, 350)

    return () => clearTimeout(timer)
  }, [spec])

  const sortable = clientOutputColumns(source, spec)

  // A chart needs one label column and at least one number to plot — the same
  // rule the finished report uses, so the preview never offers a view the real
  // report would withhold.
  const chartable =
    spec.groupFields.length > 0 && state.columns.some((c) => c.numeric) && state.rows.length > 0

  return (
    <Card>
      <CardHeader
        title="Preview"
        description={
          state.range
            ? `First ${PREVIEW_ROWS} rows · ${state.range.from} to ${state.range.to}`
            : `First ${PREVIEW_ROWS} rows`
        }
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {state.loading && (
              <Badge tone="neutral">
                <Icons.Refresh size={11} className="animate-spin" />
                Running
              </Badge>
            )}

            {/* Which FORM to draw lives on the chart itself, beside its measure
                picker — one control rather than two that can disagree. */}
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

            {view === 'table' && sortable.length > 0 && (
              <>
                <Select
                  aria-label="Sort by"
                  value={spec.sort?.key ?? ''}
                  onChange={(e) =>
                    onChange({
                      sort: e.target.value
                        ? { key: e.target.value, dir: spec.sort?.dir ?? 'desc' }
                        : undefined,
                    })
                  }
                  className="w-44"
                >
                  <option value="">No sort</option>
                  {sortable.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                {spec.sort && (
                  <Select
                    aria-label="Sort direction"
                    value={spec.sort.dir}
                    onChange={(e) =>
                      onChange({
                        sort: { key: spec.sort!.key, dir: e.target.value as 'asc' | 'desc' },
                      })
                    }
                    className="w-32"
                  >
                    <option value="desc">Highest first</option>
                    <option value="asc">Lowest first</option>
                  </Select>
                )}
              </>
            )}
          </div>
        }
      />

      {state.error ? (
        <div className="p-4">
          <Callout tone="danger" title="This report cannot run yet">
            {state.error}
          </Callout>
        </div>
      ) : state.loading && state.rows.length === 0 ? (
        <div className="p-4">
          <TableSkeleton rows={6} />
        </div>
      ) : (
        <>
          {state.hiddenColumns.length > 0 && (
            <div className="px-4 pb-3">
              <Callout tone="neutral" title="Some columns are hidden">
                Your role does not include {state.hiddenColumns.join(', ')}.
              </Callout>
            </div>
          )}
          {view === 'chart' && chartable ? (
            <div className="p-4">
              <ReportChart
                columns={state.columns}
                rows={state.rows}
                labelKey={spec.groupFields[0]}
                type={spec.chartType ?? 'bar'}
                // Persisted on the spec, so a saved report opens as the shape
                // it was built as.
                onTypeChange={(chartType) => onChange({ chartType })}
              />
            </div>
          ) : (
            <ReportGrid
              columns={state.columns}
              rows={state.rows}
              totals={state.totals}
              emptyHint="Nothing matched. Try a wider period, or remove a filter."
            />
          )}
        </>
      )}
    </Card>
  )
}
