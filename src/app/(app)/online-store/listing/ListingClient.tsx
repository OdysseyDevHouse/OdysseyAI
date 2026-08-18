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
  Input,
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
  BADGE_TONES,
  MAX_TILE_BADGES,
  type BadgeRules,
  type BadgeTone,
  type CardField,
  type ListingFacet,
  type ListingPreset,
} from '@/lib/storefront/listing'
import { CATALOGUE_SORTS, type CatalogueSort } from '@/lib/storefront/sorts'
import { clearListingAction, saveBadgeRulesAction, saveListingAction } from './actions'

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

/** A tone is a MEANING. These are the meanings, not the colours. */
const TONE_LABEL: Record<BadgeTone, string> = {
  brand: 'Your shop’s colour',
  success: 'Green — good news',
  warning: 'Amber — hurry',
  danger: 'Red — urgent',
  neutral: 'Grey — quiet',
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
  badgeRules,
}: {
  shop: ListingPreset
  departments: DepartmentRow[]
  badgeRules: BadgeRules
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
            title="Badges"
            description="Small labels on a product tile. Shop-wide — a shopper cannot tell that “New” means something different in one aisle."
          />
          <CardBody>
            <BadgeForm rules={badgeRules} />
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

/**
 * The three rules, and the wording each one uses.
 *
 * ── THE LABEL IS THE OFF SWITCH ──────────────────────────────────────────
 *
 * Rather than a tick box beside each. A rule with nothing to say cannot draw
 * anything, so "off" and "blank" are one state — and two controls that can
 * disagree about whether a badge shows is a bug waiting for somebody to set one
 * and not the other. The hint says so, because an empty field that means
 * something is worth explaining.
 */
function BadgeForm({ rules }: { rules: BadgeRules }) {
  const [draft, setDraft] = useState<BadgeRules>(rules)
  const [busy, startAction] = useTransition()
  const toast = useToast()

  const set = <K extends keyof BadgeRules>(key: K, value: BadgeRules[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  return (
    <div className="flex flex-col gap-4">
      <BadgeRule
        label="New arrivals"
        hint="Leave the wording blank to switch this off."
        text={draft.newLabel}
        onText={(v) => set('newLabel', v)}
        tone={draft.newTone}
        onTone={(v) => set('newTone', v)}
        extra={
          <Field label="Added within" hint="Days.">
            <Select value={String(draft.newDays)} onChange={(e) => set('newDays', Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      <BadgeRule
        label="Best sellers"
        hint="Worked out from the last 90 days of sales."
        text={draft.bestSellerLabel}
        onText={(v) => set('bestSellerLabel', v)}
        tone={draft.bestSellerTone}
        onTone={(v) => set('bestSellerTone', v)}
      />

      <BadgeRule
        label="Nearly out"
        hint="Only shows where you publish stock levels."
        text={draft.lowStockLabel}
        onText={(v) => set('lowStockLabel', v)}
        tone={draft.lowStockTone}
        onTone={(v) => set('lowStockTone', v)}
        extra={
          <Field label="When this many are left">
            <Select value={String(draft.lowStockAt)} onChange={(e) => set('lowStockAt', Number(e.target.value))}>
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      {/* Said once, at the bottom: a product can qualify for all three at
          once, and an owner setting the third rule should know what happens
          before they see a tile that dropped one. */}
      <p className="text-sm text-muted">
        A product shows at most {MAX_TILE_BADGES} badges. Rules come first, then anything you
        wrote on the product itself.
      </p>

      <div className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() =>
            startAction(async () => {
              const result = await saveBadgeRulesAction(draft)
              if (result.ok) toast.success('Saved.')
              else toast.error(result.error)
            })
          }
        >
          {busy ? 'Saving…' : 'Save badges'}
        </Button>
      </div>
    </div>
  )
}

function BadgeRule({
  label,
  hint,
  text,
  onText,
  tone,
  onTone,
  extra,
}: {
  label: string
  hint: string
  text: string
  onText: (value: string) => void
  tone: BadgeTone
  onTone: (value: BadgeTone) => void
  extra?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        {/* The real thing, not a description of it. An owner picking a tone
            from a list of words is guessing; one looking at the badge is not. */}
        {text.trim() ? <Badge tone={tone}>{text}</Badge> : <span className="text-xs text-faint">Off</span>}
      </div>
      <div className="grid gap-2 @sm:grid-cols-2">
        <Field label="Wording" hint={hint}>
          <Input value={text} maxLength={24} placeholder="e.g. New" onChange={(e) => onText(e.target.value)} />
        </Field>
        <Field label="Colour">
          <Select value={tone} onChange={(e) => onTone(e.target.value as BadgeTone)}>
            {BADGE_TONES.map((t) => (
              <option key={t} value={t}>
                {TONE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {extra}
      </div>
    </div>
  )
}
