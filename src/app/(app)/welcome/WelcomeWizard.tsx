'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Field,
  FileInput,
  Icons,
  Input,
  NumberInput,
  SelectableCard,
  Select,
  TextLinkButton,
  useToast,
} from '@/components/ui'
import { STEPS, type StepKey } from '@/lib/site/onboardingSteps'
import type { SiteDetails } from '@/lib/sites'
import {
  saveStoreDetailsAction,
  saveLogoAction,
  saveMoneyAction,
  saveTaxRatesAction,
  savePriceTypesAction,
  saveCostingAction,
  saveDecimalsAction,
  acknowledgeStepAction,
  dismissOnboardingAction,
} from './actions'

/**
 * The first-run wizard, as a person experiences it.
 *
 * ── ONE QUESTION PER SCREEN, WHICH IS NOT HOW THE REST OF THIS APP WORKS ────
 *
 * The back office is dense on purpose — an operator scanning a thousand
 * products wants sixteen rows visible. This is the opposite kind of screen. It
 * is run once, by somebody who has never seen the product, and each step is a
 * decision rather than a lookup. So it is roomy, single-column, and asks one
 * thing at a time.
 *
 * ── EVERY STEP CAN BE SKIPPED, AND THAT IS THE DESIGN ───────────────────────
 *
 * Every setting here already has a working default, and a shop that skips the
 * lot can still trade. Making any of it mandatory would buy nothing except a
 * person typing something — anything — to get past a gate, which is worse than
 * a default they can revisit. What the wizard is really for is putting the
 * expensive decisions in FRONT of somebody before they matter, and you cannot
 * do that by trapping them.
 *
 * ── PROGRESS IS SAVED PER STEP, NOT AT THE END ──────────────────────────────
 *
 * Each step's Save writes its own settings and returns. Nothing is held until a
 * final submit, so closing the tab half-way keeps everything answered so far —
 * which is the whole point of a flow somebody is expected to abandon and come
 * back to.
 */

type TaxRow = {
  id: number | null
  code: string
  name: string
  rate: number
  isDefault: boolean
  productCount: number
}

type PriceTypeRow = {
  id: number | null
  name: string
  isDefault: boolean
  priceCount: number
}

/**
 * Steps that argue their own case in a `Callout`, and so must not also print
 * the footnote — see where this is read.
 */
const STEPS_WITH_OWN_CALLOUT = new Set<StepKey>(['costing', 'pricing'])

export default function WelcomeWizard({
  details,
  detailsEditable,
  hasLogo,
  settings,
  vatRates,
  priceTypes,
  doneSteps,
}: {
  details: SiteDetails
  detailsEditable: boolean
  hasLogo: boolean
  settings: Record<string, string>
  vatRates: TaxRow[]
  priceTypes: PriceTypeRow[]
  doneSteps: StepKey[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  /* Which step is open. Starts at the first unanswered one so a person coming
     back lands where they stopped rather than at the beginning. */
  const done = new Set(doneSteps)
  const [index, setIndex] = useState(() => {
    const first = STEPS.findIndex((s) => !done.has(s.key))
    return first === -1 ? 0 : first
  })
  /* Local so a tick appears the moment a step saves, without a round trip. The
     server is still the source of truth — this is refreshed on navigation. */
  const [completed, setCompleted] = useState<Set<StepKey>>(done)

  const step = STEPS[index]
  const isLast = index === STEPS.length - 1

  /* ── FORM STATE ───────────────────────────────────────────────────────────
     Held for the whole wizard rather than per step, so stepping back and
     forward does not discard what was typed. Each step saves its own slice. */
  const [form, setForm] = useState(details)
  const [currencyCode, setCurrencyCode] = useState(settings.currency_code ?? 'ZAR')
  const [currencySymbol, setCurrencySymbol] = useState(settings.currency_symbol ?? 'R')
  const [taxLabel, setTaxLabel] = useState(settings.tax_label ?? 'VAT')
  const [costBasis, setCostBasis] = useState(settings.cost_basis ?? 'average')
  const [qtyDecimals, setQtyDecimals] = useState(settings.qty_decimals ?? '2')
  const [costDecimals, setCostDecimals] = useState(settings.cost_decimals ?? '2')
  const [rates, setRates] = useState<TaxRow[]>(vatRates)
  const [tiers, setTiers] = useState<PriceTypeRow[]>(priceTypes)
  const [logoName, setLogoName] = useState<string | null>(null)

  const set = <K extends keyof SiteDetails>(key: K, value: SiteDetails[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  function advance(key: StepKey) {
    setCompleted((prev) => new Set(prev).add(key))
    if (isLast) {
      finish()
      return
    }
    setIndex((i) => Math.min(i + 1, STEPS.length - 1))
  }

  /**
   * Run a step's save, then move on.
   *
   * A refusal STOPS the flow and shows why. Advancing past a failed save would
   * quietly leave the shop on a value it thinks it changed — the one outcome a
   * setup wizard must never produce.
   */
  function save(key: StepKey, action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startSaving(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Saved.')
      advance(key)
      router.refresh()
    })
  }

  function skip() {
    if (isLast) {
      finish()
      return
    }
    setIndex((i) => Math.min(i + 1, STEPS.length - 1))
  }

  /** Stop the wizard offering itself. Used by "Finish" and by "I'll do this later". */
  function finish() {
    startSaving(async () => {
      const result = await dismissOnboardingAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.push('/getting-started')
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <StepRail
        index={index}
        completed={completed}
        onPick={setIndex}
      />

      <div className="min-w-0 flex-1">
        <Card>
          <CardHeader
            title={step.title}
            description={step.blurb}
            action={
              /* Always neutral. This says WHERE YOU ARE, which is a count and
                 not a judgement — colouring it green on a finished step spends
                 the success tone on "you are on step 2" and leaves the rail,
                 which does mark completion, competing with it. */
              <Badge tone="neutral">
                Step {index + 1} of {STEPS.length}
              </Badge>
            }
          />

          <CardBody>
            <div className="flex flex-col gap-5">
              {step.key === 'store' && (
                <StoreStep
                  form={form}
                  set={set}
                  editable={detailsEditable}
                  hasLogo={hasLogo}
                  logoName={logoName}
                  onLogo={(file) => {
                    const data = new FormData()
                    data.set('logo', file)
                    startSaving(async () => {
                      const result = await saveLogoAction(data)
                      if (!result.ok) {
                        toast.error(result.error)
                        return
                      }
                      setLogoName(file.name)
                      toast.success('Logo uploaded.')
                      router.refresh()
                    })
                  }}
                />
              )}

              {step.key === 'money' && (
                <MoneyStep
                  currencyCode={currencyCode}
                  setCurrencyCode={setCurrencyCode}
                  currencySymbol={currencySymbol}
                  setCurrencySymbol={setCurrencySymbol}
                  taxLabel={taxLabel}
                  setTaxLabel={setTaxLabel}
                />
              )}

              {step.key === 'tax' && (
                <TaxStep rates={rates} setRates={setRates} taxLabel={taxLabel} />
              )}

              {step.key === 'pricing' && <PriceTypeStep tiers={tiers} setTiers={setTiers} />}

              {step.key === 'costing' && (
                <CostingStep value={costBasis} onChange={setCostBasis} />
              )}

              {step.key === 'decimals' && (
                <DecimalsStep
                  qty={qtyDecimals}
                  setQty={setQtyDecimals}
                  cost={costDecimals}
                  setCost={setCostDecimals}
                />
              )}

              {/* The steps with a real screen behind them. See the comment on
                  acknowledgeStepAction: the wizard sends somebody there rather
                  than reproducing a cut-down copy that can disagree with it. */}
              {(step.key === 'numbering' ||
                step.key === 'locations' ||
                step.key === 'tenders' ||
                step.key === 'people' ||
                step.key === 'catalogue') && <HandoffStep href={step.href} stepKey={step.key} />}

              {/* Suppressed where the step already makes the same argument in a
                  Callout. Saying it twice — once loudly, once quietly, three
                  inches apart — reads as a mistake and teaches people to skip
                  the footnote on the steps where it is the only explanation. */}
              {!STEPS_WITH_OWN_CALLOUT.has(step.key) && (
                <p className="text-xs text-muted">{step.why}</p>
              )}
            </div>
          </CardBody>

          <CardFooter>
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0 || saving}
                >
                  Back
                </Button>
                {/* Hidden on the last step, where "skip" and "I'll finish this
                    later" beside it would be two links doing the same thing. */}
                {!isLast && (
                  <TextLinkButton onClick={skip} disabled={saving}>
                    Skip this step
                  </TextLinkButton>
                )}
              </div>

              <div className="flex items-center gap-2">
                <TextLinkButton onClick={finish} disabled={saving}>
                  I&rsquo;ll finish this later
                </TextLinkButton>

                {step.key === 'store' && (
                  <Button
                    variant="primary"
                    disabled={saving || !detailsEditable}
                    onClick={() => save('store', () => saveStoreDetailsAction(form))}
                  >
                    Save and continue
                  </Button>
                )}

                {step.key === 'money' && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() =>
                      save('money', () =>
                        saveMoneyAction({ currencyCode, currencySymbol, taxLabel }),
                      )
                    }
                  >
                    Save and continue
                  </Button>
                )}

                {step.key === 'tax' && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() =>
                      save('tax', () =>
                        saveTaxRatesAction({
                          rates: rates.map((r) => ({
                            id: r.id,
                            code: r.code,
                            name: r.name,
                            rate: r.rate,
                            isDefault: r.isDefault,
                          })),
                        }),
                      )
                    }
                  >
                    Save and continue
                  </Button>
                )}

                {step.key === 'pricing' && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() =>
                      save('pricing', () =>
                        savePriceTypesAction({
                          structures: tiers.map((t) => ({
                            id: t.id,
                            name: t.name,
                            isDefault: t.isDefault,
                          })),
                        }),
                      )
                    }
                  >
                    Save and continue
                  </Button>
                )}

                {step.key === 'costing' && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() => save('costing', () => saveCostingAction({ costBasis }))}
                  >
                    Save and continue
                  </Button>
                )}

                {step.key === 'decimals' && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() =>
                      save('decimals', () =>
                        saveDecimalsAction({
                          qtyDecimals: qtyDecimals,
                          costDecimals: costDecimals,
                        }),
                      )
                    }
                  >
                    Save and continue
                  </Button>
                )}

                {(step.key === 'numbering' ||
                  step.key === 'locations' ||
                  step.key === 'tenders' ||
                  step.key === 'people' ||
                  step.key === 'catalogue') && (
                  <Button
                    variant="primary"
                    disabled={saving}
                    onClick={() => save(step.key, () => acknowledgeStepAction(step.key))}
                  >
                    {isLast ? 'Finish' : 'Continue'}
                  </Button>
                )}
              </div>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

/**
 * The rail down the side — where you are, and what is left.
 *
 * Clickable on purpose. A wizard that only goes forwards makes somebody redo
 * five steps to correct a typo in the second, and every one of these steps is
 * independent of the others.
 */
function StepRail({
  index,
  completed,
  onPick,
}: {
  index: number
  completed: Set<StepKey>
  onPick: (next: number) => void
}) {
  return (
    <nav className="shrink-0 lg:w-60" aria-label="Setup steps">
      <ol className="flex flex-col gap-0.5">
        {STEPS.map((s, i) => {
          const isCurrent = i === index
          const isDone = completed.has(s.key)
          return (
            <li key={s.key}>
              {/* Not a kit component: this is a nav row that has to sit flush
                  with its siblings and carry three states. A Button would bring
                  its own height and hover. */}
              <button
                type="button"
                data-kit-ok
                onClick={() => onPick(i)}
                aria-current={isCurrent ? 'step' : undefined}
                className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm transition-colors ${
                  isCurrent
                    ? 'bg-brand-soft font-semibold text-brand'
                    : 'text-ink-2 hover:bg-surface-2'
                }`}
              >
                {/* Only a step that is CURRENT or DONE wears a filled disc. An
                    unvisited step is a bare digit — eleven grey circles down the
                    rail read as eleven badges competing with the one that marks
                    where you actually are. */}
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-pill text-xs font-semibold ${
                    isDone
                      ? 'bg-success text-white'
                      : isCurrent
                        ? 'bg-brand text-white'
                        : 'text-muted'
                  }`}
                >
                  {isDone ? <Icons.Check className="size-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.short}</span>
                {!s.cheapToChangeLater && !isDone && (
                  <Icons.StatusWarning className="size-3.5 shrink-0 text-warning" />
                )}
              </button>
            </li>
          )
        })}
      </ol>
      <p className="mt-3 px-3 text-xs text-muted">
        <Icons.StatusWarning className="mr-1 inline size-3 text-warning" />
        Hard to change once you are trading.
      </p>
    </nav>
  )
}

function StoreStep({
  form,
  set,
  editable,
  hasLogo,
  logoName,
  onLogo,
}: {
  form: SiteDetails
  set: <K extends keyof SiteDetails>(key: K, value: SiteDetails[K]) => void
  editable: boolean
  hasLogo: boolean
  logoName: string | null
  onLogo: (file: File) => void
}) {
  return (
    <>
      {!editable && (
        <Callout tone="brand">
          This store keeps its own database, so its name and address are held in the control panel
          and changed there. You can still set your VAT number and your logo here.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Registered company name">
          <Input
            value={form.companyName}
            onChange={(e) => set('companyName', e.target.value)}
            disabled={!editable}
          />
        </Field>
        <Field label="Trading name" hint="If you trade under a different name to the registered one.">
          <Input
            value={form.tradingName ?? ''}
            onChange={(e) => set('tradingName', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
        <Field
          label="VAT number"
          hint="Leave blank if you are not registered — you can add it later."
        >
          <Input
            value={form.vatNumber ?? ''}
            onChange={(e) => set('vatNumber', e.target.value || null)}
          />
        </Field>
        <Field label="Company registration number">
          <Input
            value={form.registrationNumber ?? ''}
            onChange={(e) => set('registrationNumber', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
        <Field label="Address line 1">
          <Input
            value={form.address1 ?? ''}
            onChange={(e) => set('address1', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
        <Field label="Address line 2">
          <Input
            value={form.address2 ?? ''}
            onChange={(e) => set('address2', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
        <Field label="Postal code">
          <Input
            value={form.postalCode ?? ''}
            onChange={(e) => set('postalCode', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
        <Field label="Telephone">
          <Input
            value={form.phone ?? ''}
            onChange={(e) => set('phone', e.target.value || null)}
            disabled={!editable}
          />
        </Field>
      </div>

      <Field
        label="Your logo"
        hint="PNG, JPG, GIF or WebP, up to 5 MB. Keep it under 500 KB so it can be emailed on invoices."
      >
        <FileInput
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onLogo(file)
          }}
        />
      </Field>
      {(hasLogo || logoName) && (
        <p className="text-xs text-success">
          <Icons.Check className="mr-1 inline size-3" />
          {logoName ? `${logoName} uploaded.` : 'A logo is already set for this store.'}
        </p>
      )}
    </>
  )
}

function MoneyStep({
  currencyCode,
  setCurrencyCode,
  currencySymbol,
  setCurrencySymbol,
  taxLabel,
  setTaxLabel,
}: {
  currencyCode: string
  setCurrencyCode: (v: string) => void
  currencySymbol: string
  setCurrencySymbol: (v: string) => void
  taxLabel: string
  setTaxLabel: (v: string) => void
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Currency code" hint="The three-letter ISO code, e.g. ZAR, GBP, USD.">
          <Input
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
            maxLength={3}
          />
        </Field>
        <Field label="Currency symbol" hint="What goes in front of a number on a slip.">
          <Input value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} />
        </Field>
      </div>

      <Field
        label="What you call sales tax"
        hint="Appears as a column heading on documents and on till slips."
      >
        <Select value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)}>
          <option value="VAT">VAT — South Africa, UK, EU</option>
          <option value="GST">GST — Australia, New Zealand, India</option>
          <option value="HST">HST — Canada</option>
          <option value="Tax">Tax — United States and elsewhere</option>
        </Select>
      </Field>
    </>
  )
}

/**
 * The tax rates step.
 *
 * ── CONFIRM, DO NOT BUILD ───────────────────────────────────────────────────
 *
 * A fresh site already has a standard rate and a zero rate. The overwhelmingly
 * common case is a shop checking that 15% is the right number for its country
 * and moving on, so the screen leads with the rates that exist and treats
 * adding one as the exception.
 *
 * Deleting is deliberately not offered. `deleteVatRate` has to weigh the
 * products pointing at a rate, and a wizard quietly removing a rate that stock
 * is priced against is exactly the damage this flow must not do. The pricing
 * screen owns that.
 */
function TaxStep({
  rates,
  setRates,
  taxLabel,
}: {
  rates: TaxRow[]
  setRates: (next: TaxRow[]) => void
  taxLabel: string
}) {
  const update = (i: number, patch: Partial<TaxRow>) =>
    setRates(rates.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  /* Exactly one default, enforced here as well as in the action — a screen
     showing two ticked boxes has already misled somebody by the time the
     server refuses it. */
  const setDefault = (i: number) =>
    setRates(rates.map((r, n) => ({ ...r, isDefault: n === i })))

  return (
    <>
      <div className="flex flex-col gap-3">
        {rates.map((rate, i) => (
          <div
            key={rate.id ?? `new-${i}`}
            className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[1fr_8rem_auto]"
          >
            <Field label="Name">
              <Input value={rate.name} onChange={(e) => update(i, { name: e.target.value })} />
            </Field>
            <Field label={`${taxLabel} %`}>
              <NumberInput
                value={rate.rate}
                onChange={(e) => update(i, { rate: Number(e.target.value) })}
              />
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox
                label="Default"
                checked={rate.isDefault}
                onChange={() => setDefault(i)}
              />
            </div>
            {rate.productCount > 0 && (
              <p className="text-xs text-muted sm:col-span-3">
                {rate.productCount} product{rate.productCount === 1 ? '' : 's'} on this rate.
              </p>
            )}
          </div>
        ))}
      </div>

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setRates([
              ...rates,
              {
                id: null,
                /* A code is required and must be unique, and asking a new owner
                   to invent one is a question about our schema rather than
                   about their shop. Generated, and editable on the pricing
                   screen if they ever care. */
                code: `RATE${rates.length + 1}`,
                name: '',
                rate: 0,
                isDefault: false,
                productCount: 0,
              },
            ])
          }
        >
          <Icons.Plus className="size-4" />
          Add another rate
        </Button>
      </div>
    </>
  )
}

function PriceTypeStep({
  tiers,
  setTiers,
}: {
  tiers: PriceTypeRow[]
  setTiers: (next: PriceTypeRow[]) => void
}) {
  const update = (i: number, patch: Partial<PriceTypeRow>) =>
    setTiers(tiers.map((t, n) => (n === i ? { ...t, ...patch } : t)))

  const setDefault = (i: number) => setTiers(tiers.map((t, n) => ({ ...t, isDefault: n === i })))

  return (
    <>
      <Callout tone="brand">
        Most shops need one — the price on the shelf. Add a second only if you genuinely sell the
        same product at two prices, such as a trade counter alongside a retail floor.
      </Callout>

      <div className="flex flex-col gap-3">
        {tiers.map((tier, i) => (
          <div
            key={tier.id ?? `new-${i}`}
            className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[1fr_auto]"
          >
            <Field label="Name">
              <Input value={tier.name} onChange={(e) => update(i, { name: e.target.value })} />
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox label="Default" checked={tier.isDefault} onChange={() => setDefault(i)} />
            </div>
            {tier.priceCount > 0 && (
              <p className="text-xs text-muted sm:col-span-2">
                {tier.priceCount} product{tier.priceCount === 1 ? '' : 's'} priced on this type.
              </p>
            )}
          </div>
        ))}
      </div>

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setTiers([...tiers, { id: null, name: '', isDefault: false, priceCount: 0 }])
          }
        >
          <Icons.Plus className="size-4" />
          Add a price type
        </Button>
      </div>
    </>
  )
}

/**
 * The costing basis.
 *
 * Both options are described in terms of what happens to a MARGIN figure,
 * because that is where the difference is felt. "Average cost" and "last cost"
 * are terms a bookkeeper knows and a first-time shop owner does not.
 */
function CostingStep({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectableCard
          name="cost-basis"
          value="average"
          title="Average cost"
          description="Every unit is valued at the average of what you paid across all your purchases. Margins move smoothly when supplier prices change. This is what most shops want."
          checked={value === 'average'}
          onChange={onChange}
          badge={<Badge tone="brand">Recommended</Badge>}
        />
        <SelectableCard
          name="cost-basis"
          value="last"
          title="Last cost"
          description="Every unit is valued at the most recent price you paid. Margins react immediately to a price change, which suits fast-moving stock bought at volatile prices."
          checked={value === 'last'}
          onChange={onChange}
        />
      </div>

      <Callout tone="warning">
        This decides what every sale reports as profit. Switching it after you have been trading
        leaves you with two periods of margin figures that cannot be compared with each other.
      </Callout>
    </>
  )
}

function DecimalsStep({
  qty,
  setQty,
  cost,
  setCost,
}: {
  qty: string
  setQty: (v: string) => void
  cost: string
  setCost: (v: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Quantity decimals"
        hint="Use 0 if you sell whole units only. Weighed items keep their own decimals whatever this says."
      >
        <Select value={qty} onChange={(e) => setQty(e.target.value)}>
          <option value="0">0 — whole units (1)</option>
          <option value="2">2 — two places (1.50)</option>
          <option value="3">3 — three places (1.500)</option>
        </Select>
      </Field>
      <Field
        label="Cost decimals"
        hint="Raise this if you buy at fractions of a cent — a distributor buying at 0.0875 a unit loses money to rounding at two."
      >
        <Select value={cost} onChange={(e) => setCost(e.target.value)}>
          <option value="2">2 — two places (1.50)</option>
          <option value="3">3 — three places (1.500)</option>
          <option value="4">4 — four places (1.5000)</option>
        </Select>
      </Field>
    </div>
  )
}

/**
 * A step whose real home is another screen.
 *
 * See `acknowledgeStepAction`: these have more in them than a wizard step
 * should reproduce, and a cut-down copy here would give a shop two places to
 * set the same thing that disagree about what is legal. So this points at the
 * real screen and records that the person was shown it.
 */
function HandoffStep({ href, stepKey }: { href: string; stepKey: StepKey }) {
  const labels: Record<string, string> = {
    numbering: 'Open document numbering',
    locations: 'Open stock locations',
    tenders: 'Open payment methods',
    people: 'Open users and roles',
    catalogue: 'Open the import tool',
  }

  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-border bg-surface-2 p-5">
      <p className="text-sm text-ink-2">
        This one has a screen of its own with more in it than belongs in a setup wizard. It opens in
        a new tab so you keep your place here.
      </p>
      <ButtonLink href={href} variant="secondary" target="_blank" rel="noopener noreferrer">
        {labels[stepKey] ?? 'Open the screen'}
        <Icons.ExternalLink className="size-4" />
      </ButtonLink>
    </div>
  )
}
