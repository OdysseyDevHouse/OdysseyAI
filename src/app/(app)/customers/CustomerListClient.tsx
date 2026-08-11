'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  BulkActionBar,
  BulkOptionsDialog,
  Badge,
  Button,
  ButtonLink,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  CurrencyInput,
  RowTile,
  Select,
  useToast,
  type BulkOptionGroup,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { accountTypeLabel } from '@/lib/accountTypes'
import type { Customer, CustomerStatus, BulkChange } from '@/lib/site/customers'
import { bulkUpdateCustomersAction } from './actions'
import { startRunAction } from './statements/actions'

/**
 * The interactive shell around the customers table.
 *
 * The page above is a Server Component: it reads the URL, queries, and hands
 * rows down. Everything here is the part that genuinely needs a client —
 * selection state, the bulk bar and its modals. Filtering, sorting and paging
 * deliberately stay in the URL, so a filtered list is linkable and survives a
 * reload; only the selection, which never needs to, lives in React state.
 */

type Filters = {
  groups: { id: number; name: string }[]
  reps: { id: number; name: string }[]
  categories: string[]
}

/** Which bulk modal is open. */
type BulkKind = BulkChange['kind'] | null

/**
 * What the options dialog can offer: every field change, plus statements —
 * which queues a run rather than changing a field, and so is handled apart.
 */
type OptionKey = BulkChange['kind'] | 'statements'

/**
 * The bulk actions, grouped by what they touch.
 *
 * A dialog rather than buttons in the bar so that customers, suppliers and
 * products all reach their bulk actions the same way — the product list has
 * twenty-odd and could never have fitted them on one strip.
 */
const BULK_OPTIONS: BulkOptionGroup<OptionKey>[] = [
  {
    title: 'Account',
    options: [
      { key: 'status', label: 'Change status', icon: <Icons.Check size={15} />, keywords: 'hold close active' },
      { key: 'terms', label: 'Set payment terms', icon: <Icons.Clock size={15} />, keywords: 'days cod' },
      { key: 'creditLimit', label: 'Set credit limit', icon: <Icons.CreditCard size={15} /> },
    ],
  },
  {
    title: 'Assignment',
    options: [
      { key: 'group', label: 'Assign group', icon: <Icons.Users size={15} /> },
      { key: 'rep', label: 'Assign rep', icon: <Icons.Contact size={15} />, keywords: 'salesperson' },
      { key: 'category', label: 'Set category', icon: <Icons.Tag size={15} /> },
    ],
  },
  {
    title: 'Statements',
    options: [{ key: 'statements', label: 'Email statements', icon: <Icons.Mail size={15} /> }],
  },
]

export default function CustomerListClient({
  rows,
  total,
  search,
  filters,
}: {
  rows: Customer[]
  total: number
  /** The active search term, echoed in the empty state. */
  search?: string
  filters: Filters
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [showOptions, setShowOptions] = useState(false)
  const [openBulk, setOpenBulk] = useState<BulkKind>(null)
  const [recent, setRecent] = useState<OptionKey[]>([])
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const selectedIds = [...selected].map(Number)

  /**
   * Queues statements for the selection and jumps to the run.
   *
   * Sending happens in the background, so this returns as soon as the queue
   * exists — the run screen is where progress and per-account outcomes live.
   */
  function sendStatements() {
    startTransition(async () => {
      const now = new Date()
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

      const result = await startRunAction({
        customerIds: selectedIds,
        periodFrom: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        periodTo: iso(now),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      remember('statements')
      setSelected(new Set())
      router.push(`/customers/statements/${result.runId}`)
    })
  }

  /** Remembers an action, most recent first, for the dialog's top row. */
  function remember(key: OptionKey) {
    setRecent((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 4))
  }

  function runBulk(change: BulkChange) {
    startTransition(async () => {
      const result = await bulkUpdateCustomersAction(selectedIds, change)
      setOpenBulk(null)
      remember(change.kind)

      if (result.updated === 0) {
        // Every row refused for the same reason is the common case — say the
        // reason rather than a bare "0 updated".
        const reason = result.skipped[0]?.reason
        toast.error(reason ? `Nothing updated — ${reason.toLowerCase()}` : 'Nothing was updated.')
        return
      }

      if (result.skipped.length > 0) {
        // Name the refusals: "2 skipped" with no list leaves the user unable to
        // tell whether the two that mattered went through.
        const names = result.skipped
          .filter((s) => s.name)
          .map((s) => s.name)
          .slice(0, 3)
          .join(', ')
        toast.info(
          `${result.updated} updated, ${result.skipped.length} skipped${names ? ` — ${names}` : ''}`,
        )
      } else {
        toast.success(`${result.updated} account${result.updated === 1 ? '' : 's'} updated`)
      }

      setSelected(new Set())
      router.refresh()
    })
  }

  return (
    <>
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
          // Statements are not a field change: they queue a run and navigate,
          // so they never reach the BulkChange modals.
          if (key === 'statements') sendStatements()
          else setOpenBulk(key)
        }}
        groups={BULK_OPTIONS}
        count={selected.size}
        noun="account"
        recent={recent}
      />

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row) => row.id}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        onRowClick={(row) => router.push(`/customers/${row.id}`)}
        actionsOnHover
        actions={(row) => (
          <ButtonLink
            href={`/customers/${row.id}/statement`}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Statement for ${row.name}`}
          >
            <Icons.FileText size={15} />
          </ButtonLink>
        )}
        empty={
          total === 0
            ? {
                title: 'No customers yet',
                hint: 'Create the first account to start selling on credit.',
                action: (
                  <ButtonLink href="/customers/new" variant="secondary" size="sm">
                    <Icons.Plus size={15} />
                    New customer
                  </ButtonLink>
                ),
              }
            : {
                title: 'No customers found',
                hint: search
                  ? `Nothing matches “${search}”. Try a different search or clear the filters.`
                  : 'Try a different search or clear the filters.',
              }
        }
      />

      <BulkModals
        kind={openBulk}
        count={selected.size}
        filters={filters}
        pending={pending}
        /* Back to the catalogue rather than closing outright: picking the wrong
           action is easy, and rebuilding the selection is not. */
        onClose={() => {
          setOpenBulk(null)
          setShowOptions(true)
        }}
        onApply={runBulk}
      />
    </>
  )
}

/* ── Columns ─────────────────────────────────────────────────────────────── */

const STATUS_TONE: Record<CustomerStatus, 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  on_hold: 'danger',
  inactive: 'neutral',
  closed: 'neutral',
}

const COLUMNS: readonly Column<Customer>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    sortValue: (row) => row.code,
    cell: (row) => <span className="text-brand">{row.code}</span>,
  },
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    sortValue: (row) => row.name,
    // Group and rep ride in the subline rather than owning columns of their
    // own — identity stays one glance wide and the table under 8 columns.
    cell: (row) => {
      const meta = [row.contactName, row.groupName, row.repName].filter(Boolean).join(' · ')
      return (
        <div className="flex items-center gap-2.5">
          <RowTile label={row.name} />
          <div className="min-w-0">
            <div className="truncate text-ink">{row.name}</div>
            {meta && <div className="truncate text-xs text-muted">{meta}</div>}
          </div>
        </div>
      )
    },
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
    key: 'limit',
    header: 'Credit limit',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.creditLimit,
    cell: (row) => (row.creditLimit > 0 ? formatMoney(row.creditLimit) : '—'),
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    // Red only when it is actually a problem. Owing money is normal; owing more
    // than the limit allows is not.
    cell: (row) => (
      <span className={row.overLimit ? 'text-danger' : 'text-ink'}>{formatMoney(row.balance)}</span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    sortValue: (row) => row.status,
    cell: (row) => <StatusCell row={row} />,
  },
]

/**
 * The status badge.
 *
 * Over-limit outranks the status itself: an active account that has blown its
 * limit needs attention now, and "Active" would hide that. Cash-only shows
 * alongside, because it explains why an otherwise healthy account cannot buy on
 * credit.
 */
function StatusCell({ row }: { row: Customer }) {
  if (row.status !== 'active') {
    return (
      <span title={row.statusReason ?? undefined}>
        <Badge tone={STATUS_TONE[row.status]}>
          {row.status === 'on_hold' ? 'On hold' : row.status === 'closed' ? 'Closed' : 'Inactive'}
        </Badge>
      </span>
    )
  }
  if (row.overLimit) return <Badge tone="warning">Over limit</Badge>
  // The type is only worth a badge when it changes what the counter can do.
  // An open-item account is the default and needs no label.
  if (row.accountType !== 'open_item') {
    return <Badge tone="neutral">{accountTypeLabel(row.accountType)}</Badge>
  }
  return <Badge tone="success">Active</Badge>
}

/* ── Bulk modals ─────────────────────────────────────────────────────────── */

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
  onApply: (change: BulkChange) => void
}) {
  const [status, setStatus] = useState<CustomerStatus>('on_hold')
  const [reason, setReason] = useState('')
  const [terms, setTerms] = useState(30)
  const [limit, setLimit] = useState(0)
  const [groupId, setGroupId] = useState('')
  const [repId, setRepId] = useState('')
  const [category, setCategory] = useState('')

  const noun = `${count} account${count === 1 ? '' : 's'}`

  const footer = (change: () => BulkChange) => (
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
          <Field label="New status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as CustomerStatus)}>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="inactive">Inactive</option>
              <option value="closed">Closed</option>
            </Select>
          </Field>
          {status !== 'active' && (
            <Field
              label="Reason"
              hint="Shown beside the badge, so staff can see why without opening the audit log."
            >
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Payment overdue 60 days"
              />
            </Field>
          )}
          {status === 'closed' && (
            <p className="text-xs text-muted">
              Accounts with an outstanding balance will be skipped — closing one would hide the debt
              from the age analysis.
            </p>
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
        <Field label="Payment terms (days)" hint="0–365. Zero means cash on delivery.">
          <NumberInput value={terms} onChange={(e) => setTerms(Number(e.target.value) || 0)} />
        </Field>
      </Modal>

      <Modal
        open={kind === 'creditLimit'}
        onClose={onClose}
        title="Set credit limit"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'creditLimit', creditLimit: limit }))}
      >
        <Field label="Credit limit" hint="Zero means no credit granted — not unlimited.">
          <CurrencyInput
            value={limit}
            onChange={(e) => setLimit(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>
      </Modal>

      <Modal
        open={kind === 'group'}
        onClose={onClose}
        title="Assign group"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'group', groupId: groupId ? Number(groupId) : null }))}
      >
        <Field label="Group">
          <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">— No group —</option>
            {filters.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={kind === 'rep'}
        onClose={onClose}
        title="Assign rep"
        description={`Applies to ${noun}.`}
        size="sm"
        footer={footer(() => ({ kind: 'rep', repId: repId ? Number(repId) : null }))}
      >
        <Field label="Sales rep">
          <Select value={repId} onChange={(e) => setRepId(e.target.value)}>
            <option value="">— No rep —</option>
            {filters.reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
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
            list="customer-categories"
            placeholder="e.g. Restaurant"
          />
          <datalist id="customer-categories">
            {filters.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </Modal>
    </>
  )
}
