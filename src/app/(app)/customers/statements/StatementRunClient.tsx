'use client'

import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  BulkActionBar,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  Icons,
  PageBody,
  PageHeader,
  RowTile,
  Select,
  Switch,
  TableToolbar,
  useToast,
  type Column,
} from '@/components/ui'
import { Callout, DateRangeField, Input } from '@/components/ui'
import { CYCLE_LABELS, type StatementCycle } from '@/lib/statementCycles'
import { formatMoney } from '@/lib/decimals'
import { startRunAction } from './actions'

/**
 * Choosing who gets a statement.
 *
 * Selection uses the DataTable's controlled API — the same one the customers
 * list uses — so the behaviour is identical: shift-click ranges, a live count,
 * and accounts that cannot be sent to greyed rather than hidden.
 *
 * Hiding them would answer "who is getting one" while quietly leaving out the
 * accounts someone most needs to notice.
 *
 * This component owns the whole screen — header included — because the one
 * primary action, Send, reads the selection, and only a client component can.
 * The server page hands the rest of the screen in as `notice` and `children`.
 */

type Candidate = {
  id: number
  code: string
  name: string
  email: string | null
  balance: number
  cycle: StatementCycle
}

export default function StatementRunClient({
  candidates,
  mailReady,
  subtitle,
  notice,
  children,
}: {
  candidates: Candidate[]
  mailReady: boolean
  subtitle: string
  /** The mail-not-ready callout, server-rendered. */
  notice?: ReactNode
  /** Rendered below the send card — the recent-runs card. */
  children?: ReactNode
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [owingOnly, setOwingOnly] = useState(true)
  const [format, setFormat] = useState<'open-item' | 'activity'>('open-item')
  const [period, setPeriod] = useState(defaultPeriod())
  const [periodMode, setPeriodMode] = useState<'cycle' | 'fixed'>('cycle')
  // In cycle mode the operator supplies one date — "statements up to" — and each
  // account contributes its own period containing it.
  const [upTo, setUpTo] = useState(() => defaultPeriod().to)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const rows = useMemo(
    () => (owingOnly ? candidates.filter((c) => c.balance !== 0) : candidates),
    [candidates, owingOnly],
  )

  const chosen = rows.filter((r) => selected.has(String(r.id)))
  const sendable = chosen.filter((c) => c.email && c.balance !== 0)
  const skipped = chosen.length - sendable.length

  // Which cycles the sendable selection spans, biggest group first.
  const cycleMix = useMemo(() => {
    const counts = new Map<StatementCycle, number>()
    for (const c of sendable) counts.set(c.cycle, (counts.get(c.cycle) ?? 0) + 1)
    return [...counts.entries()]
      .map(([cycle, count]) => ({ cycle, count }))
      .sort((a, b) => b.count - a.count)
  }, [sendable])

  function selectAllSendable() {
    setSelected(new Set(rows.filter((r) => r.email && r.balance !== 0).map((r) => String(r.id))))
  }

  function send() {
    startTransition(async () => {
      const result = await startRunAction({
        customerIds: chosen.map((c) => c.id),
        // In cycle mode the run's own dates are only the reference window the
        // screen shows; each item carries the period actually used.
        periodFrom: periodMode === 'cycle' ? upTo : period.from,
        periodTo: periodMode === 'cycle' ? upTo : period.to,
        format,
        periodMode,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setSelected(new Set())
      router.push(`/customers/statements/${result.runId}`)
    })
  }

  return (
    <>
      <PageHeader
        title="Statements"
        subtitle={subtitle}
        action={
          <Button
            variant="primary"
            disabled={sendable.length === 0 || pending || !mailReady}
            onClick={send}
          >
            <Icons.Send size={15} />
            {pending
              ? 'Queueing…'
              : `Send ${sendable.length || ''} statement${sendable.length === 1 ? '' : 's'}`}
          </Button>
        }
      />

      <PageBody>
        {notice}

        <Card>
          <CardHeader
            title="Send statements"
            description="Queued and sent in the background — you can leave this screen."
            action={
              <Button variant="ghost" size="sm" onClick={selectAllSendable} disabled={pending}>
                <Icons.Check size={15} />
                Select all sendable
              </Button>
            }
          />

          <CardBody className="flex flex-col gap-4 border-b border-border">
            <TableToolbar>
              <Field
                label="Period"
                hint={
                  periodMode === 'cycle'
                    ? 'Each account gets its own period containing this date.'
                    : 'The same dates for every account, whatever their cycle.'
                }
                className="w-56"
              >
                <Select
                  value={periodMode}
                  onChange={(e) => setPeriodMode(e.target.value as typeof periodMode)}
                >
                  <option value="cycle">Each account&rsquo;s own cycle</option>
                  <option value="fixed">One fixed period for everyone</option>
                </Select>
              </Field>

              {periodMode === 'cycle' ? (
                <Field label="Statements up to" className="w-44">
                  <Input type="date" value={upTo} onChange={(e) => setUpTo(e.target.value)} />
                </Field>
              ) : (
                <DateRangeField value={period} onChange={setPeriod} label="Dates" />
              )}
              <Field
                label="Format"
                hint="Open items is what a customer needs in order to pay."
                className="w-48"
              >
                <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                  <option value="open-item">Open items</option>
                  <option value="activity">Full activity</option>
                </Select>
              </Field>
              <Switch
                checked={owingOnly}
                onChange={setOwingOnly}
                label="Only accounts with a balance"
                hint="A statement saying nothing is owed is inbox noise."
              />
            </TableToolbar>

            {/* Only worth saying when the selection actually spans cycles —
                otherwise it is a notice about nothing. */}
            {periodMode === 'cycle' && cycleMix.length > 1 && (
              <Callout tone="neutral" title="These accounts are on different cycles">
                {cycleMix.map((m) => `${m.count} ${CYCLE_LABELS[m.cycle].toLowerCase()}`).join(', ')}
                {' — each gets its own period containing '}
                {upTo}.
              </Callout>
            )}
          </CardBody>

          <BulkActionBar count={chosen.length} onClear={() => setSelected(new Set())}>
            {skipped > 0 && (
              /* Named up front rather than discovered afterwards in the run. */
              <span className="text-sm text-muted">
                {skipped} will be skipped — no email, or nothing owed
              </span>
            )}
          </BulkActionBar>

          <DataTable
            columns={COLUMNS}
            rows={rows}
            getRowKey={(row) => row.id}
            selectedKeys={selected}
            onSelectionChange={setSelected}
            // Greyed rather than hidden: an account nobody can send to is exactly
            // the one someone needs to notice.
            isRowSelectable={(row) => Boolean(row.email) && row.balance !== 0}
            empty={{
              title: owingOnly ? 'No account has a balance' : 'No accounts',
              hint: owingOnly ? 'Turn off the filter to see everyone.' : undefined,
            }}
          />
        </Card>

        {children}
      </PageBody>
    </>
  )
}

const COLUMNS: readonly Column<Candidate>[] = [
  { key: 'code', header: 'Code', sortable: true, cell: (row) => row.code },
  {
    key: 'name',
    header: 'Account',
    sortable: true,
    sortValue: (row) => row.name,
    cell: (row) => (
      <div className="flex items-center gap-2.5">
        <RowTile label={row.name} />
        <span className="truncate text-ink">{row.name}</span>
      </div>
    ),
  },
  {
    key: 'email',
    header: 'Email',
    sortable: true,
    sortValue: (row) => row.email ?? '',
    cell: (row) =>
      row.email ? (
        <span className="text-ink-2">{row.email}</span>
      ) : (
        <Badge tone="warning">No email</Badge>
      ),
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    cell: (row) =>
      row.balance === 0 ? (
        <span className="text-faint">{formatMoney(0)}</span>
      ) : (
        <span className="text-ink">{formatMoney(row.balance)}</span>
      ),
  },
]

/** Last month to date — the period a month-end statement run covers. */
function defaultPeriod() {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(now) }
}
