'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Input, NumberInput, Icons } from '@/components/ui'
import { formatMoney, qtyDecimalsOf, roundQty } from '@/lib/decimals'
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
/**
 * The quantity label, naming what this product will actually accept.
 *
 * Whole units get said in words rather than as "0 decimals", which reads like a
 * setting rather than like an instruction to the person typing.
 */
function qtyLabel(product: TillProduct): string {
  const places = qtyDecimalsOf(product)
  return places === 0 ? 'Quantity (whole units)' : `Quantity (${places} decimals)`
}

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
    /* Rounded here as well as on blur, because Enter commits without ever
       blurring the box — see the note on onBlur. `lineFromProduct` rounds again
       on the way into the basket; this one is so the counterhand and the line
       agree about what was just added. */
    onAdd(found, roundQty(qty, found))
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
          {/* Named with the limit once a product is in hand, the way the till's
              line editor names it. A counterhand typing 3.5 into a box labelled
              "Quantity (whole units)" can see why it will land as 4, rather than
              watching a number change on its own. Before the lookup there is no
              product to have a rule, so the plain label stands. */}
          <Field label={found ? qtyLabel(found) : 'Quantity'}>
            <NumberInput
              value={qty}
              min={0}
              /* The product's own places once one is found. `step="any"` was
                 inert anyway — NumberInput renders type="text", so min/step have
                 never constrained anything here. */
              step="any"
              /*
               * What actually holds the rule: a keystroke past the product's
               * places is REFUSED, so the box never shows a figure the counter
               * hand did not type. Before the lookup there is no product to
               * have a rule, so it is left undefined and anything may be typed
               * — the blur and commit rounding below settle whatever was
               * entered once the product IS known.
               */
              precision={found ? qtyDecimalsOf(found) : undefined}
              onChange={(e) => setQty(Number(String(e.target.value).replace(',', '.')) || 0)}
              /*
               * Rounded when the box is LEFT, not per keystroke.
               *
               * Rounding as they type would fight the caret — "1.2" of a
               * two-decimal product becomes 1.2 and the next keystroke cannot
               * reach 1.25. On blur the number is settled, so correcting it
               * there is the first honest moment.
               *
               * `commit` rounds again rather than trusting this: Enter fires
               * without a blur, and the counter's whole point is that a line is
               * entered without the hands leaving the keyboard.
               */
              onBlur={() => {
                if (found) setQty(roundQty(qty, found))
              }}
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
