'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Icons, Input, Modal } from '@/components/ui'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { SerialCaptureMode } from '@/lib/serialStatus'

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
 *
 * ── AND WHY THE LIST CAN BE TURNED OFF ENTIRELY ──────────────────────────
 *
 * Not preselecting is not enough on its own. A clerk under pressure taps the
 * first row without reading the box, which produces exactly the mismatch the
 * paragraph above is about — the list makes the fast wrong answer one tap away.
 * `serial_capture_mode` = 'scan' hides it, so the number has to come off the
 * box every time.
 *
 * The units are still LOADED under 'scan'. They are what the typed number is
 * checked against, and that check is the reason a wrong serial is refused here
 * rather than at the tender pad. The setting removes the shortcut, not the
 * validation.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * When the unit was received, as a short date — or '' when it has none.
 *
 * Read with the getUTC* getters, not the local ones. The pool runs at timezone
 * 'Z', so the stored wall-clock reading is carried in the ISO string's UTC
 * fields; `getDate()` on a till west of Greenwich would show the day before.
 * Formatted by hand rather than through toLocaleDateString for the same reason
 * the getters are UTC — the locale version reads the LOCAL fields and would
 * undo the care taken to get here.
 */
function receivedLabel(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function SerialModal({
  product,
  units,
  capture = 'list',
  loading,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  /** In-stock units at this till's location. */
  units: { id: number; serial: string; receivedAt?: string | null }[]
  /**
   * Whether the units may be LISTED, or only matched against.
   *
   * Under 'scan' the list is not rendered — but the units are still loaded and
   * still the thing the typed number is checked against, so a serial that is
   * not on this counter's shelf is refused exactly as before. The setting hides
   * the shortcut, it does not weaken the check.
   */
  capture?: SerialCaptureMode
  loading: boolean
  onConfirm: (unit: { id: number; serial: string }) => void
  onCancel: () => void
}) {
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const listed = capture === 'list'

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

  /* Under 'scan' there is no row to have picked, so the only thing that can
     confirm the sale is an exact match on what was typed. Reusing `chosen` for
     both keeps one definition of "which unit is going out" — the button's
     enabled state and what `submit` acts on can never drift apart. */
  const typedExact =
    units.find((u) => u.serial.toLowerCase() === term.trim().toLowerCase()) ?? null
  const chosen = listed ? (units.find((u) => u.id === picked) ?? null) : typedExact

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
          {listed
            ? 'Scan the serial on the box, or pick it from the list.'
            : 'Scan the serial on the box, or type it in.'}
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
        ) : /* Under 'scan' the shop has chosen not to see the units, so the
              feedback is about the number in the box and nothing else. Saying
              how many are on hand would hand back a piece of the list — and
              telling a clerk the count is the start of guessing. */
        !listed ? (
          term.trim() === '' ? null : typedExact ? (
            <p className="flex items-center gap-2 rounded-control bg-success-soft px-3 py-2 text-sm text-success-ink">
              <Icons.StatusSuccess size={15} />
              {typedExact.serial}
              {receivedLabel(typedExact.receivedAt) && (
                <span className="text-muted">· in stock since {receivedLabel(typedExact.receivedAt)}</span>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted">
              No unit here has that number. Check the box, or type it again.
            </p>
          )
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
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {unit.serial}
                </span>
                {/* When the unit was bought in.
                    Right-aligned and quiet: the serial is what the row is FOR,
                    and the date is the tie-breaker between two units that look
                    the same on the shelf — sell the older one. It renders only
                    where there is a date to show, so an opening-stock unit that
                    predates any GRV gets a clean row rather than a dash. */}
                {receivedLabel(unit.receivedAt) && (
                  <span className="shrink-0 text-xs text-muted">
                    Purchased {receivedLabel(unit.receivedAt)}
                  </span>
                )}
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
