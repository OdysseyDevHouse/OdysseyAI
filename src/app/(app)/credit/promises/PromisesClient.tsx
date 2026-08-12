'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Callout,
  Badge,
  DataTable,
  EmptyState,
  Icons,
  StatStrip,
  StatTile,
  Modal,
  Field,
  CurrencyInput,
  SegmentedControl,
  TableToolbar,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { PROMISE_LABELS, type PromiseStatus, type PromiseState } from '@/lib/creditModel'
import { resolvePromiseAction, sweepPromisesAction } from '../actions'

export type PromiseRow = {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  promisedDate: string
  promisedAmount: number
  receivedAmount: number
  balanceAtPromise: number
  status: PromiseStatus
  state: PromiseState
  promisedBy: string | null
  notes: string | null
  userName: string
}

const STATE_LABEL: Record<PromiseState, string> = {
  ...PROMISE_LABELS,
  'due-today': 'Due now',
  overdue: 'Overdue',
}

export function PromisesClient({ promises }: { promises: PromiseRow[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [tab, setTab] = useState<'open' | 'history'>('open')
  const [settling, setSettling] = useState<PromiseRow | null>(null)
  const [received, setReceived] = useState('')

  const open = useMemo(() => promises.filter((p) => p.status === 'open'), [promises])
  const history = useMemo(() => promises.filter((p) => p.status !== 'open'), [promises])
  const broken = useMemo(() => open.filter((p) => p.state === 'broken'), [open])
  const dueNow = useMemo(() => open.filter((p) => p.state === 'due-today'), [open])

  const keptCount = history.filter((p) => p.status === 'kept').length
  const brokenCount = history.filter((p) => p.status === 'broken').length
  const decided = keptCount + brokenCount

  function resolve(id: number, outcome: 'kept' | 'broken' | 'cancelled', amount?: number) {
    start(async () => {
      const result = await resolvePromiseAction(id, outcome, amount)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      setSettling(null)
      setReceived('')
      router.refresh()
    })
  }

  function sweep() {
    start(async () => {
      const result = await sweepPromisesAction()
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      router.refresh()
    })
  }

  const columns: Column<PromiseRow>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (p) => (
        <Link href={`/customers/${p.customerId}`} className="block hover:text-brand">
          <span className="text-ink">{p.customerName}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {p.promisedBy ? `via ${p.promisedBy}` : p.customerCode}
          </span>
        </Link>
      ),
      sortValue: (p) => p.customerName,
    },
    {
      key: 'date',
      header: 'Promised for',
      cell: (p) => (
        <span className={p.state === 'broken' ? 'text-danger' : 'text-ink-2'}>
          {p.promisedDate}
        </span>
      ),
      sortValue: (p) => p.promisedDate,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (p) => (
        <>
          <span className="text-ink">{formatMoney(p.promisedAmount)}</span>
          {/* A part payment is neither kept nor simply broken — say so. */}
          {p.receivedAmount > 0 && p.receivedAmount < p.promisedAmount && (
            <span className="mt-0.5 block text-xs text-warning-ink">
              {formatMoney(p.receivedAmount)} received
            </span>
          )}
        </>
      ),
      sortValue: (p) => p.promisedAmount,
    },
    {
      key: 'context',
      header: 'Owed then',
      numeric: true,
      // Without this, a promise of 5 000 against a 5 000 balance and the same
      // promise against 50 000 read identically a month later.
      cell: (p) => <span className="text-muted">{formatMoney(p.balanceAtPromise)}</span>,
      sortValue: (p) => p.balanceAtPromise,
    },
    {
      key: 'state',
      header: 'State',
      cell: (p) => (
        <Badge
          dot
          tone={
            p.state === 'broken'
              ? 'danger'
              : p.state === 'kept'
                ? 'success'
                : p.state === 'due-today'
                  ? 'warning'
                  : p.state === 'cancelled'
                    ? 'default'
                    : 'brand'
          }
        >
          {STATE_LABEL[p.state]}
        </Badge>
      ),
      sortValue: (p) => p.state,
    },
  ]

  return (
    <>
      {broken.length > 0 && (
        <Callout
          tone="danger"
          title={`${broken.length} promise${broken.length === 1 ? '' : 's'} past their date`}
        >
          These were promised and have not arrived. Settling them keeps the account history
          honest — and a broken promise is the strongest signal an account has gone bad.
        </Callout>
      )}

      {/* StatStrip rather than a hand-rolled grid, so this strip keeps the
          same gutters and breakpoints as every other one in the app. */}
      <StatStrip columns={4}>
        <StatTile
          label="Open"
          value={String(open.length)}
          hint={formatMoney(open.reduce((sum, p) => sum + p.promisedAmount, 0))}
          icon={<Icons.Wallet size={20} />}
        />
        <StatTile
          label="Due now"
          value={String(dueNow.length)}
          tone={dueNow.length > 0 ? 'warning' : 'default'}
          hint={dueNow.length > 0 ? 'check the bank first' : 'nothing due today'}
          icon={<Icons.Clock size={20} />}
        />
        <StatTile
          label="Broken"
          value={String(broken.length)}
          tone={broken.length > 0 ? 'danger' : 'default'}
          hint={broken.length > 0 ? 'needs settling' : 'none outstanding'}
          icon={<Icons.StatusFailure size={20} />}
        />
        {/* The record, not an opinion: the counts sit beside the rate so a
            perfect score over one promise cannot be mistaken for a long one. */}
        <StatTile
          label="Kept overall"
          value={decided === 0 ? '—' : `${Math.round((keptCount / decided) * 100)}%`}
          tone={decided === 0 ? 'default' : keptCount / decided >= 0.8 ? 'positive' : 'warning'}
          hint={decided === 0 ? 'no promises settled yet' : `${keptCount} of ${decided} settled`}
          icon={<Icons.StatusSuccess size={20} />}
        />
      </StatStrip>

      <Card>
        <CardHeader
          title="Promises"
          description="A promise pauses the automated chasing until its date, then becomes visible when it is broken."
          action={
            broken.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={sweep} disabled={pending}>
                Mark {broken.length} broken
              </Button>
            ) : undefined
          }
        />

        {/* A segmented control, not Tabs: these slice ONE list of promises by
            whether they are still live, which is what the segmented bar means.
            The counts move into the count pills, which is what they are for. */}
        <TableToolbar inCard>
          <SegmentedControl
            aria-label="Promise state"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'open' as const,
                label: 'Open',
                count: open.length || undefined,
                icon: <Icons.Clock size={15} />,
              },
              {
                value: 'history' as const,
                label: 'History',
                count: history.length || undefined,
                icon: <Icons.StatusSuccess size={15} />,
              },
            ]}
          />
        </TableToolbar>

        {tab === 'open' ? (
          open.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No open promises"
                hint="Record one from a customer's account when they commit to a date. It stops the reminders until then."
              />
            </CardBody>
          ) : (
            <DataTable
              columns={columns}
              rows={open}
              getRowKey={(p) => p.id}
              actions={(p) => (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSettling(p)
                      setReceived(String(p.promisedAmount))
                    }}
                    disabled={pending}
                  >
                    Settle
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    onClick={() => resolve(p.id, 'cancelled')}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                </div>
              )}
              empty={{ title: 'No open promises', hint: '' }}
            />
          )
        ) : history.length === 0 ? (
          <CardBody>
            <EmptyState title="No history yet" hint="Settled promises appear here." />
          </CardBody>
        ) : (
          <DataTable
            columns={columns}
            rows={history}
            getRowKey={(p) => p.id}
            empty={{ title: 'No history', hint: '' }}
          />
        )}
      </Card>

      <Modal
        open={settling !== null}
        onClose={() => setSettling(null)}
        title={`Settle ${settling?.customerName ?? ''}`}
        size="sm"
        footer={
          <>
            <Button
              variant="danger"
              onClick={() => settling && resolve(settling.id, 'broken', Number(received) || 0)}
              disabled={pending}
            >
              Broken
            </Button>
            <Button
              onClick={() => settling && resolve(settling.id, 'kept', Number(received) || 0)}
              disabled={pending}
            >
              Kept
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted">
          {settling &&
            `Promised ${formatMoney(settling.promisedAmount)} by ${settling.promisedDate}.`}
        </p>
        <Field
          label="Received"
          hint="What actually arrived against this promise. A part payment is still a broken promise — the record is only useful if it is honest."
        >
          <CurrencyInput
            value={received}
            onChange={(e) => setReceived(e.target.value)}
            autoFocus
          />
        </Field>
      </Modal>
    </>
  )
}
