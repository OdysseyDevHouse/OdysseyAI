'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  TileGrid,
  toneForId,
  toneForTileToken,
  useToast,
} from '@/components/ui'
import {
  createMenuDepartmentAction,
  moveAndOrderProductsAction,
  moveDepartmentAction,
  moveProductsAction,
  reorderDepartmentsAction,
  reorderProductsAction,
  setDepartmentVisibleAction,
  setProductsVisibleAction,
  updateDepartmentTileAction,
  updateProductTileAction,
  type MenuActionResult,
  type MenuPayload,
} from './actions'
import { BackTile, DepartmentTile, DragOverlayCards, ProductTile, TILE_H } from './tiles'
import { NewDepartmentModal } from './NewDepartmentModal'
import { TileEditorModal, type EditorTarget } from './TileEditorModal'
import { UnassignedTray } from './UnassignedTray'
import {
  byMenuOrder,
  childrenOf,
  descendantsOf,
  type Department,
  type DragData,
  type DropData,
  type DropZone,
  type MenuProduct,
  type OverState,
} from './types'

/**
 * The menu designer: the till's browse menu, arranged by dragging it.
 *
 * ── THE GESTURE ────────────────────────────────────────────────────────────
 *
 *   product onto the EDGE of a product   → reorder, caret shows where
 *   product onto a DEPARTMENT            → file it in there
 *   product onto the tray                → take it off the menu
 *   department onto a DEPARTMENT's middle→ nest it inside
 *   department onto Back / a crumb       → promote it to that level
 *   hold a drag over a folder            → it springs open, keep dragging
 *
 * One drag, decided by where the tile sits over the target. The alternative — a
 * mode switch, or a right-click menu — makes the common act (reorder) cost the
 * same as the rare one (re-parent), and a shop reorders far more than it nests.
 *
 * ── DEPTH IS NOT CAPPED ────────────────────────────────────────────────────
 *
 * Departments are an arbitrary-depth tree here (`parent_id`), so there is no
 * level at which a branch becomes illegal. Nothing is ever "too deep" to nest,
 * and there is correspondingly no merge-and-confirm step: a drop either happens
 * or is refused for a reason the server can name.
 *
 * ── OPTIMISTIC, THEN RECONCILED ────────────────────────────────────────────
 *
 * A drag paints instantly and the action returns the whole fresh menu, which
 * replaces state wholesale. Positions are renumbered server-side, so a local
 * guess at the new order would drift from what the till draws — and the drift
 * would only show up on the next reload. See actions.ts.
 */

/** Hold a drag over a folder, Back or a crumb this long to spring it open. */
const SPRING_MS = 700

/**
 * How many product tiles one department draws before the rest are held back.
 *
 * Not a design preference — a real catalogue puts twenty THOUSAND products in a
 * department, and a grid that renders them all is a browser that stops
 * answering. Every tile is a drag source and a drop target, so the cost is
 * dnd-kit measuring 20,000 rects on every move, not merely the DOM.
 *
 * The cap is on what is DRAWN, never on what is loaded: the order sent to the
 * server is always the department's full list, so tiles beyond the cap keep
 * their positions instead of being silently renumbered to the end. "Show more"
 * raises it, and the count says plainly what is not on screen — a cap nobody
 * can see is a screen quietly lying about what it holds.
 */
const GRID_PAGE = 200

const dragDataOf = (bag: Record<string, unknown> | undefined) =>
  (bag as { drag?: DragData } | undefined)?.drag
const dropDataOf = (bag: Record<string, unknown> | undefined) =>
  (bag as { drop?: DropData } | undefined)?.drop

/**
 * Where the dragged TILE sits over a target, 0..1 across its width.
 *
 * Judged by the tile's own centre rather than the pointer, so the gesture does
 * not depend on where the tile happened to be grabbed — and so it still works
 * for a drag with no pointer at all.
 */
function relativeX(e: DragMoveEvent | DragOverEvent): number {
  const rect = e.over?.rect
  const dragged = e.active.rect.current.translated
  if (!rect || !dragged) return 0.5
  const centre = dragged.left + dragged.width / 2
  return Math.min(1, Math.max(0, (centre - rect.left) / rect.width))
}

/** Removes `moving` from `list`, then re-inserts it around `target`. */
function insertAround<T>(
  list: T[],
  moving: T[],
  target: T,
  side: 'before' | 'after',
): T[] | null {
  const movingSet = new Set(moving)
  const rest = list.filter((item) => !movingSet.has(item))
  let index = rest.indexOf(target)
  if (index === -1) return null
  if (side === 'after') index += 1
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)]
}

interface ActiveDrag {
  kind: 'product' | 'department'
  /** Product ids, or the single department id. */
  ids: number[]
  fromTray: boolean
}

export function MenuDesigner({
  initialMenu,
  canEdit,
}: {
  initialMenu: MenuPayload
  canEdit: boolean
}) {
  const toast = useToast()
  const [menu, setMenu] = useState(initialMenu)
  const [saving, setSaving] = useState(0)

  const departments = menu.departments
  const products = menu.products

  /* ── navigation ──────────────────────────────────────────────────────── */

  /**
   * The browsing path as department IDS rather than objects, so it survives a
   * menu replacing itself after every save — an object path would go stale on
   * each round trip and the screen would jump back to the root mid-arrangement.
   */
  const [pathIds, setPathIds] = useState<number[]>([])

  const path = useMemo(() => {
    const byId = new Map(departments.map((d) => [d.id, d]))
    const out: Department[] = []
    for (const id of pathIds) {
      const found = byId.get(id)
      // A department deleted elsewhere truncates the path rather than blanking
      // the screen.
      if (!found) break
      out.push(found)
    }
    return out
  }, [departments, pathIds])

  const current = path.length ? path[path.length - 1] : null
  const children = useMemo(
    () => childrenOf(departments, current?.id ?? null),
    [departments, current],
  )

  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)

  /** How many product tiles this level is currently drawing (see GRID_PAGE). */
  const [gridLimit, setGridLimit] = useState(GRID_PAGE)

  const navigate = useCallback((ids: number[]) => {
    setPathIds(ids)
    setSelection(new Set())
    setAnchor(null)
    // Each level starts from the cap again — walking into a department should
    // never inherit a limit raised somewhere else.
    setGridLimit(GRID_PAGE)
  }, [])

  /* ── derived indexes ─────────────────────────────────────────────────── */

  /** Products filed DIRECTLY under each department, in menu order. */
  const byDepartment = useMemo(() => {
    const map = new Map<number | null, MenuProduct[]>()
    for (const p of products) {
      const list = map.get(p.departmentId)
      if (list) list.push(p)
      else map.set(p.departmentId, [p])
    }
    for (const list of map.values()) list.sort(byMenuOrder)
    return map
  }, [products])

  const gridProducts = useMemo(
    () => (current ? (byDepartment.get(current.id) ?? []) : []),
    [byDepartment, current],
  )
  const unassigned = useMemo(() => byDepartment.get(null) ?? [], [byDepartment])

  /**
   * Products under a department INCLUDING its whole subtree, so a folder can
   * say what is inside it rather than only what sits at its own level.
   */
  const deepCount = useCallback(
    (id: number) => {
      const family = descendantsOf(departments, id)
      let n = 0
      for (const p of products) if (p.departmentId !== null && family.has(p.departmentId)) n += 1
      return n
    },
    [departments, products],
  )

  /* ── writes ──────────────────────────────────────────────────────────── */

  /**
   * Runs an action with the menu already painted optimistically.
   *
   * The server's fresh menu replaces the optimistic one on success; on refusal
   * the previous menu goes back, so the canvas never keeps a state the server
   * rejected. Same shape as DepartmentsClient's `run`.
   */
  const run = useCallback(
    async (
      optimistic: (menu: MenuPayload) => MenuPayload,
      action: () => Promise<MenuActionResult>,
    ) => {
      const previous = menu
      setMenu(optimistic)
      setSaving((n) => n + 1)
      try {
        const result = await action()
        if (!result.ok) {
          setMenu(previous)
          toast.error(result.error)
          return false
        }
        setMenu(result.menu)
        return true
      } catch {
        setMenu(previous)
        toast.error('That did not work.')
        return false
      } finally {
        setSaving((n) => n - 1)
      }
    },
    [menu, toast],
  )

  /** Optimistically files products into a department (or the tray). */
  const paintMove = useCallback(
    (ids: number[], departmentId: number | null) => (m: MenuPayload): MenuPayload => {
      const moving = new Set(ids)
      const top = m.products
        .filter((p) => p.departmentId === departmentId)
        .reduce((max, p) => Math.max(max, p.posSortOrder), 0)
      let next = top
      return {
        ...m,
        products: m.products.map((p) => {
          if (!moving.has(p.id)) return p
          next = departmentId === null ? 0 : next + 1
          return {
            ...p,
            departmentId,
            posSortOrder: next,
            // Mirrors what moveProductsAction does server-side.
            visibleInPos: departmentId === null ? p.visibleInPos : true,
          }
        }),
      }
    },
    [],
  )

  /** Optimistically renumbers one department's products. */
  const paintOrder = useCallback(
    (departmentId: number, orderedIds: number[]) => (m: MenuPayload): MenuPayload => {
      const position = new Map(orderedIds.map((id, i) => [id, i + 1]))
      return {
        ...m,
        products: m.products.map((p) =>
          position.has(p.id)
            ? { ...p, departmentId, posSortOrder: position.get(p.id)!, visibleInPos: true }
            : p,
        ),
      }
    },
    [],
  )

  /* ── selection ───────────────────────────────────────────────────────── */

  const handleProductClick = useCallback(
    (e: MouseEvent, id: number, visual: number[]) => {
      e.stopPropagation()
      if (e.ctrlKey || e.metaKey) {
        setSelection((sel) => {
          const next = new Set(sel)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setAnchor(id)
      } else if (e.shiftKey && anchor !== null && visual.includes(anchor)) {
        const a = visual.indexOf(anchor)
        const b = visual.indexOf(id)
        if (b === -1) return
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelection(new Set(visual.slice(lo, hi + 1)))
      } else {
        setSelection(new Set([id]))
        setAnchor(id)
      }
    },
    [anchor],
  )

  /* ── modals ──────────────────────────────────────────────────────────── */

  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [creating, setCreating] = useState(false)

  const editorProduct =
    editor?.kind === 'product' ? (products.find((p) => p.id === editor.id) ?? null) : null
  const editorDepartment =
    editor?.kind === 'department' ? (departments.find((d) => d.id === editor.id) ?? null) : null

  /* ── drag state ──────────────────────────────────────────────────────── */

  const [active, setActive] = useState<ActiveDrag | null>(null)
  const [over, setOver] = useState<OverState | null>(null)
  const activeRef = useRef<ActiveDrag | null>(null)
  const overRef = useRef<OverState | null>(null)
  const spring = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const [springingId, setSpringingId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    /* Long-press first, so the canvas can still be SCROLLED with a finger on the
       tablet a manager is likely holding — and so a tap still opens a folder
       rather than starting a drag nobody wanted. */
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const clearSpring = useCallback(() => {
    if (spring.current) {
      clearTimeout(spring.current.timer)
      spring.current = null
    }
    setSpringingId(null)
  }, [])

  // A spring timer outliving the component would fire navigate() into a
  // unmounted tree.
  useEffect(() => () => clearSpring(), [clearSpring])

  const setOverState = useCallback((next: OverState | null) => {
    overRef.current = next
    setOver(next)
  }, [])

  /**
   * Whatever the dragged TILE overlaps most, ignoring itself.
   *
   * Rect-based first because it reads far smoother while sliding across a grid
   * than a pointer test does; `pointerWithin` is the fallback for the case
   * where the tile's rect clips nothing but the cursor is over a target.
   */
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const dragged = activeRef.current
    const excluded = new Set<string>()
    if (dragged?.kind === 'product') {
      for (const id of dragged.ids) {
        excluded.add(`product-${id}`)
        excluded.add(`tray-${id}`)
      }
    } else if (dragged?.kind === 'department') {
      for (const id of dragged.ids) excluded.add(`department-${id}`)
    }

    const containers = args.droppableContainers.filter((c) => !excluded.has(String(c.id)))
    const overlapping = rectIntersection({ ...args, droppableContainers: containers })
    if (overlapping.length > 0) return overlapping
    return pointerWithin({ ...args, droppableContainers: containers })
  }, [])

  /** May `id` be re-parented under `parentId`? */
  const canReparent = useCallback(
    (id: number, parentId: number | null): boolean => {
      const node = departments.find((d) => d.id === id)
      if (!node) return false
      if (node.parentId === parentId) return false
      if (parentId === null) return true
      // Into itself or its own subtree would detach the branch entirely.
      return !descendantsOf(departments, id).has(parentId)
    },
    [departments],
  )

  function handleDragStart(e: DragStartEvent) {
    const data = dragDataOf(e.active.data.current)
    if (!data) return

    let next: ActiveDrag
    if (data.kind === 'product') {
      let ids: number[]
      if (selection.has(data.productId) && selection.size > 0) {
        // Kept in visual order so a multi-drag lands in the order it was
        // picked up in, not in id order.
        const source = data.fromTray ? unassigned : gridProducts
        ids = source.map((p) => p.id).filter((id) => selection.has(id))
        if (ids.length === 0) ids = [data.productId]
      } else {
        ids = [data.productId]
        setSelection(new Set([data.productId]))
        setAnchor(data.productId)
      }
      next = { kind: 'product', ids, fromTray: data.fromTray }
    } else {
      next = { kind: 'department', ids: [data.departmentId], fromTray: false }
    }

    activeRef.current = next
    setActive(next)
    setOverState(null)
  }

  /** What a release over `drop` would mean, or null for "nothing". */
  function zoneFor(drop: DropData, dragged: ActiveDrag, xRel: number): DropZone | null {
    if (dragged.kind === 'department') {
      const id = dragged.ids[0]
      if (drop.kind === 'department-tile') {
        const nests = canReparent(id, drop.departmentId)
        const isSibling = children.some((c) => c.id === id)
        // Among on-screen siblings the edges reorder and the middle nests;
        // after a spring navigation only nesting is on offer.
        if (isSibling) {
          if (!nests) return xRel < 0.5 ? 'before' : 'after'
          return xRel < 0.3 ? 'before' : xRel > 0.7 ? 'after' : 'onto'
        }
        return nests ? 'onto' : null
      }
      if (drop.kind === 'back') {
        const parent = path.length >= 2 ? path[path.length - 2].id : null
        return path.length >= 1 && canReparent(id, parent) ? 'onto' : null
      }
      if (drop.kind === 'crumb') {
        const parent = drop.index >= 0 ? (path[drop.index]?.id ?? null) : null
        return canReparent(id, parent) ? 'onto' : null
      }
      if (drop.kind === 'level') {
        return canReparent(id, current?.id ?? null) ? 'onto' : null
      }
      return null
    }

    switch (drop.kind) {
      case 'product-tile':
        // Products only ever reorder against each other. Grouping two products
        // into a department is the "New department" button's job, not a drag's:
        // a folder that appears mid-drag with a name nobody chose is worse than
        // the two clicks it saves.
        return xRel < 0.5 ? 'before' : 'after'
      case 'department-tile':
      case 'back':
      case 'crumb':
      case 'tray':
      case 'level':
        return 'onto'
    }
  }

  /**
   * Wired to BOTH onDragMove and onDragOver.
   *
   * dnd-kit reports a change of target as a separate DragOver AFTER its
   * collision pass, so with the pointer held still — resting on Back just after
   * a spring navigation, say — nothing else would fire and the intent would go
   * stale exactly when it matters.
   */
  function handleDragMove(e: DragMoveEvent | DragOverEvent) {
    const dragged = activeRef.current
    if (!dragged) return

    const overId = e.over ? String(e.over.id) : null
    const drop = dropDataOf(e.over?.data.current)
    if (!overId || !drop) {
      setOverState(null)
      clearSpring()
      return
    }

    const xRel = relativeX(e)
    const zone = zoneFor(drop, dragged, xRel)

    // The indicator only shows where a release would actually do something.
    if (zone) {
      const prev = overRef.current
      if (!prev || prev.id !== overId || prev.zone !== zone) setOverState({ id: overId, zone })
    } else {
      setOverState(null)
    }

    /* Spring-loaded navigation is a SEPARATE question from whether the drop
       would land. Holding a top-level department over Back is a no-op as a
       drop, but it still has to travel there so it can be released on the strip
       at that level. */
    let springable = false
    if (drop.kind === 'back' || drop.kind === 'crumb') {
      springable = dragged.kind === 'department' || zone === 'onto'
    } else if (drop.kind === 'department-tile') {
      if (dragged.kind === 'product') {
        springable = zone === 'onto'
      } else {
        // Middle only — the edges mean reorder — and never into its own subtree.
        const own = descendantsOf(departments, dragged.ids[0])
        springable = !own.has(drop.departmentId) && xRel >= 0.3 && xRel <= 0.7
      }
    }

    if (!springable) {
      clearSpring()
      return
    }
    if (spring.current?.id === overId) return

    clearSpring()
    const timer = setTimeout(() => {
      setSpringingId(null)
      spring.current = null
      // The selection is deliberately NOT cleared here (as navigate() would):
      // the selection IS the drag in flight, and dropping it on arrival is the
      // whole point of springing a folder open.
      setGridLimit(GRID_PAGE)
      if (drop.kind === 'department-tile') {
        setPathIds((ids) => [...ids, drop.departmentId])
      } else if (drop.kind === 'back') {
        setPathIds((ids) => ids.slice(0, -1))
      } else if (drop.kind === 'crumb') {
        setPathIds((ids) => (drop.index < 0 ? [] : ids.slice(0, drop.index + 1)))
      }
      setOverState(null)
    }, SPRING_MS)
    spring.current = { id: overId, timer }
    setSpringingId(overId)
  }

  function resetDrag() {
    activeRef.current = null
    setActive(null)
    setOverState(null)
    clearSpring()
  }

  async function handleDragEnd(e: DragEndEvent) {
    const dragged = activeRef.current
    const landing = overRef.current
    const drop = dropDataOf(e.over?.data.current)
    resetDrag()
    if (!dragged || !landing || !drop) return

    /* ---- a department: nest, promote, or reorder ---- */
    if (dragged.kind === 'department') {
      const id = dragged.ids[0]
      const node = departments.find((d) => d.id === id)
      if (!node) return

      if (landing.zone === 'onto') {
        let parentId: number | null
        if (drop.kind === 'department-tile') parentId = drop.departmentId
        else if (drop.kind === 'back') parentId = path.length >= 2 ? path[path.length - 2].id : null
        else if (drop.kind === 'crumb') parentId = drop.index >= 0 ? (path[drop.index]?.id ?? null) : null
        else if (drop.kind === 'level') parentId = current?.id ?? null
        else return

        if (!canReparent(id, parentId)) return
        await run(
          (m) => ({
            ...m,
            departments: m.departments.map((d) => (d.id === id ? { ...d, parentId } : d)),
          }),
          () => moveDepartmentAction(id, parentId),
        )
        return
      }

      if (drop.kind !== 'department-tile') return
      const target = departments.find((d) => d.id === drop.departmentId)
      if (!target) return

      const ordered = insertAround(children, [node], target, landing.zone)
      if (!ordered) return
      const orderById = new Map(ordered.map((d, i) => [d.id, i + 1]))
      await run(
        (m) => ({
          ...m,
          departments: m.departments.map((d) =>
            orderById.has(d.id) ? { ...d, sortOrder: orderById.get(d.id)! } : d,
          ),
        }),
        () => reorderDepartmentsAction(ordered.map((d) => d.id)),
      )
      return
    }

    /* ---- products ---- */
    const ids = dragged.ids

    if (drop.kind === 'product-tile') {
      // Only canvas tiles are droppable, so this is always a grid reorder —
      // either in place, or in from the tray in one gesture.
      if (landing.zone === 'onto' || !current) return
      const target = gridProducts.find((p) => p.id === drop.productId)
      if (!target) return

      if (dragged.fromTray) {
        const moving = products.filter((p) => ids.includes(p.id))
        const visual = insertAround([...gridProducts, ...moving], moving, target, landing.zone)
        if (!visual) return
        const orderedIds = visual.map((p) => p.id)
        await run(
          (m) => paintOrder(current.id, orderedIds)(paintMove(ids, current.id)(m)),
          () => moveAndOrderProductsAction(ids, current.id, orderedIds),
        )
      } else {
        const moving = gridProducts.filter((p) => ids.includes(p.id))
        const visual = insertAround(gridProducts, moving, target, landing.zone)
        if (!visual) return
        const orderedIds = visual.map((p) => p.id)
        await run(
          paintOrder(current.id, orderedIds),
          () => reorderProductsAction(current.id, orderedIds),
        )
      }
      setSelection(new Set())
      return
    }

    /** Where a non-reorder product drop files them, or undefined for "nowhere". */
    let destination: number | null | undefined
    if (drop.kind === 'department-tile') destination = drop.departmentId
    else if (drop.kind === 'back') destination = path.length >= 2 ? path[path.length - 2].id : null
    else if (drop.kind === 'crumb') destination = drop.index >= 0 ? (path[drop.index]?.id ?? null) : null
    else if (drop.kind === 'tray') destination = dragged.fromTray ? undefined : null
    else if (drop.kind === 'level') destination = current ? current.id : undefined

    if (destination === undefined) return
    // Dropping onto Back from the top level would mean "no department" — that
    // is the tray's job, and doing it here would be a surprise.
    if (destination === null && drop.kind === 'back' && path.length < 2) return

    await run(paintMove(ids, destination), () => moveProductsAction(ids, destination))
    setSelection(new Set())
  }

  /* ── the drop strip ──────────────────────────────────────────────────── */

  /**
   * "File it right here" for the level being browsed — the release point after
   * spring-navigating into a department, where there may be no tile to aim at.
   * Null when a release here would do nothing, and the strip does not mount.
   */
  const levelDropLabel = useMemo(() => {
    if (!active) return null

    if (active.kind === 'department') {
      const node = departments.find((d) => d.id === active.ids[0])
      if (!node || !canReparent(node.id, current?.id ?? null)) return null
      return current
        ? `Drop here to put “${node.name}” inside “${current.name}”`
        : `Drop here to make “${node.name}” a top-level department`
    }

    if (!current) return null
    const allHere = active.ids.every(
      (id) => products.find((p) => p.id === id)?.departmentId === current.id,
    )
    if (allHere) return null
    const n = active.ids.length
    return `Drop here to move ${n === 1 ? 'this product' : `these ${n} products`} into “${current.name}”`
  }, [active, current, departments, products, canReparent])

  /* ── overlay ─────────────────────────────────────────────────────────── */

  const overlayItems = useMemo(() => {
    if (!active) return []
    // Toned by the same rules the tiles use, so the chip under the cursor is
    // the tile that was picked up rather than a grey stand-in for it.
    if (active.kind === 'department') {
      const node = departments.find((d) => d.id === active.ids[0])
      return node
        ? [
            {
              key: `d-${node.id}`,
              label: node.name,
              tone: toneForTileToken(node.color) ?? toneForId(node.id),
              isDepartment: true,
            },
          ]
        : []
    }
    const byId = new Map(products.map((p) => [p.id, p]))
    return active.ids.slice(0, 3).map((id) => {
      const p = byId.get(id)
      return {
        key: `p-${id}`,
        label: p?.description ?? String(id),
        tone: p
          ? (toneForTileToken(p.imageColor) ?? toneForId(p.departmentId ?? p.id))
          : toneForId(id),
        isDepartment: false,
      }
    })
  }, [active, departments, products])

  /* ── keyboard ────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The modals own their own Escape.
      if (e.key === 'Escape' && !editor && !creating) {
        setSelection(new Set())
        setAnchor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, creating])

  /* ── render ──────────────────────────────────────────────────────────── */

  /* Only these are drawn. `gridProducts` stays the full list everywhere else —
     the reorder maths and the drop handlers must see the whole department, or
     a tile past the cap would be renumbered to the end by a drag it was never
     part of. */
  const gridShown = useMemo(() => gridProducts.slice(0, gridLimit), [gridProducts, gridLimit])
  const gridHidden = gridProducts.length - gridShown.length

  const gridVisual = useMemo(() => gridShown.map((p) => p.id), [gridShown])
  const activeIds = useMemo(
    () => new Set(active?.kind === 'product' ? active.ids : []),
    [active],
  )
  const trayReceiving = over?.id === 'tray' && active?.kind === 'product' && !active.fromTray
  const emptyLevel = children.length === 0 && gridProducts.length === 0

  return (
    <DndContext
      /* Fixed id: dnd-kit derives its aria ids from a module counter the server
         restarts at 0, so an unnamed context is a hydration mismatch on every
         load. The quick-key canvas documents this at length. */
      id="menu-designer"
      sensors={sensors}
      collisionDetection={collisionDetection}
      /* Re-measured continuously: springing a folder open swaps the whole grid
         mid-drag, and stale rects would land the drop against the old layout. */
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
    >
      <div className="flex flex-col gap-4">
        {/* ── breadcrumbs: navigation, and drop targets while dragging ── */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Crumb
            index={-1}
            label="Departments"
            isLast={path.length === 0}
            /* Stays a target even where the drop is a no-op, so a held drag can
               still spring-navigate out to the top level. */
            droppable={active?.kind === 'department' && path.length > 0}
            receiving={over?.id === 'crumb--1'}
            springing={springingId === 'crumb--1'}
            onClick={() => navigate([])}
          />
          {path.map((node, i) => (
            <span key={node.id} className="flex items-center gap-2">
              <Icons.ChevronRight size={14} aria-hidden />
              <Crumb
                index={i}
                label={node.name}
                isLast={i === path.length - 1}
                droppable={i < path.length - 1 && active !== null}
                receiving={over?.id === `crumb-${i}`}
                springing={springingId === `crumb-${i}`}
                onClick={() => navigate(pathIds.slice(0, i + 1))}
              />
            </span>
          ))}

          <span className="ml-auto flex items-center gap-2">
            {selection.size > 1 && (
              <span className="flex items-center gap-2 text-sm text-ink">
                <Badge tone="brand">{selection.size}</Badge>
                selected
                <Button variant="ghost" size="sm" onClick={() => setSelection(new Set())}>
                  Clear
                </Button>
              </span>
            )}
            {saving > 0 && (
              <span className="flex items-center gap-1.5 text-sm text-muted">
                <Icons.Spinner size={14} className="animate-spin" />
                Saving…
              </span>
            )}
            {canEdit && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Icons.Plus size={15} />
                {current ? 'New sub-department' : 'New department'}
              </Button>
            )}
          </span>
        </div>

        {/* ── the canvas ── */}
        <Card>
          <div
            className="p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelection(new Set())
                setAnchor(null)
              }
            }}
          >
            {emptyLevel && path.length === 0 ? (
              <EmptyState
                icon={<Icons.LayoutGrid size={22} />}
                title="No departments yet"
                hint="Make a department, then drag products into it from the tray below. What you arrange here is what a cashier sees on the till."
                action={
                  canEdit ? (
                    <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                      <Icons.Plus size={14} />
                      New department
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <TileGrid tileWidth={168} tileHeight={TILE_H}>
                {path.length > 0 && (
                  <BackTile
                    label={path.length > 1 ? path[path.length - 2].name : 'All departments'}
                    receiving={
                      over?.id === 'back' && (active?.kind === 'department' || path.length >= 2)
                    }
                    springing={springingId === 'back'}
                    onClick={() => navigate(pathIds.slice(0, -1))}
                  />
                )}

                {children.map((d) => {
                  const sections = childrenOf(departments, d.id).length
                  const items = deepCount(d.id)
                  const id = `department-${d.id}`
                  return (
                    <DepartmentTile
                      key={id}
                      department={d}
                      dragId={id}
                      detail={
                        sections
                          ? `${sections} section${sections === 1 ? '' : 's'} · ${items} product${items === 1 ? '' : 's'}`
                          : `${items} product${items === 1 ? '' : 's'}`
                      }
                      zone={over?.id === id ? over.zone : null}
                      dimmed={active?.kind === 'department' && active.ids.includes(d.id)}
                      springing={springingId === id}
                      canEdit={canEdit}
                      onOpen={() => navigate([...pathIds, d.id])}
                      onEdit={() => setEditor({ kind: 'department', id: d.id })}
                      onToggleVisible={(on) =>
                        run(
                          (m) => ({
                            ...m,
                            departments: m.departments.map((x) =>
                              x.id === d.id ? { ...x, isActive: on } : x,
                            ),
                          }),
                          () => setDepartmentVisibleAction(d.id, on),
                        )
                      }
                    />
                  )
                })}

                {gridShown.map((p) => {
                  const id = `product-${p.id}`
                  return (
                    <ProductTile
                      key={id}
                      product={p}
                      dragId={id}
                      fromTray={false}
                      selected={selection.has(p.id)}
                      dimmed={activeIds.has(p.id)}
                      zone={over?.id === id ? over.zone : null}
                      canEdit={canEdit}
                      onClick={(e) => handleProductClick(e, p.id, gridVisual)}
                      onEdit={() => setEditor({ kind: 'product', id: p.id })}
                      onToggleVisible={(on) =>
                        run(
                          (m) => ({
                            ...m,
                            products: m.products.map((x) =>
                              x.id === p.id ? { ...x, visibleInPos: on } : x,
                            ),
                          }),
                          () => setProductsVisibleAction([p.id], on),
                        )
                      }
                    />
                  )
                })}
              </TileGrid>
            )}

            {/* Says what is not on screen rather than truncating quietly — a
                department that draws 200 of its 20,000 products and says nothing is a
                screen lying about what it holds.

                Outside the grid: its rows are a fixed tile height now, and a notice
                sitting in one would be clipped to 116px. */}
            {!emptyLevel && gridHidden > 0 && (
              <div className="mt-4 flex items-center justify-center gap-3 rounded-card border border-dashed border-border px-4 py-3 text-sm text-muted">
                <span>
                  Showing {gridShown.length.toLocaleString()} of{' '}
                  {gridProducts.length.toLocaleString()} products here.
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setGridLimit((l) => l + GRID_PAGE)}
                >
                  Show {Math.min(GRID_PAGE, gridHidden).toLocaleString()} more
                </Button>
              </div>
            )}

            {emptyLevel && (
              <div className="mt-4">
                <EmptyLevel label={levelDropLabel} receiving={over?.id === 'level'} />
              </div>
            )}
          </div>
        </Card>

        {/* The strip only mounts while a drag could be filed here — and never
            alongside the empty-level panel, which carries the same droppable id
            and must only be mounted once. */}
        {levelDropLabel && !emptyLevel && (
          <LevelDropStrip label={levelDropLabel} receiving={over?.id === 'level'} />
        )}

        <UnassignedTray
          products={unassigned}
          selection={selection}
          activeIds={activeIds}
          receiving={!!trayReceiving}
          canEdit={canEdit}
          onProductClick={handleProductClick}
          onEdit={(id) => setEditor({ kind: 'product', id })}
          onToggleVisible={(id, on) =>
            run(
              (m) => ({
                ...m,
                products: m.products.map((x) => (x.id === id ? { ...x, visibleInPos: on } : x)),
              }),
              () => setProductsVisibleAction([id], on),
            )
          }
        />
      </div>

      {/* Keyed off the live drag, never the selection: DragOverlay portals a
          floating element at the cursor, so leaving it mounted for a merely
          selected tile parks an invisible chip over the canvas that swallows
          every click after it. */}
      <DragOverlay dropAnimation={null}>
        {active && overlayItems.length > 0 ? (
          <DragOverlayCards items={overlayItems} count={active.ids.length} />
        ) : null}
      </DragOverlay>

      <NewDepartmentModal
        open={creating}
        parentName={current?.name ?? null}
        onClose={() => setCreating(false)}
        onCreate={async (input) => {
          const ok = await run(
            (m) => m,
            () =>
              createMenuDepartmentAction({
                name: input.name,
                parentId: current?.id ?? null,
                color: input.color,
              }),
          )
          if (ok) {
            setCreating(false)
            toast.success(`Created “${input.name}” — drag products into it.`)
          }
          return ok
        }}
      />

      <TileEditorModal
        product={editorProduct}
        department={editorDepartment}
        canEdit={canEdit}
        onClose={() => setEditor(null)}
        onRename={(name) => {
          if (editorProduct) {
            const id = editorProduct.id
            void run(
              (m) => ({
                ...m,
                products: m.products.map((x) => (x.id === id ? { ...x, description: name } : x)),
              }),
              () => updateProductTileAction(id, { description: name }),
            )
          } else if (editorDepartment) {
            const id = editorDepartment.id
            void run(
              (m) => ({
                ...m,
                departments: m.departments.map((x) => (x.id === id ? { ...x, name } : x)),
              }),
              () => updateDepartmentTileAction(id, { name }),
            )
          }
        }}
        onRecolor={(token) => {
          if (editorProduct) {
            const id = editorProduct.id
            void run(
              (m) => ({
                ...m,
                products: m.products.map((x) => (x.id === id ? { ...x, imageColor: token } : x)),
              }),
              () => updateProductTileAction(id, { imageColor: token }),
            )
          } else if (editorDepartment) {
            const id = editorDepartment.id
            void run(
              (m) => ({
                ...m,
                departments: m.departments.map((x) => (x.id === id ? { ...x, color: token } : x)),
              }),
              () => updateDepartmentTileAction(id, { color: token }),
            )
          }
        }}
        onToggleVisible={(on) => {
          if (editorProduct) {
            const id = editorProduct.id
            void run(
              (m) => ({
                ...m,
                products: m.products.map((x) => (x.id === id ? { ...x, visibleInPos: on } : x)),
              }),
              () => setProductsVisibleAction([id], on),
            )
          } else if (editorDepartment) {
            const id = editorDepartment.id
            void run(
              (m) => ({
                ...m,
                departments: m.departments.map((x) => (x.id === id ? { ...x, isActive: on } : x)),
              }),
              () => setDepartmentVisibleAction(id, on),
            )
          }
        }}
      />
    </DndContext>
  )
}

/* ── the level drop strip ─────────────────────────────────────────────────── */

function LevelDropStrip({ label, receiving }: { label: string; receiving: boolean }) {
  const { setNodeRef } = useDroppable({
    id: 'level',
    data: { drop: { kind: 'level' } satisfies DropData },
  })
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center justify-center gap-2 rounded-card border-2 border-dashed px-4 py-3 text-sm font-medium transition ${
        receiving ? 'border-brand bg-brand-soft text-brand-ink' : 'border-border bg-surface-2 text-muted'
      }`}
    >
      <Icons.Download size={15} aria-hidden />
      {label}
    </div>
  )
}

/* ── the empty level (also the "level" drop target) ───────────────────────── */

function EmptyLevel({ label, receiving }: { label: string | null; receiving: boolean }) {
  const { setNodeRef } = useDroppable({
    id: 'level',
    data: { drop: { kind: 'level' } satisfies DropData },
    disabled: !label,
  })
  return (
    <div
      ref={setNodeRef}
      className={`rounded-card border-2 border-dashed transition ${
        receiving ? 'border-brand bg-brand-soft' : 'border-border'
      }`}
    >
      <EmptyState
        icon={<Icons.Download size={22} />}
        title={label ?? 'Nothing in here yet'}
        hint={
          label
            ? undefined
            : 'Drag products in from the tray below, or drop a department here to nest it.'
        }
      />
    </div>
  )
}

/* ── one breadcrumb ───────────────────────────────────────────────────────── */

function Crumb({
  index,
  label,
  isLast,
  droppable,
  receiving,
  springing,
  onClick,
}: {
  index: number
  label: string
  isLast: boolean
  droppable: boolean
  receiving: boolean
  springing: boolean
  onClick: () => void
}) {
  const { setNodeRef } = useDroppable({
    id: `crumb-${index}`,
    data: { drop: { kind: 'crumb', index } satisfies DropData },
    disabled: !droppable,
  })

  if (isLast) {
    return (
      <span ref={setNodeRef} className="font-semibold text-ink">
        {label}
      </span>
    )
  }

  return (
    <span ref={setNodeRef} className={receiving || springing ? 'rounded-control ring-2 ring-brand' : ''}>
      <Button variant="bare" size="sm" onClick={onClick}>
        {label}
      </Button>
    </span>
  )
}
