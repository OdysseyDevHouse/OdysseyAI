'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  NumberInput,
  SegmentedControl,
  Badge,
  FeatureGlyph,
  TableGlyph,
  useToast,
  Icons,
} from '@/components/ui'
import { FloorCanvas, placementOf, type Placement } from './FloorCanvas'
import { useFloorHistory, type Geometry, type GeometryChange } from './useFloorHistory'
import {
  SEAT_PRESETS,
  TABLE_SHAPES,
  alignTo,
  distribute,
  firstFreeSlot,
  matchSize,
  presetForSeats,
  round2,
  seatLayout,
  type AlignMode,
  type DistributeMode,
  type MatchMode,
  type Placed,
  type SeatPreset,
  type TableShape,
} from '@/lib/site/floorGeometry'
import {
  createRoomAction,
  createTableOnFloorAction,
  duplicateTablesAction,
  retireRoomAction,
  updateRoomAction,
  savePlacementsAction,
  saveFeatureAction,
  deleteFeatureAction,
} from './actions'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { FloorResult } from './actions'
import type { PosTable } from '@/lib/site/posTables'

/**
 * The floor plan, as a manager draws it.
 *
 * ── A DRAFT, THEN ONE SAVE ────────────────────────────────────────────────
 *
 * Dragging edits local state; Save writes the whole room in one transaction. A canvas
 * that persisted every nudge would turn one reorganisation into forty round trips and
 * leave a half-moved floor behind if the tab closed — and `savePlacements` exists as a
 * batch precisely so that cannot happen.
 *
 * The unsaved count is shown rather than implied. A manager who drags six tables and
 * walks away should be able to see that nothing has been written, because the canvas
 * looks identical either way.
 *
 * ── EDIT MODE IS OPT-IN ───────────────────────────────────────────────────
 *
 * The plan opens read-only, so a manager can look at their floor without nudging a table
 * out of place with a stray tap. It also settles who owns a gesture: in edit mode a drag
 * moves something, out of it a click just inspects.
 *
 * ── FEATURES SAVE IMMEDIATELY, AND TABLES DO NOT ──────────────────────────
 *
 * Deliberately inconsistent, for a reason worth stating. A wall is CREATED by pressing
 * "Add wall" — it has to exist server-side to have an id to drag, and nothing is lost by
 * writing it straight away because a wall carries no bill and no history. A TABLE already
 * exists and may have a live document on it, so moving it is an edit to a real record and
 * belongs in the batch with every other edit.
 *
 * Their POSITIONS, though, are drafted alike: dragging a wall is as exploratory as
 * dragging a table, so feature geometry lives in the same local draft and lands in the
 * same Save. Only creation and deletion are immediate.
 *
 * ── A TABLE CAN BE CREATED HERE, AND THAT IS NOT A DUPLICATE OF THE LIST ───
 *
 * The tray creates tables as well as placing them, because building a floor is one job:
 * a manager laying out twenty tables should not have to scroll up to the list, add a row,
 * and scroll back for each one. The list above remains the place to EDIT a table — area,
 * seats, description, visit type — and this creates the minimum a table needs to be drawn,
 * which is a code. Everything else can be filled in later, or never.
 *
 * The new table is created and then PLACED in one gesture, so it appears under the
 * pointer rather than in a tray the user then has to notice. Creation is immediate (like
 * a wall, for the same reason: it needs an id to be dragged) while its position joins the
 * draft, so a table added and dragged is still one Save.
 */
export default function FloorDesigner({
  rooms: initialRooms,
  tables: initialTables,
  features: initialFeatures,
  chrome = 'card',
  onExpand,
}: {
  rooms: FloorRoom[]
  tables: PosTable[]
  features: FloorFeature[]
  /**
   * Whether to draw its own Card, or render bare for a host that already has a frame.
   *
   * 'bare' is what the full-screen dialog uses: the Modal supplies the panel, the title
   * and the footer, so a Card inside it would be a second border around one thing.
   */
  chrome?: 'card' | 'bare'
  /** Shows the "Open full screen" button. Omit where there is nothing to expand into. */
  onExpand?: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [rooms, setRooms] = useState(initialRooms)
  const [tables, setTables] = useState(initialTables)
  const [serverFeatures, setServerFeatures] = useState(initialFeatures)
  const [roomId, setRoomId] = useState<number | null>(initialRooms[0]?.id ?? null)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  const [addingRoom, setAddingRoom] = useState(false)
  const [newRoom, setNewRoom] = useState({ name: '', width: 100, height: 70 })
  /** The room being renamed or resized, or null. Seeded from the room when opened. */
  const [editingRoom, setEditingRoom] = useState<{
    name: string
    width: number
    height: number
  } | null>(null)
  const [addingTable, setAddingTable] = useState(false)
  /**
   * Table ids held by Ctrl+C, waiting for Ctrl+V.
   *
   * Deliberately NOT the system clipboard. A floor plan's "copy" means "these tables",
   * which has no sensible text representation, and writing to the real clipboard would
   * also stamp on whatever the user had copied from somewhere else — a table code they
   * were about to paste into the name field, for instance.
   */
  const [clipboard, setClipboard] = useState<number[]>([])
  /** The scrolling viewport, so "show off-screen" can scroll it. */
  const viewportRef = useRef<HTMLDivElement | null>(null)

  /** The working copy of every table's placement. Only what differs is sent on Save. */
  const [draft, setDraft] = useState<Map<number, Placement>>(
    () => new Map(initialTables.map((t) => [t.id, placementOf(t)])),
  )
  /** The working copy of the furniture, for the same reason. */
  const [featureDraft, setFeatureDraft] = useState<FloorFeature[]>(initialFeatures)

  const room = rooms.find((r) => r.id === roomId) ?? null

  /**
   * Which tables have actually moved.
   *
   * Compared against the SERVER's copy rather than tracked with a dirty flag, so a table
   * dragged out and back again correctly counts as unchanged — a flag would report a
   * change that Save would then write as a no-op, and the count would lie.
   */
  const changed = useMemo(() => {
    const out: Placement[] = []
    for (const table of tables) {
      const next = draft.get(table.id)
      if (!next) continue
      const before = placementOf(table)
      if (
        next.roomId !== before.roomId ||
        next.x !== before.x ||
        next.y !== before.y ||
        next.width !== before.width ||
        next.height !== before.height ||
        next.rotation !== before.rotation ||
        next.shape !== before.shape
      ) {
        out.push(next)
      }
    }
    return out
  }, [tables, draft])

  /** Furniture whose geometry differs from what the server holds. */
  const changedFeatures = useMemo(() => {
    const byId = new Map(serverFeatures.map((f) => [f.id, f]))
    return featureDraft.filter((f) => {
      const before = byId.get(f.id)
      if (!before) return false
      return (
        f.x !== before.x ||
        f.y !== before.y ||
        f.width !== before.width ||
        f.height !== before.height ||
        f.rotation !== before.rotation
      )
    })
  }, [featureDraft, serverFeatures])

  const dirty = changed.length + changedFeatures.length

  /* ── Applying geometry ─────────────────────────────────────────────────── */

  /**
   * Write a set of geometries into the draft.
   *
   * One function for drags, nudges, tools, undo and redo alike — which is the whole
   * reason history is a geometry stack rather than per-gesture bookkeeping. A new tool
   * that only moves and resizes things becomes undoable for free.
   */
  const applyGeometries = useCallback((changes: { id: string; geo: Geometry }[]) => {
    const tableChanges = changes.filter((c) => c.id.startsWith('t'))
    const featureChanges = changes.filter((c) => c.id.startsWith('f'))

    if (tableChanges.length > 0) {
      setDraft((current) => {
        const copy = new Map(current)
        for (const c of tableChanges) {
          const id = Number(c.id.slice(1))
          const existing = copy.get(id)
          if (!existing) continue
          copy.set(id, {
            ...existing,
            x: c.geo.x,
            y: c.geo.y,
            width: c.geo.w,
            height: c.geo.h,
            rotation: c.geo.rotation,
            shape: c.geo.shape ?? existing.shape,
          })
        }
        return copy
      })
    }

    if (featureChanges.length > 0) {
      setFeatureDraft((current) =>
        current.map((f) => {
          const hit = featureChanges.find((c) => Number(c.id.slice(1)) === f.id)
          if (!hit) return f
          return {
            ...f,
            x: hit.geo.x,
            y: hit.geo.y,
            width: hit.geo.w,
            height: hit.geo.h,
            rotation: hit.geo.rotation,
          }
        }),
      )
    }
  }, [])

  const history = useFloorHistory(applyGeometries)

  /** A completed gesture: record it for undo, then apply it. */
  const commit = useCallback(
    (changes: GeometryChange[]) => {
      history.record(changes)
      applyGeometries(changes.map((c) => ({ id: c.id, geo: c.after })))
    },
    [history, applyGeometries],
  )

  /** The current geometry of anything on the plan, keyed the way the canvas keys it. */
  const geometryOf = useCallback(
    (key: string): Geometry | null => {
      if (key.startsWith('t')) {
        const placement = draft.get(Number(key.slice(1)))
        if (!placement || placement.x === null) return null
        return {
          x: placement.x ?? 0,
          y: placement.y ?? 0,
          w: placement.width,
          h: placement.height,
          rotation: placement.rotation,
          shape: placement.shape,
        }
      }
      const feature = featureDraft.find((f) => f.id === Number(key.slice(1)))
      if (!feature) return null
      return {
        x: feature.x,
        y: feature.y,
        w: feature.width,
        h: feature.height,
        rotation: feature.rotation,
      }
    },
    [draft, featureDraft],
  )

  /**
   * Nudge the selection with the arrow keys.
   *
   * The natural partner to free dragging: drag to get roughly there, then land it
   * exactly. One step is a tenth of a unit — finer than any hand can drag, and the only
   * way to place something precisely now that nothing rounds to a whole unit.
   */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!room) return
      const changes: GeometryChange[] = []
      for (const key of selectedKeys) {
        const before = geometryOf(key)
        if (!before) continue
        const x = round2(Math.min(Math.max(0, before.x + dx), room.width - before.w))
        const y = round2(Math.min(Math.max(0, before.y + dy), room.height - before.h))
        changes.push({ id: key, before, after: { ...before, x, y } })
      }
      commit(changes)
    },
    [room, selectedKeys, geometryOf, commit],
  )

  /**
   * Run an align / match / distribute tool over the selection.
   *
   * Everything funnels through `commit`, so each is one undo step exactly like a drag.
   * The selection ORDER is preserved into the maths, because the first entry is the
   * reference (see alignTo and matchSize).
   */
  const runTool = useCallback(
    (fn: (items: Placed[]) => Placed[]) => {
      if (!room) return
      const chosen: { key: string; geo: Geometry }[] = []
      for (const key of selectedKeys) {
        const geo = geometryOf(key)
        if (geo) chosen.push({ key, geo })
      }
      if (chosen.length < 2) return

      const out = fn(
        chosen.map((c) => ({ id: c.key, x: c.geo.x, y: c.geo.y, w: c.geo.w, h: c.geo.h })),
      )
      const changes: GeometryChange[] = []
      for (const p of out) {
        const source = chosen.find((c) => c.key === p.id)
        if (!source) continue
        /* Clamped here as well as in the canvas: distributing a wide bank can compute a
           position past the wall, and a table off the edge is invisible. */
        const w = Math.min(p.w, room.width)
        const h = Math.min(p.h, room.height)
        changes.push({
          id: p.id,
          before: source.geo,
          after: {
            ...source.geo,
            x: round2(Math.min(Math.max(0, p.x), room.width - w)),
            y: round2(Math.min(Math.max(0, p.y), room.height - h)),
            w: round2(w),
            h: round2(h),
          },
        })
      }
      /* record() drops no-ops, so a tool that changed nothing costs no undo step. */
      commit(changes)
    },
    [room, selectedKeys, geometryOf, commit],
  )

  /* ── Server round-trips ────────────────────────────────────────────────── */

  /**
   * Adopts a server response, or reports why not.
   *
   * Returns a TYPE PREDICATE rather than a plain boolean, so a caller that needs the
   * fresh rooms afterwards can still see them — `if (!apply(r)) return` otherwise leaves
   * `r` as the whole union and `r.rooms` unreachable.
   */
  function apply(result: FloorResult): result is Extract<FloorResult, { ok: true }> {
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setRooms(result.rooms)
    setTables(result.tables)
    setServerFeatures(result.features)
    /* The draft is RESET from what came back, not merged into. The server clamps
       positions to the room and normalises rotation, so keeping the local numbers would
       leave the canvas showing something the till will not draw — and the difference
       would only surface as a table half off the edge of the floor screen. */
    setDraft(new Map(result.tables.map((t) => [t.id, placementOf(t)])))
    setFeatureDraft(result.features)
    /* Geometry the server has re-clamped can no longer be replayed against what the stack
       recorded, so the stack goes. */
    history.clear()
    return true
  }

  function save() {
    if (dirty === 0 || !room) return
    startTransition(async () => {
      /* Furniture first: a feature save returns the whole floor, so doing it after the
         placements would hand back tables that overwrite what we just wrote. */
      for (const feature of changedFeatures) {
        const result = await saveFeatureAction(feature)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
      }
      const result = await savePlacementsAction(
        changed.map((p) => ({
          tableId: p.id,
          roomId: p.roomId,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          rotation: p.rotation,
          shape: p.shape,
        })),
      )
      if (apply(result)) toast.success('Floor plan saved.')
    })
  }

  function addRoom() {
    startTransition(async () => {
      const result = await createRoomAction(newRoom)
      if (!apply(result)) return
      setAddingRoom(false)
      setNewRoom({ name: '', width: 100, height: 70 })
      /* Select what was just created — a manager who adds a room wants to put tables in
         it, and making them find it in a picker first is a step for nothing. */
      const added = result.rooms.find((r) => !rooms.some((old) => old.id === r.id))
      if (added) setRoomId(added.id)
      toast.success('Room added.')
    })
  }

  /**
   * Rename or resize the current room.
   *
   * SHRINKING is the case worth knowing about: `savePlacements` clamps every table into
   * its room, but only on the next save — a table already sitting past the new edge stays
   * there in the database until something moves it. The server does not re-clamp on a
   * resize, so the note in the form warns rather than the code silently rearranging a
   * floor somebody spent time on.
   */
  function saveRoom() {
    if (!editingRoom || !room) return
    startTransition(async () => {
      const result = await updateRoomAction(room.id, editingRoom)
      if (!apply(result)) return
      setEditingRoom(null)
      toast.success('Room updated.')
    })
  }

  /* ── Placing and removing ──────────────────────────────────────────────── */

  /** Drop a table onto the plan, somewhere it will not land on another one. */
  const place = useCallback(
    (tableId: number) => {
      if (!room) return
      const taken = tables
        .map((t) => draft.get(t.id))
        .filter((p): p is Placement => Boolean(p && p.roomId === room.id && p.x !== null))
        .map((p) => ({ x: p.x ?? 0, y: p.y ?? 0, w: p.width, h: p.height }))
      const existing = draft.get(tableId)
      const w = existing?.width ?? 8
      const h = existing?.height ?? 8
      const slot = firstFreeSlot(taken, w, h, room.width, room.height)
      setDraft((current) => {
        const copy = new Map(current)
        const before = copy.get(tableId)
        if (!before) return current
        copy.set(tableId, { ...before, roomId: room.id, x: slot.x, y: slot.y })
        return copy
      })
      /* A table appearing changes what the stack's entries refer to. */
      history.clear()
      setSelectedKeys([`t${tableId}`])
    },
    [room, tables, draft, history],
  )

  /**
   * Create a table and drop it straight onto the plan.
   *
   * ── CREATED ALREADY PLACED, NOT CREATED THEN PLACED ───────────────────────
   *
   * The position goes in the INSERT (see `TableInput.placement`) rather than being
   * drafted afterwards, so a table added here is on the plan the instant it exists —
   * there is no window in which it is neither drawn nor in the tray. That also means
   * adding a table is NOT an unsaved change: nothing about it is waiting for Save, and
   * telling a manager otherwise would have them hunting for a change that isn't there.
   *
   * The slot is computed from the SERVER's list, because the local draft has not seen
   * the new table yet and a slot chosen against a stale list can land on top of
   * something.
   */
  function addTable(code: string, preset: SeatPreset, shape: TableShape) {
    if (!room) return
    startTransition(async () => {
      const taken = tables
        .map((t) => draft.get(t.id))
        .filter((p): p is Placement => Boolean(p && p.roomId === room.id && p.x !== null))
        .map((p) => ({ x: p.x ?? 0, y: p.y ?? 0, w: p.width, h: p.height }))
      const slot = firstFreeSlot(taken, preset.w, preset.h, room.width, room.height)

      const result = await createTableOnFloorAction({
        code,
        seats: preset.seats,
        placement: {
          roomId: room.id,
          x: slot.x,
          y: slot.y,
          width: preset.w,
          height: preset.h,
          shape,
        },
      })
      if (!apply(result)) return

      setAddingTable(false)
      const added = result.tables.find((t) => t.code === code)
      if (added) setSelectedKeys([`t${added.id}`])
      toast.success(`Table ${code} added.`)
    })
  }

  /**
   * Copy the selected tables.
   *
   * The server names the copies, because a code is unique and only the server can see
   * every row while it picks — see `duplicateTablesAction`. Placed tables only: there is
   * nowhere to offset a copy of something that has no position.
   */
  const duplicateSelection = useCallback(() => {
    const ids = selectedKeys.filter((k) => k.startsWith('t')).map((k) => Number(k.slice(1)))
    if (ids.length === 0) return
    startTransition(async () => {
      const result = await duplicateTablesAction(ids)
      if (!apply(result)) return
      const made = result.made ?? 0
      /* New tables mean the stack's entries name a different world; apply() has already
         cleared it, and the selection with it. */
      setSelectedKeys([])
      toast.success(made === 1 ? 'Table copied.' : `${made} tables copied.`)
    })
    /* `apply` is redefined every render but only ever reads state it is given; leaving it
       out keeps this callback stable for the key handler that depends on it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys, toast])

  /**
   * Copy the selection to the clipboard.
   *
   * ── WHY THIS IS NOT JUST ANOTHER NAME FOR Ctrl+D ──────────────────────────
   *
   * Ctrl+D duplicates immediately and forgets. Copy REMEMBERS, so one copy can be pasted
   * five times to lay out a bank of identical tables — which is the whole reason to want
   * copy/paste on a floor plan rather than the duplicate that was already here.
   *
   * The clipboard holds ids, not geometry. What gets pasted is read fresh from the tables
   * at paste time, so copying a table and then resizing it before pasting gives you the
   * NEW size — which is what "paste this table" means to anyone who did not write it.
   * The ids are validated on paste, because a copied table can be taken off the plan or
   * retired in between.
   */
  const copySelection = useCallback(() => {
    const ids = selectedKeys.filter((k) => k.startsWith('t')).map((k) => Number(k.slice(1)))
    if (ids.length === 0) {
      toast.info('Select a table first.')
      return
    }
    setClipboard(ids)
    toast.success(ids.length === 1 ? 'Table copied.' : `${ids.length} tables copied.`)
  }, [selectedKeys, toast])

  /**
   * Paste whatever was copied, as new tables beside the originals.
   *
   * Runs through `duplicateTablesAction` — the same server call Ctrl+D uses — because the
   * hard part is identical: a code is UNIQUE, so only the server can pick a free name
   * without racing every other till. Paste is copy's memory plus that call, not a second
   * implementation of it.
   */
  const pasteClipboard = useCallback(() => {
    if (clipboard.length === 0) {
      toast.info('Nothing copied yet — select a table and press Ctrl+C.')
      return
    }
    /* Anything since removed from the plan or retired is dropped rather than failing the
       whole paste: pasting four when one has gone should give three and say so. */
    const live = clipboard.filter((id) => {
      const placement = draft.get(id)
      return Boolean(placement && placement.roomId !== null && placement.x !== null)
    })
    if (live.length === 0) {
      setClipboard([])
      toast.info('Those tables are no longer on the plan.')
      return
    }
    startTransition(async () => {
      const result = await duplicateTablesAction(live)
      if (!apply(result)) return
      const made = result.made ?? 0
      setSelectedKeys([])
      toast.success(made === 1 ? 'Table pasted.' : `${made} tables pasted.`)
    })
    /* `apply` is redefined every render but only reads state it is given; leaving it out
       keeps this callback stable for the key handler that depends on it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipboard, draft, toast])

  /** Take the selected tables off the plan — they go back to the tray, not the bin. */
  const unplaceSelection = useCallback(() => {
    const ids = selectedKeys.filter((k) => k.startsWith('t')).map((k) => Number(k.slice(1)))
    if (ids.length === 0) return
    setDraft((current) => {
      const copy = new Map(current)
      for (const id of ids) {
        const before = copy.get(id)
        if (before) copy.set(id, { ...before, roomId: null, x: null, y: null })
      }
      return copy
    })
    history.clear()
    setSelectedKeys([])
  }, [selectedKeys, history])

  /**
   * Set the selected tables' shape.
   *
   * Shape rides in the geometry stack, so this is undoable exactly like a drag — which
   * is the reason `Geometry` carries a field that is not position or size at all.
   */
  const setShape = useCallback(
    (shape: TableShape) => {
      const changes: GeometryChange[] = []
      for (const key of selectedKeys) {
        if (!key.startsWith('t')) continue
        const before = geometryOf(key)
        if (!before || before.shape === shape) continue
        changes.push({ id: key, before, after: { ...before, shape } })
      }
      commit(changes)
    },
    [selectedKeys, geometryOf, commit],
  )

  /* ── Keyboard ──────────────────────────────────────────────────────────────
     The shortcuts that make a layout tool feel like one. Bound to the window rather than
     the canvas so they work wherever focus happens to be — but only in edit mode, and
     never while a text field has it. */
  useEffect(() => {
    if (!editing || !room) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return
      /* A dialog owns the keyboard while it is open — Delete in the add-table form must
         not unplace whatever happened to be selected behind it. */
      if (addingTable || addingRoom || editingRoom) return

      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        const did = e.shiftKey ? history.redo() : history.undo()
        if (!did) toast.info(e.shiftKey ? 'Nothing to redo.' : 'Nothing to undo.')
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        history.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      /* Ctrl+C / Ctrl+V. Safe to claim: the guard above has already bowed out if a text
         field has focus, so copying a table code out of the name box still works. */
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        copySelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        pasteClipboard()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const keys = [
          ...featureDraft.filter((f) => f.roomId === room.id).map((f) => `f${f.id}`),
          ...tables
            .filter((t) => {
              const p = draft.get(t.id)
              return p?.roomId === room.id && p.x !== null
            })
            .map((t) => `t${t.id}`),
        ]
        setSelectedKeys(keys)
        return
      }
      if (e.key === 'Escape') {
        setSelectedKeys([])
        return
      }
      /* Delete takes tables OFF the plan rather than deleting them — the destructive
         reading of that key would be wrong here, since a table is a physical thing that
         may have a bill open on it. */
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKeys.length > 0) {
        e.preventDefault()
        unplaceSelection()
        return
      }
      /* A tenth of a unit, or a whole one with Shift. */
      const step = e.shiftKey ? 1 : 0.1
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const delta = arrows[e.key]
      if (delta && selectedKeys.length > 0) {
        e.preventDefault()
        nudge(delta[0], delta[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    editing,
    room,
    history,
    toast,
    selectedKeys,
    nudge,
    unplaceSelection,
    duplicateSelection,
    copySelection,
    pasteClipboard,
    addingTable,
    addingRoom,
    editingRoom,
    tables,
    draft,
    featureDraft,
  ])

  const unplaced = tables.filter((t) => t.isActive && draft.get(t.id)?.roomId == null)
  const selectedTables = selectedKeys.filter((k) => k.startsWith('t')).length

  /* ── What the side panel needs to describe the selection ─────────────────── */

  /** The one selected feature, when a feature is exactly what is selected. */
  const selectedFeature =
    selectedKeys.length === 1 && selectedKeys[0].startsWith('f')
      ? featureDraft.find((f) => f.id === Number(selectedKeys[0].slice(1))) ?? null
      : null

  /** A name for a single selection — the table's code, or the fixture's kind. */
  const selectionLabel = useMemo(() => {
    if (selectedKeys.length !== 1) return ''
    const key = selectedKeys[0]
    if (key.startsWith('t')) {
      const table = tables.find((t) => t.id === Number(key.slice(1)))
      if (!table) return ''
      return table.seats > 0 ? `${table.code} · ${table.seats} seats` : table.code
    }
    return selectedFeature?.kind ?? ''
  }, [selectedKeys, tables, selectedFeature])

  /**
   * The shape every selected table shares, or null when they differ.
   *
   * Read from the DRAFT so a shape changed and not yet saved shows as chosen — the panel
   * would otherwise contradict the tile beside it.
   */
  const selectedShape = useMemo(() => {
    const shapes = selectedKeys
      .filter((k) => k.startsWith('t'))
      .map((k) => geometryOf(k)?.shape ?? 'rect')
    if (shapes.length === 0) return null
    return shapes.every((s) => s === shapes[0]) ? shapes[0] : null
  }, [selectedKeys, geometryOf])

  /**
   * Tables sitting (almost) entirely under another one.
   *
   * The equivalent of the old designer's "N off-screen" rescue, corrected for a canvas
   * that CANNOT lose a table off the edge: this room is drawn whole, at an aspect ratio,
   * and every position is clamped inside it, so nothing can be dragged out of view. What
   * can still happen is a table dropped on top of another and forgotten — invisible for
   * the same reason and just as hard to find by eye.
   *
   * Reported, never auto-fixed. Two tables genuinely can overlap (a table pushed against
   * a bar), so this points and lets a manager decide.
   */
  const buried = useMemo(() => {
    if (!room) return []
    const placed = tables
      .map((t) => ({ table: t, p: draft.get(t.id) }))
      .filter((e): e is { table: PosTable; p: Placement } =>
        Boolean(e.p && e.p.roomId === room.id && e.p.x !== null),
      )
    return placed.filter(({ p }, index) =>
      placed.some(({ p: other }, otherIndex) => {
        if (index === otherIndex) return false
        const ax = p.x ?? 0
        const ay = p.y ?? 0
        const bx = other.x ?? 0
        const by = other.y ?? 0
        const overlapW = Math.min(ax + p.width, bx + other.width) - Math.max(ax, bx)
        const overlapH = Math.min(ay + p.height, by + other.height) - Math.max(ay, by)
        if (overlapW <= 0 || overlapH <= 0) return false
        /* 80% covered, not merely touching — tables legitimately sit shoulder to
           shoulder, and flagging every neighbour would make this noise. */
        return (overlapW * overlapH) / (p.width * p.height) > 0.8
      }),
    )
  }, [tables, draft, room])

  /* The toolbar's right-hand side, shared by the card header and the dialog header so
     the two cannot drift — Save is the same button in both, disabled by the same rule. */
  const actions = (
    <div className="flex items-center gap-2">
      {/* The count, not a dot. "6 changes" is actionable where a dirty indicator is
          a puzzle. */}
      {dirty > 0 && (
        <span className="text-sm text-warning-ink">
          {dirty} unsaved change{dirty === 1 ? '' : 's'}
        </span>
      )}
      {onExpand && (
        /* Never disabled. The shell keeps this component mounted across the switch, so
           an unsaved arrangement travels with you — there is nothing to save first and
           nothing to warn about. See FloorPlanSection's note. */
        <Button
          variant="secondary"
          size="sm"
          title="Give the canvas the whole screen"
          onClick={onExpand}
        >
          <Icons.Maximize size={16} />
          Open full screen
        </Button>
      )}
      <Button variant="primary" disabled={dirty === 0 || pending} onClick={save}>
        <Icons.Save size={16} />
        Save plan
      </Button>
    </div>
  )

  /*
   * The body, without any chrome of its own.
   *
   * Pulled out so the SAME markup can sit in a Card on the setup page and bare inside a
   * full-screen dialog. Rendering it twice would mean two copies of the draft, and a
   * manager who arranged a room full-screen would find the page behind still showing the
   * old layout — which is exactly the bug worth designing out.
   */
  const body = (
    <div className="space-y-4">
        {rooms.length === 0 ? (
          <>
            <EmptyState
              icon={<Icons.LayoutGrid size={28} />}
              title="No rooms yet"
              hint="Add a room to start placing tables. Until then the till shows the sectioned list, which is a perfectly good floor for most shops."
            />
            {!addingRoom && (
              <Button variant="secondary" onClick={() => setAddingRoom(true)}>
                <Icons.Plus size={16} />
                Add a room
              </Button>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              value={String(roomId ?? '')}
              onChange={(next) => {
                setRoomId(Number(next))
                setSelectedKeys([])
                /* Undo entries name things in the room you are leaving; replaying them
                   from another room would move what you cannot see. */
                history.clear()
              }}
              options={rooms.map((r) => ({ value: String(r.id), label: r.name }))}
            />
            <Button variant="ghost" size="sm" onClick={() => setAddingRoom(true)}>
              <Icons.Plus size={14} />
              Room
            </Button>
            {/* Renaming and resizing a room was previously impossible from here — the
                action existed on the server and nothing called it, so a room typed wrong
                had to be removed and rebuilt, taking its layout with it. */}
            {room && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setEditingRoom({
                    name: room.name,
                    width: room.width,
                    height: room.height,
                  })
                  setAddingRoom(false)
                }}
              >
                <Icons.Pencil size={14} />
                Edit room
              </Button>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {room && (
                <span className="text-xs text-muted">
                  {room.width} × {room.height} units
                </span>
              )}
              {editing && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Undo"
                    title="Undo the last move (Ctrl+Z). Adding and removing rooms isn't undoable."
                    disabled={!history.canUndo}
                    onClick={() => history.undo()}
                  >
                    <Icons.Undo size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Redo"
                    title="Redo (Ctrl+Shift+Z)"
                    disabled={!history.canRedo}
                    onClick={() => history.redo()}
                  >
                    <Icons.Redo size={16} />
                  </Button>
                  {/* The main way a floor gets built, so it sits in the toolbar rather
                      than in the tray below where the canvas can push it off-screen. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => setAddingTable(true)}
                  >
                    <Icons.Plus size={14} />
                    Add table
                  </Button>
                </>
              )}
              <Button
                variant={editing ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  setEditing((v) => !v)
                  setSelectedKeys([])
                }}
              >
                {editing ? 'Done' : 'Edit layout'}
              </Button>
            </div>
          </div>
        )}

        {addingRoom && (
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Room name" className="min-w-48">
                <Input
                  value={newRoom.name}
                  onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })}
                  placeholder="Inside, Patio, Upstairs..."
                />
              </Field>
              {/* No `hint` on any of these three. The row is `items-end`, so a hint under
                  ONE field makes that field taller and lifts its input above the others —
                  the three boxes stopped being level. The note moved below the row, where
                  it explains the units for both without skewing the alignment. */}
              <Field label="Width">
                <NumberInput
                  value={newRoom.width}
                  onChange={(e) => setNewRoom({ ...newRoom, width: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Height">
                <NumberInput
                  value={newRoom.height}
                  onChange={(e) => setNewRoom({ ...newRoom, height: Number(e.target.value) || 0 })}
                />
              </Field>
              <Button
                variant="primary"
                disabled={!newRoom.name.trim() || pending}
                onClick={addRoom}
              >
                Add
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setAddingRoom(false)}>
                Cancel
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">
              Width and height are room units, not metres — and you can change them later.
            </p>
          </div>
        )}

        {editingRoom && room && (
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Room name" className="min-w-48">
                <Input
                  value={editingRoom.name}
                  autoFocus
                  onChange={(e) => setEditingRoom({ ...editingRoom, name: e.target.value })}
                />
              </Field>
              <Field label="Width">
                <NumberInput
                  value={editingRoom.width}
                  onChange={(e) =>
                    setEditingRoom({ ...editingRoom, width: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Field label="Height">
                <NumberInput
                  value={editingRoom.height}
                  onChange={(e) =>
                    setEditingRoom({ ...editingRoom, height: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Button
                variant="primary"
                disabled={!editingRoom.name.trim() || pending}
                onClick={saveRoom}
              >
                Save room
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setEditingRoom(null)}>
                Cancel
              </Button>
            </div>
            {/* Said only when it applies. Growing a room is free; shrinking one can leave
                a table beyond the new wall, and a manager should hear that before pressing
                Save rather than discovering it on the canvas afterwards. */}
            {(editingRoom.width < room.width || editingRoom.height < room.height) && (
              <p className="mt-2 text-xs text-warning-ink">
                Making the room smaller can leave tables outside the new edge. Drag any
                that end up there back in, then save the plan.
              </p>
            )}
          </div>
        )}

        {room && (
          <>
            {dirty > 0 && (
              <Callout tone="warning">
                Nothing is saved yet. The till still shows the last saved arrangement.
              </Callout>
            )}

            {/*
              ── THE WORKBENCH: TOOLS LEFT, FLOOR RIGHT ──────────────────────
              The tools used to sit in rows ABOVE the canvas, which meant the floor
              jumped down the page every time a second item was selected and the align
              row appeared. A fixed column holds its width whatever is in it, so the
              canvas never moves and the eye never has to re-find it.

              Only while EDITING. Out of edit mode there is nothing to put in the column
              and the plan should have the whole width, exactly as the till shows it.
            */}
            {/* `items-stretch` and NO height constraint: the canvas measures the space
                left to it against its scrolling container, so a wrapper that also claimed
                a height would fight that and collapse it — which is exactly what happened
                the first time, out of edit mode where the sidebar is absent. */}
            <div className="flex items-stretch gap-4">
              {editing && (
                /* Scrolls on its own if the panels outgrow the space beside the canvas,
                   capped rather than stretched so a tall panel cannot push the floor
                   down the page. */
                <div className="flex max-h-[74vh] w-60 shrink-0 flex-col gap-4 overflow-y-auto">

                  {/* ── Add items ───────────────────────────────────────────── */}
                  <PanelSection title="Add items">
                    <div className="grid grid-cols-3 gap-2">
                      {(['wall', 'bar', 'pass', 'door', 'plant', 'text'] as const).map(
                        (kind) => (
                          /* Not a kit Button: this is a picture-above-a-label tile, and
                             forcing that into Button's single row is what made the seat
                             presets overlap their captions earlier. */
                          <button
                            key={kind}
                            type="button"
                            data-kit-ok
                            disabled={pending}
                            title={`Add a ${kind}`}
                            onClick={() =>
                              startTransition(async () => {
                                const result = await saveFeatureAction({
                                  roomId: room.id,
                                  kind,
                                  label: kind === 'text' ? 'Label' : '',
                                  /* Dropped near the top-left but not ON it, so a new wall
                                     never lands exactly under the last one and becomes
                                     impossible to separate. */
                                  x: 4 + ((featureDraft.length * 3) % 20),
                                  y: 4 + ((featureDraft.length * 3) % 20),
                                  width: kind === 'wall' ? 24 : 10,
                                  height: kind === 'wall' ? 2 : 6,
                                  rotation: 0,
                                })
                                apply(result)
                              })
                            }
                            className="flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-card border border-border bg-surface text-[11px] font-medium capitalize text-ink transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                          >
                            {/* The drawing rather than a plus, so the palette shows what
                                each one puts on the floor. 'text' has no glyph — a label
                                is its own drawing — so it gets a letter instead. */}
                            {kind === 'text' ? (
                              <span className="text-lg font-bold leading-none">T</span>
                            ) : (
                              <span className="text-ink-2">
                                <FeatureGlyph
                                  kind={kind}
                                  style={FEATURE_PALETTE_SIZE[kind]}
                                />
                              </span>
                            )}
                            {kind}
                          </button>
                        ),
                      )}
                    </div>
                  </PanelSection>

                  {/* ── Selected items ──────────────────────────────────────
                      Everything that acts on a selection, in one place. Appears only
                      when something is selected: a panel of permanently-disabled
                      controls teaches nothing and takes the room the floor wants. */}
                  {/* Paste stands on its own, because a clipboard outlives a selection:
                      copy a table, click empty floor to deselect, and Paste must still be
                      reachable. Shown only when there IS something to paste. */}
                  {clipboard.length > 0 && selectedKeys.length === 0 && (
                    <PanelSection
                      title="Clipboard"
                      note={
                        clipboard.length === 1
                          ? '1 table copied'
                          : `${clipboard.length} tables copied`
                      }
                      action={
                        <Button variant="ghost" size="sm" onClick={() => setClipboard([])}>
                          Clear
                        </Button>
                      }
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending}
                        onClick={pasteClipboard}
                      >
                        <Icons.Plus size={14} />
                        Paste (Ctrl+V)
                      </Button>
                    </PanelSection>
                  )}

                  {selectedKeys.length > 0 && (
                    <PanelSection
                      title="Selected items"
                      /* Short enough not to truncate in a 240px column — the REF marker
                         is drawn on the canvas, so the panel does not have to explain it
                         in words as well. */
                      note={
                        selectedKeys.length === 1
                          ? selectionLabel
                          : `${selectedKeys.length} selected`
                      }
                      action={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedKeys([])}
                        >
                          Clear
                        </Button>
                      }
                    >
                      {/* The align tools need two things to compare. With one selected
                          the panel still appears, carrying just what applies to it. */}
                      {selectedKeys.length > 1 && (
                        <>
                          <PanelGroup label="Align">
                            {(
                              [
                                ['left', 'Align left edges'],
                                ['hcentre', 'Align horizontal centres'],
                                ['right', 'Align right edges'],
                                ['top', 'Align top edges'],
                                ['vmiddle', 'Align vertical middles'],
                                ['bottom', 'Align bottom edges'],
                              ] as [AlignMode, string][]
                            ).map(([mode, title]) => (
                              <PanelIcon
                                key={mode}
                                label={title}
                                onClick={() => runTool((i) => alignTo(i, mode))}
                              >
                                <AlignGlyph kind={mode} />
                              </PanelIcon>
                            ))}
                          </PanelGroup>

                          <PanelGroup label="Same size">
                            {(
                              [
                                ['width', 'Width'],
                                ['height', 'Height'],
                              ] as [MatchMode, string][]
                            ).map(([mode, label]) => (
                              <Button
                                key={mode}
                                variant="secondary"
                                size="sm"
                                title={`Make the selection the same ${mode} as the reference`}
                                onClick={() => runTool((i) => matchSize(i, mode))}
                              >
                                {label}
                              </Button>
                            ))}
                          </PanelGroup>

                          {/* Distribute needs three to mean anything — with two there is
                              nothing between the ends to space out. */}
                          <PanelGroup label="Space evenly">
                            {(
                              [
                                ['horizontal', 'Space evenly across'],
                                ['vertical', 'Space evenly down'],
                              ] as [DistributeMode, string][]
                            ).map(([mode, title]) => (
                              <PanelIcon
                                key={mode}
                                label={
                                  selectedKeys.length < 3
                                    ? 'Select three or more to space them evenly'
                                    : title
                                }
                                disabled={selectedKeys.length < 3}
                                onClick={() => runTool((i) => distribute(i, mode))}
                              >
                                <AlignGlyph
                                  kind={mode === 'horizontal' ? 'dist-h' : 'dist-v'}
                                />
                              </PanelIcon>
                            ))}
                          </PanelGroup>
                        </>
                      )}

                      {selectedTables > 0 && (
                        <>
                          <PanelGroup label="Shape">
                            {TABLE_SHAPES.map((s) => (
                              <PanelIcon
                                key={s}
                                label={`Make ${s}`}
                                /* Lit when every selected table already IS this shape,
                                   so the panel reports the selection as well as changing
                                   it — the single-selection bar used to do this and the
                                   information should not be lost in the move. */
                                active={selectedShape === s}
                                onClick={() => setShape(s)}
                              >
                                <ShapeGlyph shape={s} />
                              </PanelIcon>
                            ))}
                          </PanelGroup>

                          <PanelGroup label="Tables">
                            {/* Copy and Paste rather than the old single "Copy" that
                                duplicated on the spot: with Ctrl+C/Ctrl+V bound, a button
                                labelled Copy that did something else would be a trap.
                                Duplicate still exists on Ctrl+D for a one-shot. */}
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={pending}
                              title="Copy the selection (Ctrl+C)"
                              onClick={copySelection}
                            >
                              <Icons.Copy size={14} />
                              Copy
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={pending || clipboard.length === 0}
                              title={
                                clipboard.length === 0
                                  ? 'Copy a table first (Ctrl+C)'
                                  : `Paste ${clipboard.length} copied (Ctrl+V)`
                              }
                              onClick={pasteClipboard}
                            >
                              <Icons.Plus size={14} />
                              Paste
                            </Button>
                            <Button
                              variant="danger-ghost"
                              size="sm"
                              disabled={pending}
                              onClick={unplaceSelection}
                            >
                              <Icons.Close size={14} />
                              Off the plan
                            </Button>
                          </PanelGroup>
                        </>
                      )}

                      {/* A feature has no shape or seats to change, only removal. */}
                      {selectedFeature && (
                        <PanelGroup label={selectedFeature.kind}>
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                const result = await deleteFeatureAction(selectedFeature.id)
                                if (apply(result)) setSelectedKeys([])
                              })
                            }
                          >
                            <Icons.Trash size={14} />
                            Remove
                          </Button>
                        </PanelGroup>
                      )}
                    </PanelSection>
                  )}

                  {/* The rescue: a table hidden under another is invisible and unfindable
                      by eye. Tapping selects them so the next drag pulls one clear. */}
                  {buried.length > 0 && (
                    <PanelSection title="Overlapping">
                      <p className="text-xs text-warning-ink">
                        {buried.length === 1
                          ? 'One table is sitting underneath another'
                          : `${buried.length} tables are sitting underneath others`}{' '}
                        — {buried.map((b) => b.table.code).join(', ')}.
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSelectedKeys(buried.map((b) => `t${b.table.id}`))}
                      >
                        Select them
                      </Button>
                    </PanelSection>
                  )}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <FloorCanvas
                  room={room}
                  tables={tables}
                  placements={draft}
                  features={featureDraft}
                  editing={editing}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedKeys}
                  onCommit={commit}
                  onOpenItem={(key) => setSelectedKeys([key])}
                  tall={chrome === 'bare'}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {editing ? (
                /* One line, not three. The tools moved into the side panel where they can
                   be seen rather than read about, so what is left here is only what has
                   no on-screen control: the gestures. Ctrl+drag especially — a plain drag
                   selects, so nobody discovers it by trying. */
                <span>
                  Drag to move · corner to resize · ⟳ to rotate · arrows nudge · Ctrl+C /
                  Ctrl+V copies and pastes · Ctrl+drag moves the floor · Ctrl+scroll or
                  pinch zooms
                </span>
              ) : (
                <span>
                  This is what the till shows on its Floor view. Tap Edit layout to move
                  anything; tables with a bill open are coloured live there, and here they
                  always read as free.
                </span>
              )}
            </div>

            {/* ── The tray: new tables, and ones not yet on the plan ─────────
                Rendered whenever the layout is being edited, not only when something is
                unplaced. A tray that appeared only when there was a table waiting in it
                is why adding a SECOND table had nowhere to be done — the first one was
                placed, the tray vanished, and with it the only route to another. */}
            {unplaced.length > 0 && (
              <div className="rounded-card border border-border bg-surface p-3">
                <p className="mb-2 text-sm text-muted">
                  Not on the plan yet — tap to drop one into {room.name}. These still show
                  on the till&rsquo;s sectioned list, so nothing is hidden from a waiter
                  meanwhile.
                </p>
                <div className="flex flex-wrap gap-2">
                  {unplaced.map((t) => (
                    <Button
                      key={t.id}
                      variant="secondary"
                      size="sm"
                      disabled={pending || !editing}
                      title={editing ? undefined : 'Tap Edit layout first.'}
                      onClick={() => place(t.id)}
                    >
                      <Icons.Plus size={14} />
                      {t.code}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Retiring a room UNPLACES its tables rather than deleting them — said here,
                because "remove" on a screen full of tables reads as destructive and a
                manager should know that it is not. */}
            {editing && (
              <div>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await retireRoomAction(room.id)
                      if (!apply(result)) return
                      setRoomId(result.rooms[0]?.id ?? null)
                      setSelectedKeys([])
                      toast.success('Room removed. Its tables are back on the list.')
                    })
                  }
                >
                  <Icons.Trash size={14} />
                  Remove {room.name}
                </Button>
              </div>
            )}
          </>
        )}
    </div>
  )

  /* The add-table dialog, rendered alongside whichever shell is in use. A nested
     <dialog> is fine — the browser stacks them, so it opens above the full-screen one. */
  const dialogs = addingTable && room && (
    <AddTableModal
      roomName={room.name}
      busy={pending}
      /* Every code in the shop, not just this room's: the column is unique across the
         site, so a clash with a table on the patio is still a clash. */
      existing={tables.map((t) => t.code.trim().toLowerCase())}
      onClose={() => setAddingTable(false)}
      onAdd={addTable}
    />
  )

  /*
   * BARE, for the full-screen dialog: the Modal already draws a header and a panel, so a
   * Card inside it would be a second border around the same content. The dialog supplies
   * its own title and puts `actions` in its footer.
   */
  if (chrome === 'bare') {
    return (
      <>
        {/* The action row is pinned ABOVE the scrolling body rather than inside it: a
            manager who has dragged six tables must be able to reach Save without
            scrolling back up past the room they just arranged. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border pb-3">
          {actions}
        </div>
        {/* `overflow-hidden`, not `auto`: the canvas measures the height left to it and
            fits inside, so nothing should ever need to scroll here — and a scroll
            container would let a mis-measurement hide as a scrollbar instead of showing
            up as the layout bug it is. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-4">{body}</div>
        {dialogs}
      </>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Floor plan"
        description="Where the tables actually stand. Optional — a room you never build keeps showing as the sectioned list on the till."
        action={actions}
      />
      <CardBody>{body}</CardBody>
      {dialogs}
    </Card>
  )
}

/* ── Adding a table ───────────────────────────────────────────────────────────
   A modal rather than an inline field, because there are three decisions here and a
   toolbar row that grew to hold all of them would crowd the canvas it sits above. */

function AddTableModal({
  roomName,
  busy,
  existing,
  onClose,
  onAdd,
}: {
  roomName: string
  busy: boolean
  existing: string[]
  onClose: () => void
  onAdd: (code: string, preset: SeatPreset, shape: TableShape) => void
}) {
  const [code, setCode] = useState('')
  const [seats, setSeats] = useState(4)
  /* Null means "whatever this size usually is" — seeded from the preset but freely
     overridable, so picking a size suggests a shape without deciding it. */
  const [shape, setShape] = useState<TableShape | null>(null)
  const preset = presetForSeats(seats)
  const effectiveShape = shape ?? preset.shape

  /* Checked here as well as on the server: the code is what a waiter types and what the
     bill hangs off, and finding out it clashed after a round-trip is a worse moment. */
  const clash = existing.includes(code.trim().toLowerCase())
  const valid = code.trim().length > 0 && !clash

  const submit = () => {
    if (!valid || busy) return
    onAdd(code.trim(), preset, effectiveShape)
  }

  return (
    <Modal
      open
      title="Add a table"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            Add to {roomName}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Table name or number"
          hint="What the staff call it — 6, B2, Patio 3."
          error={clash ? `There is already a table "${code.trim()}".` : undefined}
        >
          <Input
            value={code}
            maxLength={16}
            autoFocus
            disabled={busy}
            placeholder="12"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>

        {/* Size is picked as a KIND of table, not a number in a box: "a four seater" is
            how a restaurant thinks about its floor, and each preset carries a sensible
            footprint so the tile never needs reshaping by hand. Still resizable after. */}
        <Field
          label="Table size"
          hint="Sets the chairs and the footprint. You can still resize it on the plan."
        >
          <div className="grid grid-cols-2 gap-2">
            {SEAT_PRESETS.map((p) => (
              /* Not a kit Button: this is a two-row picker tile (a drawing above a
                 label) and forcing that into Button's single-row layout is what made the
                 glyphs overlap their captions. Marked so the kit check knows it was a
                 decision — the kit has no "illustrated choice tile" and one screen does
                 not justify adding one. */
              <button
                key={p.seats}
                type="button"
                data-kit-ok
                disabled={busy}
                onClick={() => {
                  setSeats(p.seats)
                  /* Back to this size's suggested shape — an explicit choice made for a
                     four-top should not silently carry over to an eight. */
                  setShape(null)
                }}
                className={`flex min-h-32 flex-col items-center justify-center gap-3 rounded-card border-2 px-3 py-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  seats === p.seats
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-border bg-surface text-muted hover:border-brand'
                }`}
              >
                <SeatPresetGlyph preset={p} />
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Shape" hint="You can rotate it once it is on the plan.">
          <div className="flex flex-wrap gap-2">
            {TABLE_SHAPES.map((s) => (
              <Button
                key={s}
                variant={effectiveShape === s ? 'primary' : 'secondary'}
                disabled={busy}
                className="capitalize"
                onClick={() => setShape(s)}
              >
                <ShapeGlyph shape={s} />
                {s}
              </Button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  )
}

/**
 * Icon proportions for the "Add:" palette.
 *
 * Roughly the shape each button actually creates (a wall is made 24×2, everything else
 * 10×6), so the palette previews the fixture rather than merely naming it. A plant is
 * squared up because its drawing is a pot and foliage, which a 2:1 box would squash.
 */
const FEATURE_PALETTE_SIZE: Record<
  Exclude<FloorFeature['kind'], 'text'>,
  { width: number; height: number }
> = {
  wall: { width: 22, height: 7 },
  bar: { width: 20, height: 12 },
  pass: { width: 20, height: 12 },
  door: { width: 15, height: 15 },
  plant: { width: 14, height: 15 },
}

/* Both pickers below draw with the SAME component the canvas does, so what you choose in
   the dialog is literally the thing that appears on the plan. Three separate drawings of
   a table is how a picker ends up promising a shape the canvas does not render. */

/** The outline of each shape, chairless — the choice here is silhouette, not seating. */
function ShapeGlyph({ shape }: { shape: TableShape }) {
  /* Proportions that make each shape distinguishable at icon size: a counter has to look
     long and shallow or it is indistinguishable from an oval. */
  const size: Record<TableShape, { width: number; height: number }> = {
    rect: { width: 20, height: 14 },
    round: { width: 15, height: 15 },
    oval: { width: 22, height: 13 },
    counter: { width: 24, height: 9 },
  }
  return (
    <TableGlyph
      shape={shape}
      seats={{ top: 0, bottom: 0, left: 0, right: 0 }}
      footprint={size[shape]}
      style={size[shape]}
    />
  )
}

/**
 * A drawing of the table AND its chairs, so a size choice is visual.
 *
 * Sized in pixels from the preset's proportions rather than its raw units: this is an
 * icon in a 100px-wide tile, and scaling room units directly gave an eight-seater a
 * table wide enough to overflow its own caption.
 */
function SeatPresetGlyph({ preset }: { preset: SeatPreset }) {
  /* The widest preset lands at ~90px and the narrowest at ~36px — a visible difference
     between sizes without any of them outgrowing the ~260px tile. The glyph carries its
     chairs OUTSIDE the table top, so this box is the whole footprint. */
  const width = Math.round(preset.w * 4.5)
  const height = Math.round(preset.h * 4.5)
  return (
    <TableGlyph
      shape={preset.shape}
      seats={seatLayout(preset.seats, preset.w, preset.h)}
      footprint={{ width, height }}
      style={{ width, height }}
    />
  )
}


/* ── Alignment toolbar bits ───────────────────────────────────────────────────
   Small enough to live here rather than in components/ui: they are specific to this
   toolbar, and pulling them out would make a shared primitive of something exactly one
   screen uses. */

/**
 * One card in the left tool column.
 *
 * A plain bordered box rather than the kit's `Card`: this sits INSIDE a card already (or
 * inside the full-screen shell), and nesting Card in Card doubles the border and the
 * padding. Small enough to live here — it is specific to this one panel, and pulling it
 * into `components/ui` would make a shared primitive of something exactly one screen uses.
 */
function PanelSection({
  title,
  note,
  action,
  children,
}: {
  title: string
  /** A line under the title — what is selected, usually. */
  note?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {note && <p className="mt-0.5 truncate text-xs text-muted">{note}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

/** A labelled row of controls inside a panel section. */
function PanelGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

/**
 * A square icon button for the panel's tool rows.
 *
 * Not a kit `Button iconOnly`: these sit six-to-a-row in a 240px column and need to be
 * smaller than the kit's 36px control height, and `active` gives them a pressed state the
 * kit's ghost variant has no equivalent for. Marked so the kit check knows it was a
 * decision rather than an oversight.
 */
function PanelIcon({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-kit-ok
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-control border transition-colors disabled:opacity-40 ${
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-surface text-ink hover:border-brand hover:text-brand'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Tiny diagrams of what each tool does — bars and a rule showing the edge they line up
 * on. Icons rather than words because six alignment buttons labelled in text is a
 * paragraph, and every design tool already teaches this shape.
 */
function AlignGlyph({ kind }: { kind: AlignMode | 'dist-h' | 'dist-v' }) {
  const bar = 'absolute rounded-[1px] bg-current'
  const rule = 'absolute bg-current opacity-40'
  return (
    <span aria-hidden className="relative block h-4 w-4">
      {kind === 'left' && (
        <>
          <span className={`${rule} left-0 top-0 h-full w-px`} />
          <span className={`${bar} left-[2px] top-[2px] h-[4px] w-[12px]`} />
          <span className={`${bar} left-[2px] top-[10px] h-[4px] w-[7px]`} />
        </>
      )}
      {kind === 'right' && (
        <>
          <span className={`${rule} right-0 top-0 h-full w-px`} />
          <span className={`${bar} right-[2px] top-[2px] h-[4px] w-[12px]`} />
          <span className={`${bar} right-[2px] top-[10px] h-[4px] w-[7px]`} />
        </>
      )}
      {kind === 'hcentre' && (
        <>
          <span className={`${rule} left-1/2 top-0 h-full w-px -translate-x-1/2`} />
          <span className={`${bar} left-[2px] top-[2px] h-[4px] w-[12px]`} />
          <span className={`${bar} left-[4px] top-[10px] h-[4px] w-[7px]`} />
        </>
      )}
      {kind === 'top' && (
        <>
          <span className={`${rule} left-0 top-0 h-px w-full`} />
          <span className={`${bar} left-[2px] top-[2px] h-[12px] w-[4px]`} />
          <span className={`${bar} left-[10px] top-[2px] h-[7px] w-[4px]`} />
        </>
      )}
      {kind === 'bottom' && (
        <>
          <span className={`${rule} bottom-0 left-0 h-px w-full`} />
          <span className={`${bar} bottom-[2px] left-[2px] h-[12px] w-[4px]`} />
          <span className={`${bar} bottom-[2px] left-[10px] h-[7px] w-[4px]`} />
        </>
      )}
      {kind === 'vmiddle' && (
        <>
          <span className={`${rule} left-0 top-1/2 h-px w-full -translate-y-1/2`} />
          <span className={`${bar} left-[2px] top-[2px] h-[12px] w-[4px]`} />
          <span className={`${bar} left-[10px] top-[4px] h-[7px] w-[4px]`} />
        </>
      )}
      {kind === 'dist-h' && (
        <>
          <span className={`${bar} left-0 top-[3px] h-[10px] w-[3px]`} />
          <span className={`${bar} left-[6px] top-[3px] h-[10px] w-[3px]`} />
          <span className={`${bar} right-0 top-[3px] h-[10px] w-[3px]`} />
        </>
      )}
      {kind === 'dist-v' && (
        <>
          <span className={`${bar} left-[3px] top-0 h-[3px] w-[10px]`} />
          <span className={`${bar} left-[3px] top-[6px] h-[3px] w-[10px]`} />
          <span className={`${bar} bottom-0 left-[3px] h-[3px] w-[10px]`} />
        </>
      )}
    </span>
  )
}
