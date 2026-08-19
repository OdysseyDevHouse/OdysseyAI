'use client'

/**
 * What goes inside a side-by-side section.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
 *
 * The columns block shipped renderable and unfillable: `columns` is declared in
 * the catalog's `extras`, which says "this is stored and nothing here draws an
 * editor for it". A merchant could add a Side-by-side section and had no way to
 * put anything in it — a block that looks finished and does nothing.
 *
 * ── ARROWS, NOT DRAG ─────────────────────────────────────────────────────
 *
 * The canvas drags whole sections and does it well. Extending that into columns
 * means a nested `SortableContext` inside the page-level `DndContext`, which is
 * real work on the one part of the builder that currently has no problems — and
 * it would still need this panel as the keyboard-reachable path.
 *
 * So: add, reorder, remove, here. Dropping a block straight into a column on
 * the canvas is a refinement on top of a working feature rather than the only
 * way to use it. Same reasoning the menu editor gives for its own arrows.
 *
 * ── ONE WRITE, THROUGH THE SECTION ───────────────────────────────────────
 *
 * Every change hands back the whole `columns` array and the Builder patches the
 * section with it. That is what makes undo, autosave and the publish diff work
 * on a child without any of them being told columns exist — they see one
 * section changing, which is exactly what happened.
 */

import { Button, Field, Icons, Select } from '@/components/ui'
import {
  COLUMN_CHILD_KINDS,
  MAX_COLUMN_CHILDREN,
  SECTION_CATALOG,
} from '@/lib/storefront/catalog'
import type { HomeSection, SectionKind } from '@/lib/storefrontModel'

export default function ColumnEditor({
  section,
  onChange,
  makeSection,
}: {
  section: HomeSection
  /** The whole array back, for the Builder to patch onto the section. */
  onChange: (columns: HomeSection[][]) => void
  /**
   * A brand-new section of one kind.
   *
   * Passed in rather than imported, because minting an id needs the Builder's
   * own counter — two ids colliding would give two blocks one React key and
   * one drag handle.
   */
  makeSection: (kind: SectionKind) => HomeSection
}) {
  const count = section.columnCount ?? 2
  // The stored array can lag `columnCount` for as long as it takes to save, so
  // this reads what will be RENDERED rather than what happens to be stored.
  const columns: HomeSection[][] = Array.from(
    { length: count },
    (_, n) => section.columns?.[n] ?? [],
  )

  const write = (n: number, children: HomeSection[]) =>
    onChange(columns.map((c, i) => (i === n ? children : c)))

  return (
    <div className="flex flex-col gap-3">
      {columns.map((children, n) => (
        <div key={n} className="rounded-card border border-border p-3">
          <p className="mb-2 text-sm font-medium text-ink">
            {count === 2 ? (n === 0 ? 'Left' : 'Right') : `Column ${n + 1}`}
          </p>

          {children.length === 0 ? (
            <p className="mb-2 text-sm text-muted">Nothing in it yet.</p>
          ) : (
            <ul className="mb-2 flex flex-col gap-1">
              {children.map((child, i) => (
                <li
                  key={child.id}
                  className="flex items-center gap-1 rounded-control border border-border px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {/* The block's own heading when it has one, its kind when it
                        does not — an owner recognises "Delivery" faster than
                        "Info cards", and a blank title is common early on. */}
                    {child.title.trim() || SECTION_CATALOG[child.kind].label}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${child.title.trim() || SECTION_CATALOG[child.kind].label} up`}
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...children]
                      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                      write(n, next)
                    }}
                  >
                    <Icons.ChevronUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${child.title.trim() || SECTION_CATALOG[child.kind].label} down`}
                    disabled={i === children.length - 1}
                    onClick={() => {
                      const next = [...children]
                      ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
                      write(n, next)
                    }}
                  >
                    <Icons.ChevronDown size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${child.title.trim() || SECTION_CATALOG[child.kind].label}`}
                    onClick={() => write(n, children.filter((_, k) => k !== i))}
                  >
                    <Icons.Trash size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/*
            A select that adds on choosing, rather than a picker and an Add
            button. There is one decision here — which block — and splitting it
            across two controls is a second step for no second choice.

            Capped, and the control goes rather than being disabled: a column
            already holding its limit has nothing to offer, and a greyed-out
            dropdown invites a click that explains nothing.
          */}
          {children.length < MAX_COLUMN_CHILDREN ? (
            <Field label="Add a block">
              <Select
                value=""
                onChange={(e) => {
                  const kind = e.target.value as SectionKind
                  if (!kind) return
                  write(n, [...children, makeSection(kind)])
                }}
              >
                <option value="">Choose…</option>
                {COLUMN_CHILD_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {SECTION_CATALOG[kind].label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-xs text-muted">
              That is as much as fits in one column.
            </p>
          )}
        </div>
      ))}

      {/*
        Said once, at the bottom. A block inside a column is edited by clicking
        it on the canvas like any other — this panel is for what goes where, not
        for what each one says.
      */}
      <p className="text-xs text-muted">
        Click a block on the page to change what it says.
      </p>
    </div>
  )
}
