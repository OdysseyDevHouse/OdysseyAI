'use client'

import { useEffect, useState } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import { Checkbox, Input, Select } from './Field'
import { Combobox } from './Combobox'
import { Filter, Close } from './icons'
import { Badge } from './Badge'
import type { FilterOp } from '@/lib/reportBuilder/spec'
import {
  opsFor,
  valuesNeeded,
  OP_LABELS,
  isConditionComplete as complete,
  type FilterCondition,
  type FilterField,
} from './filterConditions'

/**
 * The advanced filter behind a button.
 *
 * ── WHY A BUTTON AND NOT MORE CONTROLS IN THE TOOLBAR ──────────────────────
 *
 * The products toolbar already carries a search box, a slice control, two
 * pickers and a sort. That is the ceiling: everyone who opens the catalogue
 * pays attention to every control on it, and most people never need to ask
 * "which products are visible on the till". Advanced filtering is a minority
 * tool used intently — exactly the shape that belongs behind one button, with
 * the complexity on the other side of it.
 *
 * What must NOT hide behind the button is the fact that a filter is ON. A list
 * showing 10 of 3,214 products with no visible reason looks like a broken
 * screen. So the button carries a count, and the caller renders a chip per
 * condition beside it. See `summarise` for the labels those chips use.
 *
 * ── THE VOCABULARY IS NOT THIS COMPONENT'S ─────────────────────────────────
 *
 * Fields, operators and value lists all come from the report builder's catalog,
 * projected to the browser without their SQL (`ClientField`). This component
 * renders whatever it is handed and never decides what is filterable — that is
 * the calling screen's business, because it depends on which joins that
 * screen's query has.
 */

export function AdvancedFilter({
  fields,
  value,
  onApply,
  remembered,
  onRememberChange,
  max = 12,
  label = 'Filter',
  builderHref,
}: {
  /** What may be filtered on, already narrowed by the screen and by permission. */
  fields: readonly FilterField[]
  /** The conditions currently applied — from the URL, so this is controlled. */
  value: readonly FilterCondition[]
  /**
   * Apply. The caller navigates, because filter state lives in the URL — that
   * is what makes a filtered list linkable and reloadable.
   */
  onApply: (conditions: FilterCondition[], remember: boolean) => void
  /** Whether "remember" is currently on. Defaults off — see the checkbox note. */
  remembered?: boolean
  onRememberChange?: (next: boolean) => void
  max?: number
  label?: string
  /**
   * Where "Build a full report" goes, with the current conditions carried over.
   * Offered because past about a dozen conditions this stops being a worklist
   * and starts being a report — and the builder is the better screen for that.
   */
  builderHref?: string
}) {
  const [open, setOpen] = useState(false)

  /* The panel edits a DRAFT, applied on Apply rather than on every keystroke.
     Filtering live would re-query on every character typed into a value box,
     and — worse — would renumber the list under someone mid-edit. */
  const [draft, setDraft] = useState<FilterCondition[]>([...value])
  const [remember, setRemember] = useState(!!remembered)
  /* The field search box. Cleared on every pick, so the next condition starts
     from an empty box rather than the last thing typed. */
  const [fieldQuery, setFieldQuery] = useState('')

  /* Re-seed whenever the applied filter changes underneath us — a chip cleared
     from the strip outside this panel, or a Back that restored an earlier set.
     Without this the panel would reopen showing a filter that is no longer on. */
  useEffect(() => {
    if (!open) {
      setDraft([...value])
      setRemember(!!remembered)
    }
  }, [open, value, remembered])

  const applied = value.filter(complete).length

  function update(index: number, changes: Partial<FilterCondition>) {
    setDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...changes } : c)))
  }

  function add(fieldKey: string) {
    const field = fields.find((f) => f.key === fieldKey)
    if (!field) return
    setDraft((prev) => [...prev, { field: fieldKey, op: opsFor(field)[0], value: '' }])
  }

  function apply() {
    onApply(draft.filter(complete), remember)
    setOpen(false)
  }

  function clearAll() {
    setDraft([])
    setRemember(false)
    onApply([], false)
    setOpen(false)
  }

  /* What the field search offers: everything not already being filtered on,
     matched on the field's own name AND its catalogue section, so typing
     "stock" finds the Quantities fields and "till" finds "Visible on the
     till". The section is shown beside each row because two sections can hold
     similarly-named fields — "Department" is both a product's own and its
     supplier's on other sources. */
  const query = fieldQuery.trim().toLowerCase()
  const chosen = new Set(draft.map((c) => c.field))
  const pickerOptions = fields
    .filter((f) => !chosen.has(f.key))
    .filter(
      (f) =>
        !query ||
        f.label.toLowerCase().includes(query) ||
        (f.group || '').toLowerCase().includes(query),
    )
    .slice(0, 50)
    .map((f) => ({
      value: f.key,
      label: f.label,
      hint: f.group || undefined,
    }))

  return (
    <>
      <Button variant={applied > 0 ? 'secondary' : 'ghost'} onClick={() => setOpen(true)}>
        <Filter size={15} />
        {label}
        {/* The count is what stops a filtered list looking broken from the
            toolbar alone. */}
        {applied > 0 && <Badge tone="brand">{applied}</Badge>}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Advanced filter"
        description="Narrow the list to exactly what you want to work through. Every condition must match."
        size="lg"
        /* Two things this dialog needs, and one flag gives both.
           It starts with ONE row and grows a row at a time, so the body must
           be its content's height — the default body is a plain block child of
           a flex column, which STRETCHES, and drew a one-row dialog full
           height with a scrollbar down the side. And the field picker is a
           Combobox that opens inside the body, so any clipping there cuts its
           list off at the body's edge — which is what put the scrollbar back
           even once the height was right. `bodyOverflows` sizes to content and
           clips nothing. Safe here because the conditions are capped at a
           dozen; see the prop's note. */
        bodyOverflows
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            {/* Remember sits in the FOOTER, beside Apply, because it is part of
                the same decision — "show me these, and keep showing me these".
                Buried in the body it would scroll out of sight at 60vh. */}
            <Checkbox
              label="Remember this filter while I work"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked)
                onRememberChange?.(e.target.checked)
              }}
            />
            <div className="flex items-center gap-2">
              {applied > 0 && (
                <Button variant="ghost" onClick={clearAll}>
                  Clear all
                </Button>
              )}
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={apply}>
                Apply
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {draft.length === 0 && (
            <p className="text-sm text-muted">
              No conditions yet. Add one below — for example “Visible on the till is Yes”, or
              “Product type is Service”.
            </p>
          )}

          {draft.map((condition, i) => {
            const field = fields.find((f) => f.key === condition.field)
            if (!field) return null
            const ops = opsFor(field)
            const needs = valuesNeeded(condition.op)
            const isDate = field.type === 'date' || field.type === 'datetime'

            return (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface p-2"
              >
                {/* A FIXED width, not flex-1: the rows stack, and a label
                    column that sizes to its own text puts every row's operator
                    in a different place. Reading down the column is the whole
                    point of a condition list. */}
                <span className="w-44 shrink-0 truncate text-sm text-ink-2" title={field.hint}>
                  {field.label}
                </span>

                <Select
                  aria-label={`How to compare ${field.label}`}
                  value={condition.op}
                  /* The cast is sound: every <option> below comes from `ops`,
                     which is FilterOp[]. A <select> just types its value as
                     string. Values are cleared because they rarely survive a
                     change of operator — a date typed for "is after" means
                     nothing once the question becomes "is empty". */
                  onChange={(e) =>
                    update(i, { op: e.target.value as FilterOp, value: '', value2: '' })
                  }
                  className="h-control-sm w-40 shrink-0 text-xs"
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op] ?? op}
                    </option>
                  ))}
                </Select>

                {needs >= 1 &&
                  (field.options.length > 0 && condition.op === 'in' ? (
                    /* "Is any of" over a closed set. The one-value case is a
                       <Select> below; this is the same promise for the many-
                       value one — the alternative was a text box asking for
                       "A, B, C", which on a choice field means typing the
                       stored spellings by hand. That is exactly what a picker
                       exists to prevent, and it is worse here than anywhere
                       else because the values are not always what the labels
                       say: a statement cycle is stored '14day'. */
                    <ChoiceList
                      field={field}
                      value={condition.value ?? ''}
                      onChange={(next) => update(i, { value: next })}
                    />
                  ) : field.options.length > 0 ? (
                    <Select
                      aria-label={`Value for ${field.label}`}
                      value={condition.value ?? ''}
                      onChange={(e) => update(i, { value: e.target.value })}
                      className="h-control-sm min-w-40 flex-1 text-xs"
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
                      value={condition.value ?? ''}
                      onChange={(e) => update(i, { value: e.target.value })}
                      type={isDate ? 'date' : 'text'}
                      placeholder={condition.op === 'in' ? 'A, B, C' : ''}
                      className="h-control-sm min-w-40 flex-1 text-xs"
                    />
                  ))}

                {needs === 2 && (
                  <Input
                    aria-label={`Second value for ${field.label}`}
                    value={condition.value2 ?? ''}
                    onChange={(e) => update(i, { value2: e.target.value })}
                    type={isDate ? 'date' : 'text'}
                    className="h-control-sm min-w-40 flex-1 text-xs"
                  />
                )}

                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove the condition on ${field.label}`}
                  onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Close size={14} />
                </Button>
              </div>
            )
          })}

          <div className="flex items-center gap-3">
            {draft.length < max ? (
              /* A SEARCH box, not a dropdown of thirty-five fields.
                 Two reasons, and the second is what forced it: at this length
                 a menu is something you hunt through, while a filter is always
                 begun by knowing the word — "till", "type", "cost". And a
                 dropdown opens INSIDE this dialog's scrolling body, so a long
                 one is clipped at the body's edge no matter what height it is
                 given. Combobox already caps its list to the room actually
                 left below it, which is the same fix the product picker needed
                 in a modal. */
              <div className="w-72">
                <Combobox
                  options={pickerOptions}
                  query={fieldQuery}
                  onQueryChange={setFieldQuery}
                  onSelect={(option) => {
                    add(String(option.value))
                    setFieldQuery('')
                  }}
                  clearOnSelect
                  placeholder="Add a condition — search fields…"
                  emptyText="No field matches"
                />
              </div>
            ) : (
              <span className="text-xs text-muted">
                That is the most conditions one list can carry.
              </span>
            )}

            {builderHref && (
              <a
                href={builderHref}
                className="text-xs text-muted underline-offset-2 transition hover:text-ink hover:underline"
              >
                Need totals or grouping? Build a report
              </a>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}

/**
 * "Is any of", over a closed set — tick the ones you mean.
 *
 * The wire format is the comma-joined string filterClause already splits on
 * (see the `in` case in reportBuilder/run.ts), so this changes how the value is
 * COMPOSED and nothing about how it is compiled, stored in a URL, or read back
 * by a chip. A filter saved before this existed still loads: the values parse
 * out of the same string, and any that no longer match an option are kept in
 * place rather than dropped, so opening a stale filter cannot silently narrow
 * it to fewer values than the list is actually being filtered by.
 *
 * Laid out as a wrapping row of checkboxes rather than a multi-select: a
 * <select multiple> requires ctrl-click to pick a second value, which is the
 * single least discoverable interaction on the web, and it is unusable on the
 * touch screens half of this product runs on.
 */
function ChoiceList({
  field,
  value,
  onChange,
}: {
  field: FilterField
  value: string
  onChange: (next: string) => void
}) {
  const picked = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  /* Values in the saved filter that are not offered any more — an option
     renamed in the catalogue, or a filter built before this control existed.
     Shown, ticked, so toggling something else does not quietly discard them. */
  const known = new Set(field.options.map((o) => o.value))
  const strays = picked.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))

  function toggle(option: string, on: boolean) {
    const next = on ? [...picked, option] : picked.filter((v) => v !== option)
    /* Emitted in the CATALOGUE's order, not the order they were clicked, so
       the chip above the list reads the same whichever way it was built. */
    const order = [...field.options.map((o) => o.value), ...strays.map((s) => s.value)]
    onChange(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(', '))
  }

  return (
    <div
      role="group"
      aria-label={`Values for ${field.label}`}
      /* Scrolls at ten-ish rows. A source can offer a long enum — the sale
         statuses, the product types — and an unbounded list would push Apply
         past the dialog's 60vh and out of reach. */
      className="flex max-h-40 min-w-40 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 overflow-y-auto rounded-control border border-border bg-surface-2 px-2.5 py-2"
    >
      {[...field.options, ...strays].map((option) => (
        <Checkbox
          key={option.value}
          label={<span className="text-xs">{option.label}</span>}
          checked={picked.includes(option.value)}
          onChange={(e) => toggle(option.value, e.target.checked)}
        />
      ))}
    </div>
  )
}
