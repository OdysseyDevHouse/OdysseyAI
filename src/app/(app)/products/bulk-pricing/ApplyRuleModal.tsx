'use client'

import { useState } from 'react'
import {
  Button,
  Callout,
  Checkbox,
  Field,
  Modal,
  NumberInput,
  Select,
} from '@/components/ui'
import {
  applyRule,
  type EndingDirection,
  type RepriceRounding,
  type RepriceRule,
} from '@/lib/repricing'
import type { BulkPricingRow } from '@/lib/site/bulkPricing'

/**
 * "Put 8% on these forty products" — a rule, run over the selected rows.
 *
 * ── WHY THIS COMPUTES IN THE BROWSER ──────────────────────────────────
 * Setup → Pricing's reprice plans server-side and writes what it planned,
 * because it sweeps a whole price type and the user never sees the rows. Here
 * the rows are already on screen with every figure the rule needs, and
 * `applyRule` is pure arithmetic with no database in it — the same function the
 * server calls. So the rule runs here and lands as PENDING EDITS in the grid,
 * which the user can then read, adjust one by one, and save or discard.
 *
 * That is the whole point of doing it on this screen rather than the other one:
 * a rule you can still argue with before it is written.
 */
export default function ApplyRuleModal({
  open,
  onClose,
  rows,
  defaultEndingDirection,
  onApply,
}: {
  open: boolean
  onClose: () => void
  /** The selected rows the rule will run over. */
  rows: BulkPricingRow[]
  defaultEndingDirection: EndingDirection
  /** Hands back the new inclusive price per product, and what was skipped. */
  onApply: (
    priced: { productId: number; priceIncl: number }[],
    skipped: { code: string; reason: string }[],
  ) => void
}) {
  const [method, setMethod] = useState<'adjust' | 'markup' | 'gp'>('adjust')
  const [percent, setPercent] = useState(5)

  /* The number means something different in each mode, so switching carries a
     sensible starting figure with it: 5 is a normal ADJUSTMENT and an absurd
     GP. Leaving "5" in the box under "Set a gross profit percentage" invites
     somebody to press the button and price a whole department at a 5% margin. */
  function chooseMethod(next: 'adjust' | 'markup' | 'gp') {
    if (next !== method) setPercent(next === 'adjust' ? 5 : next === 'markup' ? 40 : 35)
    setMethod(next)
  }
  const [roundingKind, setRoundingKind] = useState<RepriceRounding['kind']>('none')
  const [endingCents, setEndingCents] = useState(99)
  const [endingDirection, setEndingDirection] = useState<EndingDirection>(defaultEndingDirection)
  const [nearestStep, setNearestStep] = useState(0.5)
  const [floorAtCost, setFloorAtCost] = useState(true)

  function buildRule(): RepriceRule {
    const rounding: RepriceRounding =
      roundingKind === 'ending'
        ? { kind: 'ending', cents: endingCents, direction: endingDirection }
        : roundingKind === 'nearest'
          ? { kind: 'nearest', step: nearestStep }
          : { kind: 'none' }

    return {
      /* An adjustment moves the price this product already has, so its source
         is THIS structure; markup and GP are ratios of cost by definition and
         applyRule refuses them against anything else. */
      source: method === 'adjust' ? { kind: 'structure', structureId: 0 } : { kind: 'cost' },
      method: { kind: method, percent },
      rounding,
      floorAtCost,
    }
  }

  /* Run live so the counts under the button are always the rule as typed —
     cheap, because applyRule is arithmetic over rows already in memory. */
  const rule = buildRule()
  const results = rows.map((row) => ({
    row,
    outcome: applyRule(rule, {
      costExcl: row.costExcl,
      // An adjustment prices off the row's CURRENT price under this structure.
      sourceIncl: row.sellingIncl,
      sellingVatPercent: row.sellingVatPercent,
      currentIncl: row.sellingIncl,
    }),
  }))

  const priced = results.filter((r) => r.outcome.ok)
  const skipped = results.filter((r) => !r.outcome.ok)

  function apply() {
    onApply(
      priced.map((r) => ({
        productId: r.row.id,
        priceIncl: (r.outcome as { priceIncl: number }).priceIncl,
      })),
      skipped.map((r) => ({
        code: r.row.code,
        reason: (r.outcome as { reason: string }).reason,
      })),
    )
    onClose()
  }

  /* The reasons, counted rather than listed per product: forty rows with "No
     cost on the product" is one fact, not forty. */
  const reasonCounts = skipped.reduce<Record<string, number>>((acc, r) => {
    const reason = (r.outcome as { reason: string }).reason
    acc[reason] = (acc[reason] ?? 0) + 1
    return acc
  }, {})

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply a rule"
      description={`Works out a new price for the ${rows.length} selected ${
        rows.length === 1 ? 'product' : 'products'
      }. Nothing is saved until you save the grid.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={priced.length === 0} onClick={apply}>
            {priced.length === 0
              ? 'Nothing to change'
              : `Put ${priced.length} ${priced.length === 1 ? 'price' : 'prices'} in the grid`}
          </Button>
        </>
      }
    >
      {/* A plain column rather than a FieldGroup: that draws a titled fieldset,
          and a bordered box repeating the dialog's own heading is a second
          frame around one set of fields. */}
      <div className="flex flex-col gap-4">
        <Field label="What to do">
          <Select value={method} onChange={(e) => chooseMethod(e.target.value as typeof method)}>
            <option value="adjust">Move the current price by a percentage</option>
            <option value="markup">Set a markup on cost</option>
            <option value="gp">Set a gross profit percentage</option>
          </Select>
        </Field>

        <Field
          label={method === 'adjust' ? 'Percentage' : method === 'markup' ? 'Markup %' : 'GP %'}
          hint={
            method === 'adjust'
              ? 'Negative takes it off: -10 is a 10% discount on what it costs today.'
              : undefined
          }
        >
          <NumberInput
            precision={2}
            value={percent}
            onChange={(e) => setPercent(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>

        <Field label="Tidy the result">
          <Select
            value={roundingKind}
            onChange={(e) => setRoundingKind(e.target.value as RepriceRounding['kind'])}
          >
            <option value="none">Leave it exact</option>
            <option value="ending">Force an ending (.99, .95)</option>
            <option value="nearest">Round to the nearest step</option>
          </Select>
        </Field>

        {roundingKind === 'ending' && (
          <>
            <Field label="Ending (cents)">
              <NumberInput
                value={endingCents}
                onChange={(e) => setEndingCents(Number(e.target.value) || 0)}
              />
            </Field>
            <Field
              label="Which way"
              hint="Up never charges less than the rule worked out; down never charges more."
            >
              <Select
                value={endingDirection}
                onChange={(e) => setEndingDirection(e.target.value as EndingDirection)}
              >
                <option value="up">Up</option>
                <option value="down">Down</option>
                <option value="nearest">Nearest</option>
              </Select>
            </Field>
          </>
        )}

        {roundingKind === 'nearest' && (
          <Field label="Step">
            <NumberInput
              precision={2}
              value={nearestStep}
              onChange={(e) => setNearestStep(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
          </Field>
        )}

        <Checkbox
          label="Never price below cost"
          checked={floorAtCost}
          onChange={(e) => setFloorAtCost(e.target.checked)}
        />
      </div>

      {skipped.length > 0 && (
        <Callout tone="warning" className="mt-4">
          {skipped.length} of {rows.length} will be left alone:{' '}
          {Object.entries(reasonCounts)
            .map(([reason, count]) => `${reason.toLowerCase()} (${count})`)
            .join(', ')}
          .
        </Callout>
      )}
    </Modal>
  )
}
