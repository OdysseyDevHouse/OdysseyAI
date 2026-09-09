'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CategoryTile, type CategoryTone } from './CategoryTile'
import { Checkbox, useFieldWiring } from './Field'
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
 * opens beside it.
 *
 * ── ONE CHOICE OR SEVERAL ─────────────────────────────────────────────────
 *
 * Pass `values` (with `onChangeMany` or `hrefForValues`) and every row grows a
 * checkbox: "show me Beer and Wine" is one list, not two visits. Pass `value`
 * and it stays the single-pick menu, because the pickers that write one id
 * into a form still want exactly one.
 *
 * ── WHAT THE ROW, THE BOX AND THE CHEVRON DO ──────────────────────────────
 *
 * Three different things, deliberately. The BOX adds that branch to a growing
 * selection and leaves the menu open. The ROW picks that branch ALONE and
 * closes — the common case, still one click, and the way out of a selection
 * that has got away from you. The CHEVRON drills in, for a level too deep to
 * reach by hovering.
 *
 * They are siblings rather than nested — a button inside a button is invalid
 * HTML and the inner one never fires — so the highlight lives on the wrapper
 * and all three parts sit inside it.
 *
 * ── HOVER OPENS THE SUBS ──────────────────────────────────────────────────
 *
 * Pointing at a parent opens its children in a panel beside it, so ticking
 * across two branches costs no clicks at all. Closing is DELAYED, because the
 * pointer has to cross the gap between the row and the panel it opened, and a
 * flyout that shut the instant the row was left could never be reached. Hover
 * is an accelerator only: the chevron does the same thing on click, and on a
 * touch screen — where nothing ever hovers — that is the whole story.
 *
 * ── PICKING A PARENT MEANS THE BRANCH ─────────────────────────────────────
 *
 * Ticking "Drinks" filters to Drinks and everything under it, which is what
 * someone reaching for a parent means, and it is what the callers do with the
 * id — `descendantIds` widens it server-side. So the children of a ticked
 * parent are drawn ticked and locked: they are genuinely included, and a box
 * that could be un-ticked would promise an exclusion the URL cannot express.
 *
 * A parent with only SOME of its children ticked wears the indeterminate dash,
 * so a collapsed branch still says that something inside it is selected — the
 * thing you otherwise have to open every parent to find out.
 *
 * ── LINKS OR STATE ────────────────────────────────────────────────────────
 *
 * An option carrying `href` navigates, because list screens keep their filters
 * in the URL — that is what makes a filtered list linkable, reloadable and
 * server-rendered. One without calls `onChange`, for the dialogs whose filters
 * are React state. Options carry their own href rather than the control taking
 * an `hrefFor` function, because a Server Component cannot pass a function
 * across the boundary.
 *
 * Multi-select in the URL cannot work that way — the destination depends on
 * what is ALREADY ticked, so it is a function of the whole set, not of one
 * row. Ticks accumulate in local state and navigate ONCE, when the menu
 * closes, via `hrefForValues`. That is also the kinder behaviour: a page load
 * per checkbox would make choosing four departments four round trips, each one
 * re-rendering the list under the menu being read.
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

/**
 * How long a flyout survives the pointer leaving it. Enough to cross the gap
 * between a row and the panel it opened, short enough that a menu left behind
 * does not sit there.
 */
const HOVER_CLOSE_MS = 220

/**
 * The flyout's own top border (1px) plus its `p-1` padding (4px).
 *
 * A flyout positioned at the hovered row's offset puts its BOX there, which
 * lands its first row 5px lower than the row it belongs to — close enough to
 * look like a mistake rather than a decision. Lifting by the inset lines the
 * two rows up exactly. Keep in step with the panel's className below.
 */
const FLYOUT_INSET = 5

export function TreeSelect({
  options,
  value,
  values,
  onChange,
  onChangeMany,
  urlFilter,
  icon,
  backLabel = 'Back',
  allLabel,
  manyNoun = 'selected',
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
  /** The single-pick value. Ignored when `values` is passed. */
  value?: string
  /**
   * The picked values, which turns the menu multi-select. An empty array is a
   * filter that is off — the same thing `value=''` says.
   */
  values?: readonly string[]
  /** Called for single-pick options with no `href`. Not called by ones that navigate. */
  onChange?: (value: string) => void
  /** Called as multi-select ticks change, for a filter held in React state. */
  onChangeMany?: (values: string[]) => void
  /**
   * Where a multi-select filter living in the URL writes itself.
   *
   * DATA, not a function, for the same reason options carry their own `href`:
   * these pickers are rendered by Server Components, and a callback cannot
   * cross that boundary. The picker rewrites `param` on `href` — dropping it
   * when nothing is ticked — and navigates ONCE, when the menu closes.
   */
  urlFilter?: {
    /** The list's own address, with its other filters already on it. */
    href: string
    /** The query parameter to rewrite, e.g. `department`. */
    param: string
    /** Parameters to drop on any change — `page`, since page 7 rarely exists. */
    reset?: readonly string[]
  }
  /** The trigger's leading glyph — the subject, e.g. a grid for departments. */
  icon?: ReactNode
  /** Header on a drilled-in panel: "Back to departments". */
  backLabel?: string
  /** What the trigger reads with nothing picked. Defaults to the ''-row's label. */
  allLabel?: string
  /**
   * The plural the trigger counts past one pick — "departments" gives
   * "3 departments". A string rather than a formatting function because these
   * pickers are rendered by Server Components, which cannot pass one.
   */
  manyNoun?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  const multiple = values !== undefined
  const [open, setOpen] = useState(false)
  /* Wired to a surrounding <Field> like every other control, so its label
     points at this trigger rather than at nothing. */
  const wiring = useFieldWiring()
  /* The branch being browsed, outermost first. Empty = the top level. */
  const [path, setPath] = useState<string[]>([])
  /* The branch a flyout is showing, outermost first — a SEPARATE axis from
     `path`, because hovering is a peek that must not move the panel under the
     pointer that is doing the peeking. */
  const [hoverPath, setHoverPath] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const router = useRouter()

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

  /* The ticks, held here while the menu is open. For a URL filter this is the
     ONLY copy that moves until the menu closes, which is what lets four ticks
     cost one navigation. Re-seeded from the prop on every open, so a menu
     reopened after a Back button shows what the URL actually says. */
  const [draft, setDraft] = useState<string[]>(() => [...(values ?? [])])
  /* What the caller has already been told. Compared against on close so that
     opening and shutting a menu untouched pushes no history entry. */
  const committed = useRef<string[]>([...(values ?? [])])

  const picked = multiple ? draft : []
  const selected = multiple ? undefined : byValue.get(value ?? '')

  /* Kept in a ref so the close handler does not need them in a dependency
     list — `onChangeMany` is a new identity on every render, and `urlFilter` a
     new object literal. */
  const commitRef = useRef({ urlFilter, onChangeMany })
  commitRef.current = { urlFilter, onChangeMany }

  const commit = useCallback(
    (next: readonly string[]) => {
      /* Nothing moved — no navigation, no callback. Opening a menu and closing
         it untouched must not push a history entry, or Back stops working. */
      if (sameSet(next, committed.current)) return
      committed.current = [...next]
      const { urlFilter: url, onChangeMany: onMany } = commitRef.current
      onMany?.([...next])
      if (url) router.push(writeParam(url, next))
    },
    [router],
  )

  const close = useCallback(() => {
    setOpen(false)
    setHoverPath([])
    if (multiple) commit(draft)
  }, [multiple, commit, draft])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  /* Reopening lands where the current filter IS, not back at the top: a shop
     working through "Drinks > Beer" reaches for this control repeatedly, and a
     menu that forgot the branch every time would charge them the descent again
     on every visit. */
  function toggle() {
    if (open) {
      close()
      return
    }
    if (multiple) {
      const fresh = [...(values ?? [])]
      setDraft(fresh)
      committed.current = [...fresh]
      /* Opens where the ONE pick lives. With several ticked there is no single
         branch to return to, and the top level is the only honest answer. */
      const only = fresh.length === 1 ? byValue.get(fresh[0]) : undefined
      setPath(only ? ancestorsOf(only, byValue) : [])
    } else {
      setPath(selected ? ancestorsOf(selected, byValue) : [])
    }
    setHoverPath([])
    setOpen(true)
  }

  /* Every value that is ticked OR sits under something ticked. Walked as
     ancestors-per-option rather than descendants-per-pick, so this stays one
     pass over the tree however wide a branch is. */
  const covered = useMemo(() => {
    if (!multiple) return new Set<string>()
    const pickedSet = new Set(picked)
    const out = new Set<string>(pickedSet)
    for (const option of options) {
      if (out.has(option.value)) continue
      if (ancestorsOf(option, byValue).some((id) => pickedSet.has(id))) out.add(option.value)
    }
    return out
  }, [multiple, picked, options, byValue])

  /* Which parents show the "something inside is picked" dash — the same pass
     from the other end: every covered value marks the ancestors above it that
     are not themselves covered. */
  const partial = useMemo(() => {
    if (!multiple) return new Set<string>()
    const out = new Set<string>()
    for (const id of covered) {
      const option = byValue.get(id)
      if (!option) continue
      for (const ancestor of ancestorsOf(option, byValue)) {
        if (!covered.has(ancestor)) out.add(ancestor)
      }
    }
    return out
  }, [multiple, covered, byValue])

  function setTick(option: TreeSelectOption, ticked: boolean) {
    setDraft((current) => {
      if (!ticked) return current.filter((v) => v !== option.value)
      /* A parent absorbs its children: with Drinks ticked, "Drinks and Beer"
         is the same filter as "Drinks", and keeping both would put two chips
         on the screen for one branch. */
      const kept = current.filter((v) => {
        const other = byValue.get(v)
        return !other || !ancestorsOf(other, byValue).includes(option.value)
      })
      return [...kept, option.value]
    })
  }

  function choose(option: TreeSelectOption) {
    if (multiple) {
      /* The row alone — a reset to exactly this branch. The empty "all" row
         clears the filter, which is that same rule with an empty value. */
      const next = option.value ? [option.value] : []
      setDraft(next)
      setOpen(false)
      setHoverPath([])
      /* Committed from `next` rather than by letting close() read `draft`:
         the setter above has not applied by the time this line runs. An option
         that navigates has already said where it goes — see below. */
      if (option.href) committed.current = next
      else commit(next)
      return
    }
    setOpen(false)
    setHoverPath([])
    /* Nothing else to do for an option that navigates — its row IS a link, and
       pushing the same href here as well put the filter into history twice, so
       Back appeared not to work on the first press. */
    if (!option.href) onChange?.(option.value)
  }

  const level = path.length === 0 ? null : path[path.length - 1]
  const rows = byParent.get(level) ?? []
  const parentOption = level === null ? undefined : byValue.get(level)
  const grandparent = path.length > 1 ? byValue.get(path[path.length - 2]) : undefined

  /* The trigger's text. One name when one thing is picked — the same as the
     single-pick menu reads — and a count past that, because two or three full
     names do not fit a 192px control, and truncating them says less than the
     number does. */
  const emptyLabel = allLabel ?? byValue.get('')?.label ?? ''
  const triggerLabel = multiple
    ? picked.length === 0
      ? emptyLabel
      : picked.length === 1
        ? (byValue.get(picked[0])?.label ?? emptyLabel)
        : `${picked.length} ${manyNoun}`
    : (selected?.label ?? '')

  const isOn = multiple ? picked.length > 0 : Boolean(value)

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
           all that fits, and "Imported" alone does not say imported what. With
           several picked it lists them, since the trigger shows only a count. */
        title={
          multiple
            ? picked.length > 0
              ? picked.map((v) => pathLabelFor(v, byValue)).join(', ')
              : undefined
            : selected
              ? pathLabel(selected, byValue)
              : undefined
        }
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
            className={`shrink-0 ${open || isOn ? 'text-brand' : 'text-muted'}`}
          >
            {icon}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${isOn ? '' : 'text-faint'}`}>{triggerLabel}</span>
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
                onClick={() => {
                  setPath((current) => current.slice(0, -1))
                  setHoverPath([])
                }}
                className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                <ArrowLeft size={14} className="shrink-0" />
                {grandparent ? `Back to ${grandparent.label}` : backLabel}
              </button>
              <div role="separator" className="my-1 border-t border-border" />
            </>
          )}

          <TreeLevel
            rows={rows}
            depth={0}
            byParent={byParent}
            multiple={multiple}
            value={value ?? ''}
            covered={covered}
            partial={partial}
            picked={picked}
            hoverPath={hoverPath}
            setHoverPath={setHoverPath}
            onChoose={choose}
            onTick={setTick}
            onDrill={(next) => {
              setPath((current) => [...current, next])
              setHoverPath([])
            }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * One panel of rows, plus whatever flyout a hovered row has opened.
 *
 * Recursive, so a hover can walk down as many levels as the catalogue has
 * without this file knowing how many that is. `depth` is the level's index into
 * `hoverPath` — the one piece of shared state a nested panel needs.
 */
function TreeLevel({
  rows,
  depth,
  byParent,
  multiple,
  value,
  covered,
  partial,
  picked,
  hoverPath,
  setHoverPath,
  onChoose,
  onTick,
  onDrill,
}: {
  rows: readonly TreeSelectOption[]
  depth: number
  byParent: Map<string | null, TreeSelectOption[]>
  multiple: boolean
  value: string
  covered: Set<string>
  partial: Set<string>
  picked: readonly string[]
  hoverPath: string[]
  setHoverPath: (path: string[]) => void
  onChoose: (option: TreeSelectOption) => void
  onTick: (option: TreeSelectOption, ticked: boolean) => void
  onDrill: (value: string) => void
}) {
  /* One timer for the whole level: only one flyout is open at a time, and a
     timer per row would leave the others pending after a hand has moved on. */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /* This level's own box, to measure a hovered row against. */
  const panelRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  /* How far down to hang the flyout, so its first row sits level with the row
     that opened it. Null until something is hovered. */
  const [flyoutTop, setFlyoutTop] = useState(0)

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    [],
  )

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  function openFlyout(optionValue: string, row?: HTMLElement) {
    cancelClose()
    /* Truncated to this depth first: moving from one parent to another has to
       drop the branch the old one had open, not nest underneath it. */
    const base = hoverPath.slice(0, depth)
    setHoverPath(optionValue ? [...base, optionValue] : base)
    /* Where the flyout's first row has to line up: the hovered row's own top,
       measured against the scroller so a level scrolled halfway down still
       aims at the row under the pointer rather than at the row that WAS
       there. Measured on hover rather than derived from an index because the
       rows are not a fixed height — a wrapped name is taller. */
    if (optionValue && row && panelRef.current) {
      setFlyoutTop(row.getBoundingClientRect().top - panelRef.current.getBoundingClientRect().top)
    }
  }

  function scheduleClose() {
    cancelClose()
    closeTimer.current = setTimeout(() => setHoverPath(hoverPath.slice(0, depth)), HOVER_CLOSE_MS)
  }

  const openValue = hoverPath[depth]
  const openRows = openValue ? (byParent.get(openValue) ?? []) : []

  /* Row-aligned, but never off the bottom of the screen.
   *
   * Measured after the paint rather than predicted: the flyout's height is
   * whatever its rows come to, and the panel can sit anywhere on the page. If
   * it overflows, it lifts by exactly the overflow — so the LAST row a long
   * branch has still lands on screen, and a branch that fits is untouched and
   * stays level with its parent. Runs on every open, so scrolling the level
   * and hovering again re-measures rather than reusing a stale lift. */
  useEffect(() => {
    const el = flyoutRef.current
    if (!openValue || !el) return
    const box = el.getBoundingClientRect()
    const overflow = box.bottom - (window.innerHeight - 8)
    if (overflow > 0) setFlyoutTop((current) => current - overflow)
  }, [openValue])

  return (
    <div
      ref={panelRef}
      className="relative"
      /* Cancels a pending close for the panel a pointer has arrived in — this
         is what makes the gap between a row and its flyout crossable. */
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      {/* A CEILING, and the level scrolls past it: a catalogue can put forty
          departments on one level, and a panel drawn to fit them all runs below
          the fold with its last rows unreachable.

          `overflow-y` on a scroller also clips overflow-x, so the flyout sits
          OUTSIDE this box rather than inside it. */}
      <div role="menu" className="max-h-80 overflow-y-auto overscroll-contain">
        {rows.map((option) => {
          const children = byParent.get(option.value) ?? []
          return (
            <TreeRow
              key={option.value}
              option={option}
              multiple={multiple}
              selected={multiple ? picked.includes(option.value) : option.value === value}
              /* Ticked because an ancestor is: drawn ticked, and locked. The
                 branch IS included, and a box that could be cleared would
                 promise an exclusion the filter cannot express. */
              covered={covered.has(option.value) && !picked.includes(option.value)}
              partial={partial.has(option.value)}
              hasChildren={children.length > 0}
              flyoutOpen={openValue === option.value}
              /* Hovering a LEAF closes the open flyout rather than leaving the
                 previous branch hanging beside an unrelated row. The row
                 element comes back so the flyout can line up with it. */
              onHover={(row) => openFlyout(children.length > 0 ? option.value : '', row)}
              onChoose={() => onChoose(option)}
              onTick={(ticked) => onTick(option, ticked)}
              onDrill={() => onDrill(option.value)}
            />
          )
        })}
      </div>

      {openValue && openRows.length > 0 && (
        <div
          ref={flyoutRef}
          /* Beside the panel, and aligned to the ROW that opened it: the sub
             department starts on the same line as the department it belongs
             to, which is what makes the two read as one thought rather than as
             two lists that happen to be side by side.
             Lifted by this panel's own border and padding (FLYOUT_INSET), so
             it is the first ROW that lands level with the hovered row — not
             the box around it, which would sit 5px low.
             CLAMPED in the effect below: a row near the bottom of a long level
             would otherwise hang its flyout off the screen. */
          style={{ top: flyoutTop - FLYOUT_INSET }}
          className="absolute left-full z-10 ml-1 w-64 rounded-control border border-border bg-surface p-1 shadow-pop"
        >
          <TreeLevel
            rows={openRows}
            depth={depth + 1}
            byParent={byParent}
            multiple={multiple}
            value={value}
            covered={covered}
            partial={partial}
            picked={picked}
            hoverPath={hoverPath}
            setHoverPath={setHoverPath}
            onChoose={onChoose}
            onTick={onTick}
            onDrill={onDrill}
          />
        </div>
      )}
    </div>
  )
}

function TreeRow({
  option,
  multiple,
  selected,
  covered,
  partial,
  hasChildren,
  flyoutOpen,
  onHover,
  onChoose,
  onTick,
  onDrill,
}: {
  option: TreeSelectOption
  multiple: boolean
  selected: boolean
  covered: boolean
  partial: boolean
  hasChildren: boolean
  flyoutOpen: boolean
  onHover: (row: HTMLElement) => void
  onChoose: () => void
  onTick: (ticked: boolean) => void
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
      {!multiple && selected && <Check size={16} className="shrink-0 text-brand" />}
    </>
  )

  const pickClass = 'flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-sm'
  const on = selected || covered

  return (
    <div
      /* Presentational, so the parts below stay children of the menu: ARIA does
         not allow a plain div between a menu and its items. */
      role="presentation"
      onMouseEnter={(event) => onHover(event.currentTarget)}
      className={`flex items-center rounded-[6px] transition ${
        on || flyoutOpen ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2'
      }`}
    >
      {/* The "everything" row has no box — there is nothing to combine it with,
          and a tick beside "All departments" would read as a fourth choice
          rather than as the way to clear the other three. */}
      {multiple && option.value !== '' && (
        <span className="pl-2">
          <Checkbox
            checked={on}
            /* Locked while an ancestor is carrying it — see `covered` above. */
            disabled={covered}
            indeterminate={!on && partial}
            onChange={(event) => onTick(event.currentTarget.checked)}
            aria-label={`Include ${option.label}`}
          />
        </span>
      )}

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

/**
 * `href` with the filter's parameter rewritten to the picked values.
 *
 * Parsed rather than concatenated, so the list's OTHER filters survive: this
 * href already carries the search term, the slice and the advanced conditions,
 * and a picker that rebuilt the URL from scratch would silently drop them.
 *
 * An empty selection DROPS the key rather than writing an empty value — the
 * two mean different things elsewhere in this app (see FILTER_PARAM, where an
 * absent parameter is what lets a remembered filter come back), so a filter
 * that is off has to look absent.
 */
function writeParam(
  { href, param, reset = [] }: { href: string; param: string; reset?: readonly string[] },
  values: readonly string[],
): string {
  /* A base is required by the URL parser and thrown away by the format below —
     these hrefs are always app-relative. */
  const url = new URL(href, 'https://x.invalid')
  if (values.length > 0) url.searchParams.set(param, values.join(','))
  else url.searchParams.delete(param)
  for (const key of reset) url.searchParams.delete(key)
  return `${url.pathname}${url.search}`
}

/** Same members, order ignored — whether a selection actually moved. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((v) => set.has(v))
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

function pathLabelFor(value: string, byValue: Map<string, TreeSelectOption>): string {
  const option = byValue.get(value)
  return option ? pathLabel(option, byValue) : ''
}
