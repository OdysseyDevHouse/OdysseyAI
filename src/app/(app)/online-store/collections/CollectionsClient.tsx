'use client'

/**
 * Making and arranging collections.
 *
 * ── THE RULE DECIDES WHAT ELSE IS ASKED ──────────────────────────────────
 *
 * A hand-picked collection needs a product picker; a brand one needs a brand;
 * "on special" needs nothing at all. Showing every control for every rule
 * would leave a merchant looking at a product picker that does nothing on a
 * collection that fills itself — and a control that appears to work and does
 * not is worse than an absent one, which is the reasoning `kindsFor` already
 * follows in the page builder.
 */

import { useState, useTransition } from 'react'
import {
  Accordion,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmModal,
  Field,
  Icons,
  Input,
  PageBody,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import ProductPicker from '../builder/ProductPicker'
import type { StorefrontDepartment } from '@/lib/site/storefront'
import {
  COLLECTION_RULES,
  MAX_COLLECTIONS,
  RULES_NEEDING_VALUE,
  RULE_HINT,
  RULE_LABEL,
  slugify,
  type Collection,
  type CollectionRule,
} from '@/lib/storefront/collections'
import { deleteCollectionAction, savePicksAction, saveCollectionAction } from './actions'

export type CollectionRow = Collection & { picks: number[] }

const blank = (): CollectionRow => ({
  id: 0,
  slug: '',
  title: '',
  description: '',
  imageId: null,
  isPublished: false,
  sortOrder: 0,
  rule: 'manual',
  ruleValue: '',
  seoTitle: '',
  seoDescription: '',
  picks: [],
})

export default function CollectionsClient({
  collections,
  departments,
  brands,
  pickerDepartments,
}: {
  collections: CollectionRow[]
  departments: { id: number; name: string }[]
  brands: string[]
  /** The storefront shape ProductPicker filters by. */
  pickerDepartments: StorefrontDepartment[]
}) {
  const [adding, setAdding] = useState(false)

  return (
    <PageBody>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Collections"
            description="A group of products with its own page — “Summer”, “Gifts under R300”, anything that is not an aisle."
          />
          <CardBody>
            {collections.length === 0 && !adding ? (
              <p className="text-sm text-muted">
                No collections yet. A collection is a way of grouping products that cuts across
                your departments, with a web address you can share.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {collections.map((c) => (
                  <CollectionPanel
                    key={c.id}
                    row={c}
                    departments={departments}
                    brands={brands}
                    pickerDepartments={pickerDepartments}
                  />
                ))}
              </div>
            )}

            {adding && (
              <div className="mt-3 rounded-card border border-border p-3">
                <CollectionForm
                  row={blank()}
                  departments={departments}
                  brands={brands}
                  pickerDepartments={pickerDepartments}
                  onDone={() => setAdding(false)}
                />
              </div>
            )}

            <div className="mt-4">
              <Button
                variant="secondary"
                disabled={adding || collections.length >= MAX_COLLECTIONS}
                onClick={() => setAdding(true)}
              >
                <Icons.Plus size={15} />
                New collection
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </PageBody>
  )
}

function CollectionPanel({
  row,
  departments,
  brands,
  pickerDepartments,
}: {
  row: CollectionRow
  departments: { id: number; name: string }[]
  brands: string[]
  pickerDepartments: StorefrontDepartment[]
}) {
  const [open, setOpen] = useState(false)

  return (
    <Accordion
      title={row.title}
      /*
       * The address, because that is the thing a merchant shares and the one
       * detail they cannot see anywhere else on this row.
       */
      description={`/k/${row.slug} · ${RULE_LABEL[row.rule]}`}
      badge={row.isPublished ? <Badge tone="success">On the shop</Badge> : <Badge>Hidden</Badge>}
      open={open}
      onToggle={() => setOpen((on) => !on)}
    >
      <CollectionForm row={row} departments={departments} brands={brands} pickerDepartments={pickerDepartments} />
    </Accordion>
  )
}

function CollectionForm({
  row,
  departments,
  brands,
  pickerDepartments,
  onDone,
}: {
  row: CollectionRow
  departments: { id: number; name: string }[]
  brands: string[]
  pickerDepartments: StorefrontDepartment[]
  onDone?: () => void
}) {
  const [draft, setDraft] = useState<CollectionRow>(row)
  const [confirming, setConfirming] = useState(false)
  const [busy, startAction] = useTransition()
  const toast = useToast()

  const set = <K extends keyof CollectionRow>(key: K, value: CollectionRow[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const isNew = row.id === 0
  /*
   * The address follows the title until somebody types one.
   *
   * After that it is theirs and stays put, because the address is what has
   * been shared — a merchant fixing a typo in a title should not silently
   * break every link to the collection.
   */
  const slugPreview = draft.slug || slugify(draft.title)

  const save = () =>
    startAction(async () => {
      const result = await saveCollectionAction(isNew ? null : row.id, {
        ...draft,
        slug: draft.slug || slugify(draft.title),
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (draft.rule === 'manual') {
        await savePicksAction(result.id, draft.picks)
      }
      toast.success(isNew ? 'Collection created.' : 'Saved.')
      onDone?.()
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 @lg:grid-cols-2">
        <Field label="Name" hint="What a shopper sees at the top of the page.">
          <Input
            value={draft.title}
            maxLength={120}
            placeholder="e.g. Summer favourites"
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>

        <Field
          label="Web address"
          hint={slugPreview ? `Shoppers reach it at /k/${slugPreview}` : 'Filled in from the name.'}
        >
          <Input
            value={draft.slug}
            maxLength={60}
            placeholder={slugify(draft.title) || 'summer-favourites'}
            onChange={(e) => set('slug', slugify(e.target.value))}
          />
        </Field>
      </div>

      <Field label="A line about it" hint="Optional. Shown under the name.">
        <Textarea
          value={draft.description}
          rows={2}
          maxLength={300}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <Field label="What goes in it" hint={RULE_HINT[draft.rule]}>
        <Select
          value={draft.rule}
          onChange={(e) =>
            /*
             * The value clears with the rule. A department id left behind on a
             * collection switched to "brand" would be compared against brand
             * names and quietly match nothing — a collection that is empty for
             * a reason nobody can see.
             */
            setDraft((d) => ({ ...d, rule: e.target.value as CollectionRule, ruleValue: '' }))
          }
        >
          {COLLECTION_RULES.map((r) => (
            <option key={r} value={r}>
              {RULE_LABEL[r]}
            </option>
          ))}
        </Select>
      </Field>

      {draft.rule === 'department' && (
        <Field label="Which department">
          <Select value={draft.ruleValue} onChange={(e) => set('ruleValue', e.target.value)}>
            <option value="">Choose…</option>
            {departments.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {draft.rule === 'brand' && (
        <Field label="Which brand">
          <Select value={draft.ruleValue} onChange={(e) => set('ruleValue', e.target.value)}>
            <option value="">Choose…</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {/* Only a hand-picked collection has anything to pick. Every other rule
          fills itself, and a picker beside one would be a control that does
          nothing. */}
      {draft.rule === 'manual' && (
        <ProductPicker
          value={draft.picks}
          onChange={(picks) => set('picks', picks)}
          departments={pickerDepartments}
        />
      )}

      <Checkbox
        label="Show this collection on the shop"
        checked={draft.isPublished}
        onChange={(e) => set('isPublished', e.target.checked)}
      />

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        {isNew ? (
          <span />
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            <Icons.Trash size={14} />
            Remove
          </Button>
        )}
        <div className="flex gap-2">
          {onDone && (
            <Button variant="secondary" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button disabled={busy || !draft.title.trim()} onClick={save}>
            {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </Button>
        </div>
      </div>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove “${row.title}”?`}
        // Said plainly, because the page a merchant built for it goes too and
        // that is not obvious from a button marked Remove.
        message="Its page and everything you arranged on it go as well. Products themselves are not affected."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() =>
          startAction(async () => {
            const result = await deleteCollectionAction(row.id, row.title)
            if (result.ok) toast.success(`“${row.title}” removed.`)
            else toast.error(result.error)
            setConfirming(false)
          })
        }
      />
    </div>
  )
}
