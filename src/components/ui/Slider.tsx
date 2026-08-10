'use client'

import type { CSSProperties } from 'react'
import { CONTROL_INVALID } from './styles'
import { useFieldWiring } from './Field'

/**
 * A range slider — pick a number by dragging, when the exact digits don't matter.
 *
 * Use it where the FEEDBACK is the point and the number is incidental: tile size on
 * the till, a zoom level, a tolerance. Anything a person types a specific value into
 * (a price, a quantity, a discount) is a `NumberInput` — a slider cannot express
 * "19.99" and pretending otherwise makes an exact field imprecise.
 *
 * ── WHY THIS IS A NATIVE <input type="range"> ────────────────────────────────
 *
 * Every custom slider in the wild is a div with a pointerdown handler, and every one
 * of them re-implements — usually badly — the four things the native element already
 * does: arrow keys and Home/End, a real focus ring, the drag continuing when the
 * pointer leaves the track, and a screen reader announcing "slider, 200, minimum 110,
 * maximum 420". The native one is also the only one that works under a touch driver
 * we have not tested.
 *
 * So the whole component is layout and sizing. The COLOUR comes for free:
 * `accent-color: var(--color-brand)` is already set on input[type=range] in
 * globals.css, which is what makes the thumb and the filled track brand-coloured and
 * dark-mode-correct without one rule here. That is also why this file writes no
 * colour of its own — there is nothing left to write.
 *
 * ── WHAT THE NATIVE ELEMENT WILL NOT DO ──────────────────────────────────────
 *
 * `accent-color` styles the thumb but gives no say over TRACK HEIGHT, and the UA
 * default is about 4px. On a counter touchscreen a 4px track is a target a finger
 * cannot find, so `touch` size raises the box to --spacing-touch and fattens the
 * thumb through the vendor pseudo-elements. Those are the only appearance rules
 * here, and they exist for reachability rather than decoration.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  size = 'md',
  /**
   * What the number MEANS, shown beside the value — "px", "%", "days".
   *
   * A slider with no readout is a control that reports nothing: a person can see the
   * thumb has moved and still not know what they have chosen. Where the units are
   * genuinely obvious, pass `showValue={false}`.
   */
  unit = '',
  showValue = true,
  /**
   * Anchor labels under the ends of the track, e.g. "Dense" … "Large".
   *
   * Use these OR a `Field` hint, not both: `Field` renders its hint after this
   * component, so the two stack into three lines of small grey text under one
   * control and the hint reads as a caption for the anchors. Anchors say what the
   * ENDS mean; a hint says what the whole setting is for. Pick whichever the
   * reader actually needs.
   */
  minLabel,
  maxLabel,
  disabled = false,
  invalid,
  id,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  size?: 'md' | 'touch'
  unit?: string
  showValue?: boolean
  minLabel?: string
  maxLabel?: string
  disabled?: boolean
  invalid?: boolean
  id?: string
  className?: string
  'aria-label'?: string
}) {
  const wiring = useFieldWiring(id, invalid)
  const touch = size === 'touch'

  /*
   * How much of the track is behind the thumb, as a percentage.
   *
   * Needed because setting a track background — which `touch` size must do, since
   * `accent-color` gives no say over track HEIGHT — replaces the filled portion the
   * browser would otherwise paint for free. A track with no fill reads as an empty
   * control rather than one set to 200, so the fill is redrawn as a hard-stop
   * gradient between two TOKENS. No colour is written here; only the stop moves.
   *
   * Clamped because a `value` outside min..max (a stale stored preference, a caller
   * doing arithmetic) would otherwise produce a gradient stop beyond 0-100% and
   * paint the track a flat colour with no visible thumb position.
   */
  const span = max - min
  const filled = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0
  const trackFill = `linear-gradient(to right, var(--color-brand) ${filled}%, var(--color-surface-2) ${filled}%)`

  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          id={wiring.id}
          aria-describedby={wiring.describedBy}
          aria-label={ariaLabel}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          /*
           * `valueAsNumber`, not `Number(e.target.value)`.
           *
           * They agree here — a range input's value is always numeric — but the
           * property is the one that stays correct if this ever grows a locale or a
           * fractional step, and it costs nothing to use the right one now.
           */
          onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
          style={{ '--track-fill': trackFill } as CSSProperties}
          className={[
            'w-full min-w-0 cursor-pointer appearance-none bg-transparent',
            /* The BOX is tall so the target is tall; the visible track inside it
               stays slim. Height on the input, not the track, is what makes the
               whole strip hittable rather than just the coloured line. */
            touch ? 'h-touch' : 'h-control',
            'focus-visible:outline-none',
            /* Track. Both vendor prefixes are required — WebKit and Firefox name
               these differently and neither falls back to the other, so omitting
               one leaves that browser on the 4px UA default. */
            touch
              ? '[&::-webkit-slider-runnable-track]:h-2.5 [&::-moz-range-track]:h-2.5'
              : '[&::-webkit-slider-runnable-track]:h-1.5 [&::-moz-range-track]:h-1.5',
            '[&::-webkit-slider-runnable-track]:rounded-pill [&::-moz-range-track]:rounded-pill',
            /* The fill, from the --track-fill custom property set in `style` below.
               A pseudo-element cannot be styled inline, but it INHERITS custom
               properties from its originating element — so the value-dependent part
               goes on the input and both vendor tracks read it from there. */
            '[&::-webkit-slider-runnable-track]:bg-[image:var(--track-fill)]',
            '[&::-moz-range-track]:bg-[image:var(--track-fill)]',
            /* Thumb. `appearance-none` on the thumb is what lets its size be set at
               all in WebKit; without it the box grows and the thumb does not. */
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-pill',
            '[&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-brand',
            '[&::-moz-range-thumb]:rounded-pill [&::-moz-range-thumb]:border-0',
            '[&::-moz-range-thumb]:bg-brand',
            touch
              ? '[&::-webkit-slider-thumb]:size-7 [&::-moz-range-thumb]:size-7'
              : '[&::-webkit-slider-thumb]:size-4 [&::-moz-range-thumb]:size-4',
            /* WebKit centres the thumb on the track only if told to: the thumb is
               laid out from the top of the track box, so a thumb taller than its
               track hangs below it without this. The margin is half the difference
               between the two heights. */
            touch
              ? '[&::-webkit-slider-thumb]:-mt-[9px]'
              : '[&::-webkit-slider-thumb]:-mt-[5px]',
            'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-brand/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            wiring.invalid ? CONTROL_INVALID : '',
          ].join(' ')}
        />

        {showValue && (
          /*
           * Fixed-width and tabular so the track does not JUMP as the digits change
           * width — dragging 99 → 100 would otherwise shove the slider left by a
           * character, which reads as the control fighting back. `numeric` is the
           * app's tabular-figures class.
           */
          <output
            htmlFor={wiring.id}
            className={`numeric shrink-0 text-right tabular-nums text-ink ${
              touch ? 'w-20 text-base' : 'w-14 text-sm'
            }`}
          >
            {value}
            {unit && <span className="text-muted">{unit}</span>}
          </output>
        )}
      </div>

      {(minLabel || maxLabel) && (
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  )
}
