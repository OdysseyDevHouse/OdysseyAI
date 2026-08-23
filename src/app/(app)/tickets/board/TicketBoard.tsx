'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
import type { Ticket, TicketLane } from '@/lib/site/tickets'
import { TICKET_PRIORITY_LABEL, TICKET_PRIORITY_TONE } from '@/lib/ticketModel'
import { moveTicketAction } from '../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/**
 * The ticket board.
 *
 * ── DRAGGING IS THE TIMING ACT ─────────────────────────────────────────────
 *
 * This is the one thing that makes a ticket board different from a job board:
 * a lane carries a clock action, so moving a card into "In Progress" starts a
 * timer and moving it to "On Hold" stops one. The card shows which, and a
 * running card wears a live indicator.
 *
 * Everything else is copied from JobBoard deliberately — including the two
 * decisions that took a while to get right there:
 *
 * ── pointerWithin, NOT closestCorners ──────────────────────────────────────
 *
 * closestCorners always answers with SOMETHING: it ranks every droppable and
 * returns the nearest, so releasing a card over empty page still "drops" it
 * into whichever column happened to be closest. A drag somebody changed their
 * mind about becomes a move they did not intend. pointerWithin returns nothing
 * unless the pointer is actually inside a column, which is what makes a cancel
 * possible.
 *
 * ── THE MOUNT GATE ─────────────────────────────────────────────────────────
 *
 * DndContext and DragOverlay render browser-only machinery — a portal, live
 * regions with generated ids — that has no server equivalent, so rendering
 * them on the first pass reports the whole page as a hydration mismatch. The
 * first paint is the plain board with every link working; the drag machinery
 * mounts a frame later.
 */
export default function TicketBoard({
  lanes,
  tickets,
  canEdit,
}: {
  lanes: TicketLane[]
  tickets: Ticket[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [, start] = useTransition()

  const [dragging, setDragging] = useState<Ticket | null>(null)
  /** Optimistic positions, cleared on refresh and reverted on a refusal. */
  const [moved, setMoved] = useState<Record<number, number>>({})
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  const sensors = useSensors(
    // A small distance before a drag begins, so a click on a card still opens
    // it rather than starting a drag nobody wanted.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  )

  function laneOf(ticket: Ticket): number {
    return moved[ticket.id] ?? ticket.statusId
  }

  function onDragStart(event: DragStartEvent) {
    const id = Number(String(event.active.id).replace('card-', ''))
    setDragging(tickets.find((t) => t.id === id) ?? null)
  }

  function onDragEnd(event: DragEndEvent) {
    const card = dragging
    setDragging(null)
    // No `over` means the pointer was not inside any lane. That is a cancel,
    // and the whole reason pointerWithin is the collision strategy.
    if (!card || !event.over) return

    const target = Number(String(event.over.id).replace('lane-', ''))
    if (!Number.isFinite(target) || laneOf(card) === target) return

    setMoved((prev) => ({ ...prev, [card.id]: target }))

    start(async () => {
      const result = await moveTicketAction(card.id, target)
      if (!result.ok) {
        /*
         * Put it back where the server still has it, and say why VERBATIM.
         *
         * The refusals this returns are the useful kind — "needs somebody
         * assigned first", "already has 2 running: TK000014" — and flattening
         * them to "could not move" would throw away the only thing that tells
         * somebody what to do next.
         */
        setMoved((prev) => {
          const next = { ...prev }
          delete next[card.id]
          return next
        })
        toast.error(result.error)
        return
      }
      if (result.started) toast.success('Clock started.')
      else if (result.stopped) toast.success('Clock stopped.')
      setMoved({})
      router.refresh()
    })
  }

  const board = (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {lanes.map((lane) => (
        <Lane
          key={lane.id}
          lane={lane}
          tickets={tickets.filter((t) => laneOf(t) === lane.id)}
          canDrag={canEdit && ready}
        />
      ))}
    </div>
  )

  if (lanes.length === 0) {
    return (
      <EmptyState
        title="No lanes yet"
        hint="A board needs lanes before it can hold anything. Set them up under Tickets → Setup."
        icon={<Icons.LayoutGrid size={22} />}
      />
    )
  }

  if (!ready || !canEdit) return board

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {board}
      <DragOverlay>{dragging ? <Card ticket={dragging} dragging /> : null}</DragOverlay>
    </DndContext>
  )
}

/** One column. Droppable whether or not it holds anything. */
function Lane({
  lane,
  tickets,
  canDrag,
}: {
  lane: TicketLane
  tickets: Ticket[]
  canDrag: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane-${lane.id}` })

  return (
    <div className="flex w-72 shrink-0 flex-col">
      {/* The header stays even when the lane is empty, with its zero. A column
          that vanished when empty would make the board change shape under
          somebody mid-drag. */}
      <div className="mb-2 flex items-center gap-2 px-1">
        <Badge tone={TONE[lane.tone] ?? 'neutral'}>{lane.name}</Badge>
        <span className="numeric text-xs text-muted">{tickets.length}</span>
        {/* What this lane does to the clock — the thing that makes this board
            different from a job board. Icon AND title, never colour alone. */}
        {lane.clock === 'start' && (
          <Icons.Play size={12} className="text-success" aria-label="Starts the clock" />
        )}
        {lane.clock === 'pause' && (
          <Icons.Pause size={12} className="text-warning" aria-label="Pauses the clock" />
        )}
        {lane.clock === 'end' && (
          <Icons.Square size={12} className="text-danger" aria-label="Ends the clock" />
        )}
      </div>

      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-col gap-2 rounded-card border border-dashed p-2 transition-colors ${
          isOver ? 'border-brand bg-surface-2' : 'border-border'
        }`}
      >
        {tickets.map((ticket) => (
          <DraggableCard key={ticket.id} ticket={ticket} canDrag={canDrag} />
        ))}
        {tickets.length === 0 && (
          <p className="px-1 py-3 text-center text-xs text-muted">Nothing here</p>
        )}
      </div>
    </div>
  )
}

function DraggableCard({ ticket, canDrag }: { ticket: Ticket; canDrag: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card-${ticket.id}`,
    disabled: !canDrag,
  })
  return (
    <div
      ref={setNodeRef}
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
      className={isDragging ? 'opacity-40' : ''}
    >
      <Card ticket={ticket} />
    </div>
  )
}

/** Business minutes as a person reads them: 2h 05m, or 45m. */
function readMinutes(total: number): string {
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`
}

function Card({ ticket, dragging = false }: { ticket: Ticket; dragging?: boolean }) {
  return (
    <div
      className={`rounded-card border border-border bg-surface p-3 ${
        dragging ? 'shadow-pop' : 'shadow-card'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="numeric text-xs text-muted">{ticket.documentNumber ?? `#${ticket.id}`}</span>
        {/* A running clock, shown on the card. This is the thing somebody scans
            the board for: who is actually working right now. */}
        {ticket.isRunning && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Icons.Play size={10} />
            {readMinutes(ticket.workedMinutes)}
          </span>
        )}
      </div>

      {/* The title is the one thing at full weight — everything else on the
          card recedes, or the board is fifty things shouting. */}
      <Link
        href={`/tickets/${ticket.id}`}
        className="mt-1 block text-sm font-medium text-ink hover:underline"
      >
        {ticket.subject}
      </Link>

      {ticket.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted">{ticket.description}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={TICKET_PRIORITY_TONE[ticket.priority] as BadgeTone}>
          {TICKET_PRIORITY_LABEL[ticket.priority]}
        </Badge>
        {ticket.category && <Badge tone="neutral">{ticket.category}</Badge>}
        {!ticket.isRunning && ticket.workedMinutes > 0 && (
          <span className="numeric text-xs text-muted">{readMinutes(ticket.workedMinutes)}</span>
        )}
      </div>

      <p className="mt-1.5 truncate text-xs text-muted">
        {ticket.customerName ?? 'No customer'}
        {ticket.assigneeName ? ` · ${ticket.assigneeName}` : ' · Unassigned'}
      </p>
    </div>
  )
}
