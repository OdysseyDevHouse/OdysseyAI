'use client'

import { DOC_BLOCK_CATALOG, type DocBlockKind } from '@/lib/stationery/blocks'

/**
 * The blocks a document can be built from.
 *
 * ── CLICK, THEN DRAG IT WHERE YOU WANT IT ─────────────────────────────────
 *
 * Each tile used to carry a dnd-kit drag handle as well, so a block could be
 * dragged straight from the palette onto a drop-gap. With free placement there
 * are no gaps to aim at, and dragging from a scrolling side panel onto a canvas
 * is the awkward version of a gesture that is easy once the block is on the
 * page: click adds it below whatever is already in that band, then drag it.
 *
 * That also removes the last thing on this screen that needed dnd-kit. The two
 * routes were justified before by "dragging is discoverable, clicking is
 * reliable" — with a canvas, adding and placing are separate steps and each gets
 * the gesture it is good at.
 */
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
      {offered.map((k) => {
        const def = DOC_BLOCK_CATALOG[k]
        return (
          <li key={k}>
            <button
              type="button"
              onClick={() => onAdd(k)}
              disabled={atLimit}
              className={`w-full rounded-control border border-border bg-surface px-3 py-2 text-left transition ${
                atLimit ? 'opacity-50' : 'hover:border-border-strong'
              }`}
              data-kit-ok
            >
              <span className="block text-sm text-ink">{def.label}</span>
              <span className="block text-xs text-muted">{def.hint}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
