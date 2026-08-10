'use client'

import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartTooltip, EmptyState, Icons, Select, useChartColors } from '@/components/ui'
import { formatCell } from '@/lib/reportBuilder/format'
import type { ChartType, ReportColumn } from '@/lib/reportBuilder/spec'

/**
 * A summarised report drawn as a picture.
 *
 * Only ever offered for a GROUPED report: a chart of 4,000 detail rows is a
 * smear, and the grouping is what makes the label axis mean something.
 *
 * Colour comes exclusively from `useChartColors()`, never named here, which is
 * what keeps these correct in dark mode and restyleable from globals.css.
 */

/** How many slices/bars stay legible before the tail is folded into "Other". */
const MAX_SLICES = 12

export default function ReportChart({
  columns,
  rows,
  labelKey,
  type,
  onTypeChange,
}: {
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  labelKey: string
  type: ChartType
  /**
   * Pass this to OWN the chart shape. The builder does, because there the
   * choice is part of the report and has to survive being saved; a report
   * being read just flips between shapes for a moment, so it keeps the
   * local state below and this stays undefined.
   */
  onTypeChange?: (type: ChartType) => void
}) {
  const colors = useChartColors()

  const numericColumns = useMemo(() => columns.filter((c) => c.numeric), [columns])
  const [measure, setMeasure] = useState(() => numericColumns[0]?.key ?? '')
  const [localShape, setLocalShape] = useState<ChartType>(type)

  // Controlled by the caller, or by us — never both, which is what would let
  // the picker and the saved spec drift apart.
  const shape = onTypeChange ? type : localShape
  const setShape = onTypeChange ?? setLocalShape

  const column = numericColumns.find((c) => c.key === measure) ?? numericColumns[0]

  const data = useMemo(() => {
    if (!column) return []
    const mapped = rows.map((r) => ({
      label: formatCell(r[labelKey], columns.find((c) => c.key === labelKey)?.type ?? 'text') || '—',
      value: Number(r[column.key] ?? 0),
    }))

    // A pie with sixty slices communicates nothing, so the tail is folded into
    // one "Other" wedge rather than silently truncated — the total still adds up.
    if (shape === 'pie' && mapped.length > MAX_SLICES) {
      const sorted = [...mapped].sort((a, b) => b.value - a.value)
      const head = sorted.slice(0, MAX_SLICES - 1)
      const tail = sorted.slice(MAX_SLICES - 1)
      const rest = tail.reduce((sum, r) => sum + r.value, 0)
      return [...head, { label: `Other (${tail.length})`, value: rest }]
    }
    return mapped
  }, [rows, column, labelKey, columns, shape])

  if (!column || data.length === 0) {
    return (
      <EmptyState
        title="Nothing to chart"
        hint="This report has no numeric column to plot."
        icon={<Icons.BarChart size={28} strokeWidth={1.75} />}
      />
    )
  }

  const axis = {
    stroke: colors.axis,
    tick: { fontSize: 11, fill: colors.axis },
    tickLine: false,
    axisLine: { stroke: colors.grid },
  }

  const fmt = (v: string | number) => formatCell(v, column.type)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Measure"
          value={column.key}
          onChange={(e) => setMeasure(e.target.value)}
        >
          {numericColumns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Chart type"
          value={shape}
          onChange={(e) => setShape(e.target.value as ChartType)}
        >
          <option value="bar">Bars</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </Select>
      </div>

      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {shape === 'pie' ? (
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="label" outerRadius="78%" strokeWidth={0}>
                {data.map((_, i) => (
                  <Cell key={i} fill={colors.series[i % colors.series.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip format={fmt} />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          ) : shape === 'line' ? (
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
              <YAxis {...axis} width={72} tickFormatter={fmt} />
              <Tooltip content={<ChartTooltip format={fmt} />} />
              <Line
                type="monotone"
                dataKey="value"
                name={column.label}
                stroke={colors.brand}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
              <YAxis {...axis} width={72} tickFormatter={fmt} />
              <Tooltip content={<ChartTooltip format={fmt} />} cursor={{ fill: colors.grid }} />
              <Bar dataKey="value" name={column.label} radius={[3, 3, 0, 0]}>
                {data.map((d, i) => (
                  <Cell
                    key={i}
                    // A negative bar is an exception and must read as one.
                    fill={d.value < 0 ? colors.danger : colors.brand}
                  />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
