'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Field, Select, useToast } from '@/components/ui'
import type { Department } from '@/lib/site/departments'
import DepartmentEditorModal, { type DepartmentEditorTarget } from './DepartmentEditorModal'
import { createDepartmentInlineAction } from '@/app/(app)/departments/actions'

/**
 * Cascading selects over an arbitrary-depth department tree.
 *
 * The schema is a tree rather than fixed Major/Sub1/Sub2 columns, so this
 * renders one select per level that actually has options: pick a major and a
 * sub level appears, and so on. A fourth level needs no code change here.
 *
 * The submitted value is the DEEPEST department chosen, since that identifies
 * the whole path — its ancestors are implied.
 *
 * ── CREATING ONE FROM HERE ────────────────────────────────────────────────
 *
 * Every level ends with a "<Create new>" option that opens the same
 * name-and-colour dialog the departments list uses. The moment somebody
 * discovers a department is missing is the moment they are filing a product,
 * and sending them to another screen then means abandoning a half-filled form.
 *
 * The department is created immediately rather than at product-save: it is a
 * real row either way, and a save that had to create departments as a side
 * effect would be one that can half-succeed. It is then selected at the level
 * it was made at, which is the only reason this needs the new id back.
 */

const LEVEL_LABELS = ['Major department', 'Sub department 1', 'Sub department 2']

/* The option value that opens the create dialog. A string that is not a
   number, so it can never collide with a department id. */
const CREATE = 'create'

function labelFor(depth: number): string {
  return LEVEL_LABELS[depth] ?? `Sub department ${depth}`
}

export default function DepartmentPicker({
  name,
  departments,
  defaultValue,
  trailing,
  canCreate = true,
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
  /**
   * `products.edit`. The action enforces it too — this only hides the option,
   * so somebody who may not create one is not handed a dialog that will fail.
   */
  canCreate?: boolean
}) {
  const router = useRouter()
  const toast = useToast()

  /* Departments created here, appended to what the server sent.
     router.refresh() brings the real rows down, but it is not instant and a
     <select> cannot show an option that is not in its list yet. Holding them
     locally is what makes a new department appear the moment it exists rather
     than a beat later. */
  const [added, setAdded] = useState<Department[]>([])
  const all = useMemo(() => [...departments, ...added], [departments, added])

  const [editor, setEditor] = useState<DepartmentEditorTarget | null>(null)
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(all.map((d) => [d.id, d])), [all])

  /* The chain of chosen ids, root first. Rebuilt from the SAVED department so
     an existing product opens with every level already filled in.

     Built from `departments` rather than the combined list on purpose: this
     must not re-run when something is created here, or the choice just made
     would be recomputed from the saved value and thrown away. */
  const initialChain = useMemo(() => {
    const chain: number[] = []
    const seen = new Set<number>()
    const lookup = new Map(departments.map((d) => [d.id, d]))
    let current = defaultValue === null ? undefined : lookup.get(defaultValue)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current.id)
      current = current.parentId === null ? undefined : lookup.get(current.parentId)
    }
    return chain
  }, [defaultValue, departments])

  const [chain, setChain] = useState<number[]>(initialChain)

  const childrenOf = (parentId: number | null) => all.filter((d) => d.parentId === parentId)

  // One select per level: the roots, then the children of each chosen node,
  // stopping when a level has nothing to offer.
  const levels: { parentId: number | null; options: Department[]; selected: number | '' }[] = []
  let parentId: number | null = null
  for (let depth = 0; ; depth++) {
    const options = childrenOf(parentId)
    /* Without create, an empty level is simply the end of the tree. With it,
       one more select still has to appear — otherwise a leaf department offers
       nowhere to stand to add its first child. */
    if (options.length === 0 && !canCreate) break
    // Indexing past the end gives undefined at runtime but types as number,
    // so the length check is what actually decides whether a level is chosen.
    const selected: number | '' = depth < chain.length ? chain[depth] : ''
    levels.push({ parentId, options, selected })
    if (selected === '') break
    parentId = selected
  }

  const choose = (depth: number, value: string) => {
    if (value === CREATE) {
      /* The parent is whatever is chosen one level UP, so creating from the
         "Sub department 1" row makes a child of the chosen major — which is
         exactly what that row is asking for. */
      const parent = depth > 0 ? (chain[depth - 1] ?? null) : null
      setEditor({
        mode: 'create',
        parentId: parent,
        parentName: parent === null ? undefined : byId.get(parent)?.name,
      })
      return
    }
    // Truncate deeper choices — they belonged to the branch just abandoned.
    const next = chain.slice(0, depth)
    if (value !== '') next.push(Number(value))
    setChain(next)
  }

  const create = async (values: { name: string; color: string | null }) => {
    if (editor?.mode !== 'create') return
    const parent = editor.parentId
    setBusy(true)
    try {
      const result = await createDepartmentInlineAction({
        name: values.name,
        parentId: parent,
        color: values.color,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }

      /* A stand-in until refresh() brings the real row down. Only the fields
         this picker reads are known here; the counts are zero because it was
         created empty, which is true at this instant. */
      const fresh: Department = {
        id: result.id,
        parentId: parent,
        name: result.name,
        code: null,
        color: values.color,
        sortOrder: 0,
        isActive: true,
        posImageId: null,
        onlineImageId: null,
        productCount: 0,
        childCount: 0,
      }
      setAdded((current) => [...current, fresh])

      // Select it at the level it was made at, replacing whatever deeper
      // choice used to sit below its parent.
      setChain((current) => {
        const depth = parent === null ? 0 : current.indexOf(parent) + 1
        return [...current.slice(0, depth), result.id]
      })

      setEditor(null)
      toast.success(`${result.name} created.`)
      router.refresh()
    } finally {
      setBusy(false)
    }
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
              {canCreate && <option value={CREATE}>&lt;Create new&gt;</option>}
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

      <DepartmentEditorModal
        target={editor}
        busy={busy}
        onClose={() => setEditor(null)}
        onSave={create}
      />
    </>
  )
}
