'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  StatStrip,
  StatTile,
  Switch,
  TableToolbar,
  Textarea,
  useToast,
  type Column,
} from '@/components/ui'
import {
  formatDays,
  workingDaysBetween,
  STATUS_LABELS,
  SOURCE_LABELS,
  type LeaveBalance,
  type LeaveRequest,
  type LedgerSource,
} from '@/lib/leaveModel'
import {
  requestLeaveAction,
  approveLeaveAction,
  declineLeaveAction,
  cancelLeaveAction,
  adjustBalanceAction,
  accrueAction,
} from './actions'

type TypeOption = { id: number; name: string; isPaid: boolean }
type Person = { id: number; name: string }
type LedgerEntry = {
  id: number
  entryDate: string
  days: number
  source: LedgerSource
  note: string | null
  createdByName: string | null
}

const STATUS_TONE: Record<LeaveRequest['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  approved: 'success',
  requested: 'warning',
  declined: 'danger',
  cancelled: 'neutral',
}

/**
 * Leave.
 *
 * Balances lead, because "how many days have I got" is the question everyone
 * opens this screen with. The approval queue sits above them for a manager,
 * since that is somebody else waiting on them.
 */
export default function LeaveScreen({
  balances,
  requests,
  pending,
  types,
  ledger,
  people,
  viewingUserId,
  currentUserId,
  currentUserName,
  canApprove,
  canEdit,
  seesEveryone,
}: {
  balances: LeaveBalance[]
  requests: LeaveRequest[]
  pending: LeaveRequest[]
  types: TypeOption[]
  ledger: LedgerEntry[]
  people: Person[]
  viewingUserId: number
  currentUserId: number
  currentUserName: string
  canApprove: boolean
  canEdit: boolean
  seesEveryone: boolean
}) {
  const [booking, setBooking] = useState(false)
  const [deciding, setDeciding] = useState<{ request: LeaveRequest; approve: boolean } | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const [showLedger, setShowLedger] = useState(false)
  const [pendingTx, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) return toast.error(result.error ?? 'That did not work.')
      toast.success(result.message ?? 'Done.')
      router.refresh()
    })
  }

  const viewingSelf = viewingUserId === currentUserId
  const viewingName = people.find((p) => p.id === viewingUserId)?.name ?? currentUserName

  const requestColumns: Column<LeaveRequest>[] = [
    {
      key: 'dates',
      header: 'Dates',
      sortable: true,
      sortValue: (r) => r.periodFrom,
      cell: (r) => (
        <div>
          <div className="text-ink">
            {r.periodFrom === r.periodTo ? r.periodFrom : `${r.periodFrom} to ${r.periodTo}`}
          </div>
          {r.reason && <div className="text-xs text-muted">{r.reason}</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      sortValue: (r) => r.leaveTypeName,
      cell: (r) => <span className="text-ink-2">{r.leaveTypeName}</span>,
    },
    {
      key: 'days',
      header: 'Days',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.days,
      cell: (r) => <span className="numeric text-ink">{r.days}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (r) => r.status,
      cell: (r) => (
        <div>
          <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>
          {r.decidedByName && (
            <div className="text-xs text-muted">by {r.decidedByName}</div>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      {/* The queue first — somebody else is waiting on it. */}
      {canApprove && pending.length > 0 && (
        <Card>
          <CardHeader
            title={`${pending.length} ${pending.length === 1 ? 'request' : 'requests'} waiting`}
            description="Approving takes the days off their balance straight away."
          />
          <DataTable
            columns={[
              {
                key: 'person',
                header: 'Person',
                sortable: true,
                sortValue: (r: LeaveRequest) => r.userName,
                cell: (r: LeaveRequest) => (
                  <span className="font-medium text-ink">{r.userName}</span>
                ),
              },
              ...requestColumns.slice(0, 3),
            ]}
            rows={pending}
            getRowKey={(r) => r.id}
            actions={(r) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingTx}
                  onClick={() => setDeciding({ request: r, approve: true })}
                >
                  <Icons.Check size={15} />
                  Approve
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={pendingTx}
                  onClick={() => setDeciding({ request: r, approve: false })}
                >
                  Decline
                </Button>
              </div>
            )}
            empty={{ title: 'Nothing waiting', hint: 'Requests appear here as they come in.' }}
          />
        </Card>
      )}

      <TableToolbar
        actions={
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                variant="ghost"
                disabled={pendingTx}
                title="Bring everybody's entitlement up to date. Safe to run repeatedly."
                onClick={() => run(() => accrueAction())}
              >
                <Icons.Refresh size={15} />
                Update entitlements
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" onClick={() => setAdjusting(true)}>
                Adjust balance
              </Button>
            )}
            <Button variant="primary" onClick={() => setBooking(true)}>
              <Icons.Plus size={16} />
              Book leave
            </Button>
          </div>
        }
      >
        {seesEveryone && people.length > 0 && (
          <Field label="" className="min-w-[12rem]">
            <Select
              aria-label="Person"
              value={String(viewingUserId)}
              onChange={(e) => router.push(`/staff/leave?user=${e.target.value}`)}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === currentUserId ? ' (you)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </TableToolbar>

      {balances.filter((b) => b.accrued > 0 || b.used > 0).length === 0 ? (
        <Callout tone="neutral" title="No entitlement recorded yet">
          {canEdit
            ? 'Press “Update entitlements” to accrue from each person’s start date. Anybody without a start date on their employment record is skipped.'
            : 'A manager needs to run the entitlement update, or record a start date against your employment.'}
        </Callout>
      ) : (
        <StatStrip>
          {balances
            .filter((b) => b.accrued > 0 || b.used > 0 || b.pending > 0)
            .map((b) => (
              <StatTile
                key={b.leaveTypeId}
                label={b.leaveTypeName}
                value={formatDays(b.available)}
                hint={
                  b.pending > 0
                    ? `${formatDays(b.balance)} less ${formatDays(b.pending)} booked ahead`
                    : `${formatDays(b.used)} taken of ${formatDays(b.accrued)}`
                }
                // Nothing left is the exception worth catching at a glance.
                tone={b.available <= 0 ? 'danger' : b.available < 2 ? 'warning' : 'default'}
                icon={<Icons.CalendarRange size={16} />}
              />
            ))}
        </StatStrip>
      )}

      <Card>
        <CardHeader
          title={viewingSelf ? 'Your leave' : `${viewingName}'s leave`}
          action={
            <Button variant="ghost" size="sm" onClick={() => setShowLedger((v) => !v)}>
              {showLedger ? 'Hide the ledger' : 'Why these numbers?'}
            </Button>
          }
        />
        <DataTable
          columns={requestColumns}
          rows={requests}
          getRowKey={(r) => r.id}
          actions={(r) =>
            (r.status === 'requested' || r.status === 'approved') &&
            (r.userId === currentUserId || canApprove) ? (
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={pendingTx}
                onClick={() => run(() => cancelLeaveAction(r.id, r.userId))}
              >
                Cancel
              </Button>
            ) : null
          }
          empty={{
            title: 'No leave booked',
            hint: 'Book a day off and it will appear here.',
            icon: <Icons.CalendarRange size={28} strokeWidth={1.75} />,
          }}
        />
      </Card>

      {/* The answer to "I should have fourteen days, not eleven". */}
      {showLedger && (
        <Card>
          <CardHeader
            title="Every movement"
            description="A balance is the sum of these. Each line can be argued on its own."
          />
          {ledger.length === 0 ? (
            <EmptyState
              title="Nothing on the ledger yet"
              hint="Entitlement and leave taken both appear here."
            />
          ) : (
            <DataTable
              columns={[
                {
                  key: 'date',
                  header: 'Date',
                  sortable: true,
                  sortValue: (e: LedgerEntry) => e.entryDate,
                  cell: (e: LedgerEntry) => <span className="text-muted">{e.entryDate}</span>,
                },
                {
                  key: 'source',
                  header: 'What',
                  sortable: true,
                  sortValue: (e: LedgerEntry) => e.source,
                  cell: (e: LedgerEntry) => (
                    <div>
                      <div className="text-ink-2">{SOURCE_LABELS[e.source]}</div>
                      {e.note && <div className="text-xs text-muted">{e.note}</div>}
                    </div>
                  ),
                },
                {
                  key: 'days',
                  header: 'Days',
                  numeric: true,
                  sortable: true,
                  sortValue: (e: LedgerEntry) => e.days,
                  cell: (e: LedgerEntry) => (
                    <span className={e.days < 0 ? 'numeric text-danger' : 'numeric text-success'}>
                      {e.days > 0 ? `+${e.days}` : e.days}
                    </span>
                  ),
                },
                {
                  key: 'by',
                  header: 'By',
                  cell: (e: LedgerEntry) => (
                    <span className="text-muted">{e.createdByName ?? '—'}</span>
                  ),
                },
              ]}
              rows={ledger}
              getRowKey={(e) => e.id}
              empty={{ title: 'Nothing yet' }}
            />
          )}
        </Card>
      )}

      {booking && (
        <BookModal
          types={types}
          balances={balances}
          people={people}
          defaultUserId={viewingUserId}
          currentUserId={currentUserId}
          canBookForOthers={canEdit}
          onClose={() => setBooking(false)}
        />
      )}

      {deciding && (
        <DecideModal
          request={deciding.request}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
        />
      )}

      {adjusting && (
        <AdjustModal
          types={types}
          people={people.length ? people : [{ id: currentUserId, name: currentUserName }]}
          defaultUserId={viewingUserId}
          onClose={() => setAdjusting(false)}
        />
      )}
    </>
  )
}

function BookModal({
  types,
  balances,
  people,
  defaultUserId,
  currentUserId,
  canBookForOthers,
  onClose,
}: {
  types: TypeOption[]
  balances: LeaveBalance[]
  people: Person[]
  defaultUserId: number
  currentUserId: number
  canBookForOthers: boolean
  onClose: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [userId, setUserId] = useState(defaultUserId)
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? 0)
  const [periodFrom, setPeriodFrom] = useState(today)
  const [periodTo, setPeriodTo] = useState(today)
  const [isHalfDay, setIsHalfDay] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  // Counted here with the same function the server uses, so the number on
  // screen while somebody picks dates is the number that gets stored.
  const days = useMemo(
    () => (isHalfDay ? 0.5 : workingDaysBetween(periodFrom, periodTo)),
    [periodFrom, periodTo, isHalfDay],
  )

  const balance = balances.find((b) => b.leaveTypeId === leaveTypeId)
  const type = types.find((t) => t.id === leaveTypeId)
  const short = type?.isPaid && balance && days > balance.available

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await requestLeaveAction({
        userId,
        leaveTypeId,
        periodFrom,
        periodTo: isHalfDay ? periodFrom : periodTo,
        isHalfDay,
        reason: reason.trim() || null,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Book leave"
      description="Working days only — weekends and public holidays are not counted."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending || days <= 0}>
            {pending ? 'Booking…' : `Book ${formatDays(days)}`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        {canBookForOthers && people.length > 1 && (
          <Field label="Who">
            <Select value={String(userId)} onChange={(e) => setUserId(Number(e.target.value))}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === currentUserId ? ' (you)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Kind of leave"
          hint={
            balance
              ? `${formatDays(balance.available)} available.`
              : type?.isPaid === false
                ? 'Unpaid — no balance is needed.'
                : undefined
          }
        >
          <Select value={String(leaveTypeId)} onChange={(e) => setLeaveTypeId(Number(e.target.value))}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isPaid ? '' : ' (unpaid)'}
              </option>
            ))}
          </Select>
        </Field>

        <Switch
          checked={isHalfDay}
          onChange={setIsHalfDay}
          label="Half a day"
          hint="For an appointment. Covers one date."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={isHalfDay ? 'Date' : 'From'}>
            <Input
              type="date"
              value={periodFrom}
              onChange={(e) => {
                setPeriodFrom(e.target.value)
                if (e.target.value > periodTo) setPeriodTo(e.target.value)
              }}
            />
          </Field>
          {!isHalfDay && (
            <Field label="To">
              <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
            </Field>
          )}
        </div>

        {days > 0 && (
          <Callout tone={short ? 'warning' : 'neutral'}>
            {short
              ? `That is ${formatDays(days)}, and only ${formatDays(balance?.available ?? 0)} is left. It will be refused unless somebody with permission allows it.`
              : `That comes to ${formatDays(days)} of working time.`}
          </Callout>
        )}

        <Field label="Reason" hint="Optional, but it helps whoever decides.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}

function DecideModal({
  request,
  approve,
  onClose,
}: {
  request: LeaveRequest
  approve: boolean
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = approve
        ? await approveLeaveAction(request.id, note)
        : await declineLeaveAction(request.id, note)
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={approve ? 'Approve this leave' : 'Decline this leave'}
      description={`${request.userName} — ${request.leaveTypeName}, ${formatDays(request.days)} from ${request.periodFrom}.`}
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={approve ? 'primary' : 'danger'}
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'Saving…' : approve ? 'Approve' : 'Decline'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        {request.reason && (
          <Callout tone="neutral" title="Their reason">
            {request.reason}
          </Callout>
        )}

        {approve && (
          <Callout tone="neutral">
            Approving takes {formatDays(request.days)} off their balance straight away.
          </Callout>
        )}

        <Field
          label="Note"
          hint={approve ? 'Optional.' : 'Worth saying why — they will see it.'}
        >
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}

function AdjustModal({
  types,
  people,
  defaultUserId,
  onClose,
}: {
  types: TypeOption[]
  people: Person[]
  defaultUserId: number
  onClose: () => void
}) {
  const [userId, setUserId] = useState(defaultUserId)
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? 0)
  const [days, setDays] = useState('0')
  const [source, setSource] = useState<LedgerSource>('adjustment')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await adjustBalanceAction(
        userId,
        leaveTypeId,
        Number(days) || 0,
        note,
        source,
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust a balance"
      description="For an opening balance from another system, a goodwill day, or a payout."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Adjust'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        {people.length > 1 && (
          <Field label="Who">
            <Select value={String(userId)} onChange={(e) => setUserId(Number(e.target.value))}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Kind of leave">
          <Select value={String(leaveTypeId)} onChange={(e) => setLeaveTypeId(Number(e.target.value))}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="What kind of adjustment">
          <Select value={source} onChange={(e) => setSource(e.target.value as LedgerSource)}>
            <option value="adjustment">Adjustment</option>
            <option value="opening">Opening balance</option>
            <option value="payout">Paid out</option>
            <option value="forfeit">Forfeited</option>
          </Select>
        </Field>

        <Field label="Days" hint="Negative takes days away.">
          <NumberInput
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="max-w-[8rem]"
          />
        </Field>

        <Field
          label="Reason"
          hint="Required. It is what makes the balance explainable months later."
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Opening balance from the old system"
          />
        </Field>
      </div>
    </Modal>
  )
}
