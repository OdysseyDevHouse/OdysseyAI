'use client'

import { Close } from './icons'
import { CATEGORY_SWATCHES } from './tiles'

/**
 * The colour palette offered wherever a record is tinted — a department in the
 * list, a product with no photo.
 *
 * Extracted from the department form so the list and the form cannot drift
 * into offering different palettes for the same field. Values are swatch
 * TOKENS, never hex: see tiles.ts for why.
 *
 * "None" is offered first and is a real choice, not the absence of one — a
 * record whose colour has been cleared falls back to a tile derived from its
 * name, which is still stable.
 */
export function SwatchPicker({
  value,
  onChange,
  size = 'md',
  disabled = false,
}: {
  /** The stored token, or null/'' for no colour. */
  value: string | null
  onChange: (next: string | null) => void
  /** 'sm' for a dense row of swatches inside a modal or toolbar. */
  size?: 'sm' | 'md'
  disabled?: boolean
}) {
  const box = size === 'sm' ? 'size-6' : 'size-8'
  const current = value ?? ''

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* data-kit-ok: "None" is an option in the palette, so it is drawn as a
          swatch — a kit Button restyled to look like one would be worse than
          the swatch it is pretending not to be. */}
      <button
        data-kit-ok
        type="button"
        aria-label="No colour"
        aria-pressed={current === ''}
        disabled={disabled}
        onClick={() => onChange(null)}
        className={`${box} flex items-center justify-center rounded-pill border-2 bg-surface text-muted transition disabled:cursor-not-allowed disabled:opacity-50 ${
          current === '' ? 'border-ink' : 'border-border-strong'
        }`}
      >
        <Close size={size === 'sm' ? 12 : 14} />
      </button>

      {/* The named category palette. `title` and `aria-label` carry the NAME
          rather than the token, so a swatch is "Bakery" to a person and to a
          screen reader alike — twenty unlabelled discs are otherwise
          indistinguishable to anyone not looking at them. */}
      {CATEGORY_SWATCHES.map((swatch) => (
        <button
          key={swatch.token}
          data-kit-ok
          type="button"
          title={swatch.label}
          aria-label={swatch.label}
          aria-pressed={current === swatch.token}
          disabled={disabled}
          onClick={() => onChange(swatch.token)}
          className={`${box} rounded-pill border-2 transition disabled:cursor-not-allowed disabled:opacity-50 ${swatch.className} ${
            current === swatch.token ? 'border-ink' : 'border-transparent'
          }`}
        />
      ))}
    </div>
  )
}
