'use client'

import { useState, useTransition, type ReactNode } from 'react'
import {
  Badge,
  Button,
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
  COMBO_MODES,
  COMBO_MODE_LABEL,
  SPECIAL_TYPES,
  TYPE_LABEL,
  validateSpecial,
  type ComboMode,
  type SpecialInput,
  type SpecialItemInput,
  type SpecialRole,
  type SpecialType,
  // The pure engine, NOT lib/site/specials — importing the server module from
  // a client component pulls mysql2 into the browser bundle.
} from '@/lib/specialsEngine'
import { saveSpecialAction } from './actions'

/**
 * Setting up one special.
 *
 * ── THE FORM FOLLOWS THE TYPE ────────────────────────────────────────────
 *
 * Four types, one of which has four modes. Only the fields the chosen shape
 * actually uses are drawn — showing all of them greyed out would make every
 * special look more complicated than it is, and a shopkeeper setting up a
 * happy hour has no business seeing a bundle price box.
 *
 * The second question is only asked once the first makes it relevant, which is
 * why the combo modes appear under the type control rather than beside it.
 *
 * ── IT VALIDATES WITH THE SERVER'S OWN FUNCTION ──────────────────────────
 *
 * `validateSpecial` is pure and imported from the module the action uses, so a
 * problem is caught before the request rather than bounced back from it — and
 * the two can never disagree about what is allowed.
 */

export type DepartmentOption = { id: number; name: string }

const DAY_LETTERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

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
  onClose,
  onSaved,
}: {
  value: SpecialInput
  /** The saved items, already resolved to names and prices. */
  rows: FormRow[]
  departments: DepartmentOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, start] = useTransition()
  const [draft, setDraft] = useState<SpecialInput>(value)
  const [rows, setRows] = useState<FormRow[]>(initialRows)
  const [error, setError] = useState('')

  const patch = (changes: Partial<SpecialInput>) => setDraft({ ...draft, ...changes })

  /** Which shape the form is drawing — a type, or a combo's mode. */
  const shape = draft.type === 'combo' ? draft.comboMode || 'cheapest_free' : draft.type

  function save() {
    /*
     * Only the rows this shape uses are sent. The rest stay in local state, so
     * switching type and back does not lose what was already picked.
     */
    const keep: SpecialRole[] =
      draft.type === 'happy_hour' || draft.type === 'special_price'
        ? ['scope']
        : draft.type === 'spend'
          ? ['reward']
          : draft.comboMode === 'free_item'
            ? ['trigger', 'reward']
            : ['trigger']

    const payload: SpecialInput = {
      ...draft,
      comboMode: draft.type === 'combo' ? draft.comboMode : '',
      appliesToAll: draft.type === 'happy_hour' ? draft.appliesToAll : false,
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
      size="lg"
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
          <SegmentedControl
            value={draft.type}
            onChange={(v) => patch({ type: v as SpecialType })}
            options={SPECIAL_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
          />
          {/* The second question, asked only once the first makes it real. */}
          {draft.type === 'combo' && (
            <SegmentedControl
              value={draft.comboMode || 'cheapest_free'}
              onChange={(v) => patch({ comboMode: v as ComboMode })}
              options={COMBO_MODES.map((m) => ({ value: m, label: COMBO_MODE_LABEL[m] }))}
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
          shape={shape}
          draft={draft}
          patch={patch}
          rows={rows}
          setRows={setRows}
          departments={departments}
          busy={busy}
        />

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
  shape: string
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
        <div className="flex flex-wrap items-end gap-4">
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
          <label className="flex h-control cursor-pointer items-center gap-2 rounded-control border border-border bg-surface-2 px-3">
            <input
              type="checkbox"
              className="size-4 cursor-pointer"
              checked={draft.appliesToAll}
              onChange={(e) => patch({ appliesToAll: e.target.checked })}
            />
            <span className="text-sm text-ink">Applies to the whole store</span>
          </label>
        </div>

        {!draft.appliesToAll &&
          editor({
            role: 'scope',
            label: 'Applies to',
            hint: 'Products and/or whole departments that get the discount.',
            empty: 'Nothing added yet — add the products or departments the discount covers.',
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

  if (shape === 'multibuy') {
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
        hint="A quantity ladder — 3 for R25, 6 for R45. Any mix of the items below counts."
      >
        <Field
          label="Tiers"
          hint="Bigger tiers fill first: nine units against 3-for and 6-for tiers is one six and one three. Units below the smallest tier pay the shelf price."
        >
          <div className="flex flex-col gap-2">
            {tiers.length === 0 && (
              <p className="text-sm text-muted">No tiers yet — add the first rung of the ladder.</p>
            )}
            {tiers.map((tier, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-24">
                  <NumberInput
                    value={tier.qty}
                    min={2}
                    aria-label={`Tier ${index + 1} quantity`}
                    onChange={(e) => patchTier(index, { qty: Number(e.target.value) || 2 })}
                  />
                </span>
                <span className="text-sm text-muted">for</span>
                <span className="w-32">
                  <CurrencyInput
                    value={tier.priceIncl || ''}
                    aria-label={`Tier ${index + 1} price`}
                    onChange={(e) => patchTier(index, { priceIncl: Number(e.target.value) || 0 })}
                  />
                </span>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove tier ${index + 1}`}
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
                      // The next rung starts above the last, so the ladder
                      // climbs by itself as rungs are added.
                      { qty: (tiers.at(-1)?.qty ?? 1) + 2, priceIncl: 0 },
                    ],
                  })
                }
              >
                <Icons.Plus size={14} />
                Add tier
              </Button>
            </div>
          </div>
        </Field>

        {editor({
          role: 'trigger',
          label: 'Counting towards the tiers',
          hint: 'Products and/or whole departments — any mix fills a tier.',
          empty: 'Nothing added yet — add the products or departments the tiers cover.',
        })}
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
