'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Field,
  Input,
  Select,
  Checkbox,
  Badge,
  Icons,
  Modal,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  CATEGORY_TYPES,
  CATEGORY_TYPE_LABELS,
  CATEGORY_TYPE_HINTS,
  type ExpenseCategoryType,
} from '@/lib/expenseModel'
import {
  saveCategoryAction,
  setCategoryActiveAction,
  deleteCategoryAction,
} from '../../expenses/actions'

type Category = {
  id: number
  accountCode: string
  name: string
  categoryType: ExpenseCategoryType
  categoryTypeLabel: string
  defaultVatRateId: number | null
  vatClaimable: boolean
  isActive: boolean
  sortOrder: number
  yearSpend: number
}

type VatRate = { id: number; name: string; rate: number }

export function CategoriesClient({
  categories,
  vatRates,
}: {
  categories: Category[]
  vatRates: VatRate[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<Category | null>(null)
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  const visible = showInactive ? categories : categories.filter((c) => c.isActive)

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Categories"
          description="Where money that is not stock goes. Spend shown is the last twelve months."
          action={
            <div className="flex items-center gap-3">
              <Checkbox
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                label="Show inactive"
              />
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
                <Icons.Plus size={15} />
                Add category
              </Button>
            </div>
          }
        />

        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Code</th>
                <th className={TABLE_TH}>Name</th>
                <th className={TABLE_TH}>Type</th>
                <th className={TABLE_TH}>VAT</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Last 12 months</th>
                <th className={`${TABLE_TH} w-32`} />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <span className="numeric text-muted">{c.accountCode}</span>
                  </td>
                  <td className={TABLE_TD}>
                    <span className={c.isActive ? 'text-ink' : 'text-muted line-through'}>
                      {c.name}
                    </span>
                  </td>
                  <td className={TABLE_TD}>
                    {/* Capital is the one type worth marking: booking an asset
                        as an expense is the commonest bookkeeping error. */}
                    <Badge tone={c.categoryType === 'capital' ? 'brand' : 'default'}>
                      {c.categoryTypeLabel}
                    </Badge>
                  </td>
                  <td className={TABLE_TD}>
                    {c.vatClaimable ? (
                      <span className="text-muted">Claimable</span>
                    ) : (
                      <Badge tone="warning">Not claimable</Badge>
                    )}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {c.yearSpend > 0 ? (
                      formatMoney(c.yearSpend)
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className={`${TABLE_TD} text-right`}>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => run(() => setCategoryActiveAction(c.id, !c.isActive))}
                      >
                        {c.isActive ? 'Hide' : 'Restore'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CategoryModal
        open={creating || editing !== null}
        category={editing}
        vatRates={vatRates}
        pending={pending}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onDelete={(id) => {
          run(() => deleteCategoryAction(id))
          setEditing(null)
        }}
        onSave={(input, id) => {
          run(() => saveCategoryAction(input, id))
          setCreating(false)
          setEditing(null)
        }}
      />
    </>
  )
}

function CategoryModal({
  open,
  category,
  vatRates,
  pending,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  category: Category | null
  vatRates: VatRate[]
  pending: boolean
  onClose: () => void
  onSave: (input: Parameters<typeof saveCategoryAction>[0], id?: number) => void
  onDelete: (id: number) => void
}) {
  const [accountCode, setAccountCode] = useState(category?.accountCode ?? '')
  const [name, setName] = useState(category?.name ?? '')
  const [categoryType, setCategoryType] = useState<ExpenseCategoryType>(
    category?.categoryType ?? 'operating',
  )
  const [defaultVatRateId, setDefaultVatRateId] = useState<number | null>(
    category?.defaultVatRateId ?? null,
  )
  const [vatClaimable, setVatClaimable] = useState(category?.vatClaimable ?? true)

  const [seededFor, setSeededFor] = useState<number | null>(category?.id ?? null)
  if (open && category && seededFor !== category.id) {
    setSeededFor(category.id)
    setAccountCode(category.accountCode)
    setName(category.name)
    setCategoryType(category.categoryType)
    setDefaultVatRateId(category.defaultVatRateId)
    setVatClaimable(category.vatClaimable)
  }

  return (
    <Modal open={open} onClose={onClose} title={category ? 'Edit category' : 'New category'}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Account code" hint="Becomes the ledger code.">
            <Input
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              maxLength={16}
              placeholder="5200"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Waste removal"
              />
            </Field>
          </div>
        </div>

        <Field label="Type" hint={CATEGORY_TYPE_HINTS[categoryType]}>
          <Select
            value={categoryType}
            onChange={(e) => setCategoryType(e.target.value as ExpenseCategoryType)}
          >
            {CATEGORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {CATEGORY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Default VAT rate" hint="Suggested when this category is chosen.">
          <Select
            value={String(defaultVatRateId ?? '')}
            onChange={(e) => setDefaultVatRateId(Number(e.target.value) || null)}
          >
            <option value="">— No default —</option>
            {vatRates.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.rate}%)
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <Checkbox
            checked={vatClaimable}
            onChange={(e) => setVatClaimable(e.target.checked)}
            label="Input VAT can be claimed on this category"
          />
          <p className="mt-1 text-sm text-muted">
            Leave this off where the VAT Act denies the deduction — entertainment and
            passenger vehicles are refused however the invoice is worded, and salaries carry no
            VAT at all.
          </p>
        </div>

        <div className="flex justify-between">
          {category ? (
            <Button variant="danger-ghost" onClick={() => onDelete(category.id)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || !accountCode.trim() || !name.trim()}
              onClick={() =>
                onSave(
                  {
                    accountCode: accountCode.trim(),
                    name: name.trim(),
                    categoryType,
                    defaultVatRateId,
                    vatClaimable,
                  },
                  category?.id,
                )
              }
            >
              {category ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
