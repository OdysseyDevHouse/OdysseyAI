'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  useToast,
  type Column,
} from '@/components/ui'
import {
  loadTrainingAction,
  startTrainingAction,
  stopTrainingAction,
  type TrainingState,
} from './actions'

/**
 * The training switch, the count of what is waiting to be removed, and the log
 * of past sessions.
 *
 * ── WHY THE COUNT IS THE POINT ───────────────────────────────────────────
 *
 * Switching training OFF deletes rows and cannot be undone, so the screen shows
 * exactly what will go before it offers the button that does it. A toggle
 * labelled "training mode" with no number beside it asks somebody to trust that
 * the right things will disappear; a list saying "47 sales, 130 stock movements,
 * 94 journal lines" lets them check it against what they remember doing. That is
 * the difference between a confirmation and a formality.
 */

/**
 * Everything the panel needs, already serialised.
 *
 * Dates are ISO strings and nothing here is a Date object — a server component
 * cannot hand a client one without it arriving as something the client has to
 * re-parse anyway, so the conversion happens once, on the server, and the shape
 * this file receives is the shape it renders.
 */
export type TrainingPanelState = {
  summary: {
    active: boolean
    session: { id: number; startedAt: string; startedName: string | null } | null
    pending: { table: string; rows: number }[]
    pendingTotal: number
  }
  history: {
    id: number
    startedAt: string
    endedAt: string | null
    startedName: string | null
    endedName: string | null
    removedTotal: number
  }[]
}

/**
 * Table names are what the database calls things; this is what a shopkeeper
 * calls them. Anything not named here falls back to the raw name with the
 * underscores taken out — a new table appearing in the purge registry then
 * reads awkwardly rather than not at all, which is the right failure.
 */
const FRIENDLY: Record<string, string> = {
  sales_documents: 'Sales, invoices and quotes',
  sales_document_lines: 'Sale lines',
  sales_tenders: 'Payments taken',
  sales_tips: 'Tips',
  document_audit: 'Document history',
  stock_movements: 'Stock movements',
  product_batches: 'Stock batches',
  batch_movements: 'Batch movements',
  serial_movements: 'Serial number movements',
  journal_batches: 'Ledger journals',
  journal_lines: 'Ledger journal lines',
  customer_transactions: 'Customer account entries',
  customer_allocations: 'Customer allocations',
  supplier_transactions: 'Supplier account entries',
  supplier_allocations: 'Supplier allocations',
  purchase_documents: 'Purchase orders and receipts',
  purchase_document_lines: 'Purchase lines',
  loyalty_ledger: 'Loyalty points',
  loyalty_wallet: 'Loyalty balances',
  loyalty_vouchers: 'Loyalty vouchers',
  gift_cards: 'Gift cards',
  gift_card_events: 'Gift card activity',
  stock_adjustments: 'Stock adjustments',
  stock_takes: 'Stock takes',
  stock_transfers: 'Stock transfers',
  manufacturing_orders: 'Manufacturing orders',
  shifts: 'Till shifts',
  shift_counts: 'Cash-up counts',
  bank_transactions: 'Bank entries',
  expenses: 'Expenses',
  job_cards: 'Job cards',
  laybys: 'Lay-bys',
  pos_void_events: 'Till voids',
  pos_tables: 'Restaurant tables',
  activity_log: 'Activity log entries',
  notifications: 'Notifications',
}

function friendly(table: string): string {
  return FRIENDLY[table] ?? table.replace(/_/g, ' ')
}

/** ISO in, "16 Aug 2026, 14:02" out. */
function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TrainingModePanel({ initial }: { initial: TrainingPanelState }) {
  const [state, setState] = useState<TrainingPanelState>(initial)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [pending, startTransition] = useTransition()
  const toast = useToast()

  const { summary, history } = state
  const active = summary.active

  function apply(result: Awaited<ReturnType<typeof loadTrainingAction>>) {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setState(result.state as TrainingPanelState)
    if (result.message) toast.success(result.message)
  }

  function onStart() {
    startTransition(async () => {
      apply(await startTrainingAction())
    })
  }

  function onStop() {
    startTransition(async () => {
      const result = await stopTrainingAction(confirmText)
      if (result.ok) {
        setConfirmOpen(false)
        setConfirmText('')
      }
      apply(result)
    })
  }

  /** Reloads the counts without changing the switch. */
  function onRefresh() {
    startTransition(async () => {
      const result = await loadTrainingAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setState(result.state as TrainingPanelState)
      toast.info('Counts brought up to date.')
    })
  }

  const pendingColumns: Column<{ table: string; rows: number }>[] = [
    {
      key: 'table',
      header: 'What',
      cell: (row) => <span className="text-ink-2">{friendly(row.table)}</span>,
      sortValue: (row) => friendly(row.table),
    },
    {
      key: 'rows',
      header: 'Records',
      numeric: true,
      cell: (row) => row.rows.toLocaleString(),
      sortValue: (row) => row.rows,
    },
  ]

  const historyColumns: Column<TrainingPanelState['history'][number]>[] = [
    {
      key: 'startedAt',
      header: 'Started',
      cell: (row) => (
        <div>
          <div className="text-ink-2">{when(row.startedAt)}</div>
          {row.startedName ? <div className="text-xs text-muted">{row.startedName}</div> : null}
        </div>
      ),
      sortValue: (row) => row.startedAt,
    },
    {
      key: 'endedAt',
      header: 'Ended',
      cell: (row) =>
        row.endedAt === null ? (
          <Badge tone="warning">Still running</Badge>
        ) : (
          <div>
            <div className="text-ink-2">{when(row.endedAt)}</div>
            {row.endedName ? <div className="text-xs text-muted">{row.endedName}</div> : null}
          </div>
        ),
      sortValue: (row) => row.endedAt ?? '',
    },
    {
      key: 'removedTotal',
      header: 'Removed',
      numeric: true,
      cell: (row) => (row.endedAt === null ? '—' : row.removedTotal.toLocaleString()),
      sortValue: (row) => row.removedTotal,
    },
  ]

  return (
    <>
      {/* The state of the world, stated first and unmissably. Everything else on
          the screen is secondary to whether this store is currently pretending. */}
      {active ? (
        <Callout
          tone="warning"
          title="This store is in training mode"
        >
          Nothing rung up now is real. Every sale, payment, stock move and ledger entry made since{' '}
          {when(summary.session?.startedAt ?? null)}
          {summary.session?.startedName ? ` by ${summary.session.startedName}` : ''} is removed when
          training is switched off.
        </Callout>
      ) : (
        <Callout tone="neutral" title="Training mode is off">
          This store is trading normally. Everything rung up is real and is kept.
        </Callout>
      )}

      <Card>
        <CardHeader
          title={active ? 'Finish training' : 'Start training'}
          description={
            active
              ? 'Switching off deletes everything below. It cannot be undone.'
              : 'Switch on to let someone practise on the real system without keeping any of it.'
          }
          action={
            active ? (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={onRefresh} disabled={pending}>
                  <Icons.Refresh size={16} />
                  Refresh
                </Button>
                <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={pending}>
                  Switch off and remove
                </Button>
              </div>
            ) : (
              <Button variant="primary" onClick={onStart} disabled={pending}>
                Switch training on
              </Button>
            )
          }
        />

        <CardBody>
          {!active ? (
            <div className="space-y-3 text-sm text-muted">
              <p>
                While training is on, the whole store is in training — every till and every user.
                That is what makes the clean-up exact: nothing real can be created alongside the
                practice, so there is no risk of removing something that mattered.
              </p>
              <p>
                <span className="font-medium text-ink">What gets removed:</span> sales, payments,
                stock movements, ledger entries, purchase orders, cash-ups and everything else
                posted during the session. Stock levels and document numbers are put back where they
                were.
              </p>
              <p>
                <span className="font-medium text-ink">What is kept:</span> products, customers,
                suppliers and other master data added while practising. Those are often worth
                keeping, and deleting a product a real sale points at is not possible anyway — tidy
                any practice ones up by hand afterwards.
              </p>
            </div>
          ) : summary.pending.length === 0 ? (
            <div className="text-sm text-muted">
              Nothing has been posted since training started, so there is nothing to remove yet.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-muted">
                <span className="numeric font-medium text-ink">
                  {summary.pendingTotal.toLocaleString()}
                </span>{' '}
                {summary.pendingTotal === 1 ? 'record' : 'records'} will be deleted when training is
                switched off.
              </div>
              <DataTable
                columns={pendingColumns}
                rows={summary.pending}
                getRowKey={(row) => row.table}
                empty={{
                  title: 'Nothing posted yet',
                  hint: 'Anything rung up during training appears here.',
                }}
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Past sessions"
          description="Kept on purpose — the record of who practised and what was cleared away."
        />
        <CardBody>
          <DataTable
            columns={historyColumns}
            rows={history}
            getRowKey={(row) => row.id}
            empty={{
              title: 'No training sessions yet',
              hint: 'Switch training on to run the first one.',
            }}
          />
        </CardBody>
      </Card>

      <Modal
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false)
          setConfirmText('')
        }}
        title="Remove all training data?"
        description="This cannot be undone."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmOpen(false)
                setConfirmText('')
              }}
              disabled={pending}
            >
              Keep training
            </Button>
            {/* Deliberately not disabled on the text — the action re-checks it
                and says what is wrong, which teaches more than a dead button. */}
            <Button variant="danger" onClick={onStop} disabled={pending}>
              {pending ? 'Removing…' : 'Remove and switch off'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            <span className="numeric font-medium">{summary.pendingTotal.toLocaleString()}</span>{' '}
            {summary.pendingTotal === 1 ? 'record' : 'records'} created during this training session
            will be permanently deleted. Stock levels and document numbers are put back to where
            they were when training started.
          </p>
          <Field label="Type REMOVE to confirm">
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="REMOVE"
              autoFocus
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
