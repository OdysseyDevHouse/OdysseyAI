'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge, Checkbox, EmptyState } from '@/components/ui'
import type { InstructionGroup } from '@/lib/site/instructions'

/**
 * Which instructions this product asks when it is sold.
 *
 * The groups themselves are a shared library managed under Inventory →
 * Instructions; this only decides which of them attach to this product. Editing
 * an option lives there too, so the same bread list serves every sandwich.
 *
 * Ticked ids submit as instructionGroup[]; the action replaces the product's
 * whole set, so anything unticked is deliberately detached.
 */

function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

export default function InstructionsPanel({
  groups,
  attached,
}: {
  /** Every active instruction in the library. */
  groups: InstructionGroup[]
  /** Ids currently attached to this product. */
  attached: number[]
}) {
  const [selected, setSelected] = useState<number[]>(attached)

  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))

  if (groups.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No instructions set up yet"
          hint="Create one under Inventory → Instructions — for example “Choice of bread” — then attach it here."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm text-muted">
        Questions the till asks when this product is sold. Instructions are shared across products —
        edit the options themselves under{' '}
        <Link href="/instructions" className="text-brand hover:underline">
          Inventory → Instructions
        </Link>
        .
      </p>

      <div className="flex flex-col gap-2">
        {groups.map((g) => {
          const on = selected.includes(g.id)
          return (
            <label
              key={g.id}
              /* Not a kit component: a full-width selectable row with a nested
                 description, which SelectableCard does not express.
                 data-kit-ok */
              data-kit-ok
              className={`flex cursor-pointer items-start gap-3 rounded-control border px-4 py-3 transition ${
                on ? 'border-brand bg-brand-soft' : 'border-border hover:border-brand/50'
              }`}
            >
              <Checkbox
                checked={on}
                onChange={(e) => toggle(g.id, e.target.checked)}
                className="mt-0.5"
              />
              {/* Only ticked ids submit, so the action receives exactly the
                  intended set rather than a list of on/off pairs. */}
              {on && <input type="hidden" name="instructionGroup" value={g.id} />}

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{g.name}</span>
                  {g.isRequired && <Badge tone="warning">required</Badge>}
                  {!g.isActive && <Badge>inactive</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {g.prompt || choiceRule(g.minChoices, g.maxChoices)}
                  {g.prompt && ` · ${choiceRule(g.minChoices, g.maxChoices)}`}
                  {` · ${g.optionCount} option${g.optionCount === 1 ? '' : 's'}`}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
