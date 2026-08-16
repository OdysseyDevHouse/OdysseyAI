'use client'

import { useMemo, useState } from 'react'
import { Button, Callout, Input, Modal } from '@/components/ui'
import { Check, Minus, Package, Plus } from '@/components/ui/icons'
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
 *
 * ── WHY EVERY QUESTION IS ON ONE SCREEN ───────────────────────────────────
 *
 * The questions are listed together and the step rail at the top only SCROLLS to
 * one, rather than paging between them. A cashier who has to click "next" to
 * discover there was a second question cannot see the order they are building,
 * and the count in the footer would be describing something off-screen. The rail
 * says how many there are and which are answered; the list stays whole.
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
  /** Distinct answers picked, across every question. The footer's count. */
  const picked = chosen.length

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
      description={describeAsk(asked.length, qty)}
      /* The product as a picture. There is no photo on a till product — the
         catalogue ships a colour, not an image — so this is the same tinted
         glyph the catalogue tiles use, which at least makes the dialog and the
         tile behind it read as the same item. */
      titleMedia={
        <span
          data-kit-ok
          className="flex size-12 shrink-0 items-center justify-center rounded-card border border-border bg-surface-2 text-muted"
        >
          <Package size={22} />
        </span>
      }
      subheader={asked.length > 1 ? <StepRail groups={asked} chosen={chosen} /> : undefined}
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
            {picked > 0 && (
              <span className="mr-3">
                {picked} picked
              </span>
            )}
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
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{error}</Callout>}

        {asked.map((group) => (
          <section
            key={group.id}
            id={`instruction-group-${group.id}`}
            /* Each question is its own panel so a long menu reads as several
               questions rather than one continuous wall of buttons. */
            className="rounded-card border border-border bg-surface-2 p-4"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{group.prompt}</h3>
                <p className="mt-0.5 text-xs text-muted">{ruleFor(group)}</p>
              </div>
              {/* Only the exception is marked. Most questions in a kitchen are
                  compulsory, so it is the skippable one worth calling out. */}
              {!group.isRequired && group.minChoices === 0 && (
                <span className="shrink-0 text-xs text-muted">Optional</span>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
          </section>
        ))}

        <section className="rounded-card border border-border bg-surface-2 p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Anything else?</h3>
          <Input
            size="touch"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={190}
            placeholder="e.g. no ice, allergy: nuts"
          />
        </section>
      </div>
    </Modal>
  )
}

/** "2 questions — answer any of them", and who the answers apply to. */
function describeAsk(count: number, qty: number): string {
  const questions = count === 1 ? '1 question' : `${count} questions`
  if (qty > 1) return `${questions} — the answers apply to each of the ${qty}`
  return questions
}

/**
 * How many questions there are, and which have been answered.
 *
 * It SCROLLS rather than pages — see the note at the top of the file. The tick
 * is the only state worth showing: a cashier wants to know what is still
 * outstanding, and "answered" is the one thing they cannot see without scrolling
 * back up.
 */
function StepRail({
  groups,
  chosen,
}: {
  groups: readonly TillInstructionGroup[]
  chosen: readonly ChosenOption[]
}) {
  return (
    <div className="flex items-center justify-center gap-1 overflow-x-auto">
      {groups.map((group, i) => {
        const answered = chosen.some((c) => c.groupId === group.id)
        return (
          <span key={group.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span className="h-px w-6 shrink-0 bg-border" aria-hidden />}
            <button
              /* A scroll-to affordance, not a kit control: it is a tick and a
                 label on the modal's own header strip. data-kit-ok */
              data-kit-ok
              type="button"
              onClick={() =>
                document
                  .getElementById(`instruction-group-${group.id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              className="flex min-h-touch items-center gap-2 rounded-pill px-2 text-sm"
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-pill border text-white ${
                  answered ? 'border-transparent bg-brand' : 'border-border-strong bg-surface'
                }`}
              >
                {answered && <Check size={13} />}
              </span>
              {/* Wide enough to tell two questions apart. The rail is a place
                  marker, so a long prompt still truncates rather than pushing
                  the later steps off the strip. */}
              <span
                className={`max-w-56 truncate ${answered ? 'text-brand' : 'text-muted'}`}
              >
                {group.prompt}
              </span>
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** "Pick one", "Choose up to 3" — the same words the back office uses. */
function ruleFor(group: TillInstructionGroup): string {
  const { minChoices: min, maxChoices: max, isRequired } = group
  if (max === 1) return min > 0 || isRequired ? 'Pick one' : 'Pick one, or skip'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose as many as you like'
  if (min > 0 && min === max) return `Choose exactly ${min}`
  if (min > 0) return `Choose ${min} to ${max}`
  return `Choose up to ${max}`
}

/**
 * One answer as a till button.
 *
 * ── WHY TAPPING AGAIN ADDS ANOTHER ────────────────────────────────────────
 *
 * On a countable answer the tile does NOT toggle — each tap is one more, and the
 * minus at its right takes one off. That is the legacy till's behaviour and it is
 * the right one: "mushroom sauce ×5" is five taps on the thing you are naming,
 * with no stepper to find first. A toggle would make the fifth tap undo the
 * order, which is the opposite of what the hand expects at speed.
 *
 * An answer that can only be taken once still toggles, because there is no
 * second one to add and tapping it again can only mean "no, not that".
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

  /** What the next tap on the body means. */
  const bump = () => {
    if (!countable) {
      onPick(on ? 0 : floor)
      return
    }
    if (!on) {
      onPick(floor)
      return
    }
    // At the ceiling a further tap is a no-op rather than a wrap to zero:
    // silently emptying an answer somebody is tapping UP is how a line loses
    // its bacon without anyone noticing.
    if (count < ceiling) onPick(count + 1)
  }

  return (
    <div
      /* A selectable tile with a count, a price and a split minus — not a shape
         the kit expresses, and it is till-sized rather than form-sized.
         data-kit-ok */
      data-kit-ok
      className={`flex min-h-touch-lg items-stretch overflow-hidden rounded-control border transition ${
        on ? 'border-brand bg-brand-soft' : 'border-border bg-surface hover:border-brand/50'
      }`}
    >
      <button
        data-kit-ok
        type="button"
        onClick={bump}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
      >
        {/* The count sits INSIDE the tile as a disc, so a line with four of
            something reads at a glance without hunting for a stepper. */}
        {on && (
          <span className="numeric flex size-7 shrink-0 items-center justify-center rounded-pill bg-brand text-sm font-semibold text-white">
            {count}
          </span>
        )}
        <span className="min-w-0">
          <span
            className={`block text-sm ${on ? 'font-medium text-brand' : 'text-ink'}`}
          >
            {option.name}
          </span>
          {option.priceAdjust !== 0 && (
            <span className="numeric mt-0.5 block text-xs text-muted">
              {option.priceAdjust > 0 ? '+ ' : '− '}
              {formatMoney(Math.abs(option.priceAdjust))}
            </span>
          )}
        </span>
      </button>

      {/* The minus is a full-height sibling rather than a small icon button:
          it is the undo for a control whose whole body adds, so it has to be
          as easy to hit as the thing it undoes. */}
      {on && (
        <button
          data-kit-ok
          type="button"
          aria-label={countable ? `One fewer ${option.name}` : `Remove ${option.name}`}
          onClick={() => onPick(count <= floor ? 0 : count - 1)}
          className="flex w-11 shrink-0 items-center justify-center border-l border-brand/40 text-brand transition hover:bg-brand/10"
        >
          <Minus size={16} />
        </button>
      )}
    </div>
  )
}
