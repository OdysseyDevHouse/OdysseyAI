'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  Modal,
  Button,
  Badge,
  Callout,
  ChoiceTile,
  EmptyState,
  Input,
  ToolbarSearch,
  Icons,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'

/**
 * Dividing one table's bill onto another.
 *
 * ── TWO SLIPS, AND A LINE MOVES BETWEEN THEM ───────────────────────────────
 *
 * Splitting a bill is one gesture repeated: take a line off THIS bill and put it on
 * THAT one. So the screen is the two bills side by side — the left is the table the
 * till has open, the right is wherever the split is going — and a line crosses between
 * them. Both halves are on screen at once because the question a waiter is actually
 * answering is "does each of these two bills now look right", and that cannot be
 * checked on a screen that shows one of them.
 *
 * A line can be moved by DRAGGING it or by tapping its Move button, and the button is
 * not a fallback. On a till a drag needs a hold to start, or every attempt to scroll
 * the bill throws a line across; the button is one tap with no gesture to learn, and it
 * is what most waiters will use. The drag is there because it is faster once known and
 * because it is what the reference POS does.
 *
 * Quantities split too. A line of 3 moved whole takes all 3; "Move 1" takes one, and
 * the line then exists on BOTH slips at once — "one of the three beers is on Dave's
 * bill" is the request this screen exists for. That is why each slip holds its own
 * copy of the lines rather than pointing at one shared list.
 *
 * ── WHERE IT IS GOING IS CHOSEN FIRST ──────────────────────────────────────
 *
 * Until a destination is picked the right-hand slip IS the picker, because a line
 * cannot be dragged onto a bill that has not been named yet. Once picked, the slip
 * shows what that sale ALREADY has on it, greyed and immovable — that is context for
 * recognising the bill, not part of the split. Moving something onto an occupied bill
 * is allowed and normal; see posSplit.ts for what the server does with it.
 *
 * ── THE PICKER LISTS OPEN SALES, NOT THE FLOOR PLAN ────────────────────────
 *
 * It used to offer `pos_tables` rows, and that was wrong in the common case. Most open
 * bills on a hospitality till are NOT seated on the floor plan — "Tiaan", "Walk-in", a
 * takeaway — so a waiter with four sales open was offered the one that happened to have
 * a table row, and on a single-table floor was told "no other tables" with three live
 * bills on the screen behind the dialog.
 *
 * So a destination is a DOCUMENT (see `SplitDestination`), which is the one thing every
 * open sale has. "New sale" is always offered alongside them, because a bill that does
 * not exist yet cannot be in a list — and on a floor with one open sale it is the only
 * place the items can go.
 *
 * ── NOTHING IS WRITTEN UNTIL CONFIRM ───────────────────────────────────────
 *
 * Every move is local state. Cancel walks away leaving both bills exactly as they were,
 * which matters because a half-finished split must never be able to lose a line — and
 * because a waiter WILL be interrupted halfway through one.
 *
 * The server writes both halves in one transaction (posSplit.ts), so the atomicity this
 * screen promises is real rather than a matter of it being careful.
 */

export type SplitLine = {
  id: number
  description: string
  productCode: string | null
  qty: number
  unitPriceIncl: number
  lineTotalIncl: number
  /** Free-text cooking note ("no onion"), shown under the description. */
  note?: string | null
  /**
   * The answers the till asked for — "no onions", "medium rare".
   *
   * Shown because they are how a waiter tells two otherwise identical lines apart. Four
   * people ordering the same burger four different ways is four lines reading "Beef
   * Burger R120", and choosing which one goes on Dave's bill is a guess without these.
   */
  instructions?: { optionName: string; qty: number }[]
}

/**
 * One place a split can go.
 *
 * An OPEN SALE, not a table. Most of a hospitality floor's open bills are not seated on
 * the floor plan at all — "Tiaan", "Walk-in", a takeaway — and offering only the seated
 * ones meant a waiter with four bills open was shown one destination, or on a
 * single-table floor, none. A document is the one thing every open sale has.
 */
export type SplitDestination = {
  documentId: number
  /** What the waiter reads: a table code, a customer's name, or "Walk-in". */
  label: string
  /** The table it happens to be seated on, when it is. Shown as context only. */
  tableCode?: string | null
  lineCount: number
  totalIncl: number
}

/** One line on one slip. `key` is stable across moves so React and dnd agree. */
type Slip = { key: string; line: SplitLine }

/** What a slip comes to — the number the waiter reads back to the table. */
function slipTotal(slip: Slip[]): number {
  return round(
    slip.reduce((sum, s) => sum + s.line.unitPriceIncl * s.line.qty, 0),
    2,
  )
}

/**
 * Moves `qty` units of `from[at]` onto `to`. Returns fresh arrays for both.
 *
 * A line landing on one that is identical in every respect that matters — same source
 * line, same price, same note — merges into it, so moving one beer back and forth reads
 * as one row rather than accumulating rows. Keyed on the SOURCE line id, which is what
 * makes a part-moved line rejoin its own other half rather than sitting beside it.
 */
function moveUnits(
  from: Slip[],
  to: Slip[],
  at: number,
  qty: number,
): { from: Slip[]; to: Slip[] } {
  const src = from[at]
  if (!src) return { from, to }
  const take = round(Math.min(Math.max(0, qty), src.line.qty), 3)
  if (take <= 0) return { from, to }

  const nextFrom = from
    .map((s, i) => (i === at ? { ...s, line: { ...s.line, qty: round(s.line.qty - take, 3) } } : s))
    // A line moved in full leaves the slip entirely.
    .filter((s) => s.line.qty > 0.0005)

  const mergeAt = to.findIndex((s) => s.line.id === src.line.id)
  const nextTo =
    mergeAt >= 0
      ? to.map((s, i) =>
          i === mergeAt ? { ...s, line: { ...s.line, qty: round(s.line.qty + take, 3) } } : s,
        )
      : [...to, { key: src.key, line: { ...src.line, qty: take } }]
  return { from: nextFrom, to: nextTo }
}

/**
 * A line's modifiers and its cooking note, under the description.
 *
 * The same shape the sale pane uses (see SaleLineCard) — a ↳, the count, then the
 * answer — because a waiter reading a bill on the split screen is reading the same bill
 * they rang up, and two renderings of one thing is how the two drift apart.
 *
 * `muted` for the greyed "already on this bill" side, which is context rather than
 * anything the waiter can act on.
 */
function LineDetail({ line, muted = false }: { line: SplitLine; muted?: boolean }) {
  const chosen = line.instructions ?? []
  if (chosen.length === 0 && !line.note) return null
  return (
    <span
      className={`mt-0.5 flex flex-col gap-0.5 pl-7 text-xs ${muted ? 'text-muted' : 'text-ink'}`}
    >
      {chosen.map((option, i) => (
        <span key={i} className="flex items-start gap-1.5">
          {/* leading-none and a nudge down: ↳ sits low on its own baseline, and left
              alone it reads as a stray comma rather than an arrow. */}
          <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
            ↳
          </span>
          {/* The count leads and is always shown, including at one, so a glance down a
              line's modifiers compares numbers rather than hunting for them. */}
          <span className="numeric shrink-0 text-muted">{option.qty} ×</span>
          <span className="min-w-0 truncate">{option.optionName}</span>
        </span>
      ))}
      {line.note && (
        <span className="flex items-start gap-1.5">
          <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
            ↳
          </span>
          <span className="min-w-0 truncate italic">“{line.note}”</span>
        </span>
      )}
    </span>
  )
}

/* ── One line on a slip ──────────────────────────────────────────────────── */

function LineRow({
  slip,
  index,
  side,
  onMove,
  busy,
  /** No destination chosen yet, so there is nowhere for this line to go. */
  locked = false,
  /** Rendered inside the floating DragOverlay — no dnd wiring, no buttons. */
  overlay = false,
}: {
  slip: Slip
  index: number
  side: 'keep' | 'move'
  onMove: (index: number, qty: number) => void
  busy?: boolean
  locked?: boolean
  overlay?: boolean
}) {
  /* Both stop the line moving, and they are kept apart because they mean different
     things: `busy` is "the server is working, wait", `locked` is "pick where this is
     going first". The second is a step the waiter has not done yet, not a delay. */
  const immovable = busy || locked
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${side}:${index}`,
    disabled: overlay || immovable,
  })
  const line = slip.line
  const splittable = line.qty > 1

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      className={`rounded-card border border-border bg-surface p-3 ${
        overlay ? 'rotate-2 shadow-pop' : ''
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      {/* The grab area is the row's body only — the buttons below sit OUTSIDE it, or
          every tap on "Move 1" would start a drag instead of moving a line. */}
      <div
        {...(overlay || immovable ? {} : listeners)}
        {...(overlay || immovable ? {} : attributes)}
        className={`min-w-0 ${overlay || immovable ? '' : 'cursor-grab touch-none active:cursor-grabbing'}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="numeric shrink-0 rounded-control bg-surface-2 px-1.5 py-0.5 text-xs font-bold text-ink">
            {line.qty}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {line.description}
          </span>
          <span className="numeric shrink-0 text-sm font-semibold text-ink">
            {formatMoney(line.unitPriceIncl * line.qty)}
          </span>
        </div>
        <LineDetail line={line} />
      </div>

      {/* A single-qty line has nothing to divide, so it only gets the whole-line move. */}
      {!overlay && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {splittable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={immovable}
              onClick={() => onMove(index, 1)}
              aria-label={`Move one ${line.description} across`}
            >
              {side === 'keep' ? 'Move 1 →' : '← Move 1'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={immovable}
            onClick={() => onMove(index, line.qty)}
            aria-label={`Move all ${line.qty} ${line.description} across`}
          >
            {side === 'keep'
              ? `Move ${splittable ? 'all ' : ''}→`
              : `← Move ${splittable ? 'all' : ''}`}
          </Button>
        </div>
      )}
    </div>
  )
}

/* ── One slip ────────────────────────────────────────────────────────────── */

function Slip({
  id,
  title,
  subtitle,
  slip,
  side,
  onMove,
  header,
  empty,
  busy,
  /** No destination chosen yet — the lines are shown but cannot be moved. */
  locked = false,
  /** Lines ALREADY on this bill — context above the split, never moved. */
  existing,
  existingLoading = false,
  existingError = '',
  /** Replaces the whole body: the destination picker, before one is chosen. */
  body,
}: {
  id: string
  title: string
  subtitle: string
  slip: Slip[]
  side: 'keep' | 'move'
  onMove: (index: number, qty: number) => void
  header?: React.ReactNode
  empty: string
  busy?: boolean
  locked?: boolean
  existing?: SplitLine[]
  existingLoading?: boolean
  existingError?: string
  body?: React.ReactNode
}) {
  /* A locked slip is not a drop target either — the dashed outline lighting up under a
     drag that cannot complete is the screen promising something it will refuse. */
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !!body || locked })
  const existingTotal = round(
    (existing ?? []).reduce((sum, l) => sum + l.unitPriceIncl * l.qty, 0),
    2,
  )
  /* The figure in the header is what the bill will COME TO — what is already on it plus
     what is being moved across. That total is the number the waiter reads out. */
  const total = round(slipTotal(slip) + existingTotal, 2)
  const lineCount = slip.length + (existing?.length ?? 0)

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-0 flex-1 flex-col rounded-card border bg-surface-2 ${
        isOver ? 'border-brand ring-1 ring-brand' : 'border-border'
      }`}
    >
      <div className="shrink-0 rounded-t-card border-b border-border bg-surface-2 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">{title}</p>
            <p className="truncate text-xs text-muted">{subtitle}</p>
          </div>
          {!body && (
            <div className="shrink-0 text-right">
              <p className="numeric text-lg font-bold text-ink">{formatMoney(total)}</p>
              <p className="text-xs text-muted">
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
              </p>
            </div>
          )}
        </div>
        {header && <div className="mt-3">{header}</div>}
      </div>

      {body ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {/* Says WHY the Move buttons are dead. A row of greyed controls with no
              explanation reads as broken; naming the missing step turns it into an
              instruction, and it sits above the lines it is talking about. */}
          {locked && (
            <p className="rounded-card border border-dashed border-border px-3 py-2 text-xs text-muted">
              Choose where the split is going first — then move items across.
            </p>
          )}
          {/* What the bill already holds. Greyed and immovable: it is here so the waiter
              can recognise the table, and these lines are not part of the split. */}
          {existingLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-card bg-surface" />
              ))}
            </div>
          ) : existingError ? (
            <Callout tone="warning">{existingError}</Callout>
          ) : existing && existing.length > 0 ? (
            <>
              <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                Already on this bill
              </p>
              {existing.map((line, i) => (
                <div
                  key={`existing-${line.id}-${i}`}
                  className="rounded-card border border-border bg-surface/60 p-3"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="numeric shrink-0 rounded-control bg-surface-2 px-1.5 py-0.5 text-xs font-bold text-muted">
                      {line.qty}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-muted">
                      {line.description}
                    </span>
                    <span className="numeric shrink-0 text-sm font-semibold text-muted">
                      {formatMoney(line.unitPriceIncl * line.qty)}
                    </span>
                  </div>
                  <LineDetail line={line} muted />
                </div>
              ))}
              <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-brand">
                Moving across
              </p>
            </>
          ) : null}

          {slip.length === 0 ? (
            <div
              className={`flex min-h-32 flex-1 items-center justify-center rounded-card border-2 border-dashed p-6 text-center text-sm ${
                isOver ? 'border-brand text-brand' : 'border-border text-muted'
              }`}
            >
              {empty}
            </div>
          ) : (
            slip.map((s, i) => (
              <LineRow
                key={`${s.key}:${i}`}
                slip={s}
                index={i}
                side={side}
                onMove={onMove}
                busy={busy}
                locked={locked}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/* ── The screen ──────────────────────────────────────────────────────────── */

export function SplitBillModal({
  open,
  onClose,
  fromLabel,
  lines,
  destinations,
  busy,
  loadDestinationLines,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  /** What the bill being split is called — a table code, or a tab's name. */
  fromLabel: string
  lines: SplitLine[]
  /** Every OTHER open sale, seated or not. The source is already excluded. */
  destinations: SplitDestination[]
  busy: boolean
  /**
   * What a prospective destination already has on it, read when it is chosen rather
   * than taken from the list — which carries a count and a total but not the products,
   * and is seconds old besides.
   */
  loadDestinationLines: (documentId: number) => Promise<SplitLine[]>
  /** `toDocumentId` null means "start a new sale", named by `newSaleName`. */
  onConfirm: (
    toDocumentId: number | null,
    moves: { lineId: number; qty: number }[],
    newSaleName: string | null,
  ) => void
}) {
  const [keep, setKeep] = useState<Slip[]>([])
  const [move, setMove] = useState<Slip[]>([])
  /**
   * Where the split is going.
   *
   * Three states, not two: `null` is "nothing chosen yet, the right slip is still the
   * picker", a number is an existing open sale, and `'new'` is a bill that does not
   * exist yet — which is why this cannot simply be a nullable id.
   */
  const [target, setTarget] = useState<number | 'new' | null>(null)
  const [newSaleName, setNewSaleName] = useState('')
  const [search, setSearch] = useState('')
  const [existing, setExisting] = useState<SplitLine[]>([])
  const [existingLoading, setExistingLoading] = useState(false)
  const [existingError, setExistingError] = useState('')
  const [dragging, setDragging] = useState<{ slip: Slip; side: 'keep' | 'move' } | null>(null)

  /*
   * Re-seeded on every OPEN: a split always starts from the bill as it stands now, never
   * from a previous attempt somebody walked away from.
   *
   * Keyed on `open` ALONE, with the lines read through a ref. Depending on `lines`
   * directly looks more correct and is not: it is a prop whose array identity changes on
   * every parent render, so choosing a destination — which sets state, which re-renders
   * the parent — re-ran this and wiped the destination's own lines back to empty the
   * instant they arrived. "Already on this bill" was never on screen.
   */
  const latestLines = useRef(lines)
  latestLines.current = lines
  useEffect(() => {
    if (!open) return
    setKeep(latestLines.current.map((line, i) => ({ key: `l${line.id}-${i}`, line: { ...line } })))
    setMove([])
    setTarget(null)
    setNewSaleName('')
    setSearch('')
    setExisting([])
    setExistingError('')
    setExistingLoading(false)
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return destinations
    return destinations.filter(
      (d) =>
        d.label.toLowerCase().includes(q) || (d.tableCode ?? '').toLowerCase().includes(q),
    )
  }, [destinations, search])

  const toSale =
    typeof target === 'number' ? (destinations.find((d) => d.documentId === target) ?? null) : null

  /**
   * Choose where the split is going, and read what that sale already has on it.
   *
   * A read that FAILS still lets the split proceed — the server re-reads the destination
   * inside its own transaction before appending to it, so the screen's copy is a
   * courtesy rather than the basis of the write. It says so rather than showing an empty
   * bill, which would read as "this sale has nothing on it".
   */
  async function chooseDestination(destination: SplitDestination) {
    setTarget(destination.documentId)
    setExisting([])
    setExistingError('')
    setExistingLoading(true)
    try {
      setExisting(await loadDestinationLines(destination.documentId))
    } catch {
      setExistingError("Couldn't read what's on that sale — the split will still work.")
    } finally {
      setExistingLoading(false)
    }
  }

  /** A bill that does not exist yet. Nothing to read — it has nothing on it by
      definition, so the right slip goes straight to holding what is moved across. */
  function chooseNewSale() {
    setTarget('new')
    setExisting([])
    setExistingError('')
    setExistingLoading(false)
  }

  /** Back to the picker. Anything already moved across goes home — it was being put on
      the bill the waiter has just backed out of. */
  function clearDestination() {
    setTarget(null)
    setNewSaleName('')
    setExisting([])
    setExistingError('')
    setKeep((current) =>
      move.reduce((acc, s) => moveUnits([s], acc, 0, s.line.qty).to, current),
    )
    setMove([])
  }

  const sensors = useSensors(
    // 6px of travel before a drag starts, so a tap on a Move button stays a tap.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  )

  /*
   * Nothing moves until a destination is chosen.
   *
   * "Move →" with nowhere to move to is a button that appears to work and does not: the
   * line leaves the left slip, lands under a heading that still reads "Split onto…", and
   * the waiter is looking at items sitting on a bill that does not exist. Picking the
   * destination first is also the order the screen already asks for — the right-hand
   * slip IS the picker until one is chosen — so this makes the lines agree with it.
   *
   * Guarded HERE rather than only by disabling the controls, because a drag can reach
   * `moveFromKeep` without passing through a button.
   */
  const locked = target === null

  function moveFromKeep(index: number, qty: number) {
    if (locked) return
    const r = moveUnits(keep, move, index, qty)
    setKeep(r.from)
    setMove(r.to)
  }
  function moveFromMove(index: number, qty: number) {
    if (locked) return
    const r = moveUnits(move, keep, index, qty)
    setMove(r.from)
    setKeep(r.to)
  }

  function onDragStart(event: DragStartEvent) {
    if (locked) return
    const [side, at] = String(event.active.id).split(':')
    const held = side === 'keep' ? keep[Number(at)] : move[Number(at)]
    if (held) setDragging({ slip: held, side: side as 'keep' | 'move' })
  }
  function onDragEnd(event: DragEndEvent) {
    const held = dragging
    setDragging(null)
    if (!held || !event.over) return
    const [side, at] = String(event.active.id).split(':')
    /* `droppedOn`, not `target` — that name belongs to the chosen destination in this
       component's state, and shadowing it here is how a later edit reads the wrong one. */
    const droppedOn = String(event.over.id)
    // Dropped back on its own slip — nothing to do.
    if (side === 'keep' && droppedOn === 'move') moveFromKeep(Number(at), held.slip.line.qty)
    else if (side === 'move' && droppedOn === 'keep') moveFromMove(Number(at), held.slip.line.qty)
  }

  const moves = move.map((s) => ({ lineId: s.line.id, qty: s.line.qty }))
  const movingCount = round(
    move.reduce((n, s) => n + s.line.qty, 0),
    3,
  )

  /* Both slips must end up with something on them. A "split" that moves everything is a
     transfer — which has its own gesture, and keeps the bill's identity rather than
     cancelling it and minting a new one — and one that moves nothing is a no-op. */
  const canConfirm = !busy && target !== null && move.length > 0 && keep.length > 0
  const blocked =
    target === null
      ? 'Pick which sale these items are moving to, or start a new one.'
      : move.length === 0
        ? 'Move items across to put them on this bill.'
        : keep.length === 0
          ? 'Everything has moved across — leave at least one item here, or use Move table instead.'
          : ''

  const destinationTitle =
    target === null ? 'Split onto…' : target === 'new' ? newSaleName.trim() || 'New sale' : (toSale?.label ?? 'That sale')
  const existingCount = existing.length || toSale?.lineCount || 0
  const destinationSubtitle =
    target === null
      ? 'Choose where these items are going'
      : target === 'new'
        ? 'A new sale — this starts its bill'
        : `${existingCount} line${existingCount === 1 ? '' : 's'} already on it`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split the bill"
      description={
        target === null
          ? 'Pick the sale these items are moving to, or start a new one.'
          : 'Drag items across, or use the buttons on each line to move one at a time.'
      }
      size="xl"
      bodyFills
      /* A half-finished split is real work — a stray tap on the backdrop must not
         throw it away. Cancel is explicit, and says what it does. */
      closeOnBackdrop={false}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted">
            {blocked || (
              <>
                Moving{' '}
                <strong className="font-semibold text-ink">
                  {movingCount} item{movingCount === 1 ? '' : 's'}
                </strong>{' '}
                ({formatMoney(slipTotal(move))}) to{' '}
                <strong className="font-semibold text-ink">{destinationTitle}</strong>.
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canConfirm}
              onClick={() =>
                target !== null &&
                onConfirm(
                  target === 'new' ? null : target,
                  moves,
                  target === 'new' ? newSaleName.trim() || null : null,
                )
              }
            >
              <Icons.Check size={16} />
              {busy ? 'Splitting…' : 'Split the bill'}
            </Button>
          </div>
        </div>
      }
    >
      {lines.length === 0 ? (
        <EmptyState
          icon={<Icons.Receipt size={28} />}
          title="Nothing on this bill"
          hint="There is nothing to split yet."
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <Slip
              id="keep"
              title="This sale"
              subtitle={`Stays on ${fromLabel || 'this sale'}`}
              slip={keep}
              side="keep"
              onMove={moveFromKeep}
              busy={busy}
              /* Nothing may move until there is somewhere for it to go. */
              locked={locked}
              empty="Everything has moved across. Move something back to keep it here."
            />

            <Slip
              id="move"
              title={destinationTitle}
              subtitle={destinationSubtitle}
              slip={move}
              side="move"
              onMove={moveFromMove}
              busy={busy}
              existing={existing}
              existingLoading={existingLoading}
              existingError={existingError}
              empty={
                existing.length > 0
                  ? 'Move items here to add them to this bill.'
                  : 'Move items here to put them on this bill.'
              }
              /* Once a destination is chosen the header keeps a way back to the list, so
                 a waiter who picked the wrong sale is not stuck with it. A NEW sale also
                 gets its name field here — it is the one thing about the destination the
                 waiter still has to supply, and it belongs beside what it names. */
              header={
                target !== null ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="brand">
                        {target === 'new' ? 'New sale' : (toSale?.tableCode ?? toSale?.label ?? 'Sale')}
                      </Badge>
                      <Button variant="ghost" size="sm" onClick={clearDestination} disabled={busy}>
                        <Icons.ArrowLeft size={14} />
                        Choose another
                      </Button>
                    </div>
                    {target === 'new' && (
                      <Input
                        value={newSaleName}
                        onChange={(e) => setNewSaleName(e.target.value)}
                        placeholder="Name this sale (optional)"
                        disabled={busy}
                        maxLength={60}
                      />
                    )}
                  </div>
                ) : undefined
              }
              /* Nothing chosen yet: the slip IS the picker.
                 It lists OPEN SALES, not the floor plan — see SplitDestination. */
              body={
                target !== null ? undefined : (
                  <div>
                    {/* Only once the list is long enough to be worth filtering — a search
                        box above four tiles is furniture. */}
                    {destinations.length > 6 && (
                      <div className="mb-3">
                        <ToolbarSearch
                          value={search}
                          onChange={setSearch}
                          placeholder="Search open sales…"
                          className="w-full"
                        />
                      </div>
                    )}

                    {/* Always first, and always offered. A split onto a brand new bill is
                        the one destination that cannot be listed, because it does not
                        exist yet — and on a floor with a single open sale it is the ONLY
                        thing a waiter can split onto. */}
                    <div className="mb-2">
                      <ChoiceTile
                        layout="inline"
                        title="New sale"
                        description="Start a fresh bill for these items"
                        disabled={busy}
                        onClick={chooseNewSale}
                      />
                    </div>

                    {destinations.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted">
                        No other sale is open, so a new one is the only place these items
                        can go.
                      </p>
                    ) : filtered.length === 0 ? (
                      <EmptyState
                        icon={<Icons.Search size={28} />}
                        title="No open sale matches that"
                        hint="Try a different name or table number."
                      />
                    ) : (
                      <>
                        <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                          Or onto an open sale
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {filtered.map((d) => (
                            <ChoiceTile
                              key={d.documentId}
                              layout="inline"
                              title={d.label}
                              /* The table is context, not identity: two tabs can be named
                                 "Walk-in", and where they are sitting is what tells them
                                 apart. Tabs with no table simply say what they are. */
                              description={
                                (d.tableCode ? `Table ${d.tableCode} · ` : '') +
                                `${d.lineCount} line${d.lineCount === 1 ? '' : 's'} already on it`
                              }
                              /* The total tells two open bills apart at a glance, so it
                                 gets the footer rather than the description line. */
                              footer={
                                <span className="numeric text-sm font-semibold text-ink">
                                  {formatMoney(d.totalIncl)}
                                </span>
                              }
                              disabled={busy}
                              onClick={() => void chooseDestination(d)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )
              }
            />
          </div>

          {/* The card that follows the finger — the source row ghosts to 40%. */}
          <DragOverlay dropAnimation={null}>
            {dragging ? (
              <div className="w-80 max-w-[80vw]">
                <LineRow slip={dragging.slip} index={0} side={dragging.side} onMove={() => {}} overlay />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </Modal>
  )
}
