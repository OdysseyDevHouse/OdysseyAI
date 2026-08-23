'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Search, Spinner } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * Type-ahead picker for a list too long to put in a <Select>.
 *
 * Built for the till: you land in it, type or scan, and the first match is
 * already highlighted so Enter takes it without ever touching the mouse. A
 * native <select> cannot search, and a thousand-product dropdown is unusable
 * even when it can.
 *
 * The caller owns the options and the searching — pass filtered results and set
 * `loading` while a query is in flight. That keeps the same component usable
 * for an in-memory list of tender types and a server-searched product file.
 */
export type ComboboxOption<T> = {
  /** Stable id. Also what `onSelect` gets back. */
  value: string
  label: string
  /** Second line — a code, a barcode, a balance. */
  hint?: string
  /** Right-aligned, e.g. a price or an on-hand figure. */
  trailing?: ReactNode
  disabled?: boolean
  data?: T
}

export function Combobox<T>({
  options,
  query,
  onQueryChange,
  onSelect,
  placeholder = 'Search…',
  loading = false,
  emptyText = 'No matches',
  autoFocus = false,
  clearOnSelect = false,
  id,
  className = '',
}: {
  options: readonly ComboboxOption<T>[]
  query: string
  onQueryChange: (next: string) => void
  onSelect: (option: ComboboxOption<T>) => void
  placeholder?: string
  loading?: boolean
  emptyText?: string
  autoFocus?: boolean
  /** True at a till: take the line, empty the box, stay focused for the next scan. */
  clearOnSelect?: boolean
  id?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const generatedId = useId()
  const inputId = id ?? generatedId

  const selectable = options.filter((option) => !option.disabled)

  // A new result set invalidates the old highlight — keep it on the first row,
  // which is the one a scan is expected to hit.
  useEffect(() => setActive(0), [options])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  /*
   * How tall the results may be before something clips them.
   *
   * The list is positioned inside the field, so a Combobox in a scrolling pane
   * — a Modal body, which stops at 60vh — has its results cut off at the pane's
   * edge rather than at their own max-height. The rows below the fold are then
   * unreachable: the pane scrolls the whole form, not the dropdown.
   *
   * So the cap is whatever room is actually left below the input inside the
   * nearest scrolling ancestor, falling back to the viewport when there is
   * none. Measured on open, and on resize while open, because a modal's height
   * is a viewport fraction.
   */
  const [roomBelow, setRoomBelow] = useState<number | null>(null)

  useEffect(() => {
    if (!open) {
      setRoomBelow(null)
      return
    }

    function measure() {
      const input = inputRef.current
      if (!input) return

      let bound = window.innerHeight
      for (let el = input.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el)
        if (overflowY === 'auto' || overflowY === 'scroll') {
          bound = Math.min(bound, el.getBoundingClientRect().bottom)
          break
        }
      }

      // Leave a hair of breathing room so the list never sits flush against
      // the edge it is being kept inside.
      setRoomBelow(Math.max(bound - input.getBoundingClientRect().bottom - 12, 0))
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  function choose(option: ComboboxOption<T>) {
    if (option.disabled) return
    onSelect(option)
    if (clearOnSelect) {
      onQueryChange('')
      inputRef.current?.focus()
    }
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Wrap: at a till you hold the key rather than counting rows.
      setActive((current) => {
        const next = current + step
        if (next < 0) return Math.max(selectable.length - 1, 0)
        if (next >= selectable.length) return 0
        return next
      })
      return
    }

    if (event.key === 'Enter') {
      // Only swallow Enter when a row is genuinely highlighted, so a scanner's
      // trailing Enter with no match still submits the surrounding form.
      const option = selectable[active]
      if (open && option) {
        event.preventDefault()
        choose(option)
      }
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
        {loading ? <Spinner size={16} className="animate-spin" /> : <Search size={16} />}
      </span>

      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onChange={(event) => {
          onQueryChange(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`${CONTROL} ${CONTROL_H} pl-9`}
      />

      {open && (query.length > 0 || options.length > 0) && (
        <ul
          id={listId}
          role="listbox"
          /* max-h-72 is the ceiling; the inline cap only ever brings it DOWN,
             and never below two rows — a list squeezed to a sliver is worse to
             use than one that overflows a little. */
          style={
            roomBelow === null
              ? undefined
              : { maxHeight: Math.min(Math.max(roomBelow, 96), 288) }
          }
          className="absolute z-20 mt-1.5 max-h-72 w-full overflow-y-auto rounded-control border border-border bg-surface p-1 shadow-pop"
        >
          {options.length === 0 && !loading && (
            <li className="px-3 py-2.5 text-sm text-muted">{emptyText}</li>
          )}

          {options.map((option) => {
            const index = selectable.indexOf(option)
            const highlighted = index === active && index !== -1

            return (
              <li key={option.value} role="option" aria-selected={highlighted}>
                <button
                  type="button"
                  disabled={option.disabled}
                  onMouseEnter={() => index !== -1 && setActive(index)}
                  onClick={() => choose(option)}
                  /* A full-width, two-line result row with a trailing figure —
                     not a Button. A kit Button here would centre the label and
                     lose the hint line. */
                  data-kit-ok
                  className={`flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left transition disabled:pointer-events-none disabled:opacity-50 ${
                    highlighted ? 'bg-brand-soft' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{option.label}</span>
                    {option.hint && (
                      <span className="block truncate text-xs text-muted">{option.hint}</span>
                    )}
                  </span>
                  {option.trailing && (
                    <span className="numeric shrink-0 text-sm text-ink-2">{option.trailing}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
