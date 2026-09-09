'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search, Spinner } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * A picker that LOOKS like a dropdown and SEARCHES like a Combobox.
 *
 * ── WHY THIS EXISTS ALONGSIDE COMBOBOX ────────────────────────────────────
 *
 * Combobox is the till's control: you land in it, type or scan, take the first
 * match. Its box is a search box and reads as one, which is right when typing
 * is the whole job.
 *
 * It is wrong when the job starts with "what are my choices?". A bare text box
 * offering no visible affordance to open looks like a filter over a list that
 * is not there yet — nothing says a list exists until a key is pressed. So the
 * screens where someone is CHOOSING FROM a known set get a closed control with
 * a chevron, and the search appears inside the panel it opens, above the rows.
 * Both halves are then true at once: the list announces itself, and a long one
 * is still narrowed by typing rather than scrolled.
 *
 * ── THE TRIGGER IS NOT AN INPUT ───────────────────────────────────────────
 *
 * It is a <button> wearing the field skin, exactly as TreeSelect's is. Two
 * things follow from that and both are wanted: it cannot be typed into while
 * closed (there is one search box, in the panel, and no question about which
 * one is live), and it can show a chosen LABEL rather than the query that found
 * it — a Combobox that cleared on select can only ever show a placeholder.
 *
 * ── THE PANEL MEASURES ITS ROOM ───────────────────────────────────────────
 *
 * The list is positioned inside the control, so a picker in a Modal body —
 * which stops at 60vh — has its rows cut off at the body's edge rather than at
 * their own max-height, and the pane scrolls the whole form instead of the
 * list. Same fix Combobox and the product picker needed: cap the rows to the
 * room actually left below, measured on open.
 *
 * The caller owns the options and the filtering, so the same control serves an
 * in-memory list of fields and a server-searched one. Pass `query` /
 * `onQueryChange` to own it, or leave them off and the panel filters the
 * options it was given on its own.
 */
export type SearchSelectOption<T = unknown> = {
  /** Stable id. Also what `onSelect` gets back. */
  value: string
  label: string
  /** Second line — a section, a code, a barcode. */
  hint?: string
  /** Right-aligned, e.g. a count or a price. */
  trailing?: ReactNode
  disabled?: boolean
  data?: T
}

export function SearchSelect<T>({
  options,
  value,
  onSelect,
  query,
  onQueryChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Type to filter…',
  emptyText = 'No matches',
  loading = false,
  disabled = false,
  clearOnSelect = false,
  icon,
  id,
  ariaLabel,
  className = '',
  menuClassName = '',
}: {
  options: readonly SearchSelectOption<T>[]
  /** The chosen option's value — what the closed trigger names. */
  value?: string
  onSelect: (option: SearchSelectOption<T>) => void
  /**
   * The search text. Pass it (with `onQueryChange`) when the caller does the
   * filtering — a server search, or a match over fields this control cannot
   * see. Leave both off and the panel filters `options` itself.
   */
  query?: string
  onQueryChange?: (next: string) => void
  /** What the CLOSED trigger reads when nothing is picked. */
  placeholder?: string
  /** What the panel's search box reads when it is empty. */
  searchPlaceholder?: string
  emptyText?: string
  loading?: boolean
  disabled?: boolean
  /** True where picking is an action rather than a choice — "add a condition". */
  clearOnSelect?: boolean
  /** Leading glyph in the trigger, brand-tinted while open or chosen. */
  icon?: ReactNode
  id?: string
  ariaLabel?: string
  className?: string
  menuClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  /* Only used when the caller does not own the query. Kept unconditionally
     because hooks cannot be called conditionally, and it costs nothing. */
  const [ownQuery, setOwnQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const generatedId = useId()
  const triggerId = id ?? generatedId

  const controlled = query !== undefined
  const text = controlled ? query : ownQuery
  const setText = (next: string) => {
    if (!controlled) setOwnQuery(next)
    onQueryChange?.(next)
  }

  /* A controlled query means the CALLER already filtered — filtering again here
     would apply the same match twice and, worse, would hide rows a server
     search matched on something this control cannot see (a barcode, a code). */
  const needle = text.trim().toLowerCase()
  const shown =
    controlled || !needle
      ? options
      : options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            (o.hint || '').toLowerCase().includes(needle),
        )

  const selectable = shown.filter((o) => !o.disabled)
  const chosen = options.find((o) => o.value === value)

  // A new result set invalidates the old highlight.
  useEffect(() => setActive(0), [shown.length, text])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  /* Opening puts the caret in the search box, because the entire reason to
     open this rather than a Select is to type. */
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  /* How tall the rows may be, and which way the panel opens. See the note at
     the top. `up` is not a nicety: this control's first caller sits at the
     BOTTOM of its dialog — it is the "add another" row, under everything
     already added — so the room below it is a sliver by construction, and a
     downward panel spilled 61px of rows over the page behind the dialog. */
  const [room, setRoom] = useState<{ height: number; up: boolean } | null>(null)

  useEffect(() => {
    if (!open) {
      setRoom(null)
      return
    }

    function measure() {
      const root = rootRef.current
      if (!root) return

      /* The nearest SCROLLING ancestor, else the viewport.
         Deliberately not the dialog: a Modal opened with `bodyOverflows` is
         `overflow-visible` exactly so a picker's panel can paint past its edge
         — the advanced filter's dialog sizes to its content, so it can be
         254px tall with 64px above the trigger and 22px below, and a panel
         held inside those bounds is a two-row sliver. Painting over the
         backdrop is what that flag is for. A SCROLLING ancestor is different:
         there the overflow is genuinely cut off, and the rows below the fold
         become unreachable because the pane scrolls the form, not the list. */
      let lower = window.innerHeight
      let upper = 0
      for (let el = root.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el)
        if (overflowY === 'auto' || overflowY === 'scroll') {
          const box = el.getBoundingClientRect()
          lower = Math.min(lower, box.bottom)
          upper = Math.max(upper, box.top)
          break
        }
      }

      /* Minus the search box the rows sit under (a control height plus its
         padding), and a hair of breathing room so the list never sits flush
         against the edge it is being kept inside. */
      const CHROME = 12 + 52
      const box = root.getBoundingClientRect()
      const below = Math.max(lower - box.bottom - CHROME, 0)
      const above = Math.max(box.top - upper - CHROME, 0)

      /* Down unless up is genuinely roomier. Biased to down — a menu that
         flips on a few pixels of difference is the more disorienting failure —
         so up has to beat it by enough to be worth the surprise. */
      setRoom(above > below + 40 ? { height: above, up: true } : { height: below, up: false })
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  function choose(option: SearchSelectOption<T>) {
    if (option.disabled) return
    onSelect(option)
    if (clearOnSelect) setText('')
    setOpen(false)
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Wrap, so holding the key walks the list rather than stopping at an end.
      setActive((current) => {
        const next = current + step
        if (next < 0) return Math.max(selectable.length - 1, 0)
        if (next >= selectable.length) return 0
        return next
      })
      return
    }

    if (event.key === 'Enter') {
      const option = selectable[active]
      if (option) {
        event.preventDefault()
        choose(option)
      }
      return
    }

    if (event.key === 'Escape') {
      /* Stopped as well as prevented: this control is often inside a Modal,
         and an Escape that closed the whole dialog on the first press would
         throw away the form behind a merely-open menu. */
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setText('')
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={triggerId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        title={chosen?.hint ? `${chosen.label} — ${chosen.hint}` : chosen?.label}
        className={`${CONTROL} ${CONTROL_H} flex cursor-pointer items-center gap-2 text-left ${
          /* Open wears the same single brand edge as a focused field — this is
             a control being operated, and it should look like one. */
          open ? 'border-brand shadow-[inset_0_0_0_1px_var(--color-brand)]' : ''
        }`}
      >
        {icon && (
          <span
            aria-hidden
            className={`shrink-0 ${open || chosen ? 'text-brand' : 'text-muted'}`}
          >
            {icon}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${chosen ? '' : 'text-faint'}`}>
          {chosen?.label ?? placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className={`absolute left-0 z-20 w-full min-w-64 rounded-control border border-border bg-surface p-1 shadow-pop ${
            room?.up ? 'bottom-full mb-1.5' : 'mt-1.5'
          } ${menuClassName}`}
        >
          {/* The search sits INSIDE the panel, above the rows, so the closed
              control stays a dropdown and the list is still narrowed by typing.
              It is not a kit <Input>: this is a menu's own filter field, sized
              to the panel's padding rather than a form's control rhythm. */}
          <div className="relative p-1">
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-faint">
              {loading ? <Spinner size={14} className="animate-spin" /> : <Search size={14} />}
            </span>
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              autoComplete="off"
              value={text}
              placeholder={searchPlaceholder}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onSearchKeyDown}
              data-kit-ok
              className="h-control-sm w-full rounded-[6px] border border-border bg-surface-2 pl-8 pr-2.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-brand focus:bg-surface"
            />
          </div>

          <ul
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            /* max-h-72 is the ceiling; the measured cap only brings it DOWN,
               and never below two rows — a list squeezed to a sliver is worse
               to use than one that overflows a little. */
            style={
              room === null ? undefined : { maxHeight: Math.min(Math.max(room.height, 96), 288) }
            }
            className="max-h-72 overflow-y-auto"
          >
            {shown.length === 0 && !loading && (
              <li className="px-3 py-2.5 text-sm text-muted">{emptyText}</li>
            )}

            {shown.map((option) => {
              const index = selectable.indexOf(option)
              const highlighted = index === active && index !== -1

              return (
                <li key={option.value} role="option" aria-selected={highlighted}>
                  <button
                    type="button"
                    disabled={option.disabled}
                    onMouseEnter={() => index !== -1 && setActive(index)}
                    onClick={() => choose(option)}
                    /* A full-width, two-line result row with a trailing figure
                       — not a kit Button, which would centre the label and lose
                       the hint line. */
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
        </div>
      )}
    </div>
  )
}
