'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  TableToolbar,
  ToolbarSearch,
  SegmentedControl,
  Badge,
  EmptyState,
  Callout,
  useToast,
  Icons,
  type Column,
  type BadgeTone,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { runExpiryAction } from './actions'

export type MemberRowView = {
  customerId: number
  code: string
  name: string
  phone: string
  points: number
  pointsValue: number
  walletBalance: number
  tierName: string
  tierColor: string
  qualifyingSpend: number
  vouchersReady: number
  lastActivity: string
}

/**
 * A tier's badge tone.
 *
 * The stored colour is a TOKEN NAME, not a hex value, so the ladder restyles
 * with the rest of the app. Anything unrecognised falls back to neutral rather
 * than crashing a list because someone typed a colour by hand.
 */
function tierTone(color: string): BadgeTone {
  const tones: Record<string, BadgeTone> = {
    brand: 'brand',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
    info: 'brand',
    muted: 'neutral',
  }
  return tones[color] ?? 'neutral'
}

export function MembersClient({
  rows,
  truncated,
  canAdjust,
  tierNames,
}: {
  rows: MemberRowView[]
  truncated: boolean
  canAdjust: boolean
  tierNames: string[]
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState('all')

  // Filtered in the browser: the server already capped the list, so this is a
  // narrowing of what is on screen rather than a second query per keystroke.
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (tier !== 'all' && row.tierName !== tier) return false
      if (!term) return true
      return (
        row.name.toLowerCase().includes(term) ||
        row.code.toLowerCase().includes(term) ||
        row.phone.toLowerCase().includes(term)
      )
    })
  }, [rows, search, tier])

  const columns: Column<MemberRowView>[] = [
    {
      key: 'name',
      header: 'Customer',
      cell: (row) => (
        <div>
          <Link href={`/customers/${row.customerId}`} className="font-medium text-ink hover:underline">
            {row.name}
          </Link>
          <div className="text-xs text-muted">
            {row.code}
            {row.phone ? ` · ${row.phone}` : ''}
          </div>
        </div>
      ),
      sortValue: (row) => row.name,
    },
    {
      key: 'tier',
      header: 'Tier',
      cell: (row) =>
        row.tierName ? <Badge tone={tierTone(row.tierColor)}>{row.tierName}</Badge> : <span className="text-faint">—</span>,
      sortValue: (row) => row.tierName,
    },
    {
      key: 'points',
      header: 'Points',
      numeric: true,
      cell: (row) => Math.floor(row.points).toLocaleString(),
      sortValue: (row) => row.points,
    },
    {
      key: 'worth',
      header: 'Worth',
      numeric: true,
      cell: (row) => formatMoney(row.pointsValue),
      sortValue: (row) => row.pointsValue,
    },
    {
      key: 'wallet',
      header: 'Wallet',
      numeric: true,
      cell: (row) =>
        row.walletBalance > 0 ? formatMoney(row.walletBalance) : <span className="text-faint">—</span>,
      sortValue: (row) => row.walletBalance,
    },
    {
      key: 'spend',
      header: 'Qualifying spend',
      numeric: true,
      cell: (row) => formatMoney(row.qualifyingSpend),
      sortValue: (row) => row.qualifyingSpend,
    },
    {
      key: 'vouchers',
      header: 'Rewards',
      numeric: true,
      cell: (row) =>
        row.vouchersReady > 0 ? (
          <Badge tone="success">{row.vouchersReady} ready</Badge>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (row) => row.vouchersReady,
    },
    {
      key: 'seen',
      header: 'Last seen',
      cell: (row) => row.lastActivity || <span className="text-faint">—</span>,
      sortValue: (row) => row.lastActivity,
    },
  ]

  function runExpiry() {
    start(async () => {
      const result = await runExpiryAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <Card>
      <CardHeader
        title="Members"
        description="Everyone earning on the programme, and what they are holding."
        action={
          canAdjust ? (
            <Button variant="secondary" size="sm" onClick={runExpiry} disabled={pending}>
              {pending ? 'Running…' : 'Run expiry'}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Icons.Gem />}
            title="Nobody has earned yet"
            hint="Members appear here the first time a customer earns points on a sale. Attach a customer at the till to start."
          />
        ) : (
          <>
            <TableToolbar
              actions={
                <>
                  <ToolbarSearch
                    value={search}
                    onChange={setSearch}
                    placeholder="Name, code or phone…"
                  />
                  {tierNames.length > 0 && (
                    <SegmentedControl
                      value={tier}
                      onChange={setTier}
                      options={[
                        { value: 'all', label: 'All' },
                        ...tierNames.map((name) => ({ value: name, label: name })),
                      ]}
                    />
                  )}
                </>
              }
            />
            <DataTable
              columns={columns}
              rows={visible}
              getRowKey={(row) => row.customerId}
              empty={{ title: 'No members match', hint: 'Try a different search or tier.' }}
            />
            {truncated && (
              <Callout tone="brand" className="mt-3">
                Showing the first {rows.length} members by balance. Search to find someone further
                down, or run the members report for the full list.
              </Callout>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
