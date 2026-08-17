'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Input, NumberInput, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The trade counter's way in: a keyboard, not a grid of pictures.
 *
 * ── WHY A RETAIL TILL'S CATALOGUE IS THE WRONG SHAPE HERE ─────────────────
 *
 * A supermarket cashier scans. A restaurant waiter taps a picture of a burger.
 * A hardware counterhand does neither: the customer says "twelve of the 15mm
 * elbows and a 3-metre length of the white trunking", and the person behind the
 * counter TYPES it — a code they know by heart, a quantity, next line.
 *
 * A tile grid is actively worse for that. Twelve tiles of near-identical
 * plumbing fittings are harder to tell apart than twelve codes, the grid needs a
 * mouse or a reach across the counter, and neither hand leaves the keyboard when
 * the entry is a code and a number.
 *
 * So this pane is one row: code, quantity, add. Enter moves through it and the
 * focus returns to the code box, which means a whole document can be entered
 * without touching anything else.
 *
 * ── WHAT IT SHARES WITH THE TOUCH TILL ────────────────────────────────────
 *
 * Everything underneath. The same basket, the same pricing, the same specials,
 * the same payment path — this pane only decides how a line is CHOSEN. It hands
 * a product and a quantity to the same `add` the tiles call, so a price rung up
 * here and one rung up at a touch till cannot disagree.
 */
export default function TradeEntryPane({
  onLookup,
  onAdd,
  online,
  busy,
}: {
  /**
   * Finds a product by code or barcode. Null when nothing matches.
   *
   * The lookup belongs to the shell, which knows whether to ask the server or
   * the offline catalogue — this pane must work identically either way, and a
   * pane that knew about the network would have to be told when it changed.
   */
  onLookup: (code: string) => Promise<TillProduct | null>
  onAdd: (product: TillProduct, qty: number) => void
  online: boolean
  busy: boolean
}) {
  const [code, setCode] = useState('')
  const [qty, setQty] = useState(1)
  const [found, setFound] = useState<TillProduct | null>(null)
  const [looking, setLooking] = useState(false)
  const [missed, setMissed] = useState<string | null>(null)

  /*
   * Focused by id rather than by ref, because `Input` is a plain function
   * component and does not forward one. Adding forwardRef to the shared kit for
   * one screen's convenience is the kind of change that should be driven by the
   * kit's own needs rather than by a caller's — and this works today.
   */
  const CODE_FIELD = 'trade-entry-code'
  /*
   * Focus only — NOT select.
   *
   * Selecting looks helpful and is actively wrong here: a scanner sends its
   * characters one at a time, and with the field's contents selected each one
   * replaces the last, so an eight-character code arrives as its final letter.
   * The box is always empty when this is called anyway — it is cleared on commit
   * and starts empty — so there is nothing a selection would save anybody.
   */
  const focusCode = () => {
    const el = document.getElementById(CODE_FIELD)
    if (el instanceof HTMLInputElement) el.focus()
  }

  /* Focus starts and RETURNS here. A counterhand entering thirty lines should
     never have to reach for the mouse to start the next one. */
  useEffect(() => {
    focusCode()
    // Mount only: re-focusing on every render would fight the quantity box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function lookup() {
    const term = code.trim()
    if (!term) return
    setLooking(true)
    setMissed(null)
    try {
      const product = await onLookup(term)
      if (product) {
        setFound(product)
        return
      }
      /* Named, not just "not found". A counterhand who mistyped one character
         needs to see what they typed to spot it. */
      setFound(null)
      setMissed(term)
    } finally {
      setLooking(false)
    }
  }

  function commit() {
    if (!found) {
      void lookup()
      return
    }
    onAdd(found, qty)
    /* Straight back to an empty code box at quantity one — the state the next
       line starts from. A pane that kept the last quantity would put 12 of the
       next item on the document the moment somebody typed a code and pressed
       Enter twice. */
    setFound(null)
    setCode('')
    setQty(1)
    setMissed(null)
    focusCode()
  }

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Code or barcode">
            <Input
              id={CODE_FIELD}
              value={code}
              placeholder="Type a code and press Enter"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value)
                /* A changed code invalidates what was found for the old one.
                   Without this, editing the code after a hit and pressing Enter
                   would add the PREVIOUS product. */
                setFound(null)
                setMissed(null)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                if (found) commit()
                else void lookup()
              }}
            />
          </Field>
        </div>

        <div className="w-28 shrink-0">
          <Field label="Quantity">
            <NumberInput
              value={qty}
              min={0}
              step="any"
              onChange={(e) => setQty(Number(e.target.value) || 0)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                }
              }}
            />
          </Field>
        </div>

        <Button
          variant="primary"
          size="touch"
          className="shrink-0"
          onClick={commit}
          disabled={busy || looking || (!found && code.trim() === '')}
        >
          <Icons.Plus size={16} />
          {found ? 'Add' : 'Find'}
        </Button>
      </div>

      {/* What was found, so the price is seen BEFORE it lands on the document —
          a counterhand quoting over a counter reads it out from here. */}
      {found && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-control bg-brand-soft px-3 py-2">
          <span className="min-w-0 font-semibold text-ink">{found.description}</span>
          <span className="text-sm text-muted">{found.code}</span>
          <span className="font-semibold tabular-nums text-ink">
            {formatMoney(found.priceIncl)}
          </span>
          <span className="w-full text-sm text-muted">
            {qty} × {formatMoney(found.priceIncl)} ={' '}
            <span className="font-semibold text-ink">{formatMoney(qty * found.priceIncl)}</span>
            {found.stockOnHand !== undefined && (
              <> · {found.availableQty} available</>
            )}
          </span>
        </div>
      )}

      {missed && (
        <p className="text-sm text-danger">
          Nothing matches “{missed}”.
          {!online && ' This till is offline, so only what it has stored can be found.'}
        </p>
      )}
    </div>
  )
}
