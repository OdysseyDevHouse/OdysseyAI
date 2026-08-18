'use client'

import { useDraggable } from '@dnd-kit/core'
import { Icons } from '@/components/ui'
import { DOC_BLOCK_CATALOG, type DocBlockKind } from '@/lib/stationery/blocks'

/**
 * The blocks a document can be built from.
 *
 * Drag one onto the page, or click it to add at the end. Both routes exist
 * because dragging is the discoverable gesture and clicking is the reliable
 * one — a shop owner on a laptop trackpad should not have to drag forty
 * millimetres accurately to add a dividing line.
 */

/** Marks a drag as "a NEW block", not a move. The collision strategy reads it. */
export const PALETTE_PREFIX = 'new:'

export function paletteKind(id: string | null): DocBlockKind | null {
  if (!id || !id.startsWith(PALETTE_PREFIX)) return null
  return id.slice(PALETTE_PREFIX.length) as DocBlockKind
}

function PaletteTile({
  kind,
  disabled,
  onAdd,
}: {
  kind: DocBlockKind
  disabled: boolean
  onAdd: () => void
}) {
  const def = DOC_BLOCK_CATALOG[kind]
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${PALETTE_PREFIX}${kind}`,
    disabled,
  })

  return (
    <li
      ref={setNodeRef}
      className={`rounded-control border border-border bg-surface transition ${
        isDragging ? 'opacity-40' : 'hover:border-border-strong'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {/* The handle carries the drag listeners; the row is the click target,
            so a tap adds and a pull moves. A single element doing both makes
            every click feel like a failed drag. */}
        {/* dnd-kit's `attributes` carry their own role and tabIndex, so they
            are spread FIRST and ours win — a handle labelled by the library
            reads as "draggable item", which says nothing about what it is. */}
        <span
          {...attributes}
          {...listeners}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={`Drag ${def.label} onto the page`}
          className="mt-0.5 cursor-grab text-faint hover:text-muted"
          data-kit-ok
        >
          <Icons.DragHandle aria-hidden className="h-4 w-4" />
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className="min-w-0 flex-1 text-left"
          data-kit-ok
        >
          <span className="block text-sm text-ink">{def.label}</span>
          <span className="block text-xs text-muted">{def.hint}</span>
        </button>
      </div>
    </li>
  )
}

export default function BlockPalette({
  kinds,
  used,
  atLimit,
  onAdd,
}: {
  kinds: DocBlockKind[]
  /** Kinds already on the page, so a one-per-document block is offered once. */
  used: Set<DocBlockKind>
  atLimit: boolean
  onAdd: (kind: DocBlockKind) => void
}) {
  const offered = kinds.filter((k) => DOC_BLOCK_CATALOG[k].repeatable || !used.has(k))

  if (offered.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted">
        Every block this document can use is already on the page.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {offered.map((k) => (
        <PaletteTile key={k} kind={k} disabled={atLimit} onAdd={() => onAdd(k)} />
      ))}
    </ul>
  )
}
