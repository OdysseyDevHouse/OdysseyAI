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
  StatTile,
  Modal,
  ConfirmModal,
  Field,
  Input,
  Tabs,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { releaseRunAction, cancelRunAction, excludeItemAction } from '../../actions'

export type ReviewItem = {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  email: string | null
  phone: string | null
  levelStep: number
  levelName: string
  overdueAmount: number
  totalBalance: number
  oldestDays: number
  status: 'queued' | 'sent' | 'failed' | 'skipped' | 'excluded'
  error: string | null
  smsStatus: 'none' | 'sent' | 'failed' | 'skipped'
  smsError: string | null
  sentAtDate: string | null
}

type Run = {
  id: number
  asAt: string
  status: 'draft' | 'sending' | 'completed' | 'cancelled'
  totalCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  userName: string
  sentByName: string | null
}

const STATUS_TONE = {
  queued: 'brand',
  sent: 'success',
  failed: 'danger',
  skipped: 'default',
  excluded: 'warning',
} as const

const STATUS_LABEL = {
  queued: 'Will send',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  excluded: 'Removed',
} as const

/**
 * The review, and the release.
 *
 * ── THE SKIPPED LIST IS NOT A FOOTNOTE ───────────────────────────────────
 *
 * It gets its own tab and equal weight, because the most common way this
 * module fails silently is chasing nobody. A run that queues 3 letters when
 * yesterday it queued 40 has usually gone wrong in the ladder, and the only
 * place that is visible is the list of accounts it decided to leave alone,
 * each carrying its reason.
 */
export function RunReview({
  run,
  items,
  canRelease,
}: {
  run: Run
  items: ReviewItem[]
  canRelease: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [excluding, setExcluding] = useState<ReviewItem | null>(null)
  const [excludeReason, setExcludeReason] = useState('')
  const [tab, setTab] = useState<'sending' | 'skipped'>('sending')

  const sending = useMemo(
    () => items.filter((i) => i.status === 'queued' || i.status === 'sent' || i.status === 'failed'),
    [items],
  )
  const skipped = useMemo(
    () => items.filter((i) => i.status === 'skipped' || i.status === 'excluded'),
    [items],
  )
  const queued = useMemo(() => items.filter((i) => i.status === 'queued'), [items])

  const isDraft = run.status === 'draft'
  const queuedValue = queued.reduce((sum, i) => sum + i.overdueAmount, 0)
  const willBlock = queued.filter((i) => i.levelStep >= 3).length

  function release() {
    setConfirmRelease(false)
    start(async () => {
      const result = await releaseRunAction(run.id)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      router.refresh()
    })
  }

  function cancel() {
    setConfirmCancel(false)
    start(async () => {
      const result = await cancelRunAction(run.id)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      router.refresh()
    })
  }

  function exclude() {
    const item = excluding
    if (!item) return
    start(async () => {
      const result = await excludeItemAction(item.id, excludeReason)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      setExcluding(null)
      setExcludeReason('')
      router.refresh()
    })
  }

  const columns: Column<ReviewItem>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (i) => (
        <Link href={`/customers/${i.customerId}`} className="block hover:text-brand">
          <span className="text-ink">{i.customerName}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {[i.email ?? 'No email address', i.phone].filter(Boolean).join(' · ')}
          </span>
        </Link>
      ),
      sortValue: (i) => i.customerName,
    },
    {
      key: 'level',
      header: 'Reminder',
      cell: (i) =>
        i.levelStep === 0 ? (
          <span className="text-faint">None</span>
        ) : (
          <>
            <span className="text-ink-2">{i.levelName}</span>
            {/* The one that suspends credit is worth saying out loud, on the
                row, before anyone clicks send. */}
            {i.levelStep >= 3 && (
              <span className="mt-0.5 block text-xs text-danger">suspends credit</span>
            )}
          </>
        ),
      sortValue: (i) => i.levelStep,
    },
    {
      key: 'overdue',
      header: 'Overdue',
      numeric: true,
      cell: (i) => <span className="text-ink">{formatMoney(i.overdueAmount)}</span>,
      sortValue: (i) => i.overdueAmount,
    },
    {
      key: 'age',
      header: 'Oldest',
      numeric: true,
      cell: (i) => (
        <span className={i.oldestDays >= 60 ? 'text-danger' : 'text-ink-2'}>
          {i.oldestDays} days
        </span>
      ),
      sortValue: (i) => i.oldestDays,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (i) => (
        <>
          <Badge tone={STATUS_TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
          {i.error && <span className="mt-0.5 block text-xs text-muted">{i.error}</span>}
          {/* The text leg's own outcome — `status` above stays the overall one,
              so "Sent" with "Text failed" beneath is a legitimate row. */}
          {i.smsStatus !== 'none' && (
            <span
              className={`mt-0.5 block text-xs ${i.smsStatus === 'failed' ? 'text-danger' : 'text-muted'}`}
            >
              Text {i.smsStatus}
              {i.smsError ? ` — ${i.smsError}` : ''}
            </span>
          )}
        </>
      ),
      sortValue: (i) => i.status,
    },
  ]

  return (
    <>
      {/* Said before the button, not after. */}
      {isDraft && (
        <Callout tone="brand" title="Nothing has been sent">
          This run has been assessed but not released. Review it, remove anything that should
          not go, then send.
        </Callout>
      )}

      {isDraft && willBlock > 0 && (
        <Callout tone="warning" title={`${willBlock} account${willBlock === 1 ? '' : 's'} will be suspended`}>
          Releasing this run puts {willBlock === 1 ? 'that account' : 'those accounts'} on hold.
          They will not be able to buy on credit until someone releases them.
        </Callout>
      )}

      {run.status === 'cancelled' && (
        <Callout tone="neutral" title="This run was cancelled">
          It is kept as a record of what was proposed. Nothing was sent.
        </Callout>
      )}

      {run.status === 'completed' && run.failedCount > 0 && (
        <Callout tone="danger" title={`${run.failedCount} reminder${run.failedCount === 1 ? '' : 's'} failed`}>
          Those accounts were not written to and did not move up the ladder. Check the addresses
          on the Failed rows, then build a new run.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={isDraft ? 'Will send' : 'Sent'}
          value={String(isDraft ? queued.length : run.sentCount)}
          hint={isDraft ? formatMoney(queuedValue) : `by ${run.sentByName ?? '—'}`}
        />
        <StatTile
          label="Not chased"
          value={String(skipped.length)}
          hint="each with a reason"
        />
        <StatTile
          label="Failed"
          value={String(run.failedCount)}
          tone={run.failedCount > 0 ? 'danger' : 'default'}
          hint={run.failedCount > 0 ? 'did not reach the customer' : 'none'}
        />
        <StatTile
          label="Assessed as at"
          value={run.asAt}
          hint={`built by ${run.userName}`}
        />
      </div>

      {isDraft && canRelease && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {queued.length === 0
                  ? 'There is nothing to send in this run.'
                  : `${queued.length} reminder${queued.length === 1 ? '' : 's'} will go out, each by the channel its level uses.`}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={pending}>
                  Cancel run
                </Button>
                <Button
                  onClick={() => setConfirmRelease(true)}
                  disabled={pending || queued.length === 0}
                >
                  {pending ? 'Sending…' : `Send ${queued.length} reminder${queued.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Accounts"
          description="Everything the run considered, including what it decided to leave alone."
        />

        {/* Tabs rather than LinkTabs: this switches a view inside one record
            and has no business putting a query param in the URL. */}
        <Tabs
          items={[
            {
              value: 'sending' as const,
              label: `${isDraft ? 'To send' : 'Sent'} (${sending.length})`,
            },
            { value: 'skipped' as const, label: `Not chased (${skipped.length})` },
          ]}
          value={tab}
          onChange={setTab}
          aria-label="Run contents"
        />

        {tab === 'sending' ? (
          sending.length === 0 ? (
            <CardBody>
              <EmptyState
                title="Nothing to send"
                hint="Every account was skipped. The Not chased tab says why for each one."
              />
            </CardBody>
          ) : (
            <DataTable
              columns={columns}
              rows={sending}
              getRowKey={(i) => i.id}
              actions={
                isDraft && canRelease
                  ? (i) =>
                      i.status === 'queued' ? (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          onClick={() => {
                            setExcluding(i)
                            setExcludeReason('')
                          }}
                        >
                          Remove
                        </Button>
                      ) : null
                  : undefined
              }
              empty={{ title: 'Nothing to send', hint: '' }}
            />
          )
        ) : skipped.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Every account was chased"
              hint="Nothing was skipped in this run."
            />
          </CardBody>
        ) : (
          <DataTable
            columns={columns}
            rows={skipped}
            getRowKey={(i) => i.id}
            empty={{ title: 'Nothing skipped', hint: '' }}
          />
        )}
      </Card>

      <ConfirmModal
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={release}
        title={`Send ${queued.length} reminder${queued.length === 1 ? '' : 's'}?`}
        message={
          willBlock > 0
            ? `This writes to ${queued.length} account${queued.length === 1 ? '' : 's'} and suspends credit on ${willBlock} of them. It cannot be undone.`
            : `This writes to ${queued.length} account${queued.length === 1 ? '' : 's'}. It cannot be undone.`
        }
        confirmLabel="Send them"
        tone={willBlock > 0 ? 'danger' : 'primary'}
        busy={pending}
      />

      <ConfirmModal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        title="Cancel this run?"
        message="Nothing will be sent. The run is kept as a record of what was proposed."
        confirmLabel="Cancel run"
        busy={pending}
      />

      <Modal
        open={excluding !== null}
        onClose={() => setExcluding(null)}
        title={`Remove ${excluding?.customerName ?? ''}`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setExcluding(null)} disabled={pending}>
              Keep it
            </Button>
            <Button onClick={exclude} disabled={pending}>
              Remove from run
            </Button>
          </>
        }
      >
        <Field
          label="Why"
          hint="Kept on the run, so the decision is on record rather than looking like an oversight."
        >
          <Input
            value={excludeReason}
            onChange={(e) => setExcludeReason(e.target.value)}
            placeholder="Owner asked us to hold off"
            autoFocus
          />
        </Field>
      </Modal>
    </>
  )
}
