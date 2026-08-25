'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Field, Select } from '@/components/ui'
import type { Department } from '@/lib/site/departments'

/**
 * Cascading selects over an arbitrary-depth department tree.
 *
 * The schema is a tree rather than fixed Major/Sub1/Sub2 columns, so this
 * renders one select per level that actually has options: pick a major and a
 * sub level appears, and so on. A fourth level needs no code change here.
 *
 * The submitted value is the DEEPEST department chosen, since that identifies
 * the whole path — its ancestors are implied.
 */

const LEVEL_LABELS = ['Major department', 'Sub department 1', 'Sub department 2']

function labelFor(depth: number): string {
  return LEVEL_LABELS[depth] ?? `Sub department ${depth}`
}

export default function DepartmentPicker({
  name,
  departments,
  defaultValue,
  trailing,
}: {
  name: string
  departments: Department[]
  defaultValue: number | null
  /**
   * A field to sit in the same grid, filling the empty column when the tree is
   * shallow enough to leave one.
   *
   * A slot rather than the caller placing it: how many selects are showing is
   * this component's own state and changes as someone drills down, so a caller
   * deciding the layout would be reading a number it cannot see. Passed in
   * rather than hard-coded because "Brand" is the product screen's business,
   * not the picker's.
   */
  trailing?: ReactNode
}) {
  const byId = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments])

  // The chain of chosen ids, root first. Rebuilt from the saved department so
  // an existing product opens with every level already filled in.
  const initialChain = useMemo(() => {
    const chain: number[] = []
    const seen = new Set<number>()
    let current = defaultValue === null ? undefined : byId.get(defaultValue)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current.id)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    return chain
  }, [defaultValue, byId])

  const [chain, setChain] = useState<number[]>(initialChain)

  const childrenOf = (parentId: number | null) =>
    departments.filter((d) => d.parentId === parentId)

  // One select per level: the roots, then the children of each chosen node,
  // stopping when a level has nothing to offer.
  const levels: { parentId: number | null; options: Department[]; selected: number | '' }[] = []
  let parentId: number | null = null
  for (let depth = 0; ; depth++) {
    const options = childrenOf(parentId)
    if (options.length === 0) break
    // Indexing past the end gives undefined at runtime but types as number,
    // so the length check is what actually decides whether a level is chosen.
    const selected: number | '' = depth < chain.length ? chain[depth] : ''
    levels.push({ parentId, options, selected })
    if (selected === '') break
    parentId = selected
  }

  const choose = (depth: number, value: string) => {
    // Truncate deeper choices — they belonged to the branch just abandoned.
    const next = chain.slice(0, depth)
    if (value !== '') next.push(Number(value))
    setChain(next)
  }

  const deepest = chain.length ? chain[chain.length - 1] : ''

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        {/* The kit's Field, not a hand-rolled label: these captions sat at
            text-xs/text-muted while every sibling field on the screen — Brand
            right below them — used Field's text-sm/text-ink-2, so the same kind
            of caption came out two sizes and two colours in one card. */}
        {levels.map((level, depth) => (
          <Field key={depth} label={labelFor(depth)}>
            <Select value={level.selected} onChange={(e) => choose(depth, e.target.value)}>
              <option value="">&lt;None&gt;</option>
              {level.options.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        ))}

        {/* Inline when there is room, on its own row when there is not.
            The grid is 3 wide, so a 1- or 2-level tree leaves a column standing
            empty and the trailing field fills it; at 3 levels or deeper it wraps
            to the next row on its own, which is the same result as rendering it
            below. Either way it is ONE grid, so every caption in the card lines
            up on the same baseline. */}
        {trailing}
      </div>

      <input type="hidden" name={name} value={deepest} />
    </>
  )
}
