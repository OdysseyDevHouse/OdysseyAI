'use client'

import { useMemo, useState } from 'react'
import { Checkbox, Input } from './Field'
import { Search } from './icons'

/**
 * A bordered, scrolling tick-list with its own search box — "which of these?"
 * asked of a list too long to eyeball but too short to deserve a modal picker.
 *
 * Departments and brands on a bulk reprice are the case this exists for. Both
 * were hand-rolled scrolling <label> stacks that worked fine at eight rows and
 * became a scroll-hunt at eighty, because there was no way to search them.
 *
 * NOT a Combobox: this is a multi-select where the ticked set is the answer and
 * needs to stay visible while you add to it. A combobox collapses to its input
 * after each pick, which is exactly wrong when you are choosing eleven
 * departments and want to see the eleven.
 *
 * Nothing ticked conventionally means ALL — say so in the Field's hint, since
 * an empty list cannot say it for itself.
 */
export type CheckListItem = { id: number; name: string }

export function CheckList({
  items,
  selected,
  onChange,
  /** Shown when the list itself is empty — not when a search matches nothing. */
  emptyText = 'None set up.',
  searchPlaceholder = 'Search…',
  /** Search appears once the list is long enough for it to earn its height. */
  searchFrom = 8,
  className = '',
}: {
  items: CheckListItem[]
  selected: number[]
  onChange: (next: number[]) => void
  emptyText?: string
  searchPlaceholder?: string
  searchFrom?: number
  className?: string
}) {
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items),
    [items, needle],
  )

  if (items.length === 0) {
    return <p className="text-sm text-muted">{emptyText}</p>
  }

  const searchable = items.length >= searchFrom

  return (
    /* KEPT bounded: this is a picker sitting among a form's other fields, and
       unbounded a long department list would push the rest of the form off
       screen. It grows with the display while still capping well short of the
       form around it. */
    <div
      className={`flex max-h-[26vh] min-h-36 flex-col overflow-hidden rounded-control border border-border bg-surface ${className}`}
    >
      {searchable && (
        /* shrink-0 so the box keeps its height when the list below it is long —
           a flex column crushes its children before it overflows them. */
        <div className="shrink-0 border-b border-border p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            icon={<Search size={16} />}
            quietFocus
            aria-label={searchPlaceholder}
          />
        </div>
      )}

      {/* A COLUMN, rather than each row being told to stack: Checkbox is an
          inline-flex label, so left to itself the rows run together across the
          width two and three to a line. Fixing it here beats fighting the
          child's own display from the call site. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted">Nothing matches “{query.trim()}”.</p>
        ) : (
          shown.map((item) => (
            <Checkbox
              key={item.id}
              /* `shrink-0` so a long list keeps its row height instead of being
                 crushed by the flex column above it. */
              className="shrink-0 px-1 py-1"
              label={item.name}
              checked={selected.includes(item.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
          ))
        )}
      </div>
    </div>
  )
}
