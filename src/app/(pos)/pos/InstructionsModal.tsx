'use client'

import { useMemo, useState } from 'react'
import { Button, Callout, Input, Modal } from '@/components/ui'
import { Minus, Plus } from '@/components/ui/icons'
import { formatMoney } from '@/lib/decimals'
import {
  adjustPerUnit,
  askedGroups,
  chooseOption,
  pruneUnasked,
  startingQty,
  validateSelection,
  type ChosenOption,
} from '@/lib/instructionRules'
import type { TillInstructionGroup, TillInstructionOption } from '@/lib/site/instructions'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The questions a product asks, put to the cashier.
 *
 * ── WHY THIS BLOCKS THE ADD ───────────────────────────────────────────────
 *
 * The line does not reach the basket until the questions are answered. The
 * alternative — add it, then nag — puts a half-specified burger on a bill that
 * can be paid, and "the till let me" is how a kitchen ends up guessing. A cashier
 * who genuinely cannot answer can still cancel, which adds nothing.
 *
 * ── WHY THE PRICE IS SHOWN BUILDING ───────────────────────────────────────
 *
 * The running total updates as answers are chosen, because the customer is
 * usually standing there and the question "how much is that with bacon" is
 * asked out loud. It is the same figure the line will carry — `adjustPerUnit` is
 * the one that computes it, here and at posting.
 */
export default function InstructionsModal({
  product,
  qty,
  groups,
  byId,
  basePriceIncl,
  onCancel,
  onConfirm,
}: {
  product: TillProduct
  qty: number
  /** The ids this product starts on, in the order it asks them. */
  groups: number[]
  byId: ReadonlyMap<number, TillInstructionGroup>
  /** The line price before any answers — what the running total builds on. */
  basePriceIncl: number
  onCancel: () => void
  onConfirm: (chosen: ChosenOption[], note: string) => void
}) {
  const [chosen, setChosen] = useState<ChosenOption[]>(() => {
    // Pre-ticked answers are applied before the cashier sees anything, so the
    // usual bread is already chosen and a plain order is one tap.
    const seed: ChosenOption[] = []
    for (const id of groups) {
      const group = byId.get(id)
      if (!group) continue
      for (const option of group.options) {
        const start = startingQty(option)
        if (start > 0) seed.push(chooseOption(group, option, start))
      }
    }
    return seed
  })
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Which questions are live right now — a follow-up appears the moment the
  // answer that reveals it is chosen, and vanishes when it is unchosen.
  const asked = useMemo(() => askedGroups(groups, byId, chosen), [groups, byId, chosen])

  const qtyOf = (optionId: number) => chosen.find((c) => c.optionId === optionId)?.qty ?? 0

  /** Sets one answer's count, and drops any follow-up that is no longer asked. */
  const setQty = (group: TillInstructionGroup, option: TillInstructionOption, next: number) => {
    setError(null)
    setChosen((prev) => {
      const without = prev.filter((c) => c.optionId !== option.id)

      // A pick-one group replaces rather than adds: choosing rye instead of
      // brown is a change of answer, not a second one.
      const cleared =
        group.maxChoices === 1 && next > 0
          ? without.filter((c) => c.groupId !== group.id)
          : without

      const updated = next > 0 ? [...cleared, chooseOption(group, option, next)] : cleared

      // Unticking "make it a meal" has to take the side and the drink with it,
      // or the line keeps charging for a side nobody can see on screen.
      return pruneUnasked(askedGroups(groups, byId, updated), updated)
    })
  }

  const adjust = adjustPerUnit(chosen)
  const built = basePriceIncl + adjust

  const confirm = () => {
    const refusal = validateSelection(asked, chosen)
    if (refusal) {
      setError(refusal)
      return
    }
    onConfirm(chosen, note.trim())
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={product.description}
      description={qty > 1 ? `${qty} × — the answers apply to each one` : undefined}
      size="lg"
      /* Half-answered work: a stray tap on the backdrop with a customer waiting
         should not throw the order away. */
      closeOnBackdrop={false}
      footer={
        /* In the FOOTER, not the body: the body scrolls at 60vh, and a long menu
           would put the confirm button below the fold on the one screen where a
           cashier is in a hurry. */
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-sm text-muted">
            {adjust !== 0 && (
              <>
                <span className="numeric">{formatMoney(basePriceIncl)}</span>
                {adjust > 0 ? ' + ' : ' − '}
                <span className="numeric">{formatMoney(Math.abs(adjust))}</span>
                {' = '}
              </>
            )}
            <span className="numeric text-base font-medium text-ink">{formatMoney(built)}</span>
            {qty > 1 && <span className="ml-1">each</span>}
          </span>

          <span className="flex gap-2">
            <Button type="button" variant="secondary" size="touch" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" variant="success" size="touch" onClick={confirm}>
              Add to sale
            </Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        {asked.map((group) => (
          <div key={group.id} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium text-ink">{group.prompt}</h3>
              <span className="text-xs text-muted">{ruleFor(group)}</span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {group.options.map((option) => (
                <OptionTile
                  key={option.id}
                  option={option}
                  count={qtyOf(option.id)}
                  single={group.maxChoices === 1}
                  onPick={(next) => setQty(group, option, next)}
                />
              ))}
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">Anything else?</h3>
          <Input
            size="touch"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={190}
            placeholder="e.g. no ice, allergy: nuts"
          />
        </div>
      </div>
    </Modal>
  )
}

/** "Pick one", "Choose up to 3" — the same words the back office uses. */
function ruleFor(group: TillInstructionGroup): string {
  const { minChoices: min, maxChoices: max, isRequired } = group
  if (max === 1) return min > 0 || isRequired ? 'Pick one' : 'Pick one, or skip'
  if (max === 0) return min > 0 ? `At least ${min}` : 'Any number'
  if (min > 0 && min === max) return `Exactly ${min}`
  if (min > 0) return `${min} to ${max}`
  return `Up to ${max}`
}

/**
 * One answer as a till button.
 *
 * A plain answer toggles. One that may be taken more than once grows a stepper
 * once it is on, rather than showing +/− next to every answer on the menu —
 * most answers are yes-or-no and a row of steppers reads as clutter.
 */
function OptionTile({
  option,
  count,
  single,
  onPick,
}: {
  option: TillInstructionOption
  count: number
  single: boolean
  onPick: (next: number) => void
}) {
  const on = count > 0
  const countable = !single && (option.maxQty === 0 || option.maxQty > 1)
  const ceiling = option.maxQty === 0 ? Infinity : option.maxQty
  const floor = Math.max(1, option.minQty)

  return (
    <div
      /* A selectable tile with a nested price and an optional stepper — not a
         shape the kit expresses, and it is till-sized rather than form-sized.
         data-kit-ok */
      data-kit-ok
      className={`flex items-center gap-2 rounded-control border px-3 py-2 transition ${
        on ? 'border-brand bg-brand-soft' : 'border-border hover:border-brand/50'
      }`}
    >
      <button
        data-kit-ok
        type="button"
        onClick={() => onPick(on ? 0 : floor)}
        className="flex min-h-touch min-w-0 flex-1 items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink">{option.name}</span>
          {option.priceAdjust !== 0 && (
            <span className="numeric block text-xs text-muted">
              {option.priceAdjust > 0 ? '+' : '−'}
              {formatMoney(Math.abs(option.priceAdjust))}
            </span>
          )}
        </span>
      </button>

      {on && countable && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`One fewer ${option.name}`}
            disabled={count <= floor}
            onClick={() => onPick(count - 1)}
          >
            <Minus size={15} />
          </Button>
          <span className="numeric w-6 text-center text-sm text-ink">{count}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`One more ${option.name}`}
            disabled={count >= ceiling}
            onClick={() => onPick(count + 1)}
          >
            <Plus size={15} />
          </Button>
        </span>
      )}
    </div>
  )
}
