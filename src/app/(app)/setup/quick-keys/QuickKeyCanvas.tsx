'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
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
  Tabs,
  useToast,
} from '@/components/ui'
import {
  groupMembers,
  quickKeyLabel,
  topLevelKeys,
  QUICK_KEY_SECTIONS,
  SUPERVISOR_GROUP_SIG,
  type QuickKeyRow,
  type QuickKeySection,
} from '@/lib/quickKeys'
import {
  applyQuickKeyTemplateAction,
  bulkDeleteQuickKeysAction,
  bulkMoveQuickKeysAction,
  bulkUpdateQuickKeysAction,
  createQuickKeyAction,
  createQuickKeyGroupAction,
  deleteQuickKeyAction,
  moveQuickKeyAction,
  updateQuickKeyAction,
} from './actions'
import { KeyTile } from './KeyTile'
import { KeyInspector } from './KeyInspector'
import { AddKeyModal } from './AddKeyModal'
import { BackTile, AppendZone } from './DropZones'
import { KeyLibrary, type NewKeyDraft } from './KeyLibrary'
import { SelectionBar } from './SelectionBar'
import { STARTER_TEMPLATES } from './templates'

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
  hospitality,
}: {
  initialKeys: QuickKeyRow[]
  /** Resolved server-side: a product key with no caption reads its product's name. */
  productNames: Record<number, string>
  departmentNames: Record<number, string>
  /** A restaurant till, which has a second bar for when a table is open. */
  hospitality: boolean
}) {
  const [keys, setKeys] = useState(initialKeys)
  const [pending, startAction] = useTransition()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [section, setSection] = useState<QuickKeySection>('main')
  /* Ticked for a bulk change. A Set of ids rather than a flag on each key, so the
     selection survives the whole list being replaced by a server reply — which happens
     after every single mutation on this screen. */
  const [tickedIds, setTickedIds] = useState<Set<number>>(new Set())
  /* Where a shift-click measures from — the last key ticked without shift. */
  const anchorId = useRef<number | null>(null)
  const toast = useToast()

  const [dragId, setDragId] = useState<number | null>(null)
  /* A library row in the air. Held separately from `dragId` because a draft has no id
     yet — it is not a row until it lands — and the two drags end differently. */
  const [draggedDraft, setDraggedDraft] = useState<NewKeyDraft | null>(null)
  /**
   * What the drop would do.
   *
   * `overId` is a key for before/after/into and 0 for the two zone targets, which are
   * not keys and have exactly one outcome each — `out` promotes to the bar, `append`
   * sends to the end of whatever scope is open.
   */
  const [intent, setIntent] = useState<{
    overId: number
    where: 'before' | 'after' | 'into' | 'out' | 'append'
  } | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    /* Long-press before a drag starts, so the canvas can still be SCROLLED with a
       finger on the tablet a manager is likely holding — and so a tap still opens a
       group rather than starting a drag nobody wanted. */
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  /**
   * Rect first, pointer as the fallback — and never the dragged tile itself.
   *
   * `closestCenter` was wrong here for the reason a sibling note in this repo records
   * about `closestCorners`: it ALWAYS returns a nearest container, so there is no
   * "over nothing". A drag that has wandered onto the page margin still reported a
   * target, and the tile it named was frequently the one being dragged — which is
   * both a droppable and the active item, since KeyTile composes the two on one node.
   *
   * Excluding self is what makes "no valid target" expressible, which is what lets a
   * drag be abandoned by dropping it somewhere harmless.
   */
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const active = String(args.active.id)
    const containers = args.droppableContainers.filter(
      (c) => String(c.id) !== `drop-${String(args.active.data.current?.keyId ?? '')}` &&
        String(c.id) !== active,
    )
    const overlapping = rectIntersection({ ...args, droppableContainers: containers })
    return overlapping.length > 0
      ? overlapping
      : pointerWithin({ ...args, droppableContainers: containers })
  }, [])

  /**
   * Spring-open: hold a drag over a folder and the canvas walks into it.
   *
   * Without it, filing a key into a group you then want to ORDER inside means two
   * separate drags with a tap between them. 650ms is long enough that merely crossing
   * a folder on the way somewhere else does not open it.
   *
   * The timer is cleared on every target change, on drop and on cancel — a surviving
   * timer would navigate the canvas after the drag it belonged to had ended.
   */
  const spring = useRef<{ id: number; timer: ReturnType<typeof setTimeout> } | null>(null)

  const clearSpring = useCallback(() => {
    if (spring.current) {
      clearTimeout(spring.current.timer)
      spring.current = null
    }
  }, [])

  // A drag interrupted by an unmount (a navigation mid-gesture) would otherwise leave
  // its timer to fire against a canvas that is gone.
  useEffect(() => clearSpring, [clearSpring])

  /* The bars a manager can arrange here. A retail shop gets one, so the tab strip is
     hidden entirely rather than shown with a single tab in it. */
  const sections = useMemo(
    () => QUICK_KEY_SECTIONS.filter((s) => hospitality || !s.hospitalityOnly),
    [hospitality],
  )
  const sectionMeta = sections.find((s) => s.section === section) ?? sections[0]

  const bar = useMemo(() => topLevelKeys(keys, section), [keys, section])
  const openGroup = openGroupId ? keys.find((k) => k.id === openGroupId) : null
  const members = useMemo(
    () => (openGroupId ? groupMembers(keys, openGroupId) : []),
    [keys, openGroupId],
  )
  const shown = openGroup ? members : bar
  const selected = selectedId ? (keys.find((k) => k.id === selectedId) ?? null) : null

  /* A till nobody has arranged yet. The supervisor folder is discounted because every
     till has one from its first load — counting it would mean the starters were never
     on offer to anybody. Matches the server's own test. */
  const isFresh = keys.every((k) => k.sig === SUPERVISOR_GROUP_SIG)

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

  /**
   * Switching bars.
   *
   * Clears the open group and the selection, because both belong to the bar being
   * left: a folder on the main bar is not on the tables bar, and an inspector still
   * showing a key the canvas no longer draws is a panel editing something invisible.
   */
  const switchSection = (next: QuickKeySection) => {
    setSection(next)
    setOpenGroupId(null)
    setSelectedId(null)
    /* Ticks belong to the bar being left. Carried across, a bulk action would act on
       keys the manager can no longer see. */
    clearTicks()
  }

  /**
   * Ticking a key, with shift extending a range.
   *
   * The range runs over `shown` — what is on screen in the order it is drawn — so
   * shift-clicking two tiles selects what a manager sees between them, which is not the
   * same as what lies between them by id or by stored position.
   */
  const toggleTick = (id: number, additive: boolean) => {
    setTickedIds((prev) => {
      const next = new Set(prev)
      const anchor = anchorId.current

      if (additive && anchor !== null && anchor !== id) {
        const from = shown.findIndex((k) => k.id === anchor)
        const to = shown.findIndex((k) => k.id === id)
        if (from >= 0 && to >= 0) {
          for (const k of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            next.add(k.id)
          }
          return next
        }
      }

      if (next.has(id)) next.delete(id)
      else next.add(id)
      /* The anchor follows the last PLAIN click. A shift-click extending a range must
         not move it, or a second shift-click would measure from the wrong end. */
      anchorId.current = id
      return next
    })
  }

  const clearTicks = () => {
    setTickedIds(new Set())
    anchorId.current = null
  }

  /** The ticked keys, in the order they are drawn. */
  const tickedKeys = shown.filter((k) => tickedIds.has(k.id))

  /**
   * Applies a bulk result and clears the selection.
   *
   * Cleared on success because the keys a manager ticked have now been changed — and
   * leaving eight tiles ticked after a recolour invites a second recolour of the same
   * eight. Kept on failure, so the selection is still there to retry with.
   */
  const applyBulk = (result: Awaited<ReturnType<typeof moveQuickKeyAction>>, done: string) => {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setKeys(result.keys)
    toast.success(done)
    clearTicks()
  }

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

  /**
   * Creates a key from a library draft, at the end of the open scope.
   *
   * The one path for both routes — clicking a library row and dropping one on the
   * canvas do exactly the same thing, so they must not be two implementations that can
   * disagree about which bar or which folder the key lands in.
   */
  const addDraft = (draft: NewKeyDraft) => {
    startAction(async () => {
      const result = await createQuickKeyAction({
        section,
        parentId: openGroupId,
        target: draft.target,
        icon: draft.icon,
        colourToken: draft.colourToken,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Key added.')
      setKeys(result.keys)
    })
  }

  function handleStart(event: DragStartEvent) {
    const draft = event.active.data.current?.draft as NewKeyDraft | undefined
    setDraggedDraft(draft ?? null)
    setDragId(Number(event.active.data.current?.keyId ?? 0) || null)
    setIntent(null)
    clearSpring()
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
    const overData = event.over?.data.current
    const activeId = Number(event.active.data.current?.keyId ?? 0)

    /* The two zone targets first — neither is a key, so neither has thirds to measure
       and both would fail the `overId` test below. */
    if (overData?.out) {
      clearSpring()
      setIntent({ overId: 0, where: 'out' })
      return
    }
    if (overData?.append) {
      clearSpring()
      setIntent({ overId: 0, where: 'append' })
      return
    }

    const overId = Number(overData?.keyId ?? 0)
    if (!overId || overId === activeId) {
      clearSpring()
      setIntent(null)
      return
    }

    const overIsGroup = Boolean(overData?.isGroup)
    if (overIsGroup) {
      /* Arm the spring only when the target CHANGES — re-arming on every mouse move
         over the same folder would restart the clock and it would never fire. */
      if (spring.current?.id !== overId) {
        clearSpring()
        spring.current = {
          id: overId,
          timer: setTimeout(() => {
            spring.current = null
            setOpenGroupId(overId)
            setSelectedId(overId)
            setIntent(null)
          }, 650),
        }
      }
      setIntent({ overId, where: 'into' })
      return
    }

    clearSpring()

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
    const draft = event.active.data.current?.draft as NewKeyDraft | undefined
    const decided = intent
    setDragId(null)
    setDraggedDraft(null)
    setIntent(null)
    clearSpring()

    /* A brand-new key, dropped anywhere on the canvas. Appended regardless of where it
       landed — see KeyLibrary on why placing it precisely is deliberately a second
       drag. `event.over` alone is the test: a draft released over nothing is a drag
       abandoned, not a key at the end of the bar. */
    if (draft) {
      if (event.over) addDraft(draft)
      return
    }

    if (!activeId || !decided) return

    const source = keys.find((k) => k.id === activeId)
    if (!source) return

    /* Out of the group, onto the bar. Appended rather than restored to some remembered
       slot — the key has not been on the bar since it was filed away, so there is no
       old position to put it back into, and the end is where the eye is already
       looking after a drag to the Back tile. */
    if (decided.where === 'out') {
      if (source.parentId === null) return
      startAction(async () => {
        apply(
          await moveQuickKeyAction(activeId, { parentId: null, index: topLevelKeys(keys).length }),
        )
      })
      return
    }

    /* The end of whatever scope is open. `shown` still contains the dragged key, so
       its length is the index AFTER removal only when the key is coming from another
       scope; within the same scope the last slot is one lower. */
    if (decided.where === 'append') {
      const sameScope = (source.parentId ?? null) === (openGroupId ?? null)
      startAction(async () => {
        apply(
          await moveQuickKeyAction(activeId, {
            parentId: openGroupId ?? null,
            index: sameScope ? shown.length - 1 : shown.length,
          }),
        )
      })
      return
    }

    const target = keys.find((k) => k.id === decided.overId)
    if (!target) return

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
            {
              section,
              caption,
              icon: target.icon || 'Shapes',
              colourToken: target.colourToken,
            },
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
      collisionDetection={collisionDetection}
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
        setDraggedDraft(null)
        setIntent(null)
        clearSpring()
      }}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${nameOf(active, keys, labelFor)}. Use the arrow keys to move it, space to drop.`,
          onDragOver: () => {
            if (!intent) return ''
            if (intent.where === 'out') return 'Will take it out of the group.'
            if (intent.where === 'append') return 'Will place it last.'
            const over = keys.find((k) => k.id === intent.overId)
            if (!over) return ''
            return intent.where === 'into'
              ? `Will file into ${labelFor(over)}.`
              : `Will place ${intent.where} ${labelFor(over)}.`
          },
          onDragEnd: ({ active }) => `${nameOf(active, keys, labelFor)} dropped.`,
          onDragCancel: ({ active }) => `Moving ${nameOf(active, keys, labelFor)} was cancelled.`,
        },
      }}
    >
      {/*
        The starters, offered only on a till nobody has arranged yet.
        Gone the moment the first key exists — a "start from a set" card above a bar a
        shop has already built is an offer to duplicate their work, and the action
        refuses it server-side anyway.
      */}
      {isFresh && (
        <Card className="mb-4">
          <CardHeader
            title="Start from a set"
            description="A working till in one press. Everything in it is an ordinary key — rename it, recolour it, take it apart."
          />
          <div className="flex flex-col gap-2 p-4 sm:flex-row">
            {STARTER_TEMPLATES.filter((t) => hospitality || !t.hospitalityOnly).map((t) => (
              <button
                key={t.key}
                type="button"
                data-kit-ok
                disabled={pending}
                onClick={() => {
                  startAction(async () => {
                    const result = await applyQuickKeyTemplateAction(t.key)
                    if (!result.ok) {
                      toast.error(result.error)
                      return
                    }
                    setKeys(result.keys)
                    toast.success('Starter keys added.')
                  })
                }}
                className="flex-1 rounded-card border border-border bg-surface p-4 text-left transition hover:border-brand hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="block text-sm font-semibold text-ink">{t.label}</span>
                <span className="mt-1 block text-xs text-muted">{t.description}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* One tab per bar, above the canvas — hidden on a retail till, which has one bar
          and would otherwise get a strip containing a single tab that does nothing. */}
      {sections.length > 1 && (
        <div className="mb-4">
          <Tabs
            aria-label="Which bar"
            items={sections.map((s) => ({
              value: s.section,
              label: s.label,
              /* The count is the point of showing it here: a manager arranging one bar
                 can see at a glance whether the other has been set up at all. */
              count: topLevelKeys(keys, s.section).length,
            }))}
            value={section}
            onChange={switchSection}
          />
          <p className="mt-2 text-sm text-muted">{sectionMeta.hint}</p>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <Card className="flex-1">
          <CardHeader
            title={openGroup ? labelFor(openGroup) : sectionMeta.label}
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

          {/* Replaces nothing — it appears above the grid when a selection exists and
              is gone the moment it is cleared. */}
          {tickedKeys.length > 0 && (
            <SelectionBar
              selected={tickedKeys}
              groups={bar.filter((k) => k.kind === 'group' && k.id !== openGroupId)}
              inGroup={openGroupId !== null}
              busy={pending}
              allSelected={tickedKeys.length === shown.length}
              onColour={(token) => {
                const ids = tickedKeys.map((k) => k.id)
                startAction(async () =>
                  applyBulk(
                    await bulkUpdateQuickKeysAction(ids, { colourToken: token }),
                    `${ids.length} keys recoloured.`,
                  ),
                )
              }}
              onMoveTo={(parentId) => {
                const ids = tickedKeys.map((k) => k.id)
                startAction(async () =>
                  applyBulk(
                    await bulkMoveQuickKeysAction(ids, parentId),
                    parentId === null
                      ? `${ids.length} keys moved to the bar.`
                      : `${ids.length} keys filed away.`,
                  ),
                )
              }}
              onDelete={() => {
                const ids = tickedKeys.map((k) => k.id)
                startAction(async () => {
                  const result = await bulkDeleteQuickKeysAction(ids)
                  applyBulk(result, `${ids.length} keys removed.`)
                  /* A deleted folder cannot stay open, and a deleted key cannot stay in
                     the inspector. */
                  if (result.ok) {
                    setSelectedId(null)
                    if (openGroupId !== null && ids.includes(openGroupId)) setOpenGroupId(null)
                  }
                })
              }}
              onSelectAll={() => setTickedIds(new Set(shown.map((k) => k.id)))}
              onClear={clearTicks}
            />
          )}

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
              /* The empty canvas is itself a drop target, or a draft dragged onto a bar
                 with nothing on it would have nowhere to land — which is exactly the
                 moment a shop is most likely to be dragging one. Back stays available
                 inside an empty group, so a key filed into it by mistake is not a
                 dead end. */
              <div className="flex flex-col gap-3">
                {openGroup && (
                  <div className="flex">
                    <BackTile
                      label="the bar"
                      active={intent?.where === 'out'}
                      onClick={() => setOpenGroupId(null)}
                    />
                  </div>
                )}
                {dragId !== null || draggedDraft ? (
                  <AppendZone active={intent?.where === 'append'} />
                ) : (
                  <EmptyState
                    icon={<Icons.LayoutGrid size={22} />}
                    title={openGroup ? 'This group is empty' : 'No quick keys yet'}
                    hint={
                      openGroup
                        ? 'Drag keys in from the bar, or delete the group to tidy up.'
                        : 'Drag one in from the right, or start from a set and edit it.'
                    }
                    action={
                      <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                        <Icons.Plus size={14} />
                        Add a key
                      </Button>
                    }
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                {/* Inside a group, Back is the FIRST tile — a fixed spot at the start of
                    the row, so it does not move as the group's contents change, and it
                    is the shortest drag from anywhere in the grid. */}
                {openGroup && (
                  <BackTile
                    label="the bar"
                    active={intent?.where === 'out'}
                    onClick={() => setOpenGroupId(null)}
                  />
                )}
                {shown.map((key) => (
                  <KeyTile
                    key={key.id}
                    keyRow={key}
                    label={labelFor(key)}
                    isGroup={key.kind === 'group'}
                    memberCount={groupMembers(keys, key.id).length}
                    dragging={dragId === key.id}
                    intent={
                      intent && intent.overId === key.id &&
                      (intent.where === 'before' || intent.where === 'after' || intent.where === 'into')
                        ? intent.where
                        : null
                    }
                    ticked={tickedIds.has(key.id)}
                    selecting={tickedIds.size > 0}
                    onTick={(additive) => toggleTick(key.id, additive)}
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
                {/* Only while something is in the air — see AppendZone on why a
                    permanent dashed box reads as a slot waiting to be filled. A library
                    draft counts: it needs somewhere to land on a full canvas. */}
                {(dragId !== null || draggedDraft) && (
                  <AppendZone active={intent?.where === 'append'} />
                )}
              </div>
            )}
          </div>
        </Card>

        {/* The rail and the inspector share the right-hand column: the inspector is
            about the ONE key selected, the library about every key not yet placed, and
            a manager moves between the two constantly while laying a bar out. Stacked
            rather than tabbed so neither is ever a click away. */}
        <div className="flex w-full flex-col gap-4 lg:w-80">
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

          <KeyLibrary
            keys={keys}
            section={section}
            hospitality={hospitality}
            busy={pending}
            onAdd={addDraft}
          />
        </div>
      </div>

      {/*
        A cheap chip, never the real tile.
        Keyed off `dragId` rather than `selectedId` — DragOverlay portals a floating
        element at the cursor, so leaving it mounted for a merely SELECTED key parks an
        invisible chip over the canvas that swallows every click after it.
      */}
      <DragOverlay dropAnimation={null}>
        {dragged || draggedDraft ? (
          <div
            data-kit-ok
            className="flex size-24 items-center justify-center rounded-card border-2 border-brand bg-surface px-1 text-center text-[11px] font-semibold text-ink shadow-pop"
          >
            {dragged ? labelFor(dragged) : draggedDraft?.label}
          </div>
        ) : null}
      </DragOverlay>

      <AddKeyModal
        open={adding}
        section={section}
        hospitality={hospitality}
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
