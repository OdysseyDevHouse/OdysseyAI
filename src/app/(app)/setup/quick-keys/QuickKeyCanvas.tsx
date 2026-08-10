'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Icons,
  useToast,
} from '@/components/ui'
import {
  groupMembers,
  quickKeyLabel,
  topLevelKeys,
  SUPERVISOR_GROUP_SIG,
  type QuickKeyRow,
} from '@/lib/quickKeys'
import {
  createQuickKeyGroupAction,
  deleteQuickKeyAction,
  moveQuickKeyAction,
  updateQuickKeyAction,
} from './actions'
import { KeyTile } from './KeyTile'
import { KeyInspector } from './KeyInspector'
import { AddKeyModal } from './AddKeyModal'

/**
 * Arranging the till's quick keys.
 *
 * ── THE GESTURE ───────────────────────────────────────────────────────────
 *
 *   key onto the MIDDLE of a key   → make a group of the two
 *   key onto a GROUP               → file it inside
 *   key onto the OUTER third       → reorder, caret shows where
 *   key onto the Back tile         → take it out of the group
 *
 * One drag, four outcomes, decided by where in the target the pointer is. The
 * alternative — a mode switch, or a right-click menu — makes the common act (reorder)
 * cost the same as the rare one (group), and a shop reorders far more than it groups.
 *
 * ── WHAT IS BORROWED FROM BuilderCanvas, AND WHY ───────────────────────────
 *
 * The sensor set, the fixed `DndContext id`, the announcements and the cheap
 * DragOverlay all come from the storefront builder, which learned each of them the hard
 * way. The comments there explain them; the two worth repeating are the id (dnd-kit
 * derives aria ids from a module counter the server restarts at 0, so an unnamed context
 * is a hydration mismatch on every load) and clearing state in `onDragCancel` (or the
 * overlay parks over the canvas and eats every click).
 *
 * ── AND WHAT IS NOT ───────────────────────────────────────────────────────
 *
 * `MeasuringStrategy.Always`, which the builder does not need. This canvas SWAPS its
 * contents mid-drag: dragging onto a group opens it. Measured once, dnd-kit would keep
 * collision rects for tiles that have since moved, and the drop would land against the
 * old layout.
 *
 * `onDragOver` is wired to the same handler as `onDragMove` for a related reason:
 * dnd-kit reports a change of target as a separate DragOver AFTER its collision pass, so
 * with a stationary pointer over a newly-arrived tile nothing else fires.
 */

const KEY_LIMIT = 60

export default function QuickKeyCanvas({
  initialKeys,
  productNames,
  departmentNames,
}: {
  initialKeys: QuickKeyRow[]
  /** Resolved server-side: a product key with no caption reads its product's name. */
  productNames: Record<number, string>
  departmentNames: Record<number, string>
}) {
  const [keys, setKeys] = useState(initialKeys)
  const [pending, startAction] = useTransition()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const toast = useToast()

  const [dragId, setDragId] = useState<number | null>(null)
  const [intent, setIntent] = useState<{
    overId: number
    where: 'before' | 'after' | 'into'
  } | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    /* Long-press before a drag starts, so the canvas can still be SCROLLED with a
       finger on the tablet a manager is likely holding — and so a tap still opens a
       group rather than starting a drag nobody wanted. */
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const bar = useMemo(() => topLevelKeys(keys), [keys])
  const openGroup = openGroupId ? keys.find((k) => k.id === openGroupId) : null
  const members = useMemo(
    () => (openGroupId ? groupMembers(keys, openGroupId) : []),
    [keys, openGroupId],
  )
  const shown = openGroup ? members : bar
  const selected = selectedId ? (keys.find((k) => k.id === selectedId) ?? null) : null

  /** What a key should say — its own caption, or the thing it points at. */
  const labelFor = (key: QuickKeyRow) =>
    quickKeyLabel(
      key,
      key.kind === 'product'
        ? productNames[key.productId ?? -1]
        : key.kind === 'department'
          ? departmentNames[key.departmentId ?? -1]
          : null,
    )

  /** Applies a server result, or reports why it refused. */
  const apply = (result: Awaited<ReturnType<typeof moveQuickKeyAction>>) => {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    // Replaces state wholesale — positions were renumbered server-side, and a local
    // guess at the new order would drift from what the till draws.
    setKeys(result.keys)
  }

  /* ── The drag ──────────────────────────────────────────────────────────── */

  function handleStart(event: DragStartEvent) {
    setDragId(Number(event.active.data.current?.keyId ?? 0) || null)
    setIntent(null)
  }

  /**
   * Works out what the drop would mean, from geometry.
   *
   * The outer third of a tile reorders; the middle nests. A GROUP is all middle — its
   * whole surface means "file it in here", because that is the only thing dropping onto
   * a folder can sensibly do, and a caret beside a folder would be ambiguous with
   * putting the key inside it.
   */
  function handleMove(event: DragMoveEvent | DragOverEvent) {
    const overId = Number(event.over?.data.current?.keyId ?? 0)
    const activeId = Number(event.active.data.current?.keyId ?? 0)
    if (!overId || overId === activeId) {
      setIntent(null)
      return
    }

    const overIsGroup = Boolean(event.over?.data.current?.isGroup)
    if (overIsGroup) {
      setIntent({ overId, where: 'into' })
      return
    }

    const rect = event.over?.rect
    const activeRect = event.active.rect.current.translated
    if (!rect || !activeRect) {
      setIntent({ overId, where: 'into' })
      return
    }

    /* The dragged tile's CENTRE against the target's thirds. Using the pointer would be
       more direct, but dnd-kit's keyboard sensor has no pointer — and a gesture that
       only works with a mouse is one a keyboard user cannot group with. */
    const centre = activeRect.left + activeRect.width / 2
    const third = rect.width / 3
    setIntent({
      overId,
      where:
        centre < rect.left + third
          ? 'before'
          : centre > rect.left + rect.width - third
            ? 'after'
            : 'into',
    })
  }

  function handleEnd(event: DragEndEvent) {
    const activeId = Number(event.active.data.current?.keyId ?? 0)
    const decided = intent
    setDragId(null)
    setIntent(null)
    if (!activeId || !decided) return

    const source = keys.find((k) => k.id === activeId)
    const target = keys.find((k) => k.id === decided.overId)
    if (!source || !target) return

    if (decided.where === 'into') {
      startAction(async () => {
        if (target.kind === 'group') {
          apply(await moveQuickKeyAction(activeId, { parentId: target.id, index: 0 }))
          return
        }
        /*
         * Two plain keys becoming a group. The group takes the TARGET's name and
         * colour, so the folder looks like the key that was already there — a shop
         * dropping "Fanta" onto "Coke" gets a "Coke" folder, which reads as the drawer
         * it just opened rather than an unnamed box.
         */
        const caption = labelFor(target).slice(0, 60)
        apply(
          await createQuickKeyGroupAction(
            { caption, icon: target.icon || 'Shapes', colourToken: target.colourToken },
            [target.id, activeId],
          ),
        )
      })
      return
    }

    // Reorder within whatever scope the target is in.
    const scope = shown.filter((k) => k.id !== activeId)
    const at = scope.findIndex((k) => k.id === target.id)
    const index = decided.where === 'before' ? Math.max(at, 0) : at + 1
    startAction(async () => {
      apply(await moveQuickKeyAction(activeId, { parentId: openGroupId ?? null, index }))
    })
  }

  const dragged = dragId ? keys.find((k) => k.id === dragId) : null

  return (
    <DndContext
      /* Fixed, for the hydration reason BuilderCanvas documents at length. */
      id="quick-key-designer"
      sensors={sensors}
      collisionDetection={closestCenter}
      /* Re-measured continuously: opening a group swaps the whole grid mid-drag, and
         stale rects would land the drop against the old layout. */
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleStart}
      onDragMove={handleMove}
      /* Same handler: dnd-kit reports a target CHANGE as a separate DragOver after its
         collision pass, so a stationary pointer over a newly-arrived tile fires nothing
         else. Without this the intent goes stale exactly when a group springs open. */
      onDragOver={handleMove}
      onDragEnd={handleEnd}
      onDragCancel={() => {
        setDragId(null)
        setIntent(null)
      }}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${nameOf(active, keys, labelFor)}. Use the arrow keys to move it, space to drop.`,
          onDragOver: () =>
            intent
              ? intent.where === 'into'
                ? `Will file into ${labelFor(keys.find((k) => k.id === intent.overId)!)}.`
                : `Will place ${intent.where} ${labelFor(keys.find((k) => k.id === intent.overId)!)}.`
              : '',
          onDragEnd: ({ active }) => `${nameOf(active, keys, labelFor)} dropped.`,
          onDragCancel: ({ active }) => `Moving ${nameOf(active, keys, labelFor)} was cancelled.`,
        },
      }}
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        <Card className="flex-1">
          <CardHeader
            title={openGroup ? labelFor(openGroup) : 'The till’s keys'}
            description={
              openGroup
                ? 'Inside this group. Drag a key onto Back to take it out.'
                : 'Drag a key onto another to group them. Drop on the edge of a key to reorder.'
            }
            action={
              <div className="flex items-center gap-2">
                {openGroup && (
                  <Button variant="ghost" size="sm" onClick={() => setOpenGroupId(null)}>
                    <Icons.Reverse size={14} />
                    Back
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending || bar.length >= KEY_LIMIT}
                  onClick={() => setAdding(true)}
                >
                  <Icons.Plus size={14} />
                  Add a key
                </Button>
              </div>
            }
          />

          {/* A shop past the ceiling has a bar nobody can read, and the honest answer is
              to say so rather than to keep accepting keys. */}
          {bar.length >= KEY_LIMIT && (
            <Callout tone="warning" title="That is a lot of keys">
              {KEY_LIMIT} is as many as one bar can usefully hold. Group some of them —
              a folder of eight reads faster than sixty in a row.
            </Callout>
          )}

          <div className="p-4">
            {shown.length === 0 ? (
              <EmptyState
                icon={<Icons.LayoutGrid size={22} />}
                title={openGroup ? 'This group is empty' : 'No quick keys yet'}
                hint={
                  openGroup
                    ? 'Drag keys in from the bar, or delete the group to tidy up.'
                    : 'Add the six things this shop sells most, and a cashier stops hunting for them.'
                }
                action={
                  <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                    <Icons.Plus size={14} />
                    Add a key
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-wrap gap-3">
                {shown.map((key) => (
                  <KeyTile
                    key={key.id}
                    keyRow={key}
                    label={labelFor(key)}
                    isGroup={key.kind === 'group'}
                    memberCount={groupMembers(keys, key.id).length}
                    dragging={dragId === key.id}
                    intent={intent?.overId === key.id ? intent.where : null}
                    selected={selectedId === key.id}
                    onSelect={() => {
                      /* A tap on a GROUP opens it; a tap on a key selects it for the
                         inspector. Two different things from one gesture, but they are
                         never ambiguous — a folder has nothing to inspect but its own
                         name, which the inspector still shows once it is open. */
                      if (key.kind === 'group') {
                        setOpenGroupId(key.id)
                        setSelectedId(key.id)
                      } else {
                        setSelectedId(key.id)
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>

        <KeyInspector
          keyRow={selected}
          label={selected ? labelFor(selected) : ''}
          busy={pending}
          canDelete={selected?.sig !== SUPERVISOR_GROUP_SIG}
          onChange={(changes) => {
            if (!selected) return
            startAction(async () => apply(await updateQuickKeyAction(selected.id, changes)))
          }}
          onDelete={() => {
            if (!selected) return
            startAction(async () => {
              const result = await deleteQuickKeyAction(selected.id)
              apply(result)
              if (result.ok) {
                setSelectedId(null)
                if (openGroupId === selected.id) setOpenGroupId(null)
              }
            })
          }}
        />
      </div>

      {/*
        A cheap chip, never the real tile.
        Keyed off `dragId` rather than `selectedId` — DragOverlay portals a floating
        element at the cursor, so leaving it mounted for a merely SELECTED key parks an
        invisible chip over the canvas that swallows every click after it.
      */}
      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div
            data-kit-ok
            className="flex size-24 items-center justify-center rounded-card border-2 border-brand bg-surface px-1 text-center text-[11px] font-semibold text-ink shadow-pop"
          >
            {labelFor(dragged)}
          </div>
        ) : null}
      </DragOverlay>

      <AddKeyModal
        open={adding}
        section="main"
        parentId={openGroupId}
        onClose={() => setAdding(false)}
        onAdded={(fresh) => {
          setKeys(fresh)
          setAdding(false)
        }}
      />
    </DndContext>
  )
}

/** A dragged item's name, for the screen-reader announcements. */
function nameOf(
  active: { data: { current?: Record<string, unknown> | null } },
  keys: readonly QuickKeyRow[],
  labelFor: (key: QuickKeyRow) => string,
): string {
  const id = Number(active.data.current?.keyId ?? 0)
  const found = keys.find((k) => k.id === id)
  return found ? labelFor(found) : 'key'
}
