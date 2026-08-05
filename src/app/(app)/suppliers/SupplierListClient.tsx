'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  BulkActionBar,
  Badge,
  Button,
  DataTable,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  Modal,
  NumberInput,
  Select,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { Supplier, SupplierStatus, SupplierBulkChange } from '@/lib/site/suppliers'
import { bulkUpdateSuppliersAction } from './actions'

/** The creditors mirror of CustomerListClient — see that file for the split. */

type Filters = {
  statuses: { value: string; label: string; href: string; active: boolean }[]
  categories: string[]
}

type BulkKind = SupplierBulkChange['kind'] | null

export default function SupplierListClient({
  rows,
  total,
  filters,
}: {
  rows: Supplier[]
  total: number
  filters: Filters
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [openBulk, setOpenBulk] = useState<BulkKind>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function runBulk(change: SupplierBulkChange) {
    const ids = [...selected].map(Number)
    startTransition(async () => {
      const result = await bulkUpdateSuppliersAction(ids, change)
      setOpenBulk(null)

      if (result.updated === 0) {
        const reason = result.skipped[0]?.reason
        toast.error(reason ? `Nothing updated — ${reason.toLowerCase()}` : 'Nothing was updated.')
        return
      }

      if (result.skipped.length > 0) {
        const names = result.skipped
          .filter((s) => s.name)
          .map((s) => s.name)
          .slice(0, 3)
          .join(', ')
        toast.info(
          `${result.updated} updated, ${result.skipped.length} skipped${names ? ` — ${names}` : ''}`,
        )
      } else {
        toast.success(`${result.updated} supplier${result.updated === 1 ? '' : 's'} updated`)
      }

      setSelected(new Set())
      router.refresh()
    })
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs">
        <Link
          href="/suppliers"
          className={
            filters.statuses.every((s) => !s.active)
              ? 'font-medium text-brand'
              : 'text-muted hover:text-ink'
          }
        >
          All
        </Link>
        {filters.statuses.map((status) => (
          <Link
            key={status.value}
            href={status.href}
            className={status.active ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
          >
            {status.label}
          </Link>
        ))}
      </div>

      <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button variant="ghost" size="sm" onClick={() => setOpenBulk('status')} disabled={pending}>
          <Icons.Check size={15} />
          Change status
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpenBulk('terms')} disabled={pending}>
          <Icons.Clock size={15} />
          Set terms
        </Button>
        <Menu label="More" variant="ghost">
          <MenuItem onClick={() => setOpenBulk('category')}>
            <Icons.Tag size={15} />
            Set category
          </MenuItem>
        </Menu>
      </BulkActionBar>

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row) => row.id}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => router.push(`/suppliers/${row.id}`)}
        empty={{
          title: 'No suppliers found',
          hint:
            total === 0
              ? 'Create your first supplier to get started.'
              : 'Try a different search or clear the filters.',
        }}
      />

      <BulkModals
        kind={openBulk}
        count={selected.size}
        filters={filters}
        pending={pending}
        onClose={() => setOpenBulk(null)}
        onApply={runBulk}
      />
    </>
  )
}

const STATUS_TONE: Record<SupplierStatus, 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  on_hold: 'danger',
  inactive: 'neutral',
  closed: 'neutral',
}

const STATUS_LABEL: Record<SupplierStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  inactive: 'Inactive',
  closed: 'Closed',
}

const COLUMNS: readonly Column<Supplier>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    cell: (row) => <span className="text-brand">{row.code}</span>,
  },
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    cell: (row) => (
      <div>
        <div className="text-ink">{row.name}</div>
        {row.contactName && <div className="text-xs text-muted">{row.contactName}</div>}
      </div>
    ),
  },
  {
    key: 'account',
    header: 'Our account',
    sortable: true,
    sortValue: (row) => row.accountNumber ?? '',
    cell: (row) => row.accountNumber ?? '—',
  },
  {
    key: 'terms',
    header: 'Terms',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.paymentTermsDays,
    cell: (row) => (row.paymentTermsDays === 0 ? 'COD' : `${row.paymentTermsDays} days`),
  },
  {
    key: 'lead',
    header: 'Lead time',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.leadTimeDays,
    cell: (row) => (row.leadTimeDays > 0 ? `${row.leadTimeDays} days` : '—'),
  },
  {
    key: 'products',
    header: 'Products',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.productCount,
    cell: (row) => (row.productCount > 0 ? String(row.productCount) : '—'),
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    // A supplier balance is what WE owe THEM — never styled as a problem.
    cell: (row) => formatMoney(row.balance),
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    sortValue: (row) => row.status,
    cell: (row) => (
      <span title={row.statusReason ?? undefined}>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
      </span>
    ),
  },
]

function BulkModals({
  kind,
  count,
  filters,
  pending,
  onClose,
  onApply,
}: {
  kind: BulkKind
  count: number
  filters: Filters
  pending: boolean
  onClose: () => void
  onApply: (change: SupplierBulkChange) => void
}) {
  const [status, setStatus] = useState<SupplierStatus>('on_hold')
  const [reason, setReason] = useState('')
  const [terms, setTerms] = useState(30)
  const [category, setCategory] = useState('')

  const noun = `${count} supplier${count === 1 ? '' : 's'}`

  const footer = (change: () => SupplierBulkChange) => (
    <>
      <Button variant="ghost" onClick={onClose} disabled={pending}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => onApply(change())} disabled={pending}>
        {pending ? 'Applying…' : `Apply to ${noun}`}
      </Button>
    </>
  )

  return (
    <>
      <Modal
        open={kind === 'status'}
        onClose={onClose}
        title="Change status"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'status', status, reason }))}
      >
        <div className="flex flex-col gap-4">
          <Field
            label="New status"
            hint="On hold stops new orders; it does not clear what is already owed."
          >
            <Select value={status} onChange={(e) => setStatus(e.target.value as SupplierStatus)}>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="inactive">Inactive</option>
              <option value="closed">Closed</option>
            </Select>
          </Field>
          {status !== 'active' && (
            <Field label="Reason">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Quality dispute"
              />
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={kind === 'terms'}
        onClose={onClose}
        title="Set payment terms"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'terms', paymentTermsDays: terms }))}
      >
        <Field label="Payment terms (days)" hint="0–365. Drives the payables age analysis.">
          <NumberInput value={terms} onChange={(e) => setTerms(Number(e.target.value) || 0)} />
        </Field>
      </Modal>

      <Modal
        open={kind === 'category'}
        onClose={onClose}
        title="Set category"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'category', category: category || null }))}
      >
        <Field label="Category" hint="Leave blank to clear it.">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            list="supplier-categories"
            placeholder="e.g. Dry goods"
          />
          <datalist id="supplier-categories">
            {filters.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </Modal>
    </>
  )
}
