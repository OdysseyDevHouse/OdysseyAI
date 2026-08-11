'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Card,
  DataTable,
  SegmentedControl,
  TableToolbar,
  ToolbarSearch,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { CONTRACT_STATE_LABELS, type ContractState } from '@/lib/contractModel'

/**
 * The contracts list.
 *
 * A Client Component because a Column array carries cell functions, which
 * cannot cross the server boundary — a server page passing `columns` crashes at
 * request time while the build and tsc stay green.
 */

export type ContractRow = {
  id: number
  contractNumber: string | null
  name: string
  customerId: number
  customerName: string | null
  frequencyLabel: string
  billingDay: number
  state: ContractState
  nextDue: string | null
  due: boolean
  totalIncl: number
  endsOn: string | null
  autoSend: boolean
  escalationPct: number
}

type Slice = 'all' | 'active' | 'due' | 'ended'

const STATE_TONE: Record<ContractState, 'default' | 'success' | 'warning' | 'danger'> = {
  active: 'success',
  scheduled: 'default',
  draft: 'default',
  paused: 'warning',
  ended: 'default',
}

export function ContractsTable({ contracts }: { contracts: ContractRow[] }) {
  const router = useRouter()
  const [slice, setSlice] = useState<Slice>('all')
  const [search, setSearch] = useState('')

  const term = search.trim().toLowerCase()
  const rows = contracts.filter((c) => {
    if (slice === 'active' && c.state !== 'active') return false
    if (slice === 'due' && !c.due) return false
    if (slice === 'ended' && c.state !== 'ended' && c.state !== 'paused') return false
    if (!term) return true
    return (
      c.name.toLowerCase().includes(term) ||
      (c.customerName ?? '').toLowerCase().includes(term) ||
      (c.contractNumber ?? '').toLowerCase().includes(term)
    )
  })

  const columns: Column<ContractRow>[] = [
    {
      key: 'name',
      header: 'Contract',
      cell: (c) => (
        <>
          <span className={c.state === 'ended' || c.state === 'paused' ? 'text-muted' : 'text-ink'}>
            {c.name}
          </span>
          <span className="mt-0.5 block text-xs text-muted">
            {c.contractNumber ? `${c.contractNumber} · ` : ''}
            {c.customerName ?? 'no customer'}
          </span>
        </>
      ),
      sortValue: (c) => c.name,
    },
    {
      key: 'schedule',
      header: 'Billing',
      cell: (c) => (
        <>
          <span className="text-ink-2">{c.frequencyLabel.toLowerCase()}</span>
          <span className="mt-0.5 block text-xs text-muted">
            on day {c.billingDay}
            {c.escalationPct > 0 ? ` · +${trim(c.escalationPct)}% a year` : ''}
          </span>
        </>
      ),
      sortValue: (c) => c.billingDay,
    },
    {
      key: 'state',
      header: 'Status',
      cell: (c) =>
        // "Due" is the exception worth seeing — it outranks the plain state,
        // because a due contract is the only row anyone needs to act on.
        c.due ? (
          <Badge tone="warning">Due to bill</Badge>
        ) : (
          <Badge tone={STATE_TONE[c.state]}>{CONTRACT_STATE_LABELS[c.state]}</Badge>
        ),
      // Due first, then live, then everything finished.
      sortValue: (c) => (c.due ? 0 : c.state === 'active' ? 1 : 2),
    },
    {
      key: 'sending',
      header: 'Sending',
      cell: (c) =>
        c.autoSend ? (
          <Badge tone="success">Automatic</Badge>
        ) : (
          <span className="text-xs text-muted">Review first</span>
        ),
      sortValue: (c) => (c.autoSend ? 0 : 1),
    },
    {
      key: 'next',
      header: 'Next invoice',
      cell: (c) =>
        c.nextDue ? (
          <>
            <span className="text-ink-2">{c.nextDue}</span>
            {c.endsOn ? (
              <span className="mt-0.5 block text-xs text-muted">ends {c.endsOn}</span>
            ) : null}
          </>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (c) => c.nextDue ?? '',
    },
    {
      key: 'value',
      header: 'Per invoice',
      numeric: true,
      cell: (c) => <span className="text-ink">{formatMoney(c.totalIncl)}</span>,
      sortValue: (c) => c.totalIncl,
    },
  ]

  return (
    <Card>
      <TableToolbar
        inCard
        actions={
          <>
            <SegmentedControl<Slice>
              value={slice}
              onChange={setSlice}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'due', label: 'Due' },
                { value: 'ended', label: 'Paused & ended' },
              ]}
            />
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Search contracts…"
            />
          </>
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(c) => c.id}
        onRowClick={(c) => router.push(`/sales/contracts/${c.id}`)}
        empty={{
          title: term ? `Nothing matches “${search.trim()}”` : 'No contracts in this view',
          hint: term
            ? 'Try a different name, customer or contract number.'
            : 'Switch to All to see every contract.',
        }}
      />
    </Card>
  )
}

/** 8 rather than 8.000 — a percentage reads as a number, not a measurement. */
function trim(value: number): string {
  return String(Number(value.toFixed(3)))
}
