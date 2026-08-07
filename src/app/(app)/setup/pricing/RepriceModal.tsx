'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  FieldGroup,
  Modal,
  NumberInput,
  Select,
  Switch,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PriceStructureRow } from '@/lib/site/pricingSetup'
import { applyEnding, type RepriceRule, type RepriceRounding, type EndingDirection } from '@/lib/repricing'
import type { RepriceScope } from '@/lib/site/reprice'
import {
  previewRepriceAction,
  applyRepriceAction,
  type RepricePreview,
  type PricingActionResult,
} from './actions'

/**
 * Bulk reprice — fill or reset a whole price type from a rule.
 *
 * Preview before apply is not optional here. This writes every shelf price in
 * the shop, and the only honest way to ask for that is to show the count and a
 * sample of actual before/after figures first. The preview is recomputed on
 * every input change, so what is on screen always matches the rule as typed.
 *
 * The apply path deliberately re-runs the rule server-side rather than posting
 * these numbers back; see applyRepriceAction.
 */

type Named = { id: number; name: string }

export default function RepriceModal({
  open,
  onClose,
  structures,
  departments,
  brands,
  defaultEndingDirection,
  onDone,
}: {
  open: boolean
  onClose: () => void
  structures: PriceStructureRow[]
  departments: Named[]
  brands: Named[]
  /** The site's price_ending_direction, used as this run's starting choice. */
  defaultEndingDirection: EndingDirection
  onDone: (result: PricingActionResult) => void
}) {
  const active = structures.filter((s) => s.isActive)
  const [targetId, setTargetId] = useState<number>(active[0]?.id ?? 0)
  const [sourceKind, setSourceKind] = useState<'cost' | 'structure'>('cost')
  const [sourceStructureId, setSourceStructureId] = useState<number>(
    active.find((s) => s.isDefault)?.id ?? active[0]?.id ?? 0,
  )
  const [methodKind, setMethodKind] = useState<'markup' | 'gp' | 'adjust'>('markup')
  const [percent, setPercent] = useState(40)
  const [roundingKind, setRoundingKind] = useState<RepriceRounding['kind']>('none')
  const [endingCents, setEndingCents] = useState(99)
  const [endingDirection, setEndingDirection] = useState<EndingDirection>(defaultEndingDirection)
  const [nearestStep, setNearestStep] = useState(0.5)
  const [floorAtCost, setFloorAtCost] = useState(true)

  const [departmentIds, setDepartmentIds] = useState<number[]>([])
  const [brandIds, setBrandIds] = useState<number[]>([])
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [includeArchived, setIncludeArchived] = useState(false)

  const [preview, setPreview] = useState<RepricePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [stale, setStale] = useState(true)
  const [pending, startTransition] = useTransition()

  // Pricing off a structure only supports a straight adjustment: "40% markup on
  // Retail" would silently mean markup-on-cost, which is not what it says.
  const effectiveMethod = sourceKind === 'structure' ? 'adjust' : methodKind

  function buildRule(): RepriceRule {
    const rounding: RepriceRounding =
      roundingKind === 'ending'
        ? { kind: 'ending', cents: endingCents, direction: endingDirection }
        : roundingKind === 'nearest'
          ? { kind: 'nearest', step: nearestStep }
          : { kind: 'none' }

    return {
      source:
        sourceKind === 'cost' ? { kind: 'cost' } : { kind: 'structure', structureId: sourceStructureId },
      method: { kind: effectiveMethod, percent } as RepriceRule['method'],
      rounding,
      floorAtCost,
    }
  }

  function buildScope(): RepriceScope {
    return {
      targetStructureId: targetId,
      departmentIds: departmentIds.length ? departmentIds : undefined,
      brandIds: brandIds.length ? brandIds : undefined,
      onlyMissing,
      includeArchived,
    }
  }

  /** Any edit invalidates the preview — an apply is only ever offered on a fresh one. */
  function touched<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value)
      setStale(true)
      setPreview(null)
    }
  }

  function runPreview() {
    setPreviewError(null)
    startTransition(async () => {
      const result = await previewRepriceAction(buildScope(), buildRule())
      if (result.ok) {
        setPreview(result.preview)
        setStale(false)
      } else {
        setPreviewError(result.error)
      }
    })
  }

  function runApply() {
    startTransition(async () => {
      const result = await applyRepriceAction(buildScope(), buildRule())
      onDone(result)
    })
  }

  const targetName = structures.find((s) => s.id === targetId)?.name ?? ''
  const canApply = !stale && preview !== null && preview.changing > 0 && !pending

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk reprice"
      description="Fill a price type across the catalogue from a rule. Nothing is written until you apply."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {stale || preview === null ? (
            <Button variant="secondary" onClick={runPreview} disabled={pending || !targetId}>
              {pending ? 'Working…' : 'Preview changes'}
            </Button>
          ) : (
            <Button variant="primary" onClick={runApply} disabled={!canApply}>
              {pending
                ? 'Applying…'
                : `Apply to ${preview.changing} product${preview.changing === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FieldGroup title="What to set" hint="The price type these new prices are written to.">
          <Field label="Price type">
            <div className="w-64">
              <Select
                value={String(targetId)}
                onChange={(e) => touched(setTargetId)(Number(e.target.value))}
              >
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          <Switch
            checked={onlyMissing}
            onChange={touched(setOnlyMissing)}
            label="Only products with no price yet"
            hint="On for filling a new price type; off to reprice everything and overwrite what is there."
          />
        </FieldGroup>

        <FieldGroup title="How to work it out" hint="Markup and GP price off cost; an adjustment moves an existing price.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Based on">
              <Select
                value={sourceKind}
                onChange={(e) => touched(setSourceKind)(e.target.value as 'cost' | 'structure')}
              >
                <option value="cost">Cost</option>
                <option value="structure">Another price type</option>
              </Select>
            </Field>

            {sourceKind === 'structure' ? (
              <Field label="Copy from">
                <Select
                  value={String(sourceStructureId)}
                  onChange={(e) => touched(setSourceStructureId)(Number(e.target.value))}
                >
                  {active
                    .filter((s) => s.id !== targetId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : (
              <Field label="Method">
                <Select
                  value={methodKind}
                  onChange={(e) => touched(setMethodKind)(e.target.value as 'markup' | 'gp')}
                >
                  <option value="markup">Markup on cost</option>
                  <option value="gp">Gross profit %</option>
                </Select>
              </Field>
            )}
          </div>

          <Field
            label={
              effectiveMethod === 'markup'
                ? 'Markup %'
                : effectiveMethod === 'gp'
                  ? 'GP %'
                  : 'Adjustment %'
            }
            hint={
              effectiveMethod === 'adjust'
                ? 'Negative discounts off the source price: -10 is 10% cheaper.'
                : effectiveMethod === 'gp'
                  ? 'What you keep, as a share of the selling price. Must be under 100.'
                  : 'What you add on, as a share of cost. A 100% markup is a 50% GP.'
            }
          >
            <div className="w-40">
              <NumberInput
                value={percent}
                onChange={(e) =>
                  touched(setPercent)(Number(String(e.target.value).replace(',', '.')) || 0)
                }
                step="0.01"
              />
            </div>
          </Field>
        </FieldGroup>

        <FieldGroup title="Tidy the result" hint="Applied to the VAT-inclusive shelf price.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rounding">
              <Select
                value={roundingKind}
                onChange={(e) => touched(setRoundingKind)(e.target.value as RepriceRounding['kind'])}
              >
                <option value="none">None — exact</option>
                <option value="ending">Force an ending (.99, .95)</option>
                <option value="nearest">Nearest step</option>
              </Select>
            </Field>

            {roundingKind === 'ending' && (
              <Field label="Ending" hint="Cents every price is forced to.">
                <Select
                  value={String(endingCents)}
                  onChange={(e) => touched(setEndingCents)(Number(e.target.value))}
                >
                  <option value="99">.99</option>
                  <option value="95">.95</option>
                  <option value="90">.90</option>
                  <option value="50">.50</option>
                  <option value="0">.00 — whole rand</option>
                </Select>
              </Field>
            )}

            {roundingKind === 'ending' && (
              <Field
                label="Direction"
                hint={endingExample(endingCents, endingDirection)}
              >
                <Select
                  value={endingDirection}
                  onChange={(e) => touched(setEndingDirection)(e.target.value as EndingDirection)}
                >
                  <option value="up">Round up — never below the worked-out price</option>
                  <option value="down">Round down — never above it</option>
                  <option value="nearest">Nearest — whichever is closer</option>
                </Select>
              </Field>
            )}

            {roundingKind === 'nearest' && (
              <Field label="Step" hint="0.05 for cash-friendly, 1 for whole rand.">
                <NumberInput
                  value={nearestStep}
                  onChange={(e) =>
                    touched(setNearestStep)(Number(String(e.target.value).replace(',', '.')) || 0)
                  }
                  step="0.05"
                  min="0"
                />
              </Field>
            )}
          </div>

          <Switch
            checked={floorAtCost}
            onChange={touched(setFloorAtCost)}
            label="Never price below cost"
            hint="Skips any product where the rule and rounding would land under cost."
          />
        </FieldGroup>

        <FieldGroup title="Which products" hint="Leave both empty to cover the whole catalogue.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Departments" hint="Optional. Nothing ticked means all.">
              <PickList
                items={departments}
                selected={departmentIds}
                onChange={touched(setDepartmentIds)}
              />
            </Field>
            <Field label="Brands" hint="Optional. Nothing ticked means all.">
              <PickList items={brands} selected={brandIds} onChange={touched(setBrandIds)} />
            </Field>
          </div>

          <Switch
            checked={includeArchived}
            onChange={touched(setIncludeArchived)}
            label="Include archived products"
            hint="Off by default — archived lines are not on sale."
          />
        </FieldGroup>

        {previewError && <Callout tone="danger">{previewError}</Callout>}

        {preview && !stale && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={preview.changing > 0 ? 'success' : 'neutral'}>
                {preview.changing} changing
              </Badge>
              {preview.unchanged > 0 && (
                <Badge tone="neutral">{preview.unchanged} already correct</Badge>
              )}
              {preview.skipped > 0 && <Badge tone="warning">{preview.skipped} skipped</Badge>}
              <span className="text-sm text-muted">
                out of {preview.considered} product{preview.considered === 1 ? '' : 's'} in scope
              </span>
            </div>

            {preview.skipReasons.length > 0 && (
              <Callout tone="warning">
                Skipped:{' '}
                {preview.skipReasons.map((s) => `${s.count} × ${s.reason.toLowerCase()}`).join(', ')}.
              </Callout>
            )}

            {preview.changing === 0 ? (
              <Callout tone="neutral">
                Nothing would change under this rule. Widen the scope, or turn off “only products
                with no price yet” to overwrite existing prices.
              </Callout>
            ) : (
              <div className="overflow-x-auto rounded-card border border-border">
                <table className="w-full">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Code</th>
                      <th className={TABLE_TH}>Product</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Now</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>New {targetName}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row) => (
                      <tr key={row.code}>
                        <td className={TABLE_TD}>{row.code}</td>
                        <td className={TABLE_TD}>{row.description}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                          {row.currentIncl === null ? '—' : formatMoney(row.currentIncl)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                          {formatMoney(row.newIncl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.changing > preview.sample.length && (
                  <p className="border-t border-border px-4 py-2 text-xs text-muted">
                    Showing {preview.sample.length} of {preview.changing} changes.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {stale && preview === null && !previewError && (
          <Callout tone="neutral">
            Preview the changes to see how many products this affects before anything is written.
          </Callout>
        )}
      </div>
    </Modal>
  )
}

/**
 * A worked example of the chosen direction, using a price that lands between
 * two endings — the only case where the three options differ.
 */
function endingExample(cents: number, direction: EndingDirection): string {
  const sample = 14.32
  const result = applyEnding(sample, cents, direction)
  return `R${sample.toFixed(2)} becomes R${result.toFixed(2)}.`
}

/** A short scrollable tick-list. Departments and brands are both small enough. */
function PickList({
  items,
  selected,
  onChange,
}: {
  items: Named[]
  selected: number[]
  onChange: (next: number[]) => void
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">None set up.</p>
  }
  return (
    <div className="max-h-36 overflow-y-auto rounded-control border border-border bg-surface p-2">
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-2 px-1 py-1 text-sm text-ink-2">
          <Checkbox
            checked={selected.includes(item.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, item.id]
                  : selected.filter((id) => id !== item.id),
              )
            }
          />
          {item.name}
        </label>
      ))}
    </div>
  )
}
