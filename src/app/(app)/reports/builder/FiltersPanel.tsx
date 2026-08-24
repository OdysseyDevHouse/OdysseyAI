'use client'

import {
  Button,
  Card,
  CardHeader,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  Select,
} from '@/components/ui'
import {
  FILTER_OP_LABELS,
  MAX_FILTERS,
  MAX_TOTAL_FILTERS,
  TOTAL_FILTER_OPS,
  valueCount,
  type CustomReportSpec,
  type FilterOp,
  type SpecFilter,
  type SpecTotalFilter,
} from '@/lib/reportBuilder/spec'
import {
  clientOutputColumns,
  findField,
  opsForClientField,
  type ClientSource,
} from '@/lib/reportBuilder/clientTypes'

/**
 * Filters — on the records, and on the totals.
 *
 * The two are genuinely different questions and are kept apart on screen for
 * that reason:
 *
 *   A RECORD filter asks "which rows go in" — sales over R500, this department
 *   only. It runs in SQL before anything is added up.
 *
 *   A TOTAL filter asks "which groups come out" — departments that took more
 *   than R10,000, products that sold nothing. It can only be answered after the
 *   summing, and it is meaningless without a grouping, so it only appears when
 *   there is one.
 *
 * Merging them into one list is the single most common way a report builder
 * confuses people: "amount > 500" means two entirely different reports
 * depending on which side of the aggregation it lands.
 */
export default function FiltersPanel({
  source,
  spec,
  onChange,
  chrome = true,
}: {
  source: ClientSource
  spec: CustomReportSpec
  onChange: (changes: Partial<CustomReportSpec>) => void
  /**
   * Off when the panel is the body of a pop-up, which supplies its own title
   * and padding — a Card nested inside a Modal reads as a box in a box.
   */
  chrome?: boolean
}) {
  const summarised = spec.groupFields.length > 0

  // The output columns a total filter may name — only the summarised numbers.
  const outputColumns = summarised
    ? clientOutputColumns(source, spec).filter((c) => c.numeric)
    : []

  function setFilter(index: number, changes: Partial<SpecFilter>) {
    const filters = [...spec.filters]
    filters[index] = { ...filters[index], ...changes }
    onChange({ filters })
  }

  function addFilter(fieldKey: string) {
    const field = findField(source, fieldKey)
    if (!field) return
    onChange({
      filters: [...spec.filters, { field: fieldKey, op: opsForClientField(field)[0], value: '' }],
    })
  }

  function setTotalFilter(index: number, changes: Partial<SpecTotalFilter>) {
    const totalFilters = [...spec.totalFilters]
    totalFilters[index] = { ...totalFilters[index], ...changes }
    onChange({ totalFilters })
  }

  const body = (
    <div className={`flex flex-col gap-4 ${chrome ? 'p-4' : ''}`}>
      <div className="flex flex-col gap-2">
          {spec.filters.map((filter, i) => {
            const field = findField(source, filter.field)
            if (!field) return null
            const ops = opsForClientField(field)
            const needs = valueCount(filter.op)

            return (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface p-2"
              >
                <span className="min-w-28 flex-1 truncate text-sm text-ink-2">{field.label}</span>

                <Select
                  aria-label={`How to compare ${field.label}`}
                  value={filter.op}
                  onChange={(e) =>
                    setFilter(i, { op: e.target.value as FilterOp, value: '', value2: '' })
                  }
                  className="h-control-sm w-40 text-xs"
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {FILTER_OP_LABELS[op]}
                    </option>
                  ))}
                </Select>

                {needs >= 1 &&
                  (field.options.length > 0 && filter.op !== 'in' ? (
                    <Select
                      aria-label={`Value for ${field.label}`}
                      value={filter.value ?? ''}
                      onChange={(e) => setFilter(i, { value: e.target.value })}
                      className="h-control-sm w-40 text-xs"
                    >
                      <option value="">Choose…</option>
                      {field.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      aria-label={`Value for ${field.label}`}
                      value={filter.value ?? ''}
                      onChange={(e) => setFilter(i, { value: e.target.value })}
                      type={field.type === 'date' || field.type === 'datetime' ? 'date' : 'text'}
                      placeholder={filter.op === 'in' ? 'A, B, C' : ''}
                      className="h-control-sm w-40 text-xs"
                    />
                  ))}

                {needs === 2 && (
                  <Input
                    aria-label={`Second value for ${field.label}`}
                    value={filter.value2 ?? ''}
                    onChange={(e) => setFilter(i, { value2: e.target.value })}
                    type={field.type === 'date' || field.type === 'datetime' ? 'date' : 'text'}
                    className="h-control-sm w-40 text-xs"
                  />
                )}

                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove filter on ${field.label}`}
                  onClick={() => onChange({ filters: spec.filters.filter((_, j) => j !== i) })}
                >
                  <Icons.Close size={14} />
                </Button>
              </div>
            )
          })}

          {spec.filters.length < MAX_FILTERS && (
            <Menu
              variant="secondary"
              align="left"
              label={
                <>
                  <Icons.Filter size={14} />
                  Add a filter
                </>
              }
            >
              {source.fields.map((f) => (
                <MenuItem key={f.key} onClick={() => addFilter(f.key)}>
                  {f.label}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>

        {/* ── filters on the summarised figures ───────────────────────────── */}
        {summarised && outputColumns.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-[13px] text-muted">
              Filter on the totals — e.g. only departments that took more than R10,000
            </span>

            {spec.totalFilters.map((tf, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface p-2"
              >
                <Select
                  aria-label="Which total"
                  value={tf.key}
                  onChange={(e) => setTotalFilter(i, { key: e.target.value })}
                  className="h-control-sm min-w-36 flex-1 text-xs"
                >
                  {outputColumns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>

                <Select
                  aria-label="How to compare"
                  value={tf.op}
                  onChange={(e) => setTotalFilter(i, { op: e.target.value as FilterOp })}
                  className="h-control-sm w-40 text-xs"
                >
                  {TOTAL_FILTER_OPS.map((op) => (
                    <option key={op} value={op}>
                      {FILTER_OP_LABELS[op]}
                    </option>
                  ))}
                </Select>

                <Input
                  aria-label="Value"
                  value={tf.value}
                  onChange={(e) => setTotalFilter(i, { value: e.target.value })}
                  inputMode="decimal"
                  className="h-control-sm w-28 text-xs"
                />

                {valueCount(tf.op) === 2 && (
                  <Input
                    aria-label="Second value"
                    value={tf.value2 ?? ''}
                    onChange={(e) => setTotalFilter(i, { value2: e.target.value })}
                    inputMode="decimal"
                    className="h-control-sm w-28 text-xs"
                  />
                )}

                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label="Remove this total filter"
                  onClick={() =>
                    onChange({ totalFilters: spec.totalFilters.filter((_, j) => j !== i) })
                  }
                >
                  <Icons.Close size={14} />
                </Button>
              </div>
            ))}

            {spec.totalFilters.length < MAX_TOTAL_FILTERS && (
              <Menu
                variant="secondary"
                align="left"
                label={
                  <>
                    <Icons.Sigma size={14} />
                    Filter on a total
                  </>
                }
              >
                {outputColumns.map((c) => (
                  <MenuItem
                    key={c.key}
                    onClick={() =>
                      onChange({
                        totalFilters: [
                          ...spec.totalFilters,
                          { key: c.key, op: 'gt', value: '0' },
                        ],
                      })
                    }
                  >
                    {c.label}
                  </MenuItem>
                ))}
              </Menu>
            )}
        </div>
      )}
    </div>
  )

  if (!chrome) return body

  return (
    <Card>
      <CardHeader title="Filters" description="Narrow the report down to what you want to see." />
      {body}
    </Card>
  )
}
