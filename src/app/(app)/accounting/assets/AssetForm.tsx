'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  Select,
  CurrencyInput,
  Textarea,
  Icons,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  ASSET_STATUS_HINTS,
  monthlyAmount,
  refuseAsset,
  schedule,
  type AssetStatus,
} from '@/lib/assetModel'
import { saveAssetAction } from './actions'

type Category = {
  id: number
  name: string
  defaultLifeMonths: number
  defaultResidualPct: number
}

export type AssetFormValues = {
  id?: number
  name: string
  description: string
  categoryId: number
  serialNumber: string
  location: string
  status: AssetStatus
  acquiredOn: string
  cost: number
  residualValue: number
  lifeMonths: number
  depreciationStart: string
  notes: string
  /** Set on an existing asset — the cost cannot change once it has depreciated. */
  accumulatedDepreciation?: number
}

/**
 * Adding or editing an asset.
 *
 * ── THE SCHEDULE IS SHOWN AS IT IS TYPED ─────────────────────────────────
 *
 * Cost, life and residual are three numbers that produce a monthly charge for
 * years, and nobody can tell by looking at them whether the result is sensible.
 * So the monthly figure and the end date are shown live: "R666.67 a month until
 * December 2028" is checkable in a way that "36 months" is not.
 */
export function AssetForm({
  categories,
  existing,
  fromExpense,
}: {
  categories: Category[]
  existing?: AssetFormValues
  fromExpense?: { cost: number; acquiredOn: string; description: string; supplierName: string | null }
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const firstCategory = categories[0]

  const [name, setName] = useState(existing?.name ?? fromExpense?.description ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? firstCategory?.id ?? 0)
  const [serialNumber, setSerialNumber] = useState(existing?.serialNumber ?? '')
  const [location, setLocation] = useState(existing?.location ?? '')
  const [status, setStatus] = useState<AssetStatus>(existing?.status ?? 'active')
  const [acquiredOn, setAcquiredOn] = useState(
    existing?.acquiredOn ?? fromExpense?.acquiredOn ?? todayIso(),
  )
  const [cost, setCost] = useState(existing?.cost ?? fromExpense?.cost ?? 0)
  const [residualValue, setResidualValue] = useState(existing?.residualValue ?? 0)
  const [lifeMonths, setLifeMonths] = useState(
    existing?.lifeMonths ?? firstCategory?.defaultLifeMonths ?? 36,
  )
  const [depreciationStart, setDepreciationStart] = useState(
    existing?.depreciationStart ?? fromExpense?.acquiredOn ?? todayIso(),
  )
  const [notes, setNotes] = useState(existing?.notes ?? '')

  const isEdit = existing?.id !== undefined
  const hasDepreciated = (existing?.accumulatedDepreciation ?? 0) > 0

  const refusal = refuseAsset({
    name,
    cost,
    residualValue,
    lifeMonths,
    acquiredOn,
    depreciationStart,
  })

  const monthly = monthlyAmount(cost, residualValue, lifeMonths)
  const preview =
    refusal === null
      ? schedule({
          id: 0,
          status: 'active',
          cost,
          residualValue,
          lifeMonths,
          depreciationStart,
          accumulatedDepreciation: 0,
          lastDepreciatedTo: null,
        })
      : []
  const endsOn = preview.length > 0 ? preview[preview.length - 1].month : null

  /** Adopting a category's defaults, which is what a category is for. */
  function applyCategory(id: number) {
    setCategoryId(id)
    const category = categories.find((c) => c.id === id)
    if (!category || isEdit) return
    setLifeMonths(category.defaultLifeMonths)
    setResidualValue(Math.round(((cost * category.defaultResidualPct) / 100) * 100) / 100)
  }

  function save() {
    startTransition(async () => {
      const result = await saveAssetAction(
        {
          name: name.trim(),
          description: description.trim() || null,
          categoryId,
          serialNumber: serialNumber.trim() || null,
          location: location.trim() || null,
          status,
          acquiredOn,
          cost,
          residualValue,
          lifeMonths,
          depreciationStart,
          notes: notes.trim() || null,
        },
        existing?.id,
      )

      if (result.ok) {
        toast.success(result.message)
        router.push(result.id ? `/accounting/assets/${result.id}` : '/accounting/assets')
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      {fromExpense && (
        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              Taken from a capital expense of {formatMoney(fromExpense.cost)}
              {fromExpense.supplierName ? ` from ${fromExpense.supplierName}` : ''}. The cost
              excludes VAT that was reclaimed — reclaimed VAT was never a cost, so capitalising
              it would overstate the asset and every charge off it.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="What it is" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Delivery bakkie"
              />
            </Field>
            <Field label="Category" hint="Sets the default life and residual.">
              <Select
                value={String(categoryId)}
                onChange={(e) => applyCategory(Number(e.target.value))}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Serial or registration" hint="What identifies it. Optional.">
              <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
            </Field>
            <Field label="Where it is" hint="Optional.">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} />
            </Field>
            <Field label="Status" hint={ASSET_STATUS_HINTS[status]}>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as AssetStatus)}
              >
                {ASSET_STATUSES.filter((s) => s !== 'disposed').map((s) => (
                  <option key={s} value={s}>
                    {ASSET_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Description" hint="Optional.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What it cost and how long it lasts"
          description="These three numbers decide what the profit and loss carries every month for years."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Cost"
              hint={
                hasDepreciated
                  ? 'Cannot change — it has already depreciated.'
                  : 'Excluding VAT you reclaimed.'
              }
            >
              <CurrencyInput
                value={cost}
                disabled={hasDepreciated}
                onChange={(e) => setCost(Number(String(e.target.value).replace(',', '.')) || 0)}
              />
            </Field>
            <Field label="Residual value" hint="What it will be worth at the end.">
              <CurrencyInput
                value={residualValue}
                onChange={(e) =>
                  setResidualValue(Number(String(e.target.value).replace(',', '.')) || 0)
                }
              />
            </Field>
            <Field label="Useful life (months)">
              <Input
                type="number"
                value={lifeMonths}
                onChange={(e) => setLifeMonths(Number(e.target.value) || 0)}
                className="max-w-32"
              />
            </Field>
            <Field label="Acquired on">
              <Input
                type="date"
                value={acquiredOn}
                onChange={(e) => setAcquiredOn(e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Depreciation starts"
              hint="Usually the month it was acquired — later if it was not used straight away."
            >
              <Input
                type="date"
                value={depreciationStart}
                onChange={(e) => setDepreciationStart(e.target.value)}
                className="max-w-48"
              />
            </Field>
          </div>

          {/* Three numbers nobody can sanity-check by looking at them, turned
              into one sentence that can be. */}
          {refusal === null && monthly > 0 && (
            <p className="mt-4 rounded-control bg-surface-2 px-3 py-2 text-sm">
              <span className="text-ink">{formatMoney(monthly)} a month</span>
              <span className="text-muted">
                {' '}
                for {lifeMonths} months
                {endsOn ? `, ending ${endsOn}` : ''}
                {residualValue > 0
                  ? `, leaving ${formatMoney(residualValue)} residual`
                  : ', down to zero'}
                .
              </span>
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Field label="Notes" hint="Optional — warranty, insurance, anything worth remembering.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </CardBody>
        <CardFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-sm text-muted">
              {refusal ?? 'Adding an asset posts no journal — the expense that bought it already did.'}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button disabled={pending || refusal !== null} onClick={save}>
                <Icons.Check size={15} />
                {isEdit ? 'Save changes' : 'Add to the register'}
              </Button>
            </div>
          </div>
        </CardFooter>
      </Card>
    </>
  )
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
