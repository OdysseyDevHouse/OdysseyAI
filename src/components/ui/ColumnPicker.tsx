'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ColumnsIcon, Check } from './icons'
import { buttonClass } from './styles'

/**
 * Which columns a wide table shows.
 *
 * A grid that has to carry twenty columns — the purchasing line grids, where a
 * buyer wants cost, markup, GP and selling price at once but a receiver wants
 * quantity and nothing else — cannot show them all and stay readable. This is
 * the control that lets one table serve both.
 *
 * ── WHY NOT <Menu> ────────────────────────────────────────────────────────
 *
 * Menu closes on any click inside it, which is right for a list of actions and
 * wrong here: choosing columns is a multi-select, and closing after each one
 * would mean reopening the menu for every column. So this owns its own panel.
 * The outside-click, Escape and aria wiring is the same as Menu's — deliberately
 * kept identical rather than shared, because the one behaviour that differs is
 * the reason this exists.
 *
 * Locked columns are the ones a table cannot be read without: the item on a
 * purchase line, the quantity being received. They are shown with their box
 * ticked and disabled, rather than hidden from the list — a user looking for
 * "Item" should find it and see that it is always on, not wonder where it went.
 */

export type ColumnOption = {
  /** Matches the key held in the visible set. */
  id: string
  label: string
  /** Always shown, and not switchable off. */
  locked?: boolean
  /** Groups entries under a heading — 'Cost', 'Pricing', 'Stock'. */
  group?: string
}

export function ColumnPicker({
  columns,
  visible,
  onChange,
  onReset,
  label = 'Columns',
  align = 'right',
}: {
  columns: readonly ColumnOption[]
  /** The ids currently shown. Locked ids need not be in here. */
  visible: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** Offered as "Reset" when given — restores the table's own default set. */
  onReset?: () => void
  label?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function toggle(id: string) {
    const next = new Set(visible)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  // Insertion-ordered, so the panel follows the order the table declares its
  // columns in rather than an alphabetical one nobody asked for.
  const groups = new Map<string, ColumnOption[]>()
  for (const column of columns) {
    const key = column.group ?? ''
    const list = groups.get(key)
    if (list) list.push(column)
    else groups.set(key, [column])
  }

  const shown = columns.filter((c) => c.locked || visible.has(c.id)).length

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={buttonClass({ variant: 'ghost', size: 'sm' })}
      >
        <ColumnsIcon size={15} />
        {label}
        <span className="numeric text-muted">{shown}</span>
      </button>

      {open && (
        <div
          id={panelId}
          /* A dialog, not a menu: menu semantics promise that activating an
             item performs an action and closes, and these are checkboxes. */
          role="dialog"
          aria-label="Choose columns"
          className={`absolute z-20 mt-1.5 max-h-[60vh] w-60 overflow-y-auto rounded-control border border-border bg-surface p-1 shadow-pop ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {[...groups.entries()].map(([group, entries]) => (
            <div key={group}>
              {group && (
                <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted">{group}</p>
              )}
              {entries.map((column) => {
                const on = column.locked || visible.has(column.id)
                return (
                  <button
                    key={column.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={column.locked}
                    onClick={() => toggle(column.id)}
                    className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left text-sm text-ink-2 transition hover:bg-surface-2 disabled:pointer-events-none disabled:text-faint"
                  >
                    {/* A tick box drawn to the checkbox's own size rather than
                        the kit <Checkbox>: this row is the control, so the box
                        must not also be separately clickable inside it.
                        data-kit-ok */}
                    <span
                      data-kit-ok
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition ${
                        on ? 'border-brand bg-brand text-white' : 'border-border-strong bg-surface'
                      }`}
                    >
                      {on && <Check size={12} />}
                    </span>
                    {column.label}
                  </button>
                )
              })}
            </div>
          ))}

          {onReset && (
            <>
              <div role="separator" className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={() => {
                  onReset()
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm text-ink-2 transition hover:bg-surface-2"
              >
                Reset to default
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
