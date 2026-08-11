'use client'

import { Fragment } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Button, Icons } from '@/components/ui'
import {
  SECTION_LABEL,
  isScheduledNow,
  sectionName,
  type HomeSection,
} from '@/lib/storefrontModel'
import { GAP_PREFIX } from './BuilderCanvas'

/**
 * The page as a list of its sections.
 *
 * ── WHY A PAGE THAT IS ALREADY VISIBLE NEEDS AN INDEX ────────────────────
 *
 * The canvas renders the real shop, which is the whole point of it — and it
 * means a twenty-section page is as long in the builder as it is for a
 * shopper. Finding "the specials row" is a scroll, reordering it across half
 * the page is a drag past everything in between, and neither is something the
 * canvas can fix without stopping being a real preview.
 *
 * So this is the other view of the same thing: every section on one screen,
 * named, with its state and a pair of arrows. It is deliberately NOT a second
 * editor — clicking one selects it in the canvas exactly as clicking the
 * section itself does, and everything else still happens over there.
 *
 * ── AND WHY THE ARROWS EXIST WHEN DRAG ALREADY WORKS ─────────────────────
 *
 * Dragging is fine over a short distance and hopeless over a long one; the
 * canvas has to scroll while the pointer is held, and the drop lands somewhere
 * approximate. Two arrows move a section one place with no aim required, and
 * they are reachable from a keyboard without entering dnd-kit's grab mode.
 *
 * ── AND WHY IT IS ALSO A SET OF DROP TARGETS ─────────────────────────────
 *
 * The same long-drag problem, from the other end. A new section from the
 * palette has to reach a spot that may be two thousand pixels down the canvas,
 * with dnd-kit auto-scrolling under a held pointer the whole way — precisely
 * the drag the arrows exist to avoid having to make.
 *
 * This list is the whole page in a few hundred pixels, right beside the
 * palette. Dropping a tile between two rows here means the same thing as
 * dropping it between those two sections on the canvas, and it is a drag of an
 * inch. Same gap ids on both sides — see `GAP_PREFIX` — so there is one notion
 * of "position 3" rather than two that could disagree.
 */
export default function Outline({
  sections,
  selected,
  placing,
  over,
  onSelect,
  onMove,
  onToggle,
}: {
  sections: HomeSection[]
  selected: string | null
  /** True while a palette tile is in flight, so the gaps show themselves. */
  placing: boolean
  over: string | null
  onSelect: (id: string) => void
  /** Move the section at `index` by `by` places. */
  onMove: (index: number, by: number) => void
  onToggle: (id: string, enabled: boolean) => void
}) {
  if (sections.length === 0) return null

  return (
    <ol className="flex flex-col gap-1">
      <OutlineGap index={0} placing={placing} over={over} />
      {sections.map((section, index) => {
        const isSelected = selected === section.id
        // Out of season is not the same as switched off, and the two want
        // different words — the canvas makes the same distinction.
        const scheduled = isScheduledNow(section)

        return (
          <Fragment key={section.id}>
          <li className="flex items-center gap-1">
            {/* Not a kit Button: this is a row with two lines of text in it and
                a selected state, and a Button variant used nowhere else would
                fight its own padding. */}
            <button
              data-kit-ok
              type="button"
              onClick={() => onSelect(section.id)}
              aria-current={isSelected}
              className={`min-w-0 flex-1 rounded-control px-2.5 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                isSelected ? 'bg-brand-soft' : 'hover:bg-surface-2'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    section.enabled && scheduled ? 'text-ink' : 'text-muted'
                  }`}
                >
                  {sectionName(section)}
                </span>
                {!section.enabled && (
                  <span className="shrink-0 text-xs text-muted">Hidden</span>
                )}
                {section.enabled && !scheduled && (
                  <span className="shrink-0 text-xs text-warning-ink">Dated</span>
                )}
              </span>
              {/* The KIND under the name, because a page can hold three rows
                  all called "Products" and the name alone would not say which
                  is the specials one. */}
              <span className="block truncate text-xs text-muted">
                {SECTION_LABEL[section.kind]}
              </span>
            </button>

            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move ${sectionName(section)} up`}
              title="Move up"
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
            >
              <Icons.ChevronUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move ${sectionName(section)} down`}
              title="Move down"
              disabled={index === sections.length - 1}
              onClick={() => onMove(index, 1)}
            >
              <Icons.ChevronDown size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={
                section.enabled
                  ? `Hide ${sectionName(section)}`
                  : `Show ${sectionName(section)}`
              }
              title={section.enabled ? 'Hide' : 'Show'}
              onClick={() => onToggle(section.id, !section.enabled)}
            >
              {section.enabled ? <Icons.Eye size={14} /> : <Icons.EyeOff size={14} />}
            </Button>
          </li>
          <OutlineGap index={index + 1} placing={placing} over={over} />
          </Fragment>
        )
      })}
    </ol>
  )
}

/**
 * The landing strip between two rows.
 *
 * Nothing at all until something is being carried — an outline laddered with
 * empty bands would be a longer list saying the same thing, and this list earns
 * its place by being short enough to take in at a glance.
 */
function OutlineGap({
  index,
  placing,
  over,
}: {
  index: number
  placing: boolean
  over: string | null
}) {
  const id = `${GAP_PREFIX}${index}`
  // Registered whatever the state, because hooks cannot be conditional — but
  // disabled unless something is actually in flight, so these never win a
  // collision test against the canvas during an ordinary section drag.
  const { setNodeRef } = useDroppable({ id, disabled: !placing })

  if (!placing) return null

  const active = over === id

  return (
    <li
      ref={setNodeRef}
      className={`flex h-7 items-center justify-center rounded-control border border-dashed text-xs font-medium transition ${
        active
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-border-strong bg-surface-2/40 text-muted'
      }`}
    >
      {active ? 'Drop it here' : 'Here'}
    </li>
  )
}
