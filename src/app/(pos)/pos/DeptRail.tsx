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

  return (
    <nav
      aria-label="Departments"
      className="hidden w-[240px] shrink-0 flex-col border-r border-border bg-surface xl:flex"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icons.Tag size={16} className="text-muted" />
        <h2 className="text-sm font-semibold text-ink">Departments</h2>
      </div>

      {top.length === 0 ? (
        <p className="p-4 text-[13px] text-muted">
          No departments yet. Products can still be found by scanning or searching.
        </p>
      ) : (
        <div className="till-pane flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
          {top.map((d) => (
            <TouchRow
              key={d.id}
              tone={activeId === d.id ? 'active' : 'default'}
              icon={<CategoryTile icon={<Icons.Tag size={18} />} tone={toneForId(d.id)} size="lg" />}
              title={d.name}
              showChevron={false}
              onClick={() => onPick(d.id)}
            />
          ))}
        </div>
      )}
    </nav>
  )
}
