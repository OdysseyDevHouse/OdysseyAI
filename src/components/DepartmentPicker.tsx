'use client'

import { useMemo, useState } from 'react'
import { Select } from '@/components/ui'
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
}: {
  name: string
  departments: Department[]
  defaultValue: number | null
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
        {levels.map((level, depth) => (
          <label key={depth} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">{labelFor(depth)}</span>
            <Select value={level.selected} onChange={(e) => choose(depth, e.target.value)}>
              <option value="">&lt;None&gt;</option>
              {level.options.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>

      <input type="hidden" name={name} value={deepest} />
    </>
  )
}
