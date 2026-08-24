'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  TableToolbar,
  ToolbarSearch,
  SegmentedControl,
  Badge,
  EmptyState,
  Callout,
  Modal,
  Field,
  Input,
  useToast,
  Icons,
  type Column,
  type BadgeTone,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { runExpiryAction, enrolMemberAction } from './actions'

export type MemberRowView = {
  memberId: number
  /**
   * The debtors account this member is linked to, if any.
   *
   * Null is ordinary, not exceptional — a walk-in member never had one. It is
   * what stops the name below being a link to a customer that does not exist.
   */
  customerId: number | null
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
  const router = useRouter()

  // The join form. Only `name` is required — see enrol().
  const [joining, setJoining] = useState(false)
  const [joinName, setJoinName] = useState('')
  const [joinPhone, setJoinPhone] = useState('')
  const [joinEmail, setJoinEmail] = useState('')
  const [joinNumber, setJoinNumber] = useState('')

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
      header: 'Member',
      cell: (row) => (
        <div>
          {/* A link only where there is somewhere to go. A walk-in member has
              no debtors account, and a name that looks clickable but is not is
              worse than plain text. */}
          {row.customerId ? (
            <Link
              href={`/customers/${row.customerId}`}
              className="font-medium text-ink hover:underline"
            >
              {row.name}
            </Link>
          ) : (
            <span className="font-medium text-ink">{row.name}</span>
          )}
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

  /*
   * Joining, in as few fields as it can be done in.
   *
   * A name is the only required one — the plan asks for enrolment at the till
   * in under ten seconds from a cell number, and every field this insisted on
   * would be a queue getting longer. The member number is left blank unless a
   * pre-printed card is being handed over, in which case it is typed and taken
   * as given.
   */
  function enrol() {
    const trimmed = joinName.trim()
    if (!trimmed) {
      toast.error('Give the member a name.')
      return
    }
    start(async () => {
      const result = await enrolMemberAction({
        name: trimmed,
        phone: joinPhone.trim() || undefined,
        email: joinEmail.trim() || undefined,
        memberNumber: joinNumber.trim() || undefined,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setJoining(false)
      setJoinName('')
      setJoinPhone('')
      setJoinEmail('')
      setJoinNumber('')
      router.refresh()
    })
  }

  const joinButton = canAdjust ? (
    <Button size="sm" onClick={() => setJoining(true)}>
      <Icons.Plus size={16} />
      Add member
    </Button>
  ) : undefined

  return (
    <>
    <Card>
      <CardHeader
        title="Members"
        description="Everyone earning on the programme, and what they are holding."
        action={
          canAdjust ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={runExpiry} disabled={pending}>
                {pending ? 'Running…' : 'Run expiry'}
              </Button>
              {joinButton}
            </div>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        /* Joining is now a deliberate act, so the empty state offers it.
           It used to say members appear "the first time a customer earns" —
           true when membership was a side effect of being a customer, and
           now a dead end: nobody would ever appear.

           No CardBody around any of this: EmptyState brings its own px-6 py-16,
           and DataTable is a full-bleed table whose cells are the gutter. A
           wrapper padding both of them inset the table a second time. */
        <EmptyState
          icon={<Icons.Gem />}
          title="Nobody has joined yet"
          hint="A member does not need a customer account — a name and a cell number is enough. Add the first one, or enrol somebody at the till."
          action={joinButton}
        />
      ) : (
        <>
          {/* Search and tier are CHILDREN, not `actions` — they narrow the
              list. As actions they fell under the toolbar's `ml-auto` and were
              pinned to the right edge, reading as buttons rather than filters.
              `inCard` is what gives the band the card gutter and its rule; its
              px-4 matches TABLE_TD, so the search box lines up with the Member
              column heading beneath it. */}
          <TableToolbar inCard>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Name, code or phone…"
              aria-label="Search members"
            />
            {tierNames.length > 0 && (
              <SegmentedControl
                aria-label="Which tier"
                value={tier}
                onChange={setTier}
                options={[
                  { value: 'all', label: 'All' },
                  ...tierNames.map((name) => ({ value: name, label: name })),
                ]}
              />
            )}
          </TableToolbar>
          <DataTable
            columns={columns}
            rows={visible}
            getRowKey={(row) => row.memberId}
            empty={{ title: 'No members match', hint: 'Try a different search or tier.' }}
          />
          {truncated && (
            /* The table is full-bleed, so the note takes the card gutter
               itself rather than inheriting one from a wrapper. */
            <div className="px-4 pb-4">
              <Callout tone="brand">
                Showing the first {rows.length} members by balance. Search to find someone further
                down, or run the members report for the full list.
              </Callout>
            </div>
          )}
        </>
      )}
    </Card>

    <Modal open={joining} onClose={() => setJoining(false)} title="Add a member">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          A member does not need a customer account. A name is enough to start earning; a
          cell number is what lets a cashier find them again without a card.
        </p>

        <Field label="Name" hint="Shown on the till and on their statement of points.">
          <Input
            value={joinName}
            onChange={(e) => setJoinName(e.target.value)}
            maxLength={160}
            placeholder="Jane Mokoena"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cell number" hint="Optional, but it is how they are found.">
            <Input
              value={joinPhone}
              onChange={(e) => setJoinPhone(e.target.value)}
              maxLength={40}
              placeholder="082 123 4567"
            />
          </Field>
          <Field label="Email" hint="Optional.">
            <Input
              type="email"
              value={joinEmail}
              onChange={(e) => setJoinEmail(e.target.value)}
              maxLength={190}
            />
          </Field>
        </div>

        <Field
          label="Card number"
          hint="Leave blank and one is allocated. Type it only when handing over a pre-printed card."
        >
          <Input
            value={joinNumber}
            onChange={(e) => setJoinNumber(e.target.value)}
            maxLength={60}
            placeholder="Allocated automatically"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setJoining(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={enrol} disabled={pending}>
            {pending ? 'Joining…' : 'Add member'}
          </Button>
        </div>
      </div>
    </Modal>
    </>
  )
}
