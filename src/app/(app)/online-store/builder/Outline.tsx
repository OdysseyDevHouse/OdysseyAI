'use client'

import { Button, Icons } from '@/components/ui'
import {
  SECTION_LABEL,
  isScheduledNow,
  sectionName,
  type HomeSection,
} from '@/lib/storefrontModel'

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
 */
export default function Outline({
  sections,
  selected,
  onSelect,
  onMove,
  onToggle,
}: {
  sections: HomeSection[]
  selected: string | null
  onSelect: (id: string) => void
  /** Move the section at `index` by `by` places. */
  onMove: (index: number, by: number) => void
  onToggle: (id: string, enabled: boolean) => void
}) {
  if (sections.length === 0) return null

  return (
    <ol className="flex flex-col gap-1">
      {sections.map((section, index) => {
        const isSelected = selected === section.id
        // Out of season is not the same as switched off, and the two want
        // different words — the canvas makes the same distinction.
        const scheduled = isScheduledNow(section)

        return (
          <li key={section.id} className="flex items-center gap-1">
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
        )
      })}
    </ol>
  )
}
