'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  BulkActionBar,
  BulkOptionsDialog,
  Badge,
  Button,
  DataTable,
  Field,
  Icons,
  Input,
  LinkSegmentedControl,
  Modal,
  NumberInput,
  PrimaryLink,
  RowTile,
  Select,
  TableToolbar,
  useToast,
  type BulkOptionGroup,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { Supplier, SupplierStatus, SupplierBulkChange } from '@/lib/site/suppliers'
import { bulkUpdateSuppliersAction } from './actions'

/** The creditors mirror of CustomerListClient — see that file for the split. */

type Filters = {
  allHref: string
  statuses: { value: string; label: string; href: string; active: boolean }[]
  categories: string[]
}

type BulkKind = SupplierBulkChange['kind'] | null

/** The bulk actions, in the same dialog customers and products use. */
const BULK_OPTIONS: BulkOptionGroup<SupplierBulkChange['kind']>[] = [
  {
    title: 'Supplier',
    options: [
      { key: 'status', label: 'Change status', icon: <Icons.Check size={15} />, keywords: 'hold active' },
      { key: 'terms', label: 'Set payment terms', icon: <Icons.Clock size={15} />, keywords: 'days cod' },
      { key: 'category', label: 'Set category', icon: <Icons.Tag size={15} /> },
    ],
  },
]

export default function SupplierListClient({
  rows,
  total,
  hasAny,
  searchTerm,
  filters,
}: {
  rows: Supplier[]
  total: number
  /** Whether ANY supplier exists at all — decides which empty state to show. */
  hasAny: boolean
  /** The active search, echoed back when it matches nothing. */
  searchTerm?: string
  filters: Filters
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [showOptions, setShowOptions] = useState(false)
  const [openBulk, setOpenBulk] = useState<BulkKind>(null)
  const [recent, setRecent] = useState<SupplierBulkChange['kind'][]>([])
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function runBulk(change: SupplierBulkChange) {
    const ids = [...selected].map(Number)
    startTransition(async () => {
      const result = await bulkUpdateSuppliersAction(ids, change)
      setOpenBulk(null)
      // Most recent first, for the dialog's top row.
      setRecent((prev) => [change.kind, ...prev.filter((k) => k !== change.kind)].slice(0, 4))

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

  const activeStatus = filters.statuses.find((s) => s.active)?.value ?? 'all'

  return (
    <>
      <TableToolbar inCard>
        <LinkSegmentedControl
          aria-label="Filter by status"
          value={activeStatus}
          options={[
            { value: 'all', label: 'All', href: filters.allHref },
            ...filters.statuses.map((status) => ({
              value: status.value,
              label: status.label,
              href: status.href,
            })),
          ]}
        />
      </TableToolbar>

      <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button variant="ghost" size="sm" onClick={() => setShowOptions(true)} disabled={pending}>
          <Icons.SlidersHorizontal size={15} />
          Bulk options
        </Button>
      </BulkActionBar>

      <BulkOptionsDialog
        open={showOptions}
        onClose={() => setShowOptions(false)}
        onPick={(key) => {
          setShowOptions(false)
          setOpenBulk(key)
        }}
        groups={BULK_OPTIONS}
        count={selected.size}
        noun="supplier"
        recent={recent}
      />

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row) => row.id}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => router.push(`/suppliers/${row.id}`)}
        empty={
          !hasAny
            ? {
                title: 'No suppliers yet',
                hint: 'Create your first supplier to get started.',
                icon: <Icons.Truck size={28} strokeWidth={1.75} />,
                action: (
                  <PrimaryLink href="/suppliers/new">
                    <Icons.Plus size={15} />
                    New supplier
                  </PrimaryLink>
                ),
              }
            : {
                title: searchTerm ? `Nothing matches “${searchTerm}”` : 'No suppliers found',
                hint: 'Try a different search or clear the filters.',
              }
        }
      />

      <BulkModals
        kind={openBulk}
        count={selected.size}
        filters={filters}
        pending={pending}
        /* Back to the catalogue rather than closing outright — see customers. */
        onClose={() => {
          setOpenBulk(null)
          setShowOptions(true)
        }}
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
    sortValue: (row) => row.name,
    cell: (row) => (
      <div className="flex items-center gap-2.5">
        <RowTile label={row.name} />
        <div>
          <div className="text-ink">{row.name}</div>
          {row.contactName && <div className="text-xs text-muted">{row.contactName}</div>}
        </div>
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
  // Lead time and product count are detail-screen facts — nobody scans this
  // list for them, and six columns beats eight.
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    // A supplier balance is what WE owe THEM — never styled as a problem.
    // Zeroes recede so the accounts that hold money are the ones that read.
    cell: (row) =>
      row.balance === 0 ? (
        <span className="text-faint">{formatMoney(0)}</span>
      ) : (
        formatMoney(row.balance)
      ),
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
        Back
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
