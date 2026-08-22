'use client'

import { useState, useTransition, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { searchProductsAction } from '@/app/(app)/products/pickerActions'
import type { ProductPick } from '@/lib/site/products'
import {
  SHAPE_GROUPS,
  SHAPE_LABEL,
  AUDIENCES,
  AUDIENCE_LABEL,
  type Audience,
  ROLES_USED,
  groupOf,
  validateSpecial,
  type SpecialInput,
  type SpecialItemInput,
  type SpecialRole,
  type SpecialShape,
  // The pure engine, NOT lib/site/specials — importing the server module from
  // a client component pulls mysql2 into the browser bundle.
} from '@/lib/specialsEngine'
import { saveSpecialAction } from './actions'

/**
 * Setting up one special.
 *
 * ── THE FORM FOLLOWS THE SHAPE ───────────────────────────────────────────
 *
 * Only the fields the chosen shape actually uses are drawn — showing all of
 * them greyed out would make every special look more complicated than it is,
 * and a shopkeeper setting up a happy hour has no business seeing a bundle
 * price box.
 *
 * ── ONE STORED SHAPE, ASKED AS TWO QUESTIONS ─────────────────────────────
 *
 * The database keeps a single flat `shape` (see 210), because every piece of
 * code that reads a special immediately wants one value to switch on. But a
 * shopkeeper does not describe a deal that way — they say "it is a combo, buy
 * three get one free". So the first control picks a GROUP and the second, shown
 * only when the group holds a choice, picks the shape within it.
 *
 * That split now lives entirely here, in the screen that asks the question,
 * rather than in two columns that could contradict each other.
 *
 * ── IT VALIDATES WITH THE SERVER'S OWN FUNCTION ──────────────────────────
 *
 * `validateSpecial` is pure and imported from the module the action uses, so a
 * problem is caught before the request rather than bounced back from it — and
 * the two can never disagree about what is allowed.
 */

export type DepartmentOption = { id: number; name: string }

const DAY_LETTERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The shapes whose arithmetic is actually written.
 *
 * `SPECIAL_SHAPES` names more than this — 210 declared every shape the enum
 * will ever hold, so that building one is a code change rather than another
 * ALTER on a table every till reads. Offering an unbuilt shape here would let a
 * shop set one up, save it, switch it on, and never find out that it does
 * nothing. So the form only offers what fires.
 */
const BUILT: ReadonlySet<SpecialShape> = new Set([
  'happy_hour',
  'special_price',
  'cheapest_free',
  'free_item',
  'percent_off',
  'bundle_price',
  'multibuy',
  'spend',
  'bonus_points',
  'quantity_break',
  'second_at_pct',
  'mix_and_match',
  'free_delivery',
])

/** A row as the form holds it — the item plus what it is called and costs. */
export type FormRow = SpecialItemInput & {
  label: string
  /** The shelf price today. Undefined for a department, which has no one price. */
  currentPrice?: number
  /** Raw typed text, so neither price box fights the cursor mid-edit. */
  priceText?: string
  pctText?: string
}

export default function SpecialForm({
  value,
  rows: initialRows,
  departments,
  customerGroups,
  onClose,
  onSaved,
}: {
  value: SpecialInput
  /** The saved items, already resolved to names and prices. */
  rows: FormRow[]
  departments: DepartmentOption[]
  /** For a special aimed at one group. Empty when the shop keeps none. */
  customerGroups: CustomerGroupOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, start] = useTransition()
  const [draft, setDraft] = useState<SpecialInput>(value)
  const [rows, setRows] = useState<FormRow[]>(initialRows)
  const [error, setError] = useState('')

  const patch = (changes: Partial<SpecialInput>) => setDraft({ ...draft, ...changes })

  /** The group the chosen shape sits in, for the first segmented control. */
  const group = SHAPE_GROUPS.find((g) => g.key === groupOf(draft.shape)) ?? SHAPE_GROUPS[0]

  function save() {
    /*
     * Only the rows this shape uses are sent. The rest stay in local state, so
     * switching shape and back does not lose what was already picked.
     *
     * The same table the server filters by, imported rather than restated —
     * two lists would be two answers to "does a bundle keep its scope rows".
     */
    const keep: SpecialRole[] = ROLES_USED[draft.shape]

    const payload: SpecialInput = {
      ...draft,
      items: rows
        .filter((r) => keep.includes(r.role))
        .map(({ role, productId, departmentId, qty, priceIncl }) => ({
          role,
          productId,
          departmentId,
          qty,
          priceIncl,
        })),
    }

    const problem = validateSpecial(payload)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    start(async () => {
      const result = await saveSpecialAction(payload)
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(`“${draft.name.trim()}” ${draft.id ? 'updated' : 'created'}.`)
      onSaved()
    })
  }

  const setDay = (index: number, on: boolean) => {
    const days = draft.daysOfWeek.split('')
    days[index] = on ? '1' : '0'
    patch({ daysOfWeek: days.join('') })
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={draft.id ? 'Edit special' : 'New special'}
      description="A promotion the till applies automatically while its window is open."
      /* `xl`, not `lg`: the combo sub-types are five segments on one bar, and
         at 3xl the bar outgrew the panel and scrolled sideways. */
      size="xl"
      /* A dozen sections, and the taller ones — product pickers, quantity tiers
         — are exactly the ones a 60vh letterbox makes unusable. */
      bodyGrows
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            <Icons.Save size={15} />
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Create special'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── Name and Active, outside any section ──────────────────────── */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label="Name">
              <Input
                value={draft.name}
                maxLength={100}
                placeholder="e.g. Friday happy hour"
                autoFocus
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
          </div>
          {/* Bordered so it reads as a control rather than a floating label. */}
          <div className="flex h-control shrink-0 items-center gap-2 rounded-control border border-border bg-surface-2 px-3">
            <Switch
              checked={draft.isActive}
              onChange={(next) => patch({ isActive: next })}
              ariaLabel="Active"
            />
            <span className="text-sm font-medium text-ink">Active</span>
          </div>
        </div>

        {/* ── What kind ─────────────────────────────────────────────────── */}
        <Section
          icon={<Icons.Tag size={14} />}
          title="What kind of special?"
          hint="Pick the shape of the promotion — the rest of the form follows."
        >
          {/*
            Two questions over ONE stored value.

            The shape is flat in the database — see 210 — but a shopkeeper does
            not describe a deal that way. They say "it is a combo, buy three get
            one free", so the form keeps asking in that order and simply picks
            the group's first shape when the group changes.
          */}
          <SegmentedControl
            value={groupOf(draft.shape)}
            onChange={(v) => {
              const group = SHAPE_GROUPS.find((g) => g.key === v)
              if (group) patch({ shape: group.shapes[0] })
            }}
            options={SHAPE_GROUPS.map((g) => ({ value: g.key, label: g.label }))}
          />
          {/* The second question, asked only when the group holds a choice. */}
          {group.shapes.length > 1 && (
            <SegmentedControl
              value={draft.shape}
              onChange={(v) => patch({ shape: v as SpecialShape })}
              options={group.shapes
                // Only what is BUILT. The enum names shapes whose arithmetic is
                // not written yet, and offering one would let a shop set up a
                // promotion that silently never fires.
                .filter((s) => BUILT.has(s))
                .map((s) => ({ value: s, label: SHAPE_LABEL[s] }))}
            />
          )}
        </Section>

        {/* ── Schedule ──────────────────────────────────────────────────── */}
        <Section
          icon={<Icons.History size={14} />}
          title="Schedule"
          hint="When the till may apply it."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts">
              <div className="flex gap-2">
                {/* The WRAPPER carries the width — a class on Input fights
                    CONTROL's own w-full and the box collapses. */}
                <span className="min-w-0 flex-1">
                  <Input
                    type="date"
                    aria-label="Start date"
                    value={draft.startsAt.split('T')[0] ?? ''}
                    onChange={(e) =>
                      patch({ startsAt: `${e.target.value}T${draft.startsAt.split('T')[1] ?? '00:00'}` })
                    }
                  />
                </span>
                <span className="w-28 shrink-0">
                  <Input
                    type="time"
                    aria-label="Start time"
                    value={draft.startsAt.split('T')[1] ?? '00:00'}
                    onChange={(e) =>
                      patch({ startsAt: `${draft.startsAt.split('T')[0]}T${e.target.value}` })
                    }
                  />
                </span>
              </div>
            </Field>
            <Field label="Ends">
              <div className="flex gap-2">
                {/* The WRAPPER carries the width — a class on Input fights
                    CONTROL's own w-full and the box collapses. */}
                <span className="min-w-0 flex-1">
                  <Input
                    type="date"
                    aria-label="End date"
                    value={draft.endsAt.split('T')[0] ?? ''}
                    onChange={(e) =>
                      patch({ endsAt: `${e.target.value}T${draft.endsAt.split('T')[1] ?? '23:59'}` })
                    }
                  />
                </span>
                <span className="w-28 shrink-0">
                  <Input
                    type="time"
                    aria-label="End time"
                    value={draft.endsAt.split('T')[1] ?? '23:59'}
                    onChange={(e) =>
                      patch({ endsAt: `${draft.endsAt.split('T')[0]}T${e.target.value}` })
                    }
                  />
                </span>
              </div>
            </Field>
          </div>

          <Field
            label="Daily window"
            hint="Leave both blank to run all day, or e.g. 17:00–18:00 for a true happy hour."
          >
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0">
                <Input
                  type="time"
                  aria-label="Daily start time"
                  value={draft.dailyStart}
                  onChange={(e) => patch({ dailyStart: e.target.value })}
                />
              </span>
              <span className="text-sm text-muted">to</span>
              <span className="w-28 shrink-0">
                <Input
                  type="time"
                  aria-label="Daily end time"
                  value={draft.dailyEnd}
                  onChange={(e) => patch({ dailyEnd: e.target.value })}
                />
              </span>
              {(draft.dailyStart || draft.dailyEnd) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => patch({ dailyStart: '', dailyEnd: '' })}
                >
                  Clear
                </Button>
              )}
            </div>
          </Field>

          <Field label="Days of the week">
            <div className="flex flex-wrap items-center gap-1.5">
              {DAY_LETTERS.map((label, i) => {
                const on = draft.daysOfWeek[i] === '1'
                return (
                  <Button
                    key={label}
                    variant={on ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={on}
                    onClick={() => setDay(i, !on)}
                  >
                    {label}
                  </Button>
                )
              })}
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              {/* Presets REPLACE the mask rather than adding to it, and never
                  look selected — they are actions, not a third state. */}
              <Button variant="ghost" size="sm" onClick={() => patch({ daysOfWeek: '1111111' })}>
                All
              </Button>
              <Button variant="ghost" size="sm" onClick={() => patch({ daysOfWeek: '1111100' })}>
                Weekdays
              </Button>
              <Button variant="ghost" size="sm" onClick={() => patch({ daysOfWeek: '0000011' })}>
                Weekend
              </Button>
            </div>
          </Field>
        </Section>

        {/* ── The deal, whichever shape it is ───────────────────────────── */}
        <DealSection
          shape={draft.shape}
          draft={draft}
          patch={patch}
          rows={rows}
          setRows={setRows}
          departments={departments}
          busy={busy}
        />

        {/* ── Who and where ─────────────────────────────────────────────── */}
        <AudienceSection draft={draft} patch={patch} customerGroups={customerGroups} />

        {/* ── Limits ────────────────────────────────────────────────────── */}
        <LimitsSection draft={draft} patch={patch} />

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            <Icons.Info size={15} className="mr-1.5 inline align-text-bottom" />
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** A tonal card with an icon, a title and a one-line explanation. */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <div className="rounded-card border border-border bg-surface-2 p-4">
      <div className="flex items-start gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block text-xs text-muted">{hint}</span>
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </div>
  )
}

/* ── Who it is for, and where it runs ────────────────────────────────────── */

/** A customer group, for a special aimed at one of them. */
export type CustomerGroupOption = { id: number; name: string }

function AudienceSection({
  draft,
  patch,
  customerGroups,
}: {
  draft: SpecialInput
  patch: (changes: Partial<SpecialInput>) => void
  customerGroups: CustomerGroupOption[]
}) {
  const audience = draft.audience ?? 'everyone'
  const inStore = draft.runsInStore !== false
  const online = draft.runsOnline !== false

  return (
    <Section
      icon={<Icons.Users size={14} />}
      title="Who it is for"
      hint="By default everyone, at the counter and online."
    >
      <SegmentedControl
        value={audience}
        onChange={(v) => patch({ audience: v as Audience })}
        options={AUDIENCES.map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))}
      />

      {audience === 'group' && (
        <Field label="Which group">
          <Select
            value={draft.audienceGroupId ?? ''}
            className="w-72"
            onChange={(e) =>
              patch({ audienceGroupId: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Choose a customer group…</option>
            {customerGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label="Where it runs"
        hint="Switch one off for a counter-only or web-only promotion."
      >
        <div className="flex flex-wrap gap-4">
          <Checkbox
            checked={inStore}
            label="At the counter"
            onChange={(e) => patch({ runsInStore: e.target.checked })}
          />
          <Checkbox
            checked={online}
            label="Online shop"
            onChange={(e) => patch({ runsOnline: e.target.checked })}
          />
        </div>
      </Field>

      {/*
        Said plainly rather than discovered.

        The shop front prices a shelf for whoever is looking at it, and a
        signed-in shopper is not carried into that pricing — so a targeted
        special genuinely does not apply online. Letting a shop believe
        otherwise would mean a price shown and then not honoured at checkout.
      */}
      {audience !== 'everyone' && online && (
        <p className="rounded-control bg-warning-soft px-3 py-2 text-xs text-warning">
          <Icons.Info size={14} className="mr-1.5 inline align-text-bottom" />
          Targeted promotions apply at the counter, where the till knows who the customer is.
          The online shop prices for everyone, so this one will not show there yet.
        </p>
      )}

      {!inStore && !online && (
        <p className="rounded-control bg-danger-soft px-3 py-2 text-xs text-danger">
          <Icons.Info size={14} className="mr-1.5 inline align-text-bottom" />
          With both switched off this promotion cannot run anywhere.
        </p>
      )}
    </Section>
  )
}

/* ── What stops it running away ──────────────────────────────────────────── */

/** The guards, as one section under the deal. Every field means "no limit" empty. */
function LimitsSection({
  draft,
  patch,
}: {
  draft: SpecialInput
  patch: (changes: Partial<SpecialInput>) => void
}) {
  const g = draft.guards ?? {
    maxDealsPerSale: 0,
    respectMaxDiscount: false,
    minMarginPct: 0,
    neverBelowCost: false,
  }
  const setGuard = (changes: Partial<typeof g>) => patch({ guards: { ...g, ...changes } })

  /* Only the combos repeat, so only they can be limited per sale. A happy hour
     applies once to a line whatever the quantity, and offering a "deals per
     sale" box there would be a control that does nothing. */
  const repeats = REPEATING.has(draft.shape)

  return (
    <Section
      icon={<Icons.ShieldCheck size={14} />}
      title="Limits"
      hint="Optional. What stops the promotion giving away more than you meant."
    >
      <div className="flex flex-wrap items-start gap-4">
        {repeats && (
          <Field
            label="Deals per sale"
            hint="0 for no limit. Stops one basket taking the deal over and over."
          >
            <NumberInput
              value={g.maxDealsPerSale || ''}
              min={0}
              className="w-36"
              placeholder="No limit"
              onChange={(e) => setGuard({ maxDealsPerSale: Number(e.target.value) || 0 })}
            />
          </Field>
        )}
        <Field label="Total uses" hint="Blank for no limit — e.g. the first 100 customers.">
          <NumberInput
            value={draft.maxRedemptions ?? ''}
            min={1}
            className="w-36"
            placeholder="No limit"
            onChange={(e) =>
              patch({ maxRedemptions: Number(e.target.value) > 0 ? Number(e.target.value) : null })
            }
          />
        </Field>
        <Field label="Minimum margin %" hint="0 for no floor. Never discount past this margin.">
          <NumberInput
            value={g.minMarginPct || ''}
            min={0}
            max={99}
            className="w-36"
            placeholder="No floor"
            onChange={(e) => setGuard({ minMarginPct: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <Checkbox
          checked={g.neverBelowCost}
          label="Never sell below cost"
          onChange={(e) => setGuard({ neverBelowCost: e.target.checked })}
        />
        <Checkbox
          checked={g.respectMaxDiscount}
          label="Respect each product's own discount limit"
          onChange={(e) => setGuard({ respectMaxDiscount: e.target.checked })}
        />
        {/* Said out loud, because it is surprising: the till already refuses a
            cashier this discount, and a special has been going around that rule
            since specials existed. Off by default — see 211 for why turning it
            on for everyone would gut promotions shops already run. */}
        <p className="text-xs text-muted">
          A cashier is already held to each product’s discount limit. Tick this to hold the
          promotion to it too. Cost-based limits are applied at the till, where the cost is known.
        </p>
      </div>
    </Section>
  )
}

/** The shapes that can complete their deal more than once on one sale. */
const REPEATING: ReadonlySet<SpecialShape> = new Set([
  'cheapest_free',
  'percent_off',
  'bundle_price',
  'multibuy',
  'quantity_break',
  'second_at_pct',
  'mix_and_match',
  'free_item',
])

/* ── The type-dependent half ─────────────────────────────────────────────── */

function DealSection({
  shape,
  draft,
  patch,
  rows,
  setRows,
  departments,
  busy,
}: {
  shape: SpecialShape
  draft: SpecialInput
  patch: (changes: Partial<SpecialInput>) => void
  rows: FormRow[]
  setRows: (rows: FormRow[]) => void
  departments: DepartmentOption[]
  busy: boolean
}) {
  const editor = (props: Omit<Parameters<typeof ItemsEditor>[0], 'rows' | 'setRows' | 'departments' | 'busy'>) => (
    <ItemsEditor {...props} rows={rows} setRows={setRows} departments={departments} busy={busy} />
  )

  if (shape === 'happy_hour') {
    return (
      <Section
        icon={<Icons.Tag size={14} />}
        title="Discount"
        hint="How much comes off, and what it covers."
      >
        <div className="w-36">
          <Field label="Discount">
            <NumberInput
              value={draft.discountPct}
              min={0}
              max={100}
              onChange={(e) => patch({ discountPct: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>

        {/*
          There is no "applies to the whole store" switch any more.

          There used to be, beside this list, and a special could carry BOTH —
          the flag silently won, so the products someone had carefully picked
          were ignored with nothing on screen to say so. Adding nothing IS the
          store-wide answer now, and the empty state says so out loud rather
          than leaving it to be discovered.
        */}
        {editor({
          role: 'scope',
          label: 'Applies to',
          hint: 'Leave empty to discount the whole store, or name the products and departments it covers.',
          empty: 'Nothing added — this discount applies to EVERYTHING in the store.',
        })}
      </Section>
    )
  }

  if (shape === 'special_price') {
    return (
      <Section
        icon={<Icons.Tag size={14} />}
        title="Special prices"
        hint="What each item rings up at while the special runs."
      >
        {editor({
          role: 'scope',
          label: 'Products on special',
          hint: 'Set either the special price or the discount % — each works out the other from the current price. A department row prices everything in it (price only).',
          empty: 'Nothing added yet — add the products or departments and set their prices.',
          showPrice: true,
        })}
      </Section>
    )
  }

  if (shape === 'bonus_points') {
    return (
      <Section
        icon={<Icons.Star size={14} />}
        title="The deal"
        hint="Loyalty points earned faster while this runs."
      >
        <Field
          label="Points multiplier"
          hint="2 for double points, 3 for triple. Applies on top of the customer's tier."
        >
          <NumberInput
            value={draft.pointsMultiplier ?? 2}
            min={1}
            max={100}
            step={0.5}
            className="w-40"
            onChange={(e) => patch({ pointsMultiplier: Number(e.target.value) || 1 })}
          />
        </Field>
        {/*
          Said out loud, because it is the one place in this whole system where
          two multipliers COMPOUND rather than the better one winning. A gold
          member on a double-points weekend gets both, and a shopkeeper setting
          this up should know that before the weekend rather than after it.
        */}
        <p className="text-xs text-muted">
          A member on a higher tier already earns faster. This multiplies with that, so a 1.5×
          tier on a double-points weekend earns 3×. It changes points only — nothing comes off
          the price.
        </p>
      </Section>
    )
  }

  if (shape === 'spend') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="What the customer must spend, and what they get for it."
      >
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1">
            <Field
              label="Customer spends"
              hint="The sale's normal-price total that unlocks the reward. Fires once per sale."
            >
              <CurrencyInput
                value={draft.spendAmountIncl}
                className="w-40"
                onChange={(e) => patch({ spendAmountIncl: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="Discount on the sale"
              hint="Optional — leave 0 to only give the free item(s)."
            >
              <NumberInput
                value={draft.discountPct}
                min={0}
                max={100}
                className="w-40"
                onChange={(e) => patch({ discountPct: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        </div>

        {editor({
          role: 'reward',
          label: 'Customer gets free',
          hint: 'Optional — products only; the till adds these to the slip at no charge.',
          empty: 'No free items — the reward is just the discount above.',
          showQty: true,
          allowDepartments: false,
        })}
      </Section>
    )
  }

  if (shape === 'cheapest_free') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="How many count as a group, and what the cheapest one costs."
      >
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1">
            <Field label="Buy how many?" hint="Any mix of the items below makes one group.">
              <NumberInput
                value={draft.triggerQty}
                min={2}
                className="w-40"
                onChange={(e) => patch({ triggerQty: Number(e.target.value) || 2 })}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="Cheapest item's discount"
              hint="100 = free; 50 = second at half price."
            >
              <NumberInput
                value={draft.discountPct}
                min={0}
                max={100}
                className="w-40"
                onChange={(e) => patch({ discountPct: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        </div>

        {editor({
          role: 'trigger',
          label: 'Counting towards the deal',
          empty: 'Nothing added yet — add the products or departments that count.',
        })}
      </Section>
    )
  }

  if (shape === 'free_item') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="What the customer must buy, and what comes free with it."
      >
        {editor({
          role: 'trigger',
          label: 'Customer buys',
          hint: 'Every row in its quantity completes one deal.',
          empty: 'Nothing added yet — add what the customer must buy.',
          showQty: true,
        })}

        <div className="flex items-center gap-2 text-xs font-medium text-muted">
          <span className="h-px flex-1 bg-border" />
          <span className="rounded-pill bg-brand-soft px-2.5 py-0.5 text-brand">then they get</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {editor({
          role: 'reward',
          label: 'Customer gets free',
          hint: 'Products only — the till adds these to the slip at no charge.',
          empty: 'Nothing added yet — add the free product(s).',
          showQty: true,
          allowDepartments: false,
        })}

        <Checkbox
          checked={draft.rewardPerDeal !== false}
          label="Give it again for each extra deal"
          onChange={(e) => patch({ rewardPerDeal: e.target.checked })}
        />
        <p className="text-xs text-muted">
          On: six pizzas against a buy-two deal hands over three garlic breads. Off: however
          much they buy, the free item is given once.
        </p>
      </Section>
    )
  }

  if (shape === 'bundle_price') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="What the bundle contains, and what it sells for."
      >
        <Field
          label="Bundle sells for"
          hint="Every row in its quantity makes one bundle at this price — the saving spreads across its items. “Any 3 for R100” is one department or product row with quantity 3."
        >
          <CurrencyInput
            value={draft.bundlePriceIncl}
            className="w-40"
            onChange={(e) => patch({ bundlePriceIncl: Number(e.target.value) || 0 })}
          />
        </Field>

        {editor({
          role: 'trigger',
          label: 'The bundle',
          hint: 'Every row in its quantity completes one bundle.',
          empty: 'Nothing added yet — add what makes up the bundle.',
          showQty: true,
        })}
      </Section>
    )
  }

  /*
   * The two laddered shapes share one editor.
   *
   * They ask the same first question — how many units — and differ only in the
   * second: multibuy sets a PRICE for that quantity, a quantity break sets a
   * PERCENTAGE off from that quantity up. One editor with one column swapped,
   * rather than two nearly identical blocks that drift apart the first time a
   * rung gains a field.
   */
  if (shape === 'multibuy' || shape === 'quantity_break') {
    const byPrice = shape === 'multibuy'
    const tiers = draft.tiers
    const patchTier = (index: number, changes: Partial<(typeof tiers)[number]>) => {
      const next = [...tiers]
      next[index] = { ...next[index], ...changes }
      patch({ tiers: next })
    }
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint={
          byPrice
            ? 'A quantity ladder — 3 for R25, 6 for R45. Any mix of the items below counts.'
            : 'Buy more, pay less per item — 10 or more at 5% off, 50 or more at 10%.'
        }
      >
        <Field
          label={byPrice ? 'Tiers' : 'Quantity breaks'}
          hint={
            byPrice
              ? 'Bigger tiers fill first: nine units against 3-for and 6-for tiers is one six and one three. Units below the smallest tier pay the shelf price.'
              : 'A break is a threshold, not a group: buy 11 against a 10-break and ALL eleven get the discount. The best break the basket reaches is the one that applies.'
          }
        >
          <div className="flex flex-col gap-2">
            {tiers.length === 0 && (
              <p className="text-sm text-muted">
                {byPrice
                  ? 'No tiers yet — add the first rung of the ladder.'
                  : 'No breaks yet — add the first one.'}
              </p>
            )}
            {tiers.map((tier, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="text-sm text-muted">{byPrice ? '' : 'From'}</span>
                <span className="w-24">
                  <NumberInput
                    value={tier.qty}
                    min={2}
                    aria-label={`${byPrice ? 'Tier' : 'Break'} ${index + 1} quantity`}
                    onChange={(e) => patchTier(index, { qty: Number(e.target.value) || 2 })}
                  />
                </span>
                <span className="text-sm text-muted">{byPrice ? 'for' : 'units,'}</span>
                <span className="w-32">
                  {byPrice ? (
                    <CurrencyInput
                      value={tier.priceIncl || ''}
                      aria-label={`Tier ${index + 1} price`}
                      onChange={(e) => patchTier(index, { priceIncl: Number(e.target.value) || 0 })}
                    />
                  ) : (
                    <NumberInput
                      value={tier.discountPct || ''}
                      min={0}
                      max={100}
                      aria-label={`Break ${index + 1} discount`}
                      onChange={(e) => patchTier(index, { discountPct: Number(e.target.value) || 0 })}
                    />
                  )}
                </span>
                {!byPrice && <span className="text-sm text-muted">% off</span>}
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${byPrice ? 'tier' : 'break'} ${index + 1}`}
                  onClick={() => patch({ tiers: tiers.filter((_, i) => i !== index) })}
                >
                  <Icons.Trash size={14} />
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  patch({
                    tiers: [
                      ...tiers,
                      /* The next rung starts above the last, so the ladder
                         climbs by itself as rungs are added. Whichever column
                         this shape does not use stays at zero — see 210 on why
                         they are separate columns. */
                      {
                        qty: (tiers.at(-1)?.qty ?? 1) + (byPrice ? 2 : 9),
                        priceIncl: 0,
                        discountPct: 0,
                      },
                    ],
                  })
                }
              >
                <Icons.Plus size={14} />
                {byPrice ? 'Add tier' : 'Add break'}
              </Button>
            </div>
          </div>
        </Field>

        {editor({
          role: 'trigger',
          label: byPrice ? 'Counting towards the tiers' : 'Counting towards the breaks',
          hint: 'Products and/or whole departments — any mix counts.',
          empty: 'Nothing added yet — add the products or departments this covers.',
        })}
      </Section>
    )
  }

  if (shape === 'second_at_pct') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="Buy two, and the cheaper one is discounted."
      >
        <Field
          label="Discount on the second"
          hint="50 for half price, 100 for free. Repeats every two — four items means two discounted."
        >
          <NumberInput
            value={draft.discountPct}
            min={1}
            max={100}
            className="w-40"
            onChange={(e) => patch({ discountPct: Number(e.target.value) || 0 })}
          />
        </Field>

        {editor({
          role: 'trigger',
          label: 'Applies to',
          hint: 'Any mix of these makes a pair — two different products both count.',
          empty: 'Nothing added yet — add the products or departments the deal covers.',
        })}
      </Section>
    )
  }

  if (shape === 'mix_and_match') {
    return (
      <Section
        icon={<Icons.ShoppingCart size={14} />}
        title="The deal"
        hint="Any few from a group, for one price."
      >
        <div className="flex flex-wrap items-start gap-4">
          <Field label="How many?" hint="Any mix of the items below.">
            <NumberInput
              value={draft.triggerQty}
              min={2}
              className="w-36"
              onChange={(e) => patch({ triggerQty: Number(e.target.value) || 2 })}
            />
          </Field>
          <Field label="For" hint="What that many costs together.">
            <CurrencyInput
              value={draft.bundlePriceIncl}
              className="w-40"
              onChange={(e) => patch({ bundlePriceIncl: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>

        {editor({
          role: 'trigger',
          label: 'Choose from',
          hint: 'Products and/or whole departments. The cheapest qualifying items fill the group first.',
          empty: 'Nothing added yet — add what they can choose from.',
        })}
      </Section>
    )
  }

  if (shape === 'free_delivery') {
    return (
      <Section
        icon={<Icons.Truck size={14} />}
        title="The deal"
        hint="Spend enough and delivery is on the shop."
      >
        <Field
          label="Customer spends"
          hint="The sale's normal-price total that waives the delivery fee."
        >
          <CurrencyInput
            value={draft.spendAmountIncl}
            className="w-40"
            onChange={(e) => patch({ spendAmountIncl: Number(e.target.value) || 0 })}
          />
        </Field>
        <p className="text-xs text-muted">
          Applies to online orders only — a sale carried out of the shop has no delivery to
          waive. Nothing comes off the price of the goods.
        </p>
      </Section>
    )
  }

  // percent_off — a combo, not a happy hour: it only pays once every trigger
  // row is on the slip.
  return (
    <Section
      icon={<Icons.ShoppingCart size={14} />}
      title="The deal"
      hint="What the customer must buy, and the discount it unlocks."
    >
      <Field label="Discount" hint="Off every item in the deal, once all of them are on the slip.">
        <NumberInput
          value={draft.discountPct}
          min={0}
          max={100}
          className="w-40"
          onChange={(e) => patch({ discountPct: Number(e.target.value) || 0 })}
        />
      </Field>

      {editor({
        role: 'trigger',
        label: 'Customer buys',
        hint: 'Every row in its quantity completes one deal — those items get the discount.',
        empty: 'Nothing added yet — add what the customer must buy.',
        showQty: true,
      })}
    </Section>
  )
}

/* ── The shared items editor ─────────────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100

function ItemsEditor({
  role,
  label,
  hint,
  empty,
  showQty = false,
  showPrice = false,
  allowDepartments = true,
  rows,
  setRows,
  departments,
  busy,
}: {
  role: SpecialRole
  label: string
  hint?: string
  empty: string
  showQty?: boolean
  showPrice?: boolean
  allowDepartments?: boolean
  rows: FormRow[]
  setRows: (rows: FormRow[]) => void
  departments: DepartmentOption[]
  busy: boolean
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductPick[]>([])
  const [searching, setSearching] = useState(false)

  const mine = rows.filter((r) => r.role === role)
  const others = rows.filter((r) => r.role !== role)
  const replace = (next: FormRow[]) => setRows([...others, ...next])
  const patchRow = (index: number, changes: Partial<FormRow>) => {
    const next = [...mine]
    next[index] = { ...next[index], ...changes }
    replace(next)
  }

  async function search(value: string) {
    setTerm(value)
    if (value.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    setResults(await searchProductsAction(value.trim()))
    setSearching(false)
  }

  function addProduct(product: ProductPick) {
    if (mine.some((r) => r.productId === product.id)) return
    replace([
      ...mine,
      {
        role,
        productId: product.id,
        departmentId: null,
        qty: 1,
        priceIncl: 0,
        label: `${product.code} · ${product.description}`,
        currentPrice: product.sellingIncl > 0 ? product.sellingIncl : undefined,
      },
    ])
    setTerm('')
    setResults([])
  }

  function addDepartment(id: number) {
    if (mine.some((r) => r.departmentId === id)) return
    const dept = departments.find((d) => d.id === id)
    replace([
      ...mine,
      {
        role,
        productId: null,
        departmentId: id,
        qty: 1,
        priceIncl: 0,
        label: dept?.name ?? `Department ${id}`,
      },
    ])
  }

  /**
   * The two price boxes write the same stored figure.
   *
   * Typing a price works out the percentage and vice versa, but the raw TEXT
   * of each is kept separately — recomputing the box being typed in would move
   * the cursor on every keystroke.
   */
  function onPriceTyped(index: number, text: string) {
    const row = mine[index]
    const price = Number(text) > 0 ? Number(text) : 0
    const usable = row.currentPrice && row.currentPrice > 0 && price > 0 && price < row.currentPrice
    patchRow(index, {
      priceIncl: price,
      priceText: text,
      pctText: usable ? String(round2((1 - price / row.currentPrice!) * 100)) : '',
    })
  }

  function onPctTyped(index: number, text: string) {
    const row = mine[index]
    const pct = Number(text)
    const usable = row.currentPrice && row.currentPrice > 0 && pct > 0 && pct < 100
    const price = usable ? round2(row.currentPrice! * (1 - pct / 100)) : 0
    patchRow(index, {
      priceIncl: price,
      pctText: text,
      priceText: usable ? String(price) : '',
    })
  }

  const remaining = departments.filter((d) => !mine.some((r) => r.departmentId === d.id))

  return (
    <Field label={label} hint={hint}>
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        {mine.length > 0 && (showQty || showPrice) && (
          <div className="flex items-center gap-2.5 border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <span className="min-w-0 flex-1">Item</span>
            {showQty && <span className="w-16 text-center">Qty</span>}
            <span className="w-20 text-right">Now</span>
            {showPrice && <span className="w-24 text-center">Discount</span>}
            {showPrice && <span className="w-28 text-center">Special</span>}
            <span className="w-8" aria-hidden />
          </div>
        )}

        {mine.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted">{empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((row, index) => (
              <li
                key={`${row.productId ?? 'd'}-${row.departmentId ?? 'p'}-${index}`}
                className="flex items-center gap-2.5 px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  {row.departmentId !== null && <Badge tone="brand">Dept</Badge>}
                  <span className="truncate text-ink">{row.label}</span>
                </span>

                {showQty && (
                  <NumberInput
                    value={row.qty}
                    min={1}
                    className="h-control-sm w-16 text-center"
                    aria-label={`Quantity of ${row.label}`}
                    onChange={(e) => patchRow(index, { qty: Number(e.target.value) || 1 })}
                  />
                )}

                {/* Always shown when the header is — a department has no one
                    price, so it says so rather than leaving a puzzling gap. */}
                <span
                  className="numeric w-20 text-right text-muted"
                  title="Current selling price"
                >
                  {row.currentPrice ? formatMoney(row.currentPrice) : '—'}
                </span>

                {showPrice && (
                  <span className="w-24">
                    {row.currentPrice ? (
                      <NumberInput
                        value={row.pctText ?? ''}
                        className="h-control-sm w-24"
                        aria-label={`Discount percentage on ${row.label}`}
                        title="Discount off the current price"
                        onChange={(e) => onPctTyped(index, e.target.value)}
                      />
                    ) : null}
                  </span>
                )}

                {showPrice && (
                  <CurrencyInput
                    value={row.priceText ?? (row.priceIncl || '')}
                    className="h-control-sm w-28"
                    aria-label={`Special price of ${row.label}`}
                    title="The special selling price"
                    onChange={(e) => onPriceTyped(index, e.target.value)}
                  />
                )}

                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${row.label}`}
                  onClick={() => replace(mine.filter((_, i) => i !== index))}
                >
                  <Icons.Trash size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* Search results sit between the list and the add bar, so a pick
            lands where the eye already is. */}
        {term.trim().length >= 2 && (
          <div className="border-t border-border">
            {searching ? (
              <p className="px-3 py-2 text-sm text-muted">Searching…</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted">Nothing matching “{term.trim()}”.</p>
            ) : (
              <ul className="max-h-40 overflow-y-auto divide-y divide-border">
                {results.map((product) => (
                  <li key={product.id}>
                    {/* Not a kit Button: a full-width result row with a code
                        under the name and a price at the end. */}
                    <button
                      data-kit-ok
                      type="button"
                      onClick={() => addProduct(product)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {product.description}
                        </span>
                        <span className="block truncate text-xs text-muted">{product.code}</span>
                      </span>
                      <span className="numeric text-sm text-muted">
                        {formatMoney(product.sellingIncl)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2 px-3 py-2">
          <Input
            value={term}
            placeholder="Search products…"
            icon={<Icons.Search size={15} />}
            className="min-w-[180px] flex-1"
            aria-label="Search products to add"
            disabled={busy}
            onChange={(e) => search(e.target.value)}
          />
          {allowDepartments && (
            /* Always shows its placeholder — it is an action menu, not a
               field with a current value. */
            <Select
              value=""
              aria-label="Add a department"
              className="w-56"
              disabled={busy || remaining.length === 0}
              onChange={(e) => e.target.value && addDepartment(Number(e.target.value))}
            >
              <option value="">Add a department…</option>
              {remaining.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
    </Field>
  )
}
