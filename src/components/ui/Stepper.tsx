'use client'

import { Minus, Plus } from './icons'

/**
 * A small whole-number control: − [ n ] +
 *
 * ── WHEN TO USE IT INSTEAD OF NumberInput ──────────────────────────────────
 *
 * For counts somebody adjusts by one or two from where they are — tills on a
 * licence, seats on a plan. The buttons carry the affordance: the number is
 * changeable, and the range is small enough that clicking is faster than
 * selecting and retyping.
 *
 * For a quantity that can be any value — a stock count, a price — use
 * `NumberInput`. Twelve clicks to reach 12 is not an interaction.
 *
 * The field is read-only rather than disabled: disabled greys the number out
 * and it is the thing being read. Typing is deliberately not offered, so there
 * is no half-typed state to validate and no caret to fight.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  label,
  disabled = false,
}: {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  /** Names the control for a screen reader — "Tills at Sandton". */
  label: string
  disabled?: boolean
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n))

  return (
    <div className="flex items-center overflow-hidden rounded-control border border-border-strong">
      <button
        type="button"
        className="flex h-control w-control items-center justify-center text-ink-2 transition-colors hover:bg-surface-2 disabled:text-faint disabled:hover:bg-transparent"
        onClick={() => onChange(clamp(value - 1))}
        disabled={disabled || value <= min}
        aria-label={`${label}: one fewer`}
      >
        <Minus size={16} />
      </button>

      <span
        className="numeric flex h-control w-12 items-center justify-center border-x border-border text-ink"
        aria-live="polite"
        aria-label={`${label}: ${value}`}
      >
        {value}
      </span>

      <button
        type="button"
        className="flex h-control w-control items-center justify-center text-ink-2 transition-colors hover:bg-surface-2 disabled:text-faint disabled:hover:bg-transparent"
        onClick={() => onChange(clamp(value + 1))}
        disabled={disabled || value >= max}
        aria-label={`${label}: one more`}
      >
        <Plus size={16} />
      </button>
    </div>
  )
}
