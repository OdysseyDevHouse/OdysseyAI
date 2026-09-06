'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Callout,
  Icons,
  Modal,
  NumPad,
  NumPadDisplay,
  Input,
  SegmentedControl,
  numPadValue,
} from '@/components/ui'
import { formatMoney, formatQty, round, roundQty, qtyDecimalsOf } from '@/lib/decimals'
import { lineTotals } from '@/lib/documentMath'
import { discountAllowed, instructionAdjust, type BasketLine } from '@/lib/basket'

/**
 * Changing one line: how many, what price, what discount.
 *
 * Three fields, one numeric pad, and a segmented control to say which of them is
 * being typed. A form with three separate inputs would need three precise taps
 * to move between them and would put the pad somewhere different for each; this
 * way the pad never moves and the cashier's thumb stays where it was.
 *
 * ── WHAT THIS REFUSES, AND WHAT IT ONLY WARNS ABOUT ───────────────────────
 *
 * A discount above the product's own ceiling is REFUSED here unless the operator
 * holds `sales.discount_override`, and a price off the shelf figure needs
 * `sales.price_override`. Both are checked again server-side by `checkPricing` at
 * save and at finalise — this is the courtesy of failing at the point of entry
 * rather than at the moment the customer is handing over money.
 */
export function LineEditModal({
  line,
  field: openOn = 'qty',
  canOverrideDiscount,
  canOverridePrice,
  onClose,
  onSave,
  onSupervisor,
}: {
  /** Null closes the dialog. */
  line: BasketLine | null
  /**
   * Which field the pad opens on.
   *
   * The Line options menu names Line Discount, Price Override and Set new
   * quantity as three separate entries, and each has to land on the field it
   * promised — a cashier who tapped "Line Discount" and got the quantity tab has
   * to read all three tabs to find the one they asked for. Defaults to quantity,
   * which is what every caller that does not care wants.
   */
  field?: 'qty' | 'price' | 'discount'
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  onClose: () => void
  onSave: (changes: Partial<BasketLine>) => void
  /**
   * "Ask a supervisor" — offered on the two refusals a manager's PIN can lift.
   * The shell opens the override pad; on approval it applies `changes` itself
   * and attaches the authorisation to the sale.
   */
  onSupervisor?: (request: {
    capability: 'sales.discount_override' | 'sales.price_override'
    actionLabel: string
    amount: number
    changes: Partial<BasketLine>
  }) => void
}) {
  type FieldName = 'qty' | 'price' | 'discount'
  const [field, setField] = useState<FieldName>(openOn)
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [discount, setDiscount] = useState('')
  const [note, setNote] = useState('')

  // Seeded from the line each time it opens, so the pad starts on the current
  // figures rather than empty — a cashier changing 1 to 2 should not have to
  // establish what it is now.
  useEffect(() => {
    if (!line) return
    // `openOn`, not a hardcoded 'qty' — the menu entry that opened this said
    // which field it was promising, and re-seeding to quantity would break it.
    setField(openOn)
    setQty(String(line.qty))
    setPrice(line.unitPriceIncl.toFixed(2))
    setDiscount(line.discountPct ? String(line.discountPct) : '')
    setNote(line.note)
  }, [line, openOn])

  if (!line) return null

  const values = { qty, price, discount }
  const setters: Record<FieldName, (v: string) => void> = {
    qty: setQty,
    price: setPrice,
    discount: setDiscount,
  }

  /*
   * Rounded to what this product allows, at the point the typed digits become a
   * number — so every reader below (the refusal, the supervisor request, the
   * totals, the saved line) sees ONE quantity rather than each rounding its own
   * copy and disagreeing by a thousandth.
   *
   * Rounded rather than refused: a cashier keying 1.2345 into a two-decimal
   * product has measured more finely than the product is sold in, which is not
   * a mistake to send back. The pad below stops accepting a fifth digit anyway;
   * this catches the value that was already in the box when the modal opened —
   * a recalled line, or a scale barcode's embedded weight.
   */
  const nextQty = roundQty(numPadValue(qty), line)
  const nextPrice = numPadValue(price)
  const nextDiscount = numPadValue(discount)

  /*
   * The answers' price is backed out before comparing to the shelf.
   *
   * It is folded INTO unitPriceIncl so the rest of the document prices the item
   * as sold, which means a burger with bacon legitimately sits above the shelf
   * figure. Without this subtraction, merely OPENING this dialog on a modified
   * line and saving it unchanged would be refused as an override — the same trap
   * checkPricing had, wearing a different face.
   */
  const adjust = instructionAdjust(line)
  const priceChanged =
    line.shelfPriceIncl !== null && round(nextPrice - adjust, 2) !== round(line.shelfPriceIncl, 2)
  const overCeiling = !discountAllowed(line, nextDiscount)

  // A refusal names the capability it needs, so a cashier knows to fetch a
  // supervisor rather than assuming the till is broken.
  const refusal =
    nextQty === 0
      ? 'Enter a quantity, or void the line instead.'
      : !line.allowFractions && !Number.isInteger(nextQty)
        ? `${line.description} is sold in whole units.`
        : overCeiling && !canOverrideDiscount
          ? `A discount above ${formatQty(line.maxDiscountPct)}% needs a supervisor.`
          : priceChanged && !canOverridePrice
            ? 'Changing the price needs a supervisor.'
            : null

  /* Which refusal a manager's PIN can lift, if any. The discount is asked
     about first when both apply — the second breach surfaces on its own the
     moment the first is approved. */
  const supervisorRequest =
    nextQty > 0 && (line.allowFractions || Number.isInteger(nextQty))
      ? overCeiling && !canOverrideDiscount
        ? {
            capability: 'sales.discount_override' as const,
            actionLabel: `${formatQty(nextDiscount)}% discount on ${line.description}`,
            amount: lineTotals({
              qty: nextQty,
              unitPriceIncl: nextPrice,
              discountPct: nextDiscount,
              vatRatePct: line.vatRatePct,
            }).discountIncl,
          }
        : priceChanged && !canOverridePrice
          ? {
              capability: 'sales.price_override' as const,
              actionLabel: `Price change on ${line.description}`,
              amount: nextPrice,
            }
          : null
      : null

  return (
    <Modal
      open
      onClose={onClose}
      title={line.description}
      size="sm"
      /* Qty, price and discount touch pads stacked above a note and a refusal
         callout — a tall panel on the small screen it is used on. */
      bodyGrows
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose}>
            Cancel
          </Button>
          {/* The refusal's remedy, right where the refusal is. On approval the
              SHELL applies these changes and rides the authorisation on the
              sale — this dialog closes out of the way. */}
          {supervisorRequest && onSupervisor && (
            <Button
              variant="warning"
              size="touch"
              onClick={() =>
                onSupervisor({
                  ...supervisorRequest,
                  changes: {
                    qty: nextQty,
                    unitPriceIncl: nextPrice,
                    discountPct: nextDiscount,
                    note: note.trim(),
                  },
                })
              }
            >
              Ask a supervisor
            </Button>
          )}
          <Button
            variant="primary"
            size="touch-lg"
            className="flex-1 justify-center"
            disabled={refusal !== null}
            onClick={() =>
              onSave({
                qty: nextQty,
                unitPriceIncl: nextPrice,
                discountPct: nextDiscount,
                note: note.trim(),
              })
            }
          >
            <Icons.Check size={20} />
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SegmentedControl
          value={field}
          onChange={(v) => setField(v as FieldName)}
          options={[
            { value: 'qty', label: 'Quantity', icon: <Icons.Hash size={15} /> },
            { value: 'price', label: 'Price', icon: <Icons.Money size={15} /> },
            { value: 'discount', label: 'Discount %', icon: <Icons.Percent size={15} /> },
          ]}
        />

        <NumPadDisplay
          label={
            field === 'qty'
              ? line.allowFractions
                ? // The number of places is named, not just the fact of them:
                  // "fractions allowed" left a cashier to discover the limit by
                  // being rounded, which is the moment it is least welcome.
                  `Quantity — up to ${qtyDecimalsOf(line)} decimals`
                : 'Quantity'
              : field === 'price'
                ? line.shelfPriceIncl !== null
                  ? // The answers are named in the comparison rather than hidden,
                    // so a cashier looking at R30.50 against a R23.00 shelf can
                    // see where the difference came from instead of assuming
                    // somebody has overridden the price.
                    adjust !== 0
                    ? `Unit price — shelf is ${formatMoney(line.shelfPriceIncl)} plus ${formatMoney(adjust)} of answers`
                    : `Unit price — shelf is ${formatMoney(line.shelfPriceIncl)}`
                  : 'Unit price'
                : `Discount % — up to ${formatQty(line.maxDiscountPct)}% without a supervisor`
          }
          value={values[field]}
          tone={refusal ? 'danger' : 'default'}
        />

        <NumPad
          value={values[field]}
          onChange={setters[field]}
          /* Quantity of a whole-unit product takes no decimal point at all,
             which is a clearer refusal than accepting 1.5 and rejecting it on
             save. A fractional one takes the places IT allows — the pad simply
             stops accepting digits past them, so the cashier sees the limit as
             they type rather than watching the number change under them after.
             qtyDecimalsOf answers 0 for a whole-unit product, which is the same
             answer the old !allowFractions branch gave. */
          maxDecimals={field === 'qty' ? qtyDecimalsOf(line) : 2}
        />

        {/* A note on ANY line, not only one that happened to be asked a
            question. "No ice" is a thing a customer says about a Coke, and a
            Coke asks nothing — without this the note box would exist only on
            products a shop had already thought to configure, which is exactly
            backwards for the unplanned thing a note is for. */}
        <Input
          size="touch"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={190}
          placeholder="Note for this line — e.g. no ice"
          aria-label="Note for this line"
        />

        {refusal ? (
          <Callout tone="danger">{refusal}</Callout>
        ) : (
          <div className="rounded-card border border-border bg-surface-2 px-4 py-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Line total</span>
              {/* lineTotals, not arithmetic written here. Its rounding is what
                  the slip and the posted document both use, and a second
                  expression that is right to the cent today drifts the first
                  time that rounding changes. */}
              <span className="numeric font-semibold text-ink">
                {formatMoney(
                  lineTotals({
                    qty: nextQty,
                    unitPriceIncl: nextPrice,
                    discountPct: nextDiscount,
                    vatRatePct: line.vatRatePct,
                  }).lineTotalIncl,
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
