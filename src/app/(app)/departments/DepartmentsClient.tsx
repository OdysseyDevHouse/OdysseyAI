'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  PrimaryLink,
  RowTile,
  Switch,
  SwatchPicker,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  tileClass,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import type { Department } from '@/lib/site/departments'
import {
  deleteDepartmentInlineAction,
  quickSaveDepartmentAction,
  reorderDepartmentsAction,
  setDepartmentActiveAction,
  setDepartmentColorAction,
} from './actions'

/* Indent per nesting level. Matches the 20px the old flat list used, so a tree
   that was already familiar does not appear to shift. */
const INDENT = 20

/**
 * The children of one node, in sort order.
 *
 * Deliberately a local copy rather than an import from `lib/site/departments`:
 * that module is `server-only` (it reaches the site DB), and importing even a
 * pure helper out of it drags the whole DB layer into the browser bundle — a
 * build error, and the right one. Only the TYPE crosses over, which erases.
 *
 * `sort_order` is what drag-to-reorder rewrites; name is the tie-break so rows
 * that share a position (or were created before ordering existed) still land
 * in a stable, readable order rather than shuffling between renders.
 */
function childrenOf(all: Department[], parentId: number | null): Department[] {
  return all
    .filter((d) => d.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** What the editor modal is currently doing. */
type EditorTarget =
  | { mode: 'create'; parentId: number | null; parentName?: string }
  | { mode: 'edit'; department: Department }

type Row = { department: Department; depth: number }

/**
 * The departments list: an arbitrary-depth tree the user can expand, search,
 * reorder by dragging, and recolour — without leaving the page.
 *
 * Client-side because every one of those is an interaction on a tree whose
 * shape is already fully loaded; re-fetching the page to open a branch would
 * be a round trip to reveal data the browser is holding. Writes still go
 * through server actions, and `router.refresh()` reconciles the optimistic
 * view with what was actually stored.
 */
export function DepartmentsClient({
  departments,
  pictureIds,
  canEdit,
}: {
  departments: Department[]
  /**
   * The ids whose till picture actually resolved server-side. A department
   * pointing at a picture since deleted from the library is simply absent, so
   * the row draws its colour tile rather than a broken-image glyph.
   */
  pictureIds: number[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const hasPicture = useMemo(() => new Set(pictureIds), [pictureIds])

  // The server list is the source of truth; this mirrors it so a drag or a
  // switch paints immediately and can be rolled back if the write is refused.
  const [tree, setTree] = useState(departments)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [colorFor, setColorFor] = useState<Department | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Department | null>(null)

  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)
  // Mirror of dragId for the native drag handlers: state set this render is not
  // visible to the dragover closures already captured, but a ref reads
  // synchronously — so preventDefault() fires reliably. Without it the browser
  // shows the "no-drop" cursor and never allows the drop.
  const dragIdRef = useRef<number | null>(null)

  // The server list arriving fresh (after router.refresh()) must win over the
  // optimistic mirror, or a refused write would stay on screen.
  const [seen, setSeen] = useState(departments)
  if (seen !== departments) {
    setSeen(departments)
    setTree(departments)
  }

  const searching = search.trim().length > 0

  /** Ids that match the search, plus every ancestor, so matches stay reachable. */
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null

    const byId = new Map(tree.map((d) => [d.id, d]))
    const keep = new Set<number>()

    for (const d of tree) {
      if (!d.name.toLowerCase().includes(q) && !(d.code ?? '').toLowerCase().includes(q)) continue
      keep.add(d.id)
      // Walk up so the branch leading to a match is not orphaned. Guarded
      // against a cycle so one mis-parented row cannot hang the render.
      let parent = d.parentId === null ? undefined : byId.get(d.parentId)
      const guard = new Set<number>()
      while (parent && !guard.has(parent.id)) {
        guard.add(parent.id)
        keep.add(parent.id)
        parent = parent.parentId === null ? undefined : byId.get(parent.parentId)
      }
    }
    return keep
  }, [tree, search])

  /**
   * Depth-first rows, honouring expansion. A search forces every surviving
   * branch open — a match the user cannot see is not a result.
   */
  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (parentId: number | null, depth: number) => {
      for (const d of childrenOf(tree, parentId)) {
        if (matching && !matching.has(d.id)) continue
        out.push({ department: d, depth })
        if (matching || expanded.has(d.id)) walk(d.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [tree, expanded, matching])

  const topLevelCount = childrenOf(tree, null).length

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const expandAll = () => setExpanded(new Set(tree.filter((d) => d.childCount > 0).map((d) => d.id)))

  /**
   * Runs a write with the optimistic tree already patched. On refusal the
   * previous tree is put back, so the screen never shows a state the server
   * rejected.
   */
  const run = useCallback(
    async (
      optimistic: (current: Department[]) => Department[],
      action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    ) => {
      const previous = tree
      setTree(optimistic)
      setBusy(true)
      try {
        const result = await action()
        if (!result.ok) {
          setTree(previous)
          toast.error(result.error ?? 'That did not work.')
          return false
        }
        if (result.message) toast.success(result.message)
        router.refresh()
        return true
      } catch {
        setTree(previous)
        toast.error('That did not work.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [tree, toast, router],
  )

  /* ── drag to reorder (siblings only) ──────────────────────────────────── */

  const byId = useMemo(() => new Map(tree.map((d) => [d.id, d])), [tree])

  /** A row may only drop onto a sibling — a different parent would be a move. */
  const canDropOn = (dragged: Department, target: Department) =>
    dragged.id !== target.id && dragged.parentId === target.parentId

  async function handleDrop(targetId: number) {
    const dragged = dragIdRef.current === null ? null : byId.get(dragIdRef.current)
    const target = byId.get(targetId)
    setOverId(null)
    setDragId(null)
    dragIdRef.current = null
    if (!dragged || !target || !canDropOn(dragged, target)) return

    const siblings = childrenOf(tree, dragged.parentId)
    const from = siblings.findIndex((s) => s.id === dragged.id)
    const to = siblings.findIndex((s) => s.id === target.id)
    if (from < 0 || to < 0 || from === to) return

    // Dropping ON a row means "take that row's place". Splicing the dragged
    // row out first shifts every later index down by one, so the destination
    // is computed against the SHORTENED array — otherwise a downward drag
    // lands one slot short and a 2→3 move appears to do nothing at all.
    const reordered = [...siblings]
    const [moved] = reordered.splice(from, 1)
    const insertAt = reordered.findIndex((s) => s.id === target.id)
    reordered.splice(from < to ? insertAt + 1 : insertAt, 0, moved)

    // sort_order is rewritten 1..n to match exactly what the action will store,
    // so the optimistic order and the persisted order cannot disagree.
    const orderById = new Map(reordered.map((d, i) => [d.id, i + 1]))

    await run(
      (current) =>
        current.map((d) => (orderById.has(d.id) ? { ...d, sortOrder: orderById.get(d.id)! } : d)),
      () => reorderDepartmentsAction(reordered.map((d) => d.id)),
    )
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  const newButton = (
    <PrimaryLink href="/departments/new">
      <Icons.Plus size={15} />
      New department
    </PrimaryLink>
  )

  return (
    <>
      {/* Toolbar. Roomy chrome above dense rows — see odyssey-craft. */}
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search departments…"
        />
        {tree.some((d) => d.childCount > 0) && (
          <Button
            variant="ghost"
            onClick={() => (expanded.size ? setExpanded(new Set()) : expandAll())}
            disabled={searching}
            title={searching ? 'Clear the search to collapse' : undefined}
          >
            {expanded.size ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
        {canEdit && (
          <Button
            variant="primary"
            className="ml-auto"
            onClick={() => setEditor({ mode: 'create', parentId: null })}
          >
            <Icons.Plus size={15} />
            New department
          </Button>
        )}
      </div>

      <Card>
        {tree.length === 0 ? (
          <EmptyState
            title="No departments yet"
            hint="Create a top-level department, then add sub-departments beneath it."
            action={canEdit ? newButton : undefined}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`Nothing matches “${search.trim()}”`}
            hint="Try a shorter term, or search by department code."
            action={
              <Button variant="ghost" onClick={() => setSearch('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            {/* Hand-built rather than DataTable for ONE reason: the tree indent,
                which per-row padding carries and DataTable cannot express. It
                still wears the shared table skin. */}
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  {/* The name column carries the drag handle, the disclosure,
                      the picture and the whole indent, so it is given the room
                      and every other column is sized to its content. */}
                  <th className={TABLE_TH}>Department</th>
                  {/* w-px on the narrow columns: with no width set they split the
                      table's slack and grow far wider than the control inside
                      them, which leaves each heading centred over empty space
                      rather than over its switch or swatch. Sized to content,
                      the column IS the control, so centring lands on it. The
                      name column has no cap and takes the remaining room. */}
                  <th className={`${TABLE_TH} w-px whitespace-nowrap text-right`}>Products</th>
                  <th className={`${TABLE_TH} w-px whitespace-nowrap text-center`}>Visible</th>
                  <th className={`${TABLE_TH} w-px whitespace-nowrap text-center`}>Colour</th>
                  <th className={`${TABLE_TH} w-px text-right`}>
                    {busy ? 'Saving…' : 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ department: d, depth }) => (
                  <DepartmentRow
                    key={d.id}
                    department={d}
                    depth={depth}
                    pictureId={
                      d.posImageId !== null && hasPicture.has(d.posImageId) ? d.posImageId : null
                    }
                    canEdit={canEdit}
                    expanded={searching || expanded.has(d.id)}
                    draggable={canEdit && !searching}
                    isDragging={dragId === d.id}
                    isDragOver={overId === d.id && dragId !== d.id}
                    onToggle={() => toggle(d.id)}
                    onAddChild={() => {
                      setExpanded((p) => new Set(p).add(d.id))
                      setEditor({ mode: 'create', parentId: d.id, parentName: d.name })
                    }}
                    onEdit={() => setEditor({ mode: 'edit', department: d })}
                    onDelete={() => setConfirmDelete(d)}
                    onOpenColor={() => setColorFor(d)}
                    onToggleActive={(next) =>
                      run(
                        (current) =>
                          current.map((x) => (x.id === d.id ? { ...x, isActive: next } : x)),
                        () => setDepartmentActiveAction(d.id, next),
                      )
                    }
                    onDragStart={(e) => {
                      dragIdRef.current = d.id
                      setDragId(d.id)
                      // Firefox will not start a drag without data on the transfer.
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(d.id))
                    }}
                    onDragOver={(e) => {
                      const dragged =
                        dragIdRef.current === null ? null : byId.get(dragIdRef.current)
                      if (dragged && canDropOn(dragged, d)) {
                        // Must preventDefault on EVERY dragover or the drop is refused.
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (overId !== d.id) setOverId(d.id)
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      void handleDrop(d.id)
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null
                      setDragId(null)
                      setOverId(null)
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-sm text-muted">
        {searching
          ? `${rows.length} matching ${rows.length === 1 ? 'department' : 'departments'}`
          : `${topLevelCount} top-level ${topLevelCount === 1 ? 'department' : 'departments'}, ${tree.length} in total`}
      </p>

      <ColorModal
        department={colorFor}
        onClose={() => setColorFor(null)}
        onPick={(color) => {
          const target = colorFor
          setColorFor(null)
          if (!target) return
          void run(
            (current) => current.map((x) => (x.id === target.id ? { ...x, color } : x)),
            () => setDepartmentColorAction(target.id, color),
          )
        }}
      />

      <EditorModal
        target={editor}
        busy={busy}
        onClose={() => setEditor(null)}
        onSave={async (values) => {
          const ok = await run(
            (current) =>
              editor?.mode === 'edit'
                ? current.map((x) =>
                    x.id === editor.department.id
                      ? { ...x, name: values.name, color: values.color }
                      : x,
                  )
                : current,
            () =>
              quickSaveDepartmentAction({
                id: editor?.mode === 'edit' ? editor.department.id : undefined,
                name: values.name,
                parentId:
                  editor?.mode === 'create'
                    ? editor.parentId
                    : (editor?.department.parentId ?? null),
                color: values.color,
              }),
          )
          if (ok) setEditor(null)
        }}
      />

      <DeleteModal
        department={confirmDelete}
        busy={busy}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete
          setConfirmDelete(null)
          if (!target) return
          void run(
            (current) => current.filter((x) => x.id !== target.id),
            () => deleteDepartmentInlineAction(target.id),
          )
        }}
      />
    </>
  )
}

/* ── one row ─────────────────────────────────────────────────────────────── */

/**
 * The word for a row's depth, as the badge beside its name.
 *
 * Top level gets nothing — a badge on every row would mark the rule rather than
 * the exception, and the leftmost column is already unambiguous. Depth 1 and 2
 * are named because that is the vocabulary shops actually use ("sub 1"); past
 * that it keeps counting rather than inventing "sub-sub-sub".
 */
function levelLabel(depth: number): string | null {
  return depth === 0 ? null : `Sub ${depth}`
}

function DepartmentRow({
  department: d,
  depth,
  pictureId,
  canEdit,
  expanded,
  draggable,
  isDragging,
  isDragOver,
  onToggle,
  onAddChild,
  onEdit,
  onDelete,
  onOpenColor,
  onToggleActive,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  department: Department
  depth: number
  /** The till picture to draw, or null to fall back to the colour tile. */
  pictureId: number | null
  canEdit: boolean
  expanded: boolean
  draggable: boolean
  isDragging: boolean
  isDragOver: boolean
  onToggle: () => void
  onAddChild: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenColor: () => void
  onToggleActive: (next: boolean) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const hasChildren = d.childCount > 0
  const level = levelLabel(depth)

  return (
    <tr
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      // A height set here rather than more padding in TABLE_TD: that constant is
      // the kit's measured 36px row (see styles.ts) and is shared by 73 tables.
      // This list carries a 34px picture, which at 36px sets the row height
      // itself and leaves the tile touching both borders — the extra room is
      // what a department list needs, not what every table needs.
      className={`group h-[53px] border-b border-border transition last:border-b-0 ${
        isDragOver ? 'bg-brand-soft' : depth > 0 ? 'bg-surface-2/40 hover:bg-surface-2' : 'hover:bg-surface-2'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <td className={`${TABLE_TD} relative`}>
        {/* data-kit-ok: the indent IS the hierarchy — computed per row, so it
            cannot be a class.

            One rule per ancestor level, each sitting in the middle of the 20px
            that level indents by. Drawn full-bleed top to bottom so consecutive
            siblings join into one unbroken line down the branch — the run of
            rows under a parent reads as a group without needing a box around
            it. They are behind the content and non-interactive, so they never
            take a click meant for the drag handle. */}
        {Array.from({ length: depth }, (_, level) => (
          <span
            key={level}
            data-kit-ok
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border"
            style={{ left: `${level * INDENT + INDENT / 2}px` }}
          />
        ))}

        {/* data-kit-ok: see above. */}
        <span
          data-kit-ok
          className="relative flex items-center gap-2"
          style={{ paddingLeft: `${depth * INDENT}px` }}
        >
          {canEdit && (
            <span
              aria-hidden
              title={draggable ? 'Drag to reorder' : 'Clear the search to reorder'}
              className={`text-faint transition-opacity ${
                draggable ? 'cursor-grab opacity-40 group-hover:opacity-100' : 'opacity-20'
              }`}
            >
              <Icons.DragHandle size={14} />
            </span>
          )}

          {/* The disclosure keeps its slot on childless rows so every name in a
              branch starts at the same x. */}
          {hasChildren ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={expanded ? `Collapse ${d.name}` : `Expand ${d.name}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? <Icons.ChevronDown size={15} /> : <Icons.ChevronRight size={15} />}
            </Button>
          ) : (
            <span aria-hidden className="size-control-sm shrink-0" />
          )}

          <DepartmentGlyph name={d.name} color={d.color} pictureId={pictureId} />

          {/* The level badge sits BEFORE the name, so the eye reads the depth on
              the way to the word rather than travelling past a name of unknown
              length to find it. */}
          {level && <Badge>{level}</Badge>}

          <a
            href={`/departments/${d.id}`}
            className={`truncate rounded-control text-sm transition hover:text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
              depth === 0 ? 'font-semibold text-ink' : 'font-medium text-ink-2'
            }`}
          >
            {d.name}
          </a>

          {hasChildren && <Badge>{d.childCount}</Badge>}

          {/* Hidden is the exception, so it is said in words on the row itself
              — the switch three columns right is the control, not the label. */}
          {!d.isActive && <Badge tone="warning">Hidden</Badge>}
        </span>
      </td>

      <td className={`${TABLE_TD} ${TABLE_NUMERIC} w-px`}>
        {d.productCount > 0 ? (
          <a
            href={`/products?department=${d.id}`}
            className="rounded-control text-brand transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {d.productCount}
          </a>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>

      <td className={`${TABLE_TD} w-px`}>
        <div className="flex justify-center">
          {canEdit ? (
            <Switch
              checked={d.isActive}
              onChange={onToggleActive}
              ariaLabel={`${d.name} is ${d.isActive ? 'visible' : 'hidden'}`}
            />
          ) : (
            <span className="text-faint">{d.isActive ? '—' : 'Hidden'}</span>
          )}
        </div>
      </td>

      <td className={`${TABLE_TD} w-px`}>
        <div className="flex justify-center">
          <ColourSwatchButton name={d.name} color={d.color} disabled={!canEdit} onClick={onOpenColor} />
        </div>
      </td>

      <td className={`${TABLE_TD} w-px`}>
        {/*
          These stay visible rather than revealing on hover.

          "Add Sub N" is the action this screen exists for — a shop building its
          tree does it dozens of times in a sitting — and an action you have to
          discover by hovering is one that gets done through the slower New
          Department form instead. Edit and delete follow it so the group reads
          as one set rather than one button plus two secrets.
        */}
        <div className="flex items-center justify-end gap-1">
          {canEdit && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={onAddChild}
                title={`Add a sub-department under ${d.name}`}
              >
                <Icons.Plus size={14} />
                Add {levelLabel(depth + 1)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Rename ${d.name}`}
                title="Rename"
                onClick={onEdit}
              >
                <Icons.Pencil size={14} />
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                aria-label={`Delete ${d.name}`}
                title="Delete"
                onClick={onDelete}
              >
                <Icons.Trash size={14} />
              </Button>
            </>
          )}
          <ButtonLink
            href={`/departments/${d.id}`}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Open ${d.name}`}
            title="Open full record"
          >
            <Icons.ChevronRight size={14} />
          </ButtonLink>
        </div>
      </td>
    </tr>
  )
}

/**
 * A stored colour that is a raw hex string rather than a swatch token.
 *
 * Departments predating the token palette hold values like `#c2410c` — see the
 * note in tiles.ts — and `tileClass` deliberately does not resolve them, so it
 * returns the FIRST swatch for every one of them.
 *
 * Behind initials that was survivable: the tile still read as "a colour". In a
 * bare swatch whose whole job is to show the colour, it is a lie — a shop with
 * nine differently-coloured departments sees nine identical blue squares and
 * concludes the screen is broken, which it would be. So a hex value is painted
 * as itself.
 */
function hexColour(color: string | null): string | null {
  return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : null
}

/**
 * The colour cell: the department's swatch, and the button that changes it.
 *
 * The swatch IS the value, so it is drawn rather than labelled — which is also
 * why it cannot be a kit Button: one would put its own fill over the colour it
 * exists to show.
 */
function ColourSwatchButton({
  name,
  color,
  disabled,
  onClick,
}: {
  name: string
  color: string | null
  disabled: boolean
  onClick: () => void
}) {
  const hex = hexColour(color)
  const shared =
    'size-6 rounded-control transition hover:ring-2 hover:ring-brand/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50'

  /* data-kit-ok on both arms: see the note above. The hex arm additionally
     needs an inline background, because the value comes from a database row —
     there is no class that can be written for a colour nobody authored, and
     Tailwind could not emit one anyway. */
  return hex ? (
    <button
      data-kit-ok
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Colour for ${name}`}
      title={color ? 'Change colour' : 'No colour set — click to choose one'}
      className={shared}
      style={{ backgroundColor: hex }}
    />
  ) : (
    <button
      data-kit-ok
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Colour for ${name}`}
      title={color ? 'Change colour' : 'No colour set — click to choose one'}
      className={`${shared} ${color ? tileClass(color) : 'border border-dashed border-border-strong bg-surface-2'}`}
    />
  )
}

/**
 * The leading identity mark: the department's till picture if it has one, and
 * the kit's initials tile if it has not.
 *
 * The picture is the same one that paints this department's tile at the till, so
 * the list shows what the shop floor actually sees — a wrong or missing icon
 * becomes visible here instead of only being discovered on the till. `RowTile`
 * is the fallback rather than a blank, so a row stays findable by shape.
 */
function DepartmentGlyph({
  name,
  color,
  pictureId,
}: {
  name: string
  color: string | null
  pictureId: number | null
}) {
  if (pictureId === null) return <RowTile label={name} token={color} className="size-[34px]" />

  return (
    /* data-kit-ok: a stored picture at row scale. RowTile draws initials on a
       token fill and has no image form; the box around the picture is what keeps
       a non-square upload from being stretched into one. */
    <span
      data-kit-ok
      aria-hidden
      className="flex size-[34px] shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface-2"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/storefront-images/${pictureId}`} alt="" className="size-full object-contain" />
    </span>
  )
}
/* ── modals ──────────────────────────────────────────────────────────────── */

function ColorModal({
  department,
  onClose,
  onPick,
}: {
  department: Department | null
  onClose: () => void
  onPick: (color: string | null) => void
}) {
  return (
    <Modal
      open={department !== null}
      onClose={onClose}
      title={department ? `Colour for ${department.name}` : 'Colour'}
      description="Shown on the department's tile in lists and pickers."
      size="sm"
    >
      <SwatchPicker value={department?.color ?? null} onChange={onPick} />
    </Modal>
  )
}

function EditorModal({
  target,
  busy,
  onClose,
  onSave,
}: {
  target: EditorTarget | null
  busy: boolean
  onClose: () => void
  onSave: (values: { name: string; color: string | null }) => void
}) {
  // Held in the parent of the <dialog>'s keyed body so a value survives the
  // remount, but re-seeded whenever the target changes.
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [seenTarget, setSeenTarget] = useState<EditorTarget | null>(null)

  if (seenTarget !== target) {
    setSeenTarget(target)
    setName(target?.mode === 'edit' ? target.department.name : '')
    setColor(target?.mode === 'edit' ? target.department.color : null)
  }

  const title =
    target?.mode === 'edit'
      ? `Rename ${target.department.name}`
      : target?.parentName
        ? `New sub-department under ${target.parentName}`
        : 'New top-level department'

  const trimmed = name.trim()

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={title}
      description={
        target?.mode === 'edit'
          ? 'Code, sort order and re-parenting live on the full record.'
          : 'You can set a code and sort order on the full record afterwards.'
      }
      size="sm"
      /* Holds half-typed work — a stray backdrop click must not discard it. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || trimmed.length === 0}
            onClick={() => onSave({ name: trimmed, color })}
          >
            <Icons.Save size={15} />
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed) onSave({ name: trimmed, color })
            }}
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Colour</span>
          <SwatchPicker value={color} onChange={setColor} size="sm" />
        </div>
      </div>
    </Modal>
  )
}

function DeleteModal({
  department,
  busy,
  onClose,
  onConfirm,
}: {
  department: Department | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  // Deletion is refused server-side when children or products still depend on
  // the row. Saying so up front beats letting the user click into a refusal.
  const blocked =
    department && (department.childCount > 0 || department.productCount > 0)
      ? department.childCount > 0
        ? `It still has ${department.childCount} sub-department${
            department.childCount === 1 ? '' : 's'
          }. Move or delete ${department.childCount === 1 ? 'that' : 'those'} first.`
        : `${department.productCount} product${
            department.productCount === 1 ? ' is' : 's are'
          } still assigned to it. Reassign ${
            department.productCount === 1 ? 'it' : 'them'
          } first, or switch the department off instead.`
      : null

  return (
    <Modal
      open={department !== null}
      onClose={onClose}
      title={department ? `Delete ${department.name}?` : 'Delete department'}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </>
      }
    >
      {blocked ? (
        <Callout tone="warning" title="This one cannot be deleted yet">
          {blocked}
        </Callout>
      ) : (
        'This cannot be undone.'
      )}
    </Modal>
  )
}
