'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Modal, NumberInput } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
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
            precision={3}
            value={weight || ''}
            onChange={(e) => setWeight(Number(String(e.target.value).replace(',', '.')) || 0)}
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
          <Button variant="success" disabled={!valid} onClick={() => onConfirm(weight)}>
            Add to sale
          </Button>
        </div>
      </div>
    </Modal>
  )
}
