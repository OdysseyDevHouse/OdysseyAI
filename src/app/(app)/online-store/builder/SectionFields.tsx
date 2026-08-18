'use client'

/**
 * The inspector for a section kind whose controls are plain.
 *
 * ── WHY THIS COVERS SOME KINDS AND NOT OTHERS ────────────────────────────
 *
 * A section's fields are declared in SECTION_CATALOG so the write boundary
 * cannot forget one. Drawing them is a separate question, and the honest
 * answer is that only some kinds are plain enough to draw from a table.
 *
 * The rest are not stubborn — they are doing real work. A product row's
 * options depend on the page kind and on which departments are published; a
 * banner back-fills its description from the picture library and warns when a
 * link points at a path that 404s; a video reduces a pasted URL to an id as it
 * is typed, so the owner sees immediately that we understood them. A schema
 * able to express all of that would be a worse language than the JSX, and the
 * repo has already made that argument once, about stationery templates:
 * `{#if}` is the door to a template language, and a template language is a
 * second product to support.
 *
 * So this draws the kinds that genuinely are a list of controls, and the
 * others keep their hand-written panels. A field with no `ui` is skipped —
 * it is declared for its coercion, not for a control this file should invent.
 */

import { Field, Input, Textarea, Select } from '@/components/ui'
import type { HomeSection } from '@/lib/storefrontModel'
import type { SectionDef, SectionField } from '@/lib/storefront/catalog'

export default function SectionFields({
  def,
  section,
  onPatch,
}: {
  def: SectionDef
  section: HomeSection
  /** Partial, because a control changes one field and leaves the rest alone. */
  onPatch: (patch: Partial<HomeSection>) => void
}) {
  return (
    <>
      {def.fields.map((field) =>
        field.ui ? (
          <FieldControl key={String(field.key)} field={field} section={section} onPatch={onPatch} />
        ) : null,
      )}
    </>
  )
}

function FieldControl({
  field,
  section,
  onPatch,
}: {
  field: SectionField
  section: HomeSection
  onPatch: (patch: Partial<HomeSection>) => void
}) {
  const ui = field.ui
  if (!ui) return null

  const value = (section as Record<string, unknown>)[field.key]
  const set = (next: unknown) => onPatch({ [field.key]: next } as Partial<HomeSection>)

  /*
   * A choice is a Select over the words the owner reads, NOT over the stored
   * values — 'medium' is what we keep and "Some" is what a shop owner
   * recognises. The two lists are declared together in the catalog so they
   * cannot fall out of step.
   */
  if (field.type === 'choice' && ui.options) {
    return (
      <Field label={ui.label} hint={ui.hint}>
        <Select value={String(value ?? field.fallback)} onChange={(e) => set(e.target.value)}>
          {ui.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  /*
   * `rows` present means a textarea. It is the field's own answer to "how much
   * writing is this", declared beside the cap it shares a line with — an
   * address is four lines and a paragraph is six, and neither is a property
   * the inspector should be guessing from the character limit.
   */
  const max = 'max' in field ? field.max : undefined
  if (ui.rows) {
    return (
      <Field label={ui.label} hint={ui.hint}>
        <Textarea
          value={String(value ?? '')}
          rows={ui.rows}
          maxLength={max}
          placeholder={ui.placeholder}
          onChange={(e) => set(e.target.value)}
        />
      </Field>
    )
  }

  return (
    <Field label={ui.label} hint={ui.hint}>
      <Input
        value={String(value ?? '')}
        maxLength={max}
        placeholder={ui.placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Field>
  )
}
