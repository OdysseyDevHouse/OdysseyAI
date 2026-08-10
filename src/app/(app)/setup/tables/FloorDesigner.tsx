'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Callout,
  EmptyState,
  Field,
  Input,
  NumberInput,
  SegmentedControl,
  useToast,
  Icons,
} from '@/components/ui'
import { FloorCanvas, placementOf, type Placement } from './FloorCanvas'
import {
  createRoomAction,
  retireRoomAction,
  savePlacementsAction,
  saveFeatureAction,
  deleteFeatureAction,
} from './actions'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { FloorResult } from './actions'
import type { PosTable } from '@/lib/site/posTables'

/**
 * The floor plan, as a manager builds it.
 *
 * ── A DRAFT, THEN ONE SAVE ────────────────────────────────────────────────
 *
 * Dragging edits local state; Save writes the whole room in one transaction. A canvas
 * that persisted every nudge would turn one reorganisation into forty round trips and
 * leave a half-moved floor behind if the tab closed — and `savePlacements` exists as a
 * batch precisely so that cannot happen.
 *
 * The unsaved-changes count is shown rather than implied. A manager who drags six tables
 * and walks away should be able to see that nothing has been written yet, because the
 * canvas looks identical either way.
 *
 * ── FEATURES SAVE IMMEDIATELY, AND TABLES DO NOT ──────────────────────────
 *
 * Deliberately inconsistent, for a reason worth stating. A wall is created by pressing
 * "Add wall" — it has to exist server-side to have an id to drag, and there is nothing to
 * lose if it is written straight away because a wall carries no bill and no history. A
 * TABLE already exists and may have a live document on it, so moving it is an edit to a
 * real record and belongs in the batch with every other edit.
 */
export default function FloorDesigner({
  rooms: initialRooms,
  tables: initialTables,
  features: initialFeatures,
}: {
  rooms: FloorRoom[]
  tables: PosTable[]
  features: FloorFeature[]
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [rooms, setRooms] = useState(initialRooms)
  const [tables, setTables] = useState(initialTables)
  const [features, setFeatures] = useState(initialFeatures)
  const [roomId, setRoomId] = useState<number | null>(initialRooms[0]?.id ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingRoom, setAddingRoom] = useState(false)
  const [newRoom, setNewRoom] = useState({ name: '', width: 100, height: 70 })

  /** The working copy. Keyed by table id; only what differs is sent on Save. */
  const [draft, setDraft] = useState<Map<number, Placement>>(
    () => new Map(initialTables.map((t) => [t.id, placementOf(t)])),
  )

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

  function move(tableId: number, next: Partial<Placement>) {
    setDraft((current) => {
      const existing = current.get(tableId)
      if (!existing) return current
      const copy = new Map(current)
      copy.set(tableId, { ...existing, ...next })
      return copy
    })
  }

  /**
   * Adopts a server response, or reports why not.
   *
   * Returns a TYPE PREDICATE rather than a plain boolean, so a caller that needs the
   * fresh rooms afterwards can still see them — `if (!apply(r)) return` otherwise leaves
   * `r` as the whole union and `r.rooms` unreachable, which is what tsc caught here.
   */
  function apply(result: FloorResult): result is Extract<FloorResult, { ok: true }> {
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setRooms(result.rooms)
    setTables(result.tables)
    setFeatures(result.features)
    /* The draft is RESET from what came back, not merged into. The server clamps positions
       to the room and normalises rotation, so keeping the local numbers would leave the
       canvas showing something the till will not draw — and the difference would only
       surface as a table half off the edge of the floor screen. */
    setDraft(new Map(result.tables.map((t) => [t.id, placementOf(t)])))
    return true
  }

  function save() {
    if (changed.length === 0) return
    startTransition(async () => {
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

  return (
    <Card>
      <CardHeader
        title="Floor plan"
        description="Where the tables actually stand. Optional — a room you never build keeps showing as the sectioned list on the till."
        action={
          <div className="flex items-center gap-2">
            {/* The count, not a dot. "6 tables moved" is actionable where a dirty
                indicator is a puzzle. */}
            {changed.length > 0 && (
              <span className="text-sm text-warning-ink">
                {changed.length} table{changed.length === 1 ? '' : 's'} moved
              </span>
            )}
            <Button
              variant="primary"
              disabled={changed.length === 0 || pending}
              onClick={save}
            >
              <Icons.Save size={16} />
              Save plan
            </Button>
          </div>
        }
      />

      <CardBody className="space-y-4">
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
                setSelectedId(null)
              }}
              options={rooms.map((r) => ({ value: String(r.id), label: r.name }))}
            />
            <Button variant="ghost" size="sm" onClick={() => setAddingRoom(true)}>
              <Icons.Plus size={14} />
              Room
            </Button>
            {room && (
              <>
                <span className="text-xs text-muted">
                  {room.width} × {room.height} units
                </span>
                {/* Retiring a room UNPLACES its tables rather than deleting them — said
                    here, because "remove" on a screen full of tables reads as destructive
                    and a manager should know it is not. */}
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await retireRoomAction(room.id)
                      if (!apply(result)) return
                      setRoomId(result.rooms[0]?.id ?? null)
                      toast.success('Room removed. Its tables are back on the list.')
                    })
                  }
                >
                  <Icons.Trash size={14} />
                  Remove {room.name}
                </Button>
              </>
            )}
          </div>
        )}

        {addingRoom && (
          <div className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface-2 p-3">
            <Field label="Room name" className="min-w-48">
              <Input
                value={newRoom.name}
                onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })}
                placeholder="Inside, Patio, Upstairs..."
              />
            </Field>
            <Field label="Width" hint="Room units, not metres">
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
            <Button variant="primary" disabled={!newRoom.name.trim() || pending} onClick={addRoom}>
              Add
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setAddingRoom(false)}>
              Cancel
            </Button>
          </div>
        )}

        {room && (
          <>
            {changed.length > 0 && (
              <Callout tone="warning">
                Nothing is saved yet. The till still shows the last saved arrangement.
              </Callout>
            )}
            <FloorCanvas
              room={room}
              tables={tables}
              placements={draft}
              features={features}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={move}
              busy={pending}
              onAddFeature={(kind) =>
                startTransition(async () => {
                  const result = await saveFeatureAction({
                    roomId: room.id,
                    kind,
                    label: kind === 'text' ? 'Label' : '',
                    /* Dropped near the top-left but not ON it, so a new wall never lands
                       exactly under the last one and become impossible to separate. */
                    x: 4 + ((features.length * 3) % 20),
                    y: 4 + ((features.length * 3) % 20),
                    width: kind === 'wall' ? 24 : 10,
                    height: kind === 'wall' ? 2 : 6,
                    rotation: 0,
                  })
                  apply(result)
                })
              }
              onMoveFeature={(id, next) =>
                startTransition(async () => {
                  const feature = features.find((f) => f.id === id)
                  if (!feature) return
                  apply(await saveFeatureAction({ ...feature, ...next }))
                })
              }
              onDeleteFeature={(id) =>
                startTransition(async () => {
                  apply(await deleteFeatureAction(id))
                })
              }
            />
          </>
        )}
      </CardBody>
    </Card>
  )
}
