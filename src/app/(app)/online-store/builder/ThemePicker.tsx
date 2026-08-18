'use client'

/**
 * How a shop chooses its look.
 *
 * ── READY-MADE FIRST, DIALS UNDERNEATH ───────────────────────────────────
 *
 * Eight separate pickers is a colour wheel by another name. Every individual
 * choice here is safe — that is what the curated lists guarantee — but the
 * COMBINATION is where a shop ends up looking assembled rather than designed:
 * sharp corners with airy spacing and a serif heading is three defensible
 * decisions and one incoherent page.
 *
 * So a whole look is one click, and the dials sit behind a fold for the shop
 * that knows what it wants. Applying a preset is CONTENT, exactly as applying
 * a page preset is: it writes the values and is then forgotten, so there is no
 * "current preset" that can disagree with what the fields say.
 *
 * ── THE SWATCHES ARE THE REAL COLOURS ────────────────────────────────────
 *
 * Each tile paints itself with the palette it would apply. A named list of
 * looks would make an owner click all six to find out what they are; painting
 * them means the choice is made by eye, which is the only way anybody actually
 * chooses how a shop looks.
 */

import { useState } from 'react'
import { Accordion, Field, Select, SettingRow } from '@/components/ui'
import {
  CORNER_STYLES,
  DENSITIES,
  INK_STYLES,
  PAGE_WIDTHS,
  PRODUCT_DENSITIES,
  SURFACE_PALETTES,
  SURFACE_STYLES,
  THEME_PRESETS,
  type DesignTokens,
} from '@/lib/storefront/tokens'

/** The words an owner reads, against the keys we store. */
const SURFACE_LABEL: Record<(typeof SURFACE_STYLES)[number], string> = {
  bright: 'Bright',
  warm: 'Warm',
  cool: 'Cool',
  paper: 'Paper',
  ink: 'Dark',
}

const INK_LABEL: Record<(typeof INK_STYLES)[number], string> = {
  neutral: 'Neutral',
  warm: 'Warm',
  cool: 'Cool',
}

const CORNER_LABEL: Record<(typeof CORNER_STYLES)[number], string> = {
  sharp: 'Square',
  soft: 'Slightly rounded',
  round: 'Rounded',
  pill: 'Fully rounded',
}

const DENSITY_LABEL: Record<(typeof DENSITIES)[number], string> = {
  compact: 'Tight',
  comfortable: 'Comfortable',
  airy: 'Roomy',
}

const WIDTH_LABEL: Record<(typeof PAGE_WIDTHS)[number], string> = {
  narrow: 'Narrow',
  standard: 'Standard',
  wide: 'Wide',
}

const PRODUCT_LABEL: Record<(typeof PRODUCT_DENSITIES)[number], string> = {
  roomy: 'Bigger tiles, fewer per row',
  standard: 'Standard',
  dense: 'Smaller tiles, more per row',
}

export default function ThemePicker({
  tokens,
  onChange,
  onPreset,
}: {
  tokens: DesignTokens
  onChange: (next: DesignTokens) => void
  /** A preset sets the colour too — see THEME_PRESETS. */
  onPreset: (tokens: DesignTokens, brandColour: string) => void
}) {
  // Local, not lifted: whether the dials are folded is a property of looking
  // at this panel, not of the shop. Persisting it would be state to keep in
  // sync for no gain.
  const [tuning, setTuning] = useState(false)

  const set = <K extends keyof DesignTokens>(key: K, value: DesignTokens[K]) =>
    onChange({ ...tokens, [key]: value })

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Ready-made looks"
        hint="Sets the colours, corners and spacing together. You can change any of it afterwards."
      >
        <div className="grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((preset) => {
            const palette = SURFACE_PALETTES[preset.tokens.surfaceStyle]
            return (
              /* Not a kit Button: this tile IS a swatch — it paints itself in
                 the palette it applies, which no Button variant should learn
                 how to do. */
              <button
                data-kit-ok
                key={preset.key}
                type="button"
                onClick={() => onPreset(preset.tokens, preset.brandColour)}
                title={preset.hint}
                className="flex flex-col gap-2 rounded-card border border-border p-2.5 text-left transition hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {/* A miniature of the shop: the canvas, a card on it, and the
                    colour a button would be. Three shapes is enough to tell
                    six looks apart at a glance. */}
                <span
                  className="flex h-10 w-full items-center gap-1.5 overflow-hidden px-1.5"
                  style={{ background: palette.canvas, borderRadius: 'var(--radius-control)' }}
                >
                  <span
                    className="h-6 flex-1"
                    style={{ background: palette.surface, borderRadius: '4px' }}
                  />
                  <span
                    className="h-4 w-8 shrink-0"
                    style={{ background: preset.brandColour, borderRadius: '999px' }}
                  />
                </span>
                <span className="text-sm font-medium text-ink">{preset.name}</span>
              </button>
            )
          })}
        </div>
      </Field>

      {/*
        Shut by default. An owner who picked a ready-made look is finished, and
        opening on eight dials would undo the point of offering the looks at
        all — it would read as "and now do it properly".
      */}
      <Accordion
        title="Fine-tune it"
        description="Colours, corners and spacing, one at a time."
        open={tuning}
        onToggle={() => setTuning((on) => !on)}
      >
        <div className="flex flex-col gap-1">
          <SettingRow label="Background" description="The colours behind your pages and cards.">
            <Select
              value={tokens.surfaceStyle}
              onChange={(e) => set('surfaceStyle', e.target.value as DesignTokens['surfaceStyle'])}
            >
              {SURFACE_STYLES.map((k) => (
                <option key={k} value={k}>
                  {SURFACE_LABEL[k]}
                </option>
              ))}
            </Select>
          </SettingRow>

          {/*
            Hidden on a dark background, because it does nothing there — the
            warm/cool distinction is a choice about black on paper and does not
            survive being inverted, so a dark shop uses one set of pale inks.
            A control that appears to do something and does not is worse than
            an absent one, which is the reasoning kindsFor already follows.
          */}
          {!SURFACE_PALETTES[tokens.surfaceStyle].dark && (
            <SettingRow label="Text tone" description="Whether your words read warm or cold.">
              <Select
                value={tokens.inkStyle}
                onChange={(e) => set('inkStyle', e.target.value as DesignTokens['inkStyle'])}
              >
                {INK_STYLES.map((k) => (
                  <option key={k} value={k}>
                    {INK_LABEL[k]}
                  </option>
                ))}
              </Select>
            </SettingRow>
          )}

          <SettingRow label="Corners" description="Buttons, cards and pictures.">
            <Select
              value={tokens.cornerStyle}
              onChange={(e) => set('cornerStyle', e.target.value as DesignTokens['cornerStyle'])}
            >
              {CORNER_STYLES.map((k) => (
                <option key={k} value={k}>
                  {CORNER_LABEL[k]}
                </option>
              ))}
            </Select>
          </SettingRow>

          <SettingRow label="Spacing" description="How much room the page gives itself.">
            <Select
              value={tokens.density}
              onChange={(e) => set('density', e.target.value as DesignTokens['density'])}
            >
              {DENSITIES.map((k) => (
                <option key={k} value={k}>
                  {DENSITY_LABEL[k]}
                </option>
              ))}
            </Select>
          </SettingRow>

          <SettingRow label="Page width" description="How wide your content runs on a big screen.">
            <Select
              value={tokens.pageWidth}
              onChange={(e) => set('pageWidth', e.target.value as DesignTokens['pageWidth'])}
            >
              {PAGE_WIDTHS.map((k) => (
                <option key={k} value={k}>
                  {WIDTH_LABEL[k]}
                </option>
              ))}
            </Select>
          </SettingRow>

          <SettingRow label="Product tiles" description="How many fit across a row.">
            <Select
              value={tokens.productDensity}
              onChange={(e) =>
                set('productDensity', e.target.value as DesignTokens['productDensity'])
              }
            >
              {PRODUCT_DENSITIES.map((k) => (
                <option key={k} value={k}>
                  {PRODUCT_LABEL[k]}
                </option>
              ))}
            </Select>
          </SettingRow>
        </div>
      </Accordion>
    </div>
  )
}
