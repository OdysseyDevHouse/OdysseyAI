'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import { NumberInput, Select } from './Field'
import {
  FACTOR_UNITS,
  UNIT_LABEL,
  factorSentence,
  usageUnitFor,
  weightFactor,
  type FactorUnit,
} from '@/lib/recipeFactor'

/**
 * Working out a recipe quantity, in three questions.
 *
 * ── WHY A WIZARD AND NOT A CALCULATOR ─────────────────────────────────────
 *
 * A recipe line does not store a weight. It stores the FRACTION of a purchased
 * unit that one made item consumes, because that is what the costing multiplies
 * and what the stock deduction takes: beef patties bought as a 10 Kg box and
 * used 200 g at a time is a quantity of 0.02.
 *
 * Neither number a person actually knows — the 10 and the 200 — is the one that
 * goes in the box, and the arithmetic between them is easy to get wrong by a
 * factor of a thousand in a way nothing downstream complains about. Typing 200
 * into the quantity box costs a burger two hundred boxes of mince and the only
 * symptom is a margin nobody can explain.
 *
 * So this asks the two questions whose answers are known, and does the sum:
 *
 *   1. Buying factor — what volume does one of these arrive in?  (10 Kg)
 *   2. Using factor  — how much does one made item use?          (200 g)
 *   3. Selling factor — reads back the answer, in the buying unit, and saves.
 *
 * The third step is not a formality. 0.02 is a figure nobody can sanity-check
 * on sight, so it is shown as a sentence naming both products and the unit
 * before it is committed.
 *
 * ── THE UNIT ON STEP 2 ────────────────────────────────────────────────────
 *
 * Chosen for the user, one step DOWN from the buying unit: Kg offers grams, L
 * offers ml, and a unit already at the bottom of its scale stays put. The whole
 * premise is that the using unit is smaller than the buying one, so offering
 * the same scale again mostly invites the error this exists to prevent. It is
 * a Select rather than fixed text so it still reads as the unit it is.
 */

type Step = 'buying' | 'using' | 'selling'

export function QtyCalculator({
  open,
  onClose,
  initial,
  onApply,
  label,
  madeName = 'this product',
}: {
  open: boolean
  onClose: () => void
  /**
   * The line's current quantity.
   *
   * Deliberately NOT used to seed the buying or usage boxes: it is a factor,
   * and neither question is asking for one. It is here so a re-opened dialog
   * can leave the line alone if cancelled.
   */
  initial: number
  /** The committed factor. Only fires from the last step. */
  onApply: (value: number) => void
  /** The ingredient — "Beef Patties (4)". */
  label: string
  /** What is being made from it — "Burger". */
  madeName?: string
}) {
  const [step, setStep] = useState<Step>('buying')
  const [buyingQty, setBuyingQty] = useState('')
  const [buyingUnit, setBuyingUnit] = useState<FactorUnit>('Kg')
  const [usageQty, setUsageQty] = useState('')
  const [usageUnit, setUsageUnit] = useState<FactorUnit>('g')
  const firstRef = useRef<HTMLInputElement>(null)

  /* Reset on OPEN, not on a changed prop: the dialog edits the line behind it,
     so keying this on `initial` would re-run the wizard as its own result
     arrived. Every question starts unanswered — this asks fresh each time
     rather than reading the product's stored pack weight, so two recipes can
     describe the same ingredient differently without fighting each other. */
  useEffect(() => {
    if (!open) return
    setStep('buying')
    setBuyingQty('')
    setBuyingUnit('Kg')
    setUsageQty('')
    setUsageUnit('g')
    const id = window.setTimeout(() => firstRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  /* The usage unit FOLLOWS the buying unit. Chosen here rather than left to the
     user because the pairing is the rule, not a preference — see the note above. */
  function chooseBuyingUnit(next: FactorUnit) {
    setBuyingUnit(next)
    setUsageUnit(usageUnitFor(next))
  }

  const buying = Number(buyingQty)
  const usage = Number(usageQty)
  const factor = weightFactor({
    buyingQty: buying,
    buyingUnit,
    usageQty: usage,
    usageUnit,
  })

  // A pack has to be a real quantity before "how much of it" means anything.
  const buyingOk = Number.isFinite(buying) && buying > 0
  const usageOk = Number.isFinite(usage) && usage >= 0 && factor !== null

  function save() {
    if (factor === null) return
    onApply(factor)
    onClose()
  }

  const heading =
    step === 'buying' ? 'Buying factor' : step === 'using' ? 'Using factor' : 'Selling factor'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Weight factor — (${label})`}
      size="sm"
      footer={
        step === 'buying' ? (
          <Button type="button" onClick={() => setStep('using')} disabled={!buyingOk}>
            Next
          </Button>
        ) : step === 'using' ? (
          <>
            <Button type="button" variant="ghost" onClick={() => setStep('buying')}>
              Back
            </Button>
            <Button type="button" onClick={() => setStep('selling')} disabled={!usageOk}>
              Next
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={() => setStep('using')}>
              Back
            </Button>
            {/* Disabled on an un-computable factor: committing one the dialog
                could not work out is how a line silently costs nothing. */}
            <Button type="button" onClick={save} disabled={factor === null}>
              Save
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-ink">{heading}</h3>

        {step === 'buying' && (
          <>
            <p className="text-sm text-muted">
              When buying {label}, what volume do you receive it in?
            </p>
            <div className="flex items-center gap-3">
              <NumberInput
                ref={firstRef}
                value={buyingQty}
                onChange={(e) => setBuyingQty(e.target.value)}
                precision={4}
                aria-label={`Volume ${label} is received in`}
                className="flex-1"
              />
              <Select
                value={buyingUnit}
                onChange={(e) => chooseBuyingUnit(e.target.value as FactorUnit)}
                aria-label="Buying unit"
                className="w-32"
              >
                {FACTOR_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}

        {step === 'using' && (
          <>
            <p className="text-sm text-muted">
              When selling {madeName}, how much {label} do you use?
            </p>
            <div className="flex items-center gap-3">
              <NumberInput
                value={usageQty}
                onChange={(e) => setUsageQty(e.target.value)}
                precision={4}
                aria-label={`Amount of ${label} used`}
                className="flex-1"
                autoFocus
              />
              {/* Only the units that can convert into the buying one. A single
                  option is left as a Select on purpose: it still names the unit,
                  which is the thing being read. */}
              <Select
                value={usageUnit}
                onChange={(e) => setUsageUnit(e.target.value as FactorUnit)}
                aria-label="Using unit"
                className="w-32"
              >
                {[...new Set([usageUnitFor(buyingUnit), buyingUnit])].map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}

        {step === 'selling' && (
          <>
            <p className="text-sm text-muted">
              {factor === null
                ? 'Those two measurements cannot be compared. Go back and choose units on the same scale.'
                : factorSentence(madeName, label, factor, buyingUnit)}
            </p>
            {/* Read-only: it is the ANSWER, and a box that invites a correction
                here would let the number drift from the two figures above it
                that explain where it came from. */}
            <NumberInput
              value={factor ?? ''}
              precision={4}
              readOnly
              aria-label="Selling factor"
            />
          </>
        )}
      </div>
    </Modal>
  )
}
