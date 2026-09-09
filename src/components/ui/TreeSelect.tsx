'use client'

import Link from 'next/link'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CategoryTile, type CategoryTone } from './CategoryTile'
import { useFieldWiring } from './Field'
import { TileGlyph } from './TileGlyph'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Tag } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * A filter whose choices form a TREE, browsed one level at a time.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Departments nest to any depth, and the native <select> this replaces could
 * only say so by flattening: forty entries reading "Drinks > Beer > Imported",
 * every one of them opening with the same two words, in a control 176px wide
 * that truncated the only part that differed. A shop with three top-level
 * departments had to read the whole list to find that out.
 *
 * Here the first panel is the top level — three rows, not forty — and a branch
 * opens on its own chevron. What a person scans is always the handful of
 * choices at one level, and the path they took is the way back.
 *
 * ── WHAT THE ROW AND THE CHEVRON DO ───────────────────────────────────────
 *
 * Two different things, deliberately. The ROW picks that branch — filtering to
 * "Beer" means Beer and everything under it, which is what someone reaching for
 * a parent almost always wants, and it stays one click away. The CHEVRON drills
 * in. A menu where clicking a parent could only descend makes the common case
 * the longer one; a menu with no drill-in is the flat list again.
 *
 * They are siblings rather than nested — a button inside a button is invalid
 * HTML and the inner one never fires — so the highlight lives on the wrapper
 * and both halves sit inside it.
 *
 * ── LINKS OR STATE ────────────────────────────────────────────────────────
 *
 * An option carrying `href` navigates, because list screens keep their filters
 * in the URL — that is what makes a filtered list linkable, reloadable and
 * server-rendered. One without calls `onChange`, for the dialogs whose filters
 * are React state. Options carry their own href rather than the control taking
 * an `hrefFor` function, because a Server Component cannot pass a function
 * across the boundary.
 */
export type TreeSelectOption = {
  value: string
  /** This level's name alone — "Imported", not "Drinks > Beer > Imported". */
  label: string
  /** The value of the option this one sits under; null or absent = top level. */
  parent?: string | null
  /** Identity colour for the row's tile. See toneForId / toneForTileToken. */
  tone?: CategoryTone
  /** A picture for the tile — the department's own, where one is uploaded. */
  image?: string | null
  /** Drawn in the tile when there is no picture. Defaults to the tag glyph. */
  icon?: ReactNode
  /** Shown right-aligned — how many records sit under this branch. */
  count?: number
  /** Where picking it goes, for a filter that lives in the URL. */
  href?: string
}

export function TreeSelect({
  options,
  value,
  onChange,
  icon,
  backLabel = 'Back',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: {
  /**
   * Every option at every level, in the order each level should read — the
   * component groups them by `parent` and never re-sorts, so a shop's own
   * arrangement of its departments survives into the menu.
   *
   * Include the "everything" entry as a top-level option with an empty value;
   * it is an ordinary row that happens to clear the filter.
   */
  options: readonly TreeSelectOption[]
  value: string
  /** Called for options with no `href`. Not called by the ones that navigate. */
  onChange?: (value: string) => void
  /** The trigger's leading glyph — the subject, e.g. a grid for departments. */
  icon?: ReactNode
  /** Header on a drilled-in panel: "Back to departments". */
  backLabel?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  /* Wired to a surrounding <Field> like every other control, so its label
     points at this trigger rather than at nothing. */
  const wiring = useFieldWiring()
  /* The branch being browsed, outermost first. Empty = the top level. */
  const [path, setPath] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const byParent = useMemo(() => {
    const map = new Map<string | null, TreeSelectOption[]>()
    for (const option of options) {
      const parent = option.parent ?? null
      const siblings = map.get(parent)
      if (siblings) siblings.push(option)
      else map.set(parent, [option])
    }
    return map
  }, [options])

  const byValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options])

  const selected = byValue.get(value)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /* Reopening lands where the current filter IS, not back at the top: a shop
     working through "Drinks > Beer" reaches for this control repeatedly, and a
     menu that forgot the branch every time would charge them the descent again
     on every visit. */
  function toggle() {
    if (!open) setPath(selected ? ancestorsOf(selected, byValue) : [])
    setOpen(!open)
  }

  function choose(option: TreeSelectOption) {
    setOpen(false)
    /* Nothing else to do for an option that navigates — its row IS a link, and
       pushing the same href here as well put the filter into history twice, so
       Back appeared not to work on the first press. */
    if (!option.href) onChange?.(option.value)
  }

  const level = path.length === 0 ? null : path[path.length - 1]
  const rows = byParent.get(level) ?? []
  const parentOption = level === null ? undefined : byValue.get(level)
  const grandparent = path.length > 1 ? byValue.get(path[path.length - 2]) : undefined

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={wiring.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggle}
        /* The full path as a tooltip: the label is one level's name, which is
           all that fits, and "Imported" alone does not say imported what. */
        title={selected ? pathLabel(selected, byValue) : undefined}
        className={`${CONTROL} ${CONTROL_H} flex cursor-pointer items-center gap-2 text-left ${
          /* Open wears the same single brand edge as a focused field — this is
             a control being operated, and it should look like one. */
          open ? 'border-brand shadow-[inset_0_0_0_1px_var(--color-brand)]' : ''
        }`}
      >
        {icon && (
          <span
            aria-hidden
            /* Brand while the filter is ON or the menu is open, muted at rest:
               the icon is what says "this list is narrowed" across a toolbar of
               otherwise identical-looking pickers. */
            className={`shrink-0 ${open || value ? 'text-brand' : 'text-muted'}`}
          >
            {icon}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-faint'}`}>
          {selected?.label ?? ''}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          className="absolute left-0 z-20 mt-1.5 w-72 min-w-full rounded-control border border-border bg-surface p-1 shadow-pop"
        >
          {parentOption && (
            <>
              {/* Outside the scroller, so the way back is on screen however far
                  down a long level someone has read. */}
              <button
                type="button"
                onClick={() => setPath((current) => current.slice(0, -1))}
                className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                <ArrowLeft size={14} className="shrink-0" />
                {grandparent ? `Back to ${grandparent.label}` : backLabel}
              </button>
              <div role="separator" className="my-1 border-t border-border" />
            </>
          )}

          {/* A CEILING, and the level scrolls past it: a catalogue can put forty
              departments on one level, and a panel drawn to fit them all runs
              below the fold with its last rows unreachable. */}
          <div role="menu" className="max-h-80 overflow-y-auto overscroll-contain">
            {rows.map((option) => (
              <TreeRow
                key={option.value}
                option={option}
                selected={option.value === value}
                hasChildren={(byParent.get(option.value)?.length ?? 0) > 0}
                onChoose={() => choose(option)}
                onDrill={() => setPath((current) => [...current, option.value])}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TreeRow({
  option,
  selected,
  hasChildren,
  onChoose,
  onDrill,
}: {
  option: TreeSelectOption
  selected: boolean
  hasChildren: boolean
  onChoose: () => void
  onDrill: () => void
}) {
  const body = (
    <>
      <CategoryTile
        size="sm"
        tone={option.tone}
        icon={<TileGlyph src={option.image ?? null} fallback={option.icon ?? <Tag size={16} />} />}
      />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.count !== undefined && (
        <span className="numeric shrink-0 text-xs text-muted">{option.count}</span>
      )}
      {selected && <Check size={16} className="shrink-0 text-brand" />}
    </>
  )

  const pickClass = 'flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-sm'

  return (
    <div
      /* Presentational, so the two halves below stay children of the menu:
         ARIA does not allow a plain div between a menu and its items. */
      role="presentation"
      className={`flex items-center rounded-[6px] transition ${
        selected ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2'
      }`}
    >
      {option.href ? (
        /* A real anchor, so a filtered list can be opened in a new tab the way
           every other filter link on these screens can. */
        <Link href={option.href} role="menuitem" onClick={onChoose} className={pickClass}>
          {body}
        </Link>
      ) : (
        <button type="button" role="menuitem" onClick={onChoose} className={pickClass}>
          {body}
        </button>
      )}

      {hasChildren && (
        <button
          type="button"
          role="menuitem"
          aria-label={`Show what is inside ${option.label}`}
          onClick={onDrill}
          className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-[6px] text-faint transition hover:bg-brand-soft hover:text-brand"
        >
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  )
}

/** The chain of ancestors above an option, outermost first. */
function ancestorsOf(option: TreeSelectOption, byValue: Map<string, TreeSelectOption>): string[] {
  const chain: string[] = []
  let parent = option.parent ?? null
  /* Guarded by a seen set rather than trusted: the tree comes from a
     self-referencing table, and a row pointing at its own descendant would
     otherwise spin here forever. */
  const seen = new Set<string>()
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent)
    chain.unshift(parent)
    parent = byValue.get(parent)?.parent ?? null
  }
  return chain
}

/** "Drinks › Beer › Imported" — the tooltip on a trigger showing one name. */
function pathLabel(option: TreeSelectOption, byValue: Map<string, TreeSelectOption>): string {
  const names = ancestorsOf(option, byValue).map((value) => byValue.get(value)?.label ?? '')
  return [...names, option.label].filter(Boolean).join(' › ')
}
