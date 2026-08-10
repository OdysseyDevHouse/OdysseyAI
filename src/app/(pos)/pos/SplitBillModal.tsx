'use client'

import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, TouchRow, EmptyState, Callout, Badge, Icons } from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import type { PosTable } from '@/lib/site/posTables'

/**
 * Dividing one table's bill onto another.
 *
 * ── TAP-AND-STEP, NOT DRAG-AND-DROP ────────────────────────────────────────
 *
 * The reference POS does this as two slips with a drag between them, and that is the
 * wrong instrument here. On a touch till a drag needs a long-press to start — otherwise
 * every attempt to scroll the bill moves a line instead — and a long-press is exactly
 * what a waiter standing at a table with three people talking at them will not wait for.
 * dnd-kit on a 56px row is also a 44px target inside a 56px one.
 *
 * So each line has a stepper. Tapping the row moves the WHOLE line, which is the common
 * case ("the steak is on his bill"); the +/− move one at a time, which is the other one
 * ("one of the three beers"). Both are single taps with no gesture to learn, and the
 * screen reads the same whether you moved one line or nine.
 *
 * ── NOTHING IS WRITTEN UNTIL CONFIRM ───────────────────────────────────────
 *
 * Every tap is local state. Cancel walks away leaving the bill exactly as it was, which
 * matters because a half-finished split must never be able to lose a line — and because a
 * waiter WILL be interrupted halfway through one.
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
}

export function SplitBillModal({
  open,
  onClose,
  fromTable,
  lines,
  tables,
  busy,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  /** The table being split. */
  fromTable: PosTable | null
  lines: SplitLine[]
  /** Every table, so the destination list can offer the free ones. */
  tables: PosTable[]
  busy: boolean
  onConfirm: (toTableId: number, moves: { lineId: number; qty: number }[]) => void
}) {
  /** How much of each line is moving. Absent means none. */
  const [moving, setMoving] = useState<Record<number, number>>({})
  const [toTableId, setToTableId] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setMoving({})
    setToTableId(null)
  }, [open])

  /*
   * Only FREE tables. A merge onto an occupied one is refused server-side because two
   * parties' food on one bill has no way back — so it is not offered here either, rather
   * than being offered and then refused after the waiter has chosen.
   */
  const destinations = useMemo(
    () =>
      tables.filter((t) => t.isActive && t.state === 'free' && t.id !== fromTable?.id),
    [tables, fromTable?.id],
  )

  const movedQty = (line: SplitLine) => moving[line.id] ?? 0
  const keptQty = (line: SplitLine) => round(line.qty - movedQty(line), 3)

  function step(line: SplitLine, delta: number) {
    setMoving((current) => {
      const next = round(Math.min(line.qty, Math.max(0, (current[line.id] ?? 0) + delta)), 3)
      const copy = { ...current }
      if (next <= 0) delete copy[line.id]
      else copy[line.id] = next
      return copy
    })
  }

  /** Tapping the row moves all of it, or puts all of it back. */
  function toggleWhole(line: SplitLine) {
    setMoving((current) => {
      const copy = { ...current }
      if ((current[line.id] ?? 0) >= line.qty) delete copy[line.id]
      else copy[line.id] = line.qty
      return copy
    })
  }

  const movingTotal = round(
    lines.reduce((sum, l) => sum + movedQty(l) * l.unitPriceIncl, 0),
    2,
  )
  const keptTotal = round(
    lines.reduce((sum, l) => sum + keptQty(l) * l.unitPriceIncl, 0),
    2,
  )
  const anyMoving = lines.some((l) => movedQty(l) > 0)
  const movingEverything = lines.every((l) => keptQty(l) <= 0.0005)

  const moves = lines
    .filter((l) => movedQty(l) > 0)
    .map((l) => ({ lineId: l.id, qty: movedQty(l) }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Split ${fromTable?.code ?? 'bill'}`}
      description="Tap a line to move all of it, or use +/− to move part."
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" size="touch" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <div className="flex items-center gap-3">
            {!anyMoving && <span className="text-sm text-muted">Choose what to move</span>}
            {anyMoving && !toTableId && (
              <span className="text-sm text-muted">Choose a table</span>
            )}
            <Button
              variant="primary"
              size="touch-lg"
              disabled={!anyMoving || !toTableId || busy}
              onClick={() => toTableId && onConfirm(toTableId, moves)}
            >
              <Icons.Check size={20} />
              Move {formatMoney(movingTotal)}
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
        <div className="space-y-4">
          {/* ── The lines ─────────────────────────────────────────────── */}
          <ul className="space-y-2">
            {lines.map((line) => {
              const moved = movedQty(line)
              const kept = keptQty(line)
              return (
                <li key={line.id}>
                  <TouchRow
                    tone={moved > 0 ? 'active' : 'default'}
                    title={line.description}
                    subtitle={
                      moved > 0
                        ? /* Both sides named, because a part-moved line is the case a
                             waiter most needs to read back to a customer. */
                          `${kept} staying · ${moved} moving`
                        : `${line.qty} × ${formatMoney(line.unitPriceIncl)}`
                    }
                    trailing={
                      <span className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="touch"
                          iconOnly
                          aria-label={`Move one less ${line.description}`}
                          disabled={moved <= 0 || busy}
                          onClick={(e) => {
                            e.stopPropagation()
                            step(line, -1)
                          }}
                        >
                          <Icons.Minus size={18} />
                        </Button>
                        <span className="numeric w-10 text-center text-base font-semibold text-ink">
                          {moved > 0 ? moved : '—'}
                        </span>
                        <Button
                          variant="ghost"
                          size="touch"
                          iconOnly
                          aria-label={`Move one more ${line.description}`}
                          disabled={moved >= line.qty || busy}
                          onClick={(e) => {
                            e.stopPropagation()
                            step(line, 1)
                          }}
                        >
                          <Icons.Plus size={18} />
                        </Button>
                      </span>
                    }
                    showChevron={false}
                    onClick={() => toggleWhole(line)}
                  />
                </li>
              )
            })}
          </ul>

          {/* ── The two halves, so the arithmetic is visible ──────────── */}
          <div className="flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm text-muted">
              Staying on {fromTable?.code ?? 'this table'}
            </span>
            <span className="numeric text-lg font-semibold text-ink">
              {formatMoney(keptTotal)}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">Moving</span>
            <span className="numeric text-lg font-semibold text-ink">
              {formatMoney(movingTotal)}
            </span>
          </div>

          {/* Moving everything is legitimate — a party changed tables — but it frees the
              table they left, and a waiter should know that before tapping rather than
              discovering it on the floor plan afterwards. */}
          {movingEverything && anyMoving && (
            <Callout tone="warning">
              That is the whole bill, so {fromTable?.code ?? 'this table'} will be freed.
            </Callout>
          )}

          {/* ── Where it goes ────────────────────────────────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-2">Move to</p>
            {destinations.length === 0 ? (
              /* Said rather than shown as an empty box: a waiter needs to know the floor
                 is full, not wonder whether the screen has loaded. */
              <Callout tone="warning">
                Every other table has a bill on it. Free one first — a split cannot merge
                two parties onto one bill.
              </Callout>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {destinations.map((t) => (
                  <Button
                    key={t.id}
                    variant={toTableId === t.id ? 'primary' : 'secondary'}
                    size="touch"
                    disabled={busy}
                    onClick={() => setToTableId(t.id)}
                  >
                    {t.code}
                    {toTableId === t.id && <Icons.Check size={16} />}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
