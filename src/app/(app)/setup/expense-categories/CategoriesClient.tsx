'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  Input,
  Select,
  Checkbox,
  Badge,
  Icons,
  Modal,
  TableToolbar,
  useToast,
  type Column,
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

  const columns: Column<Category>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      sortValue: (c) => c.accountCode,
      cell: (c) => <span className="numeric text-muted">{c.accountCode}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className="text-ink">{c.name}</span>
          {!c.isActive && <Badge tone="neutral">Inactive</Badge>}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortValue: (c) => c.categoryTypeLabel,
      cell: (c) => (
        // Capital is the one type worth marking: booking an asset as an
        // expense is the commonest bookkeeping error.
        <Badge tone={c.categoryType === 'capital' ? 'brand' : 'default'}>
          {c.categoryTypeLabel}
        </Badge>
      ),
    },
    {
      key: 'vat',
      header: 'VAT',
      sortValue: (c) => (c.vatClaimable ? 'Claimable' : 'Not claimable'),
      cell: (c) =>
        c.vatClaimable ? (
          <span className="text-muted">Claimable</span>
        ) : (
          // Neutral, not warning: "not claimable" is a correct configuration
          // (entertainment, salaries), not a condition needing attention.
          <Badge tone="neutral">Not claimable</Badge>
        ),
    },
    {
      key: 'spend',
      header: 'Last 12 months',
      numeric: true,
      sortable: true,
      sortValue: (c) => c.yearSpend,
      cell: (c) =>
        c.yearSpend > 0 ? formatMoney(c.yearSpend) : <span className="text-faint">—</span>,
    },
  ]

  return (
    <>
      <TableToolbar
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icons.Plus size={15} />
            Add category
          </Button>
        }
      >
        <Checkbox
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          label="Show inactive"
        />
      </TableToolbar>

      <Card>
        <CardHeader
          title="Categories"
          description="Where money that is not stock goes. Spend shown is the last twelve months."
        />
        <DataTable
          columns={columns}
          rows={visible}
          getRowKey={(c) => c.id}
          actionsOnHover
          actions={(c) => (
            <>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Edit ${c.name}`}
                onClick={() => setEditing(c)}
              >
                <Icons.Pencil size={15} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                disabled={pending}
                aria-label={c.isActive ? `Hide ${c.name}` : `Restore ${c.name}`}
                title={c.isActive ? 'Hide' : 'Restore'}
                onClick={() => run(() => setCategoryActiveAction(c.id, !c.isActive))}
              >
                {c.isActive ? <Icons.Archive size={15} /> : <Icons.ArchiveRestore size={15} />}
              </Button>
            </>
          )}
          empty={{
            title: showInactive ? 'No categories yet' : 'No active categories',
            hint: showInactive
              ? 'Add one for each kind of non-stock spend — rent, wages, bank charges.'
              : 'Add a category, or tick “Show inactive” to see hidden ones.',
            action: (
              <Button variant="secondary" onClick={() => setCreating(true)}>
                <Icons.Plus size={15} />
                Add category
              </Button>
            ),
          }}
        />
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
    <Modal
      open={open}
      onClose={onClose}
      title={category ? 'Edit category' : 'New category'}
      /* Five fields plus the account-mapping selects, which carry the whole
         chart of accounts. */
      bodyGrows
    >
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

        <Field hint="Leave this off where the VAT Act denies the deduction — entertainment and passenger vehicles are refused however the invoice is worded, and salaries carry no VAT at all.">
          <Checkbox
            checked={vatClaimable}
            onChange={(e) => setVatClaimable(e.target.checked)}
            label="Input VAT can be claimed on this category"
          />
        </Field>

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
              variant="primary"
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
