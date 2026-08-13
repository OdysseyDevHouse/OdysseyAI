'use client'

import { Icons, TouchRow, CategoryTile, toneForId } from '@/components/ui'
import type { Department } from './types'
import { childDepartments } from './saleSelectors'

/**
 * The department rail — the middle column.
 *
 * Only TOP-LEVEL departments. Drilling happens in the catalogue pane to the
 * right, so the rail stays a fixed list a cashier learns by position rather than
 * a tree that reshuffles under their finger. That is the whole reason it is a
 * separate column instead of a collapsible tree: muscle memory.
 *
 * Colour comes from `toneForId`, never from a stored hex. Departments do have a
 * `color` column, but a component painting itself from one puts a raw colour in
 * the source, which the design system forbids — and a derived tone is stable per
 * department across every screen with no migration and no colour picker.
 */
export function DeptRail({
  departments,
  activeId,
  onPick,
}: {
  departments: Department[]
  /** The department currently drilled into, if it is a top-level one. */
  activeId: number | null
  onPick: (id: number) => void
}) {
  const top = childDepartments(departments, null)

  /* A floating card like the basket and the catalogue, and visible from `lg`
     rather than `xl`: a 1280px till is an ordinary size for a counter screen, and
     hiding the department rail there left those shops with no way to browse at
     all — only scanning and searching. */
  return (
    <nav
      aria-label="Departments"
      className="hidden w-[240px] shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card lg:flex"
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3.5">
        <Icons.Tag size={16} className="text-muted" />
        <h2 className="text-[16px] font-bold text-ink">Departments</h2>
      </div>

      {top.length === 0 ? (
        <p className="p-4 text-[13px] text-muted">
          No departments yet. Products can still be found by scanning or searching.
        </p>
      ) : (
        <div className="till-pane flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
          {top.map((d) => {
            /* One tone, read once and spent on both the edge and the disc. Two calls
               would be two chances for them to drift apart, and a row whose bar and
               disc disagree reads as a rendering fault rather than a colour code. */
            const tone = toneForId(d.id)
            return (
              <TouchRow
                key={d.id}
                tone={activeId === d.id ? 'active' : 'default'}
                edge={tone}
                icon={<CategoryTile icon={<Icons.Tag size={18} />} tone={tone} size="lg" />}
                title={d.name}
                showChevron={false}
                onClick={() => onPick(d.id)}
              />
            )
          })}
        </div>
      )}
    </nav>
  )
}
