'use client'

/**
 * How a shop arranges its product listings.
 *
 * ── THE SHOP FIRST, DEPARTMENTS UNDERNEATH ───────────────────────────────
 *
 * One panel at the top sets the whole shop, and every department below reads
 * "Following the shop" until somebody deliberately changes it. That order is
 * the screen's argument: a shop with forty aisles should configure ONE thing,
 * and the per-department controls exist for the two or three that genuinely
 * differ — a bakery next to a hardware department, not forty variations of the
 * same decision.
 *
 * ── AND WHY THE TILE PREVIEW IS HERE ─────────────────────────────────────
 *
 * "Show the brand" and "show the stock badge" are abstract until you see what
 * comes off the tile. The preview is drawn from the same CARD_FIELDS list the
 * shop renders from, so it cannot promise a tile the shop does not draw.
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
  Field,
  PageBody,
  Select,
  SettingRow,
  useToast,
} from '@/components/ui'
import {
  CARD_FIELDS,
  LISTING_FACETS,
  LISTING_LAYOUTS,
  PER_PAGE_CHOICES,
  type CardField,
  type ListingFacet,
  type ListingPreset,
} from '@/lib/storefront/listing'
import { CATALOGUE_SORTS, type CatalogueSort } from '@/lib/storefront/sorts'
import { clearListingAction, saveListingAction } from './actions'

/** The words an owner reads. The keys are ours; these are theirs. */
const FIELD_LABEL: Record<CardField, string> = {
  department: 'Department name',
  saving: '“Save 20%” badge',
  stock: 'Stock badge',
  brand: 'Brand',
  variants: 'Number of options',
  rating: 'Star rating',
  price: 'Price',
  add: 'Add button',
}

const FACET_LABEL: Record<ListingFacet, string> = {
  brand: 'Brand',
  price: 'Price range',
  special: 'On special',
  stock: 'In stock',
}

const SORT_LABEL: Record<CatalogueSort, string> = {
  name: 'A to Z',
  priceAsc: 'Cheapest first',
  priceDesc: 'Dearest first',
  newest: 'Newest first',
}

const LAYOUT_LABEL: Record<(typeof LISTING_LAYOUTS)[number], string> = {
  grid: 'Grid of tiles',
  list: 'A list',
}

export type DepartmentRow = {
  id: number
  name: string
  /** Whether this department has settings of its own, or follows the shop. */
  hasOwn: boolean
  preset: ListingPreset
}

export default function ListingClient({
  shop,
  departments,
}: {
  shop: ListingPreset
  departments: DepartmentRow[]
}) {
  return (
    <PageBody>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Every listing"
            description="How your product pages look, unless a department says otherwise."
          />
          <CardBody>
            <ListingForm preset={shop} departmentId={null} name="the whole shop" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="One department at a time"
            description="Only worth changing where a department genuinely reads differently."
          />
          <CardBody>
            {departments.length === 0 ? (
              <p className="text-sm text-muted">
                You are not publishing any departments yet.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {departments.map((d) => (
                  <DepartmentPanel key={d.id} row={d} shop={shop} />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </PageBody>
  )
}

function DepartmentPanel({ row, shop }: { row: DepartmentRow; shop: ListingPreset }) {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const [busy, startAction] = useTransition()

  return (
    <Accordion
      title={row.name}
      /*
       * The badge says which of the two states this department is in, without
       * opening it. On a shop with forty aisles that is the only way to see at
       * a glance which ones somebody has already touched.
       */
      description={row.hasOwn ? 'Has its own settings' : 'Following the shop'}
      badge={row.hasOwn ? <Badge tone="brand">Custom</Badge> : null}
      open={open}
      onToggle={() => setOpen((on) => !on)}
    >
      <div className="flex flex-col gap-4">
        {/*
          Said before the controls, not after: an owner opening a department
          that follows the shop needs to know that touching anything here stops
          it following — including stopping it from picking up the shop's later
          changes, which is the part nobody expects.
        */}
        {!row.hasOwn && (
          <p className="text-sm text-muted">
            This department follows the settings above. Change anything here and it stops
            following — including any change you make to the shop later.
          </p>
        )}

        <ListingForm
          preset={row.hasOwn ? row.preset : shop}
          departmentId={row.id}
          name={row.name}
        />

        {row.hasOwn && (
          <div className="flex justify-end border-t border-border pt-3">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                startAction(async () => {
                  const result = await clearListingAction(row.id, row.name)
                  if (result.ok) toast.success(`“${row.name}” follows the shop again.`)
                  else toast.error(result.error)
                })
              }
            >
              Follow the shop again
            </Button>
          </div>
        )}
      </div>
    </Accordion>
  )
}

function ListingForm({
  preset,
  departmentId,
  name,
}: {
  preset: ListingPreset
  departmentId: number | null
  name: string
}) {
  const [draft, setDraft] = useState<ListingPreset>(preset)
  const [busy, startAction] = useTransition()
  const toast = useToast()

  const set = <K extends keyof ListingPreset>(key: K, value: ListingPreset[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const toggleField = (field: CardField, on: boolean) =>
    set(
      'cardFields',
      // Filtered from the VOCABULARY rather than appended, so the stored order
      // is the declared one however the boxes were ticked — see readSet.
      CARD_FIELDS.filter((f) => (f === field ? on : draft.cardFields.includes(f))),
    )

  const toggleFacet = (facet: ListingFacet, on: boolean) =>
    set(
      'facets',
      LISTING_FACETS.filter((f) => (f === facet ? on : draft.facets.includes(f))),
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1 @lg:grid-cols-2">
        <SettingRow label="Shape" description="Tiles with photographs, or a row per product.">
          <Select
            value={draft.layout}
            onChange={(e) => set('layout', e.target.value as ListingPreset['layout'])}
          >
            {LISTING_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {LAYOUT_LABEL[l]}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow label="Opens in this order" description="A shopper can change it.">
          <Select
            value={draft.defaultSort}
            onChange={(e) => set('defaultSort', e.target.value as CatalogueSort)}
          >
            {CATALOGUE_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow label="Tiles across, on a computer">
          <Select
            value={String(draft.columnsDesktop)}
            onChange={(e) => set('columnsDesktop', Number(e.target.value))}
          >
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow label="Tiles across, on a phone">
          <Select
            value={String(draft.columnsPhone)}
            onChange={(e) => set('columnsPhone', Number(e.target.value))}
          >
            <option value="1">1 — bigger pictures</option>
            <option value="2">2</option>
          </Select>
        </SettingRow>

        <SettingRow label="Products per page" description="The rest go onto the next page.">
          <Select value={String(draft.perPage)} onChange={(e) => set('perPage', Number(e.target.value))}>
            {PER_PAGE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </SettingRow>
      </div>

      <Field
        label="What each product shows"
        hint="The picture and the name always show — a tile without them is not a tile."
      >
        <div className="grid gap-1 @sm:grid-cols-2">
          {CARD_FIELDS.map((field) => (
            <Checkbox
              key={field}
              label={FIELD_LABEL[field]}
              checked={draft.cardFields.includes(field)}
              onChange={(e) => toggleField(field, e.target.checked)}
            />
          ))}
        </div>
      </Field>

      <Field label="Filters a shopper can use" hint="Shown above the products.">
        <div className="grid gap-1 @sm:grid-cols-2">
          {LISTING_FACETS.map((facet) => (
            <Checkbox
              key={facet}
              label={FACET_LABEL[facet]}
              checked={draft.facets.includes(facet)}
              onChange={(e) => toggleFacet(facet, e.target.checked)}
            />
          ))}
        </div>
      </Field>

      <div className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() =>
            startAction(async () => {
              const result = await saveListingAction(departmentId, name, draft)
              if (result.ok) toast.success('Saved.')
              else toast.error(result.error)
            })
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
