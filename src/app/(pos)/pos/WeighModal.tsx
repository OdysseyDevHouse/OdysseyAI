'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Modal, NumberInput } from '@/components/ui'
import { formatMoney, qtyDecimalsOf, roundQty } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The weight prompt for a scale item added WITHOUT a scale barcode.
 *
 * A scale barcode arrives with its weight embedded and skips this entirely.
 * Everything else — a tile, a search result, a typed code — has no weight, and
 * ringing up "1" of something priced per kilogram silently charges for a whole
 * kilogram of mince somebody wanted 300g of. The product-properties switch has
 * promised this prompt since 006; this is the till holding it to that.
 *
 * The weight is typed from the scale's display rather than read from a device —
 * a live scale integration is its own piece of work, and a shop without one
 * still weighs on a standalone scale and keys what it says.
 */
export function WeighModal({
  product,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  /** The confirmed weight, in the product's selling unit (usually kg). */
  onConfirm: (weight: number) => void
  onCancel: () => void
}) {
  const [weight, setWeight] = useState<number>(0)

  // A fresh product means a fresh entry — never inherit the last item's weight.
  useEffect(() => setWeight(0), [product.id])

  /*
   * ── A SCALE ITEM THAT DOES NOT ALLOW FRACTIONS ────────────────────────────
   *
   * `qtyDecimalsOf` answers 0 for one, and a weight box that rounds every entry
   * to a whole number is not a weight box. The two switches disagree — somebody
   * has marked a product "sold by weight" and left fractions off — and this is
   * the screen where that shows up, with a customer waiting.
   *
   * The prompt still works: it takes whole units, which is what the product file
   * actually says, and `roundQty` below makes the box say so rather than
   * accepting 0.3 and quietly ringing up 0. Refusing to open would be worse — it
   * would take the product off sale over a settings mistake.
   */
  const places = qtyDecimalsOf(product)

  const valid = Number.isFinite(weight) && weight > 0

  return (
    <Modal open onClose={onCancel} title={`Weigh ${product.description}`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Sold by weight at {formatMoney(product.priceIncl)} per unit. Key what the scale
          says.
        </p>

        <Field label="Weight">
          <NumberInput
            autoFocus
            /*
             * The product's own places, not a hardcoded three.
             *
             * Three was both too few and too many: a product set to 4 decimals
             * had its fourth place shown away while the state still held it, and
             * one set to 2 displayed a third place it cannot be sold in. The
             * blur rounding below is what makes the display honest — `precision`
             * alone only formats, it never writes back.
             */
            precision={places}
            value={weight || ''}
            onChange={(e) => setWeight(Number(String(e.target.value).replace(',', '.')) || 0)}
            /* Settled on blur so the box and the line agree. Rounding per
               keystroke would stop 0.3 ever reaching 0.375. */
            onBlur={() => setWeight(roundQty(weight, product))}
            className="text-right"
          />
        </Field>

        {valid && (
          <div className="flex justify-between rounded-control bg-surface-2 px-3 py-2 text-sm">
            <span className="text-muted">This line</span>
            <span className="numeric text-ink">{formatMoney(product.priceIncl * weight)}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          {/* Rounded here too: the button can be pressed without the box ever
              blurring, and the weight this hands back becomes the line. */}
          <Button variant="success" disabled={!valid} onClick={() => onConfirm(roundQty(weight, product))}>
            Add to sale
          </Button>
        </div>
      </div>
    </Modal>
  )
}
