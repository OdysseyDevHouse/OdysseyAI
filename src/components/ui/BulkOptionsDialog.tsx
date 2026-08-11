'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import { Input } from './Field'
import { Search } from './icons'

/**
 * The catalogue of bulk actions, shown as a dialog.
 *
 * Lists with more than a handful of bulk actions cannot put them all in the
 * selection bar: products alone has twenty-odd, and a bar that wide either
 * wraps into three rows of buttons or hides everything real behind "More".
 * Both make the user hunt. A dialog gives every action the same weight, a
 * label wide enough to read, and room to group them by what they touch.
 *
 * Deliberately dumb: it renders actions and reports which one was picked. The
 * list owns what those actions mean, which modal opens next, and what counts
 * as recently used — so customers, suppliers and products share this screen
 * without sharing anything about their fields.
 */

export type BulkOption<K extends string = string> = {
  /** Identifies the action to the caller — usually the BulkChange kind. */
  key: K
  label: string
  icon?: ReactNode
  /**
   * Destructive actions render in danger tone, matching the old system where
   * "Delete products" was the one red row in the grid.
   */
  tone?: 'default' | 'danger'
  /** Extra words that should match the filter without crowding the label. */
  keywords?: string
}

export type BulkOptionGroup<K extends string = string> = {
  title: string
  options: readonly BulkOption<K>[]
}

export function BulkOptionsDialog<K extends string>({
  open,
  onClose,
  onPick,
  groups,
  count,
  noun,
  recent = [],
}: {
  open: boolean
  onClose: () => void
  /** Fired with the chosen key. The caller closes this and opens its own modal. */
  onPick: (key: K) => void
  groups: readonly BulkOptionGroup<K>[]
  /** How many rows are selected — echoed so the user cannot misread the scope. */
  count: number
  /** What is selected, singular. "product" gives "2 products selected". */
  noun: string
  /**
   * Keys to surface at the top, most recent first. The caller persists these;
   * a shop that only ever changes departments should not scroll past twenty
   * actions to reach it.
   */
  recent?: readonly K[]
}) {
  const [filter, setFilter] = useState('')

  const query = filter.trim().toLowerCase()

  /** Every option, flattened — used to resolve the recent keys to options. */
  const all = useMemo(() => groups.flatMap((group) => group.options), [groups])

  const matches = (option: BulkOption<K>) =>
    !query ||
    option.label.toLowerCase().includes(query) ||
    (option.keywords?.toLowerCase().includes(query) ?? false)

  const visibleGroups = groups
    .map((group) => ({ ...group, options: group.options.filter(matches) }))
    .filter((group) => group.options.length > 0)

  // Recent is hidden while filtering: a search should show one flat set of
  // results, not the same action twice under two headings.
  const recentOptions = query
    ? []
    : recent.map((key) => all.find((option) => option.key === key)).filter((o): o is BulkOption<K> => !!o)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk options"
      description={`${count} ${noun}${count === 1 ? '' : 's'} selected`}
      /* Wider than a form dialog: three columns of action names need the room,
         and at lg the longest ("Change pack weight description") clips. */
      size="xl"
      /* The footer's Close is the only way out besides Escape — the body
         scrolls at 60vh and a button below the fold cannot be found. */
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          icon={<Search size={16} />}
          placeholder="Type to filter actions…"
          aria-label="Filter actions"
        />

        {recentOptions.length > 0 && (
          <OptionGroup title="Recently used" options={recentOptions} onPick={onPick} />
        )}

        {visibleGroups.map((group) => (
          <OptionGroup key={group.title} title={group.title} options={group.options} onPick={onPick} />
        ))}

        {visibleGroups.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">
            No action matches “{filter.trim()}”.
          </p>
        )}
      </div>
    </Modal>
  )
}

function OptionGroup<K extends string>({
  title,
  options,
  onPick,
}: {
  title: string
  options: readonly BulkOption<K>[]
  onPick: (key: K) => void
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {/* Three columns so twenty actions read as one scannable block rather
          than a twenty-row list. Collapses on narrow viewports. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((option) => (
          <OptionButton key={option.key} option={option} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

const TONE_CLASS: Record<'default' | 'danger', string> = {
  default: 'border-border text-ink hover:border-brand hover:bg-brand-soft',
  danger: 'border-danger/40 text-danger hover:border-danger hover:bg-danger-soft',
}

const ICON_TONE_CLASS: Record<'default' | 'danger', string> = {
  default: 'text-muted',
  danger: 'text-danger',
}

function OptionButton<K extends string>({
  option,
  onPick,
}: {
  option: BulkOption<K>
  onPick: (key: K) => void
}) {
  const tone = option.tone ?? 'default'
  return (
    /* Not a kit Button: this is a full-width tile with a leading icon and a
       left-aligned label, which no Button variant expresses — and adding a
       "tile" variant would be a variant used in exactly one place. */
    <button
      type="button"
      data-kit-ok
      onClick={() => onPick(option.key)}
      className={`flex h-control items-center gap-2.5 rounded-control border bg-surface px-3 text-left text-sm transition outline-none focus-visible:border-brand ${TONE_CLASS[tone]}`}
    >
      {option.icon && (
        <span className={`shrink-0 ${ICON_TONE_CLASS[tone]}`}>{option.icon}</span>
      )}
      <span className="truncate">{option.label}</span>
    </button>
  )
}
