'use client'

import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  Select,
  ToolbarSearch,
} from '@/components/ui'
import {
  AGG_LABELS,
  CALC_FORMAT_LABELS,
  CALC_FORMATS,
  CALC_OP_SYMBOLS,
  CALC_OPS,
  MAX_GROUP_FIELDS,
  nextCalcKey,
  ROW_COUNT_FIELD,
  type AggFn,
  type CalcFormat,
  type CalcOp,
  type CustomReportSpec,
  type SpecColumn,
} from '@/lib/reportBuilder/spec'
import {
  aggsForClientField,
  defaultAggForClientField,
  findField,
  groupedFields,
  isClientCalcOperand,
  type ClientField,
  type ClientSource,
} from '@/lib/reportBuilder/clientTypes'

/**
 * Columns, grouping and calculations.
 *
 * The grouping decision comes FIRST in the panel even though it is technically
 * optional, because it changes what every other control means: with no
 * grouping this is a list of records, with one it is a summary and every other
 * column becomes an aggregate. Burying that at the bottom is how people end up
 * confused about why their column headers suddenly say "Total".
 */
export default function ColumnsPanel({
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
  const [search, setSearch] = useState('')
  const [showCalc, setShowCalc] = useState(false)

  const summarised = spec.groupFields.length > 0
  const groups = useMemo(() => groupedFields(source), [source])

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map(([name, fields]) => [name, fields.filter((f) => f.label.toLowerCase().includes(q))] as const)
      .filter(([, fields]) => fields.length > 0)
  }, [groups, search])

  const chosen = new Set(spec.columns.map((c) => c.field))

  function toggleColumn(field: ClientField) {
    if (chosen.has(field.key)) {
      onChange({
        columns: spec.columns.filter((c) => c.field !== field.key),
        // A sort pointing at a column that is gone would silently do nothing.
        ...(spec.sort?.key.startsWith(field.key) ? { sort: undefined } : {}),
      })
      return
    }
    onChange({
      columns: [
        ...spec.columns,
        { field: field.key, ...(summarised ? { agg: defaultAggForClientField(field) } : {}) },
      ],
    })
  }

  function toggleGroup(key: string) {
    const has = spec.groupFields.includes(key)
    const groupFields = has
      ? spec.groupFields.filter((k) => k !== key)
      : [...spec.groupFields, key].slice(0, MAX_GROUP_FIELDS)

    // Switching into or out of summary mode rewrites every column's aggregate,
    // because a column means a different thing in each mode.
    const nowSummarised = groupFields.length > 0
    const columns = spec.columns.map((c) => {
      if (c.calc) return nowSummarised ? { ...c, agg: c.agg ?? ('sum' as AggFn) } : { ...c, agg: undefined }
      if (c.field === ROW_COUNT_FIELD) return c
      const f = findField(source, c.field)
      if (!f) return c
      return nowSummarised ? { ...c, agg: c.agg ?? defaultAggForClientField(f) } : { ...c, agg: undefined }
    })

    onChange({ groupFields, columns, sort: undefined, totalFilters: [] })
  }

  function setAgg(index: number, agg: AggFn) {
    const columns = [...spec.columns]
    columns[index] = { ...columns[index], agg }
    onChange({ columns, sort: undefined })
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= spec.columns.length) return
    const columns = [...spec.columns]
    ;[columns[index], columns[target]] = [columns[target], columns[index]]
    onChange({ columns })
  }

  function removeColumn(index: number) {
    onChange({ columns: spec.columns.filter((_, i) => i !== index) })
  }

  const body = (
    <>
      <div className={`flex flex-col gap-4 ${chrome ? 'p-4' : ''}`}>
        {!chrome && (
          <p className="text-sm text-muted">
            {summarised
              ? 'One row per group. Every other column is summarised.'
              : 'One row per record. Add a grouping to summarise instead.'}
          </p>
        )}
        {/* ── grouping ────────────────────────────────────────────────────── */}
        <Field
          label="Group by"
          hint={
            summarised
              ? `Grouped by ${spec.groupFields.length} field${spec.groupFields.length === 1 ? '' : 's'}. Up to ${MAX_GROUP_FIELDS}.`
              : 'Leave empty to list every record.'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {spec.groupFields.map((key) => (
              <Badge key={key} tone="brand">
                {findField(source, key)?.label ?? key}
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  aria-label={`Stop grouping by ${findField(source, key)?.label ?? key}`}
                  className="ml-1 hover:text-brand-ink"
                >
                  <Icons.Close size={12} />
                </button>
              </Badge>
            ))}
            {spec.groupFields.length < MAX_GROUP_FIELDS && (
              <Menu
                variant="secondary"
                align="left"
                label={
                  <>
                    <Icons.Plus size={14} />
                    {spec.groupFields.length === 0 ? 'Group by…' : 'Add'}
                  </>
                }
              >
                {source.fields
                  .filter((f) => !spec.groupFields.includes(f.key))
                  .map((f) => (
                    <MenuItem key={f.key} onClick={() => toggleGroup(f.key)}>
                      {f.label}
                    </MenuItem>
                  ))}
              </Menu>
            )}
          </div>
        </Field>

        {/* ── chosen columns, in order ────────────────────────────────────── */}
        {spec.columns.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted">Showing, in this order</span>
            {spec.columns.map((col, i) => (
              <ChosenColumn
                key={`${col.field}-${i}`}
                col={col}
                source={source}
                summarised={summarised}
                isGrouped={spec.groupFields.includes(col.field)}
                onAgg={(agg) => setAgg(i, agg)}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => removeColumn(i)}
                first={i === 0}
                last={i === spec.columns.length - 1}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowCalc(true)}>
            <Icons.Sigma size={14} />
            Add a calculation
          </Button>
          {summarised && !chosen.has(ROW_COUNT_FIELD) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onChange({ columns: [...spec.columns, { field: ROW_COUNT_FIELD }] })}
            >
              <Icons.Plus size={14} />
              Add row count
            </Button>
          )}
        </div>

        {showCalc && (
          <CalcEditor
            source={source}
            existing={spec.columns}
            onCancel={() => setShowCalc(false)}
            onAdd={(col) => {
              onChange({ columns: [...spec.columns, col] })
              setShowCalc(false)
            }}
          />
        )}

        {/* ── the field picker ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Find a field…"
            className="w-full"
            aria-label="Find a field"
          />
          <div className="max-h-80 overflow-y-auto pr-1">
            {visibleGroups.map(([name, fields]) => (
              <div key={name} className="mb-3">
                <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                  {name}
                </p>
                <div className="flex flex-col gap-0.5">
                  {fields.map((f) => (
                    <label
                      key={f.key}
                      className="flex cursor-pointer items-start gap-2 rounded-control px-2 py-1 hover:bg-surface-2"
                      title={f.hint || undefined}
                    >
                      <Checkbox
                        checked={chosen.has(f.key)}
                        onChange={() => toggleColumn(f)}
                        aria-label={f.label}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-ink-2">{f.label}</span>
                        {f.hint && <span className="block text-xs text-faint">{f.hint}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {visibleGroups.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted">No field matches “{search}”.</p>
            )}
          </div>
        </div>
      </div>
    </>
  )

  if (!chrome) return body

  return (
    <Card>
      <CardHeader
        title="Columns"
        description={
          summarised
            ? 'One row per group. Every other column is summarised.'
            : 'One row per record. Add a grouping to summarise instead.'
        }
      />
      {body}
    </Card>
  )
}

function ChosenColumn({
  col,
  source,
  summarised,
  isGrouped,
  onAgg,
  onUp,
  onDown,
  onRemove,
  first,
  last,
}: {
  col: SpecColumn
  source: ClientSource
  summarised: boolean
  isGrouped: boolean
  onAgg: (agg: AggFn) => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  first: boolean
  last: boolean
}) {
  const field = col.calc ? undefined : findField(source, col.field)
  const label = col.calc
    ? col.calc.label
    : col.field === ROW_COUNT_FIELD
      ? 'Row count'
      : (field?.label ?? col.field)

  // A group field is shown as the label it groups by, never aggregated.
  const aggs = field ? aggsForClientField(field) : col.calc ? (['sum', 'avg', 'min', 'max'] as AggFn[]) : []
  const showAgg = summarised && !isGrouped && col.field !== ROW_COUNT_FIELD && aggs.length > 0

  return (
    <div className="flex items-center gap-2 rounded-control border border-border bg-surface px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
        {label}
        {isGrouped && <span className="ml-1.5 text-xs text-muted">(grouped)</span>}
        {col.calc && <Icons.Sigma size={12} className="ml-1.5 inline text-muted" />}
      </span>

      {showAgg && (
        <Select
          aria-label={`How to summarise ${label}`}
          value={col.agg ?? 'sum'}
          onChange={(e) => onAgg(e.target.value as AggFn)}
          className="h-control-sm w-32 text-xs"
        >
          {aggs.map((a) => (
            <option key={a} value={a}>
              {AGG_LABELS[a]}
            </option>
          ))}
        </Select>
      )}

      <Button variant="ghost" size="sm" iconOnly aria-label="Move up" onClick={onUp} disabled={first}>
        <Icons.ChevronUp size={14} />
      </Button>
      <Button variant="ghost" size="sm" iconOnly aria-label="Move down" onClick={onDown} disabled={last}>
        <Icons.ChevronDown size={14} />
      </Button>
      <Button variant="danger-ghost" size="sm" iconOnly aria-label={`Remove ${label}`} onClick={onRemove}>
        <Icons.Close size={14} />
      </Button>
    </div>
  )
}

/**
 * A calculated column: A (+ − × ÷) B.
 *
 * Deliberately two operands and an operator rather than a formula box. A
 * formula language would need parsing, precedence and error reporting, and
 * would put user text into an expression — the one thing the catalog boundary
 * exists to prevent.
 */
function CalcEditor({
  source,
  existing,
  onAdd,
  onCancel,
}: {
  source: ClientSource
  existing: SpecColumn[]
  onAdd: (col: SpecColumn) => void
  onCancel: () => void
}) {
  const operands = useMemo(() => source.fields.filter(isClientCalcOperand), [source])
  const [label, setLabel] = useState('')
  const [left, setLeft] = useState(operands[0]?.key ?? '')
  const [op, setOp] = useState<CalcOp>('mul')
  const [rightMode, setRightMode] = useState<'field' | 'number'>('field')
  const [rightField, setRightField] = useState(operands[1]?.key ?? operands[0]?.key ?? '')
  const [rightNumber, setRightNumber] = useState('1')
  const [format, setFormat] = useState<CalcFormat>('currency')

  if (operands.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface-2 p-3 text-sm text-muted">
        This data has no numeric fields to calculate with.
        <Button variant="ghost" size="sm" onClick={onCancel} className="ml-2">
          Close
        </Button>
      </div>
    )
  }

  const right = rightMode === 'number' ? Number(rightNumber) : rightField
  const valid =
    label.trim().length > 0 &&
    left &&
    (rightMode === 'field'
      ? !!rightField
      : Number.isFinite(Number(rightNumber)) && !(op === 'div' && Number(rightNumber) === 0))

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-3">
      <Field label="Column name">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Sales per basket"
          maxLength={60}
        />
      </Field>

      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <Field label="This">
          <Select value={left} onChange={(e) => setLeft(e.target.value)}>
            {operands.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <Select
          aria-label="Operator"
          value={op}
          onChange={(e) => setOp(e.target.value as CalcOp)}
          className="w-16"
        >
          {CALC_OPS.map((o) => (
            <option key={o} value={o}>
              {CALC_OP_SYMBOLS[o]}
            </option>
          ))}
        </Select>
        <Field label="By">
          {rightMode === 'field' ? (
            <Select value={rightField} onChange={(e) => setRightField(e.target.value)}>
              {operands.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={rightNumber}
              onChange={(e) => setRightNumber(e.target.value)}
              inputMode="decimal"
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRightMode(rightMode === 'field' ? 'number' : 'field')}
        >
          {rightMode === 'field' ? 'Use a fixed number instead' : 'Use a field instead'}
        </Button>
        <Field label="Show as" className="w-40">
          <Select value={format} onChange={(e) => setFormat(e.target.value as CalcFormat)}>
            {CALC_FORMATS.map((f) => (
              <option key={f} value={f}>
                {CALC_FORMAT_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {op === 'div' && rightMode === 'field' && (
        <p className="text-xs text-muted">
          Dividing two fields gives a ratio of totals when the report is summarised — total ÷
          total, not the average of each row&rsquo;s ratio.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!valid}
          onClick={() =>
            onAdd({
              field: nextCalcKey(existing),
              calc: { label: label.trim(), left, op, right, format },
            })
          }
        >
          Add column
        </Button>
      </div>
    </div>
  )
}
