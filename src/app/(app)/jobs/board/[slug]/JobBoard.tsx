'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { Badge, EmptyState, Icons, useToast, type BadgeTone } from '@/components/ui'
import type { BoardColumn, BoardCard } from '@/lib/site/jobBoards'
import { PRIORITY_LABEL, PRIORITY_TONE, storedMillis, type JobPriority } from '@/lib/jobStatusModel'
import { moveCardAction } from '../../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/**
 * The board.
 *
 * ── WHY pointerWithin AND NOT closestCorners ───────────────────────────────
 *
 * `closestCorners` always answers with SOMETHING: it ranks every droppable by
 * distance and returns the nearest, however far away the pointer is. For
 * rearranging a list that is right — an item dragged loosely towards a gap
 * should land in it.
 *
 * For a kanban card it is wrong, and wrong in the way that matters most. Picking
 * a card up and putting it back down is how everybody cancels a drag they have
 * changed their mind about. With closestCorners, releasing over empty page
 * still resolves to the nearest column, so the release reads as a drop — and a
 * job silently changes status, with an audit entry saying somebody meant it.
 *
 * `pointerWithin` answers only when the pointer is genuinely inside a column and
 * otherwise answers nothing at all, which gives the release somewhere to mean
 * "not there". The Builder made this same call for the same reason; see its
 * header. A status change is far less recoverable than a page section, so this
 * is the strictness that belongs here.
 *
 * ── THE DRAG IS NOT A LIGHTER PATH THAN THE DROPDOWN ───────────────────────
 *
 * moveCardAction calls the same setStatus() the status field calls, so the same
 * refusals apply — most importantly that a job with undecided costs cannot be
 * closed. Dragging a card onto Work Completed refuses with the same sentence,
 * and the card springs back. The PRD requires exactly this, and a board that
 * bypassed it would be the way around every guard on the job screen.
 */
export default function JobBoard({
  boardSlug,
  columns,
  canMove,
}: {
  boardSlug: string
  columns: BoardColumn[]
  canMove: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [, start] = useTransition()

  const [dragging, setDragging] = useState<BoardCard | null>(null)
  /*
   * Where a card has been moved to, before the server confirms it.
   *
   * Held so the card appears in its new column the instant it is dropped rather
   * than after a round trip — a board that lags a drag by 400ms feels broken.
   * Cleared by router.refresh() on success, and on failure the entry is dropped
   * so the card snaps back to where the server still says it is.
   */
  const [moved, setMoved] = useState<Record<number, number>>({})

  /*
   * Which cards are late, decided AFTER mount.
   *
   * Lateness is a comparison against the current time, and the current time on
   * the server is not the current time in the browser. Rendering it during the
   * first pass makes any card sitting near its due moment differ between the two
   * and fails hydration. Starting empty and filling it in an effect means the
   * first paint matches the server exactly, and the badge appears a frame later.
   */
  const [lateIds, setLateIds] = useState<ReadonlySet<number>>(new Set())

  /*
   * Whether the browser has taken over.
   *
   * DndContext and DragOverlay both render browser-only machinery — a portal, and
   * accessibility live-regions with generated ids — that has no server
   * equivalent. Rendering them on the first pass makes the server HTML and the
   * client tree disagree, and React reports the whole page as a hydration
   * mismatch rather than the one node.
   *
   * So the first paint is the plain board: real columns, real cards, every link
   * working. The drag machinery mounts a frame later. A board that cannot be
   * dragged for one frame is a far smaller problem than a board that logs a
   * hydration error and re-renders itself from scratch.
   */
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  useEffect(() => {
    const now = Date.now()
    const late = new Set<number>()
    for (const card of columns.flatMap((c) => c.cards)) {
      if (card.dueAt === null) continue
      if (storedMillis(card.dueAt) < now) late.add(card.id)
    }
    setLateIds(late)
  }, [columns])

  const sensors = useSensors(
    // 6px before a drag starts, so a click through to the job is not read as a
    // drag by a hand that moved slightly.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Long-press on a tablet, so the board can still be scrolled with a finger.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const cardsFor = (column: BoardColumn) => {
    const kept = column.cards.filter((card) => (moved[card.id] ?? column.statusId) === column.statusId)
    // Cards dragged in from elsewhere, so the column they landed in shows them.
    const arrived = columns
      .filter((other) => other.statusId !== column.statusId)
      .flatMap((other) => other.cards)
      .filter((card) => moved[card.id] === column.statusId)
    return [...arrived, ...kept]
  }

  function onDragStart(event: DragStartEvent) {
    const card = columns.flatMap((c) => c.cards).find((c) => `card-${c.id}` === String(event.active.id))
    setDragging(card ?? null)
  }

  function onDragEnd(event: DragEndEvent) {
    const card = dragging
    setDragging(null)
    // No `over` means the pointer was not inside any column. That is a cancel,
    // and the whole reason pointerWithin is the collision strategy.
    if (!card || !event.over) return

    const target = Number(String(event.over.id).replace('col-', ''))
    if (!Number.isFinite(target)) return

    const from = columns.find((c) => c.cards.some((x) => x.id === card.id))
    const current = moved[card.id] ?? from?.statusId
    if (current === target) return

    setMoved((prev) => ({ ...prev, [card.id]: target }))

    start(async () => {
      const result = await moveCardAction(card.id, target, boardSlug)
      if (!result.ok) {
        // Put it back where the server still has it, and say why.
        setMoved((prev) => {
          const next = { ...prev }
          delete next[card.id]
          return next
        })
        toast.error(result.error)
        return
      }
      setMoved({})
      router.refresh()
    })
  }

  if (columns.length === 0) {
    return (
      <EmptyState
        title="This board has no columns"
        hint="A board shows the statuses you choose for it. Pick some under Setup and every job in them appears here."
        icon={<Icons.LayoutGrid size={22} />}
      />
    )
  }

  /* One horizontal scroller. Columns keep a fixed width so a board of nine
     statuses scrolls rather than squeezing each to unreadable. */
  const grid = (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((column) => (
        <Column
          key={column.statusId}
          column={column}
          cards={cardsFor(column)}
          lateIds={lateIds}
          canMove={canMove && ready}
          onOpen={(id) => router.push(`/jobs/${id}`)}
        />
      ))}
    </div>
  )

  // The server pass, and the first client pass, render exactly this.
  if (!ready || !canMove) return grid

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {grid}
      <DragOverlay dropAnimation={null}>
        {dragging ? <CardFace card={dragging} overdue={lateIds.has(dragging.id)} dragging /> : null}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  column,
  cards,
  lateIds,
  canMove,
  onOpen,
}: {
  column: BoardColumn
  cards: BoardCard[]
  lateIds: ReadonlySet<number>
  canMove: boolean
  onOpen: (id: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${column.statusId}`, disabled: !canMove })

  return (
    <section
      ref={setNodeRef}
      /* shrink-0 so a column keeps its width inside the flex scroller instead of
         being crushed by its siblings — the flex-column trap this repo has hit
         before. */
      className={`flex w-72 shrink-0 flex-col rounded-card border bg-surface-2 transition-colors ${
        isOver ? 'border-brand bg-brand-soft' : 'border-border'
      }`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Badge tone={TONE[column.tone] ?? 'neutral'}>{column.name}</Badge>
          {/* The count is the number a dispatcher reads first, so it is plain
              text rather than a second badge competing with the status. */}
          <span className="numeric text-xs text-muted">{cards.length}</span>
        </div>
        {column.isClosed && <span className="text-xs text-muted">Closed</span>}
      </header>

      <div className="flex min-h-24 flex-col gap-2 p-2">
        {cards.length === 0 ? (
          <p className="px-1 py-3 text-xs text-faint">
            {canMove ? 'Nothing here. Drag a card in.' : 'Nothing here.'}
          </p>
        ) : (
          cards.map((card) => (
            <DraggableCard
              key={card.id}
              card={card}
              overdue={lateIds.has(card.id)}
              canMove={canMove}
              onOpen={() => onOpen(card.id)}
            />
          ))
        )}
        {column.overflow > 0 && (
          /* Silent truncation reads as "that is all of them". */
          <p className="px-1 pt-1 text-xs text-muted">
            + {column.overflow} more not shown — use the job list
          </p>
        )}
      </div>
    </section>
  )
}

function DraggableCard({
  card,
  overdue,
  canMove,
  onOpen,
}: {
  card: BoardCard
  overdue: boolean
  canMove: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card-${card.id}`,
    disabled: !canMove,
  })

  /*
   * A real <button>, not a div with role="button".
   *
   * dnd-kit's `attributes` already supply role, tabIndex and the aria-describedby
   * that announces the drag instructions — adding my own on top gave the element
   * two of each, and the second copy is what the hydration mismatch was. A native
   * button also gets Enter and Space for free, which the hand-rolled keydown only
   * half-implemented.
   */
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className={`w-full cursor-pointer text-left ${isDragging ? 'opacity-40' : ''}`}
    >
      <CardFace card={card} overdue={overdue} />
    </button>
  )
}

/**
 * The card itself, shared by the column and the drag overlay so the thing under
 * the cursor is the thing that will land.
 *
 * Four facts and no more: the number, the work, who it is for, who has it. A
 * card that tried to show the costs would be unreadable at the distance a board
 * is actually looked at.
 */
function CardFace({
  card,
  overdue = false,
  dragging = false,
}: {
  card: BoardCard
  /**
   * Passed in rather than computed here.
   *
   * `Date.now()` differs between the server render and the client hydration, so
   * computing lateness in the component makes a card that is due within the
   * round trip render one way on the server and the other in the browser — a
   * hydration mismatch, which React reports as the whole tree being wrong. The
   * comparison happens once, in an effect after mount, where only the client
   * ever runs it.
   */
  overdue?: boolean
  dragging?: boolean
}) {
  const priority = card.priority as JobPriority

  /* A div, not an <article>: this sits inside the card's <button>, and the HTML
     content model forbids sectioning content there. React reports that as
     invalid nesting during hydration rather than at build time. */
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-control border border-border bg-surface p-2.5 ${
        dragging ? 'shadow-pop' : 'shadow-card'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="numeric text-xs text-muted">{card.documentNumber ?? `#${card.id}`}</span>
        {/* Only above Normal earns a badge: most jobs are normal, and a column
            where every card is coloured is a column where colour says nothing. */}
        {(priority === 'urgent' || priority === 'high') && (
          <Badge tone={TONE[PRIORITY_TONE[priority]] ?? 'neutral'}>{PRIORITY_LABEL[priority]}</Badge>
        )}
      </div>

      <p className="text-sm leading-snug text-ink">{card.title}</p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted">{card.customerName ?? 'Walk-in'}</span>
        {card.ownerName ? (
          <span className="text-ink-2">· {card.ownerName}</span>
        ) : (
          <span className="text-warning">· Nobody</span>
        )}
      </div>

      {(overdue || card.pendingCount > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {overdue && <Badge tone="danger">Overdue</Badge>}
          {/* The money-leaking condition, on the card, because it is the reason a
              job cannot be closed and the dispatcher should see it before trying. */}
          {card.pendingCount > 0 && (
            <Badge tone="warning">
              {card.pendingCount} to decide
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}
