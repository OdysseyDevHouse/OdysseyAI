'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Input, Modal, NumberInput } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The description and price prompts, for a product whose file asks for them.
 *
 * Two switches on the Properties tab, answered on one screen because a product
 * may carry both and two dialogs in a row for one scan is a worse counter
 * experience than one dialog with two boxes.
 *
 *   `change_description`  the stored description names a CATEGORY — "Sundry",
 *                         "Repair", "Delivery" — and the real wording is written
 *                         at the counter so the customer's copy says what they
 *                         actually bought.
 *
 *   `ask_price_at_sale`   there is no shelf price to ring up: cut flowers, fabric
 *                         off a roll, a repair quoted at the counter. The price
 *                         IS typed, which is why `checkPricing` exempts these
 *                         products from the override guard rather than refusing
 *                         every one of them.
 *
 * ── WHY THIS HAD TO EXIST ─────────────────────────────────────────────────
 *
 * Both switches have been saved since 006 and neither was ever read by a till.
 * `ask_price_at_sale` was the worse of the two: the guard already skipped those
 * products, so the flag SUPPRESSED the check that would have caught a wrong
 * price without ever prompting for the right one. A product marked "ask for the
 * price" rang up at its stored price with the safety net switched off.
 *
 * Modelled on WeighModal deliberately — same shape, same place in `add()`, same
 * reason. A prompt that only some add paths reach is a prompt the scanner will
 * miss, and the scanner is most of a shop's volume.
 */
export function AskDetailsModal({
  product,
  askDescription,
  askPrice,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  askDescription: boolean
  askPrice: boolean
  /** The answers. `description` is trimmed; `price` is inclusive of VAT. */
  onConfirm: (answers: { description: string; price: number }) => void
  onCancel: () => void
}) {
  /*
   * The stored description is the STARTING POINT, not a placeholder.
   *
   * "Repair" is a real answer for a repair nobody wants to elaborate on, and a
   * cashier who presses straight through gets exactly what the old behaviour
   * gave them. Selecting it on focus (NumberInput and Input both do) means
   * typing over it costs no keystrokes either.
   */
  const [description, setDescription] = useState(product.description)
  const [price, setPrice] = useState<number>(askPrice ? 0 : product.priceIncl)

  // A fresh product means fresh answers — never inherit the last item's.
  useEffect(() => {
    setDescription(product.description)
    setPrice(askPrice ? 0 : product.priceIncl)
  }, [product.id, product.description, product.priceIncl, askPrice])

  /*
   * A priced-at-sale line may legitimately be worth nothing — a no-charge
   * repair, a replacement handed over — so zero is allowed. What is refused is
   * a NEGATIVE price, which is a refund wearing a sale's clothing: the till has
   * its own refund path, and letting one in here would post a sale line that
   * subtracts from the takings without any of the checks a return goes through.
   */
  /*
   * This product's price IS a rate, so the box is asking for a percentage.
   *
   * The two switches contradict each other — "ask for the price" says the money
   * is typed, "charge % of subtotal" says it is derived — and a product can
   * carry both. Rather than refuse the combination, the typed figure is taken
   * as the RATE: the only reading under which it survives, since money typed
   * here would be overwritten by the next reprice.
   */
  const isCharge = product.chargePctSubtotal

  const priceOk =
    !askPrice || (Number.isFinite(price) && price >= 0 && (!isCharge || price <= 100))
  const descriptionOk = !askDescription || description.trim().length > 0
  const valid = priceOk && descriptionOk

  const title = askDescription && askPrice ? 'Item details' : askDescription ? 'Item description' : 'Item price'

  return (
    <Modal open onClose={onCancel} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {askPrice
            ? isCharge
              ? `${product.description} is charged as a percentage of the rest of the sale.`
              : `${product.description} is priced at the counter.`
            : `${product.description} is sold under a description you enter.`}
        </p>

        {askDescription && (
          <Field label="Description">
            <Input
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              /* The column the line is stored in. Truncating here rather than
                 at save means the cashier sees what will actually print. */
              maxLength={200}
            />
          </Field>
        )}

        {askPrice && (
          /* Named for what the number MEANS on this product. A charge line's
             box takes a rate, and calling it a price would have the cashier
             type rands into a field that reads them as a percentage. */
          <Field label={isCharge ? 'Percentage of the sale' : 'Price (incl. VAT)'}>
            <NumberInput
              autoFocus={!askDescription}
              precision={2}
              value={price || ''}
              onChange={(e) => setPrice(Number(String(e.target.value).replace(',', '.')) || 0)}
              className="text-right"
            />
          </Field>
        )}

        {valid && askPrice && (
          <div className="flex justify-between rounded-control bg-surface-2 px-3 py-2 text-sm">
            <span className="text-muted">This line</span>
            {/* A charge cannot be shown as money here: what it comes to depends
                on the rest of the sale, which is not settled until the line is
                on the document. Showing the rate is the honest answer. */}
            <span className="numeric text-ink">
              {isCharge ? `${price}% of the sale` : formatMoney(price)}
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="success"
            disabled={!valid}
            onClick={() =>
              onConfirm({
                description: description.trim() || product.description,
                price: askPrice ? price : product.priceIncl,
              })
            }
          >
            Add to sale
          </Button>
        </div>
      </div>
    </Modal>
  )
}
