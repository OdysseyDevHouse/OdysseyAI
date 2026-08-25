'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Icons, Input, Modal } from '@/components/ui'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * Which UNIT is being handed over, asked when a serial-tracked item is added.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ─────────────────────────────────────────
 *
 * Nothing at a till has ever picked a serial. A laptop could be rung up, and
 * was only refused at the TENDER PAD — "choose 1 serial number, 0 selected" —
 * after the customer had been asked to pay. Offline the same item was refused
 * kindly at the tile. Same shop, same product, opposite experiences, and the
 * bad one happened with somebody's card already out.
 *
 * ── WHY A SCAN BOX AND NOT ONLY A LIST ───────────────────────────────────
 *
 * A serial is usually PRINTED ON THE BOX, and the box is on the counter. The
 * fast path is scanning it, so the field is focused and a scanner's Enter
 * selects an exact match outright. The list is the fallback for a unit whose
 * label will not read, and it filters as you type.
 *
 * ── AND WHY THE FIRST UNIT IS NOT PRESELECTED ────────────────────────────
 *
 * Unlike the lot picker, which preselects the earliest expiry because that IS
 * the answer the server would have chosen. Here there is no such default: one
 * laptop is not interchangeable with another once its serial goes on an
 * invoice and its warranty starts. Preselecting would let a distracted cashier
 * hand over unit A while the paperwork retires unit B — and warranty claims are
 * where that surfaces, months later.
 */
export function SerialModal({
  product,
  units,
  loading,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  /** In-stock units at this till's location. */
  units: { id: number; serial: string }[]
  loading: boolean
  onConfirm: (unit: { id: number; serial: string }) => void
  onCancel: () => void
}) {
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<number | null>(null)

  // A fresh product means a fresh answer — never inherit the last item's unit.
  useEffect(() => {
    setTerm('')
    setPicked(null)
  }, [product.id])

  const shown = useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (!needle) return units.slice(0, 50)
    return units.filter((u) => u.serial.toLowerCase().includes(needle)).slice(0, 50)
  }, [units, term])

  const chosen = units.find((u) => u.id === picked) ?? null

  /*
   * A scanner sends the serial and then Enter. An EXACT match is taken
   * immediately — that is the whole fast path, and asking someone to scan and
   * then also tap a row would make the feature slower than the bug.
   */
  function submit() {
    const needle = term.trim().toLowerCase()
    const exact = units.find((u) => u.serial.toLowerCase() === needle)
    if (exact) {
      onConfirm(exact)
      return
    }
    if (chosen) onConfirm(chosen)
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Which ${product.description}?`}
      /* The unit LIST scrolls inside a growing body, so the scan box above it
         stays put while the serials scroll past. */
      bodyPins
    >
      <div className="flex min-h-0 flex-col gap-4">
        <p className="text-sm text-muted">
          Scan the serial on the box, or pick it from the list.
        </p>

        <Input
          autoFocus
          value={term}
          placeholder="Scan or type a serial number"
          icon={<Icons.Barcode size={16} />}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />

        {loading ? (
          <p className="text-sm text-faint">Reading the units on hand…</p>
        ) : units.length === 0 ? (
          <EmptyState
            title="No units on hand here"
            hint="This till's location has none in stock. Receive one, or transfer it in, before selling it."
          />
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing matches “{term.trim()}”. Clear the box to see all {units.length}.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {shown.map((unit) => (
              <label
                key={unit.id}
                /* Not a kit component: a selectable row whose whole surface is
                   the target, which Radio's inline label cannot express. */
                data-kit-ok
                className={`flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 ${
                  picked === unit.id
                    ? 'border-brand bg-brand-soft'
                    : 'border-border bg-surface hover:bg-surface-2'
                }`}
              >
                <input
                  type="radio"
                  name="serial"
                  className="size-4 cursor-pointer border-border-strong"
                  checked={picked === unit.id}
                  onChange={() => setPicked(unit.id)}
                />
                <span className="truncate text-sm font-medium text-ink">{unit.serial}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" disabled={!chosen} onClick={submit}>
            Add to sale
          </Button>
        </div>
      </div>
    </Modal>
  )
}
