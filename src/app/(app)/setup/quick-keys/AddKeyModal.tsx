'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Button,
  Combobox,
  type ComboboxOption,
  Field,
  Icons,
  Modal,
  SegmentedControl,
  Select,
  TouchRow,
  useToast,
} from '@/components/ui'
import {
  QUICK_KEY_ACTIONS,
  type QuickKeyRow,
  type QuickKeySection,
  type QuickKeyTarget,
} from '@/lib/quickKeys'
import { createQuickKeyAction } from './actions'
import { searchProductsAction, listProductDepartmentsAction } from '@/app/(app)/sales/actions'

/**
 * Adding a key.
 *
 * Three kinds, chosen first, because what you pick next depends entirely on which: an
 * action comes from a fixed list, a product needs a search, a department needs a tree.
 * One combined picker would have to be all three at once.
 *
 * ── PRODUCTS ARE SEARCHED, NOT LISTED ─────────────────────────────────────
 *
 * A shop here has 40,000 products. A dropdown of them is not a control — it is a
 * scroll bar with words behind it. The same type-ahead the till uses answers "which
 * Coke" in three characters, and reusing `searchProductsAction` means the designer and
 * the till agree about what a product is called.
 */
export function AddKeyModal({
  open,
  section,
  parentId,
  onClose,
  onAdded,
}: {
  open: boolean
  section: QuickKeySection
  /** The group the key lands in, or null for the bar. */
  parentId: number | null
  onClose: () => void
  onAdded: (keys: QuickKeyRow[]) => void
}) {
  const [kind, setKind] = useState<'action' | 'product' | 'department'>('action')
  const [slug, setSlug] = useState('')
  const [productId, setProductId] = useState<number | null>(null)
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [departments, setDepartments] = useState<{ id: number; name: string; depth: number }[]>([])
  const [query, setQuery] = useState('')
  const [productOptions, setProductOptions] = useState<ComboboxOption<number>[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, startAction] = useTransition()
  const toast = useToast()

  /* Debounced at 180ms, the same as the till's own search: a shop here has 40,000
     products, and querying per character is a dozen useless round trips. Two characters
     is the threshold because one letter matches most of the file. */
  useEffect(() => {
    if (!open || kind !== 'product') return
    const term = query.trim()
    if (term.length < 2) {
      setProductOptions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsAction(term, null)
        .then((rows) => {
          if (cancelled) return
          setProductOptions(
            rows.map((p) => ({ value: String(p.id), label: p.description, hint: p.code })),
          )
        })
        .catch(() => {
          if (!cancelled) setProductOptions([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, kind, query])

  // Reset on every open, so a cancelled add does not preload the next one.
  useEffect(() => {
    if (!open) return
    setKind('action')
    setSlug('')
    setProductId(null)
    setDepartmentId(null)
  }, [open])

  /* Departments load once, on demand — the tree is small enough for a select and there
     is no point fetching it for somebody who only ever adds action keys. */
  useEffect(() => {
    if (!open || kind !== 'department' || departments.length > 0) return
    let cancelled = false
    void listProductDepartmentsAction()
      .then((rows) => {
        if (!cancelled) setDepartments(rows)
      })
      .catch(() => {
        if (!cancelled) toast.error('The department list could not be loaded.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, departments.length])

  const target: QuickKeyTarget | null =
    kind === 'action'
      ? slug
        ? { kind: 'action', actionSlug: slug }
        : null
      : kind === 'product'
        ? productId
          ? { kind: 'product', productId }
          : null
        : departmentId
          ? { kind: 'department', departmentId }
          : null

  function add() {
    if (!target) return
    startAction(async () => {
      const chosen = QUICK_KEY_ACTIONS.find((a) => a.slug === slug)
      const result = await createQuickKeyAction({
        section,
        parentId,
        target,
        /* An action key takes the catalogue's icon; the others are given one in the
           inspector. A key with no icon still reads, because the caption is the label. */
        icon: kind === 'action' ? (chosen?.icon ?? '') : '',
        colourToken: 'tile-1',
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Key added.')
      onAdded(result.keys)
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={parentId ? 'Add a key to this group' : 'Add a key'}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1 justify-center"
            disabled={pending || !target}
            onClick={add}
          >
            Add it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="What kind of key"
          value={kind}
          onChange={(next) => setKind(next)}
          options={[
            { value: 'action', label: 'Does something' },
            { value: 'product', label: 'A product' },
            { value: 'department', label: 'A department' },
          ]}
        />

        {kind === 'action' && (
          <div className="till-pane flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto">
            {QUICK_KEY_ACTIONS.map((a) => (
              <TouchRow
                key={a.slug}
                title={a.label}
                /* The hint, not the slug. A manager choosing between "Void sale" and
                   "Refund" needs to know which one reverses a posted invoice. */
                subtitle={
                  a.hospitalityOnly ? `${a.hint} — restaurant tills only` : a.hint
                }
                tone={slug === a.slug ? 'active' : 'default'}
                disabled={pending}
                onClick={() => setSlug(a.slug)}
              />
            ))}
          </div>
        )}

        {kind === 'product' && (
          <Field label="Which product" hint="Type a code, a barcode or part of the name.">
            <Combobox
              options={productOptions}
              query={query}
              onQueryChange={setQuery}
              onSelect={(option) => {
                setProductId(Number(option.value))
                /* The chosen name stays in the box, so the modal shows WHICH product is
                   about to become a key. clearOnSelect would leave an empty field above
                   an enabled "Add it" button. */
                setQuery(option.label)
              }}
              placeholder="Search the product file…"
              loading={searching}
              emptyText={query.trim().length >= 2 ? 'No product matches.' : 'Keep typing…'}
            />
          </Field>
        )}

        {kind === 'department' && (
          <Field label="Which department" hint="The key drills into it, showing what is inside.">
            <Select
              value={departmentId ? String(departmentId) : ''}
              disabled={pending || departments.length === 0}
              onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Choose a department…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {/* Indented with figure spaces, because a flat list of a nested tree
                      reads as forty unrelated departments. */}
                  {' '.repeat(d.depth * 2)}
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  )
}
