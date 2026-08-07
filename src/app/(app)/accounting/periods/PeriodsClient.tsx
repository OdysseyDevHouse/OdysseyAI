'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  Select,
  Badge,
  Icons,
  Modal,
  DataTable,
  type Column,
  useToast,
} from '@/components/ui'
import { SCOPE_LABELS, type PeriodLock } from '@/lib/periodLockModel'
import { lockMonthAction, lockPeriodAction, unlockPeriodAction } from '../actions'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function PeriodsClient({ locks }: { locks: PeriodLock[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const now = new Date()
  // Default to LAST month: the one being closed is almost never the current one.
  const lastMonth = now.getMonth() === 0 ? 12 : now.getMonth()
  const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()

  const [year, setYear] = useState(lastMonthYear)
  const [month, setMonth] = useState(lastMonth)
  const [lockType, setLockType] = useState<'hard' | 'soft'>('hard')
  const [scope, setScope] = useState<'all' | 'sales' | 'purchases' | 'ledger' | 'stock'>('all')
  const [reason, setReason] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [unlocking, setUnlocking] = useState<PeriodLock | null>(null)
  const [unlockReason, setUnlockReason] = useState('')
  const [unlockTouched, setUnlockTouched] = useState(false)

  const unlockError =
    unlockTouched && !unlockReason.trim()
      ? 'Give a reason — it is what the auditor reads.'
      : undefined

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  const active = locks.filter((l) => l.active)
  const history = locks.filter((l) => !l.active)

  const activeColumns: Column<PeriodLock>[] = [
    {
      key: 'period',
      header: 'Period',
      cell: (lock) => (
        <span className="text-ink">
          {lock.periodFrom} → {lock.periodTo}
        </span>
      ),
      sortValue: (lock) => lock.periodFrom,
    },
    {
      key: 'type',
      header: 'Type',
      // A hard lock is the NORMAL state of a closed period — neutral. Soft is
      // the one still letting postings through, so it carries the warning.
      cell: (lock) =>
        lock.lockType === 'hard' ? (
          <Badge tone="default">Hard</Badge>
        ) : (
          <Badge tone="warning">Soft</Badge>
        ),
      sortValue: (lock) => lock.lockType,
    },
    {
      key: 'covers',
      header: 'Covers',
      cell: (lock) => lock.scopeLabel,
      sortValue: (lock) => lock.scopeLabel,
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (lock) => <span className="text-muted">{lock.reason ?? '—'}</span>,
      sortValue: (lock) => lock.reason ?? '',
    },
    {
      key: 'by',
      header: 'Closed by',
      cell: (lock) => <span className="text-muted">{lock.lockedBy}</span>,
      sortValue: (lock) => lock.lockedBy ?? '',
    },
  ]

  const historyColumns: Column<PeriodLock>[] = [
    {
      key: 'period',
      header: 'Period',
      cell: (lock) => (
        <span className="text-ink">
          {lock.periodFrom} → {lock.periodTo}
        </span>
      ),
      sortValue: (lock) => lock.periodFrom,
    },
    {
      key: 'by',
      header: 'Reopened by',
      cell: (lock) => <span className="text-muted">{lock.unlockedBy ?? '—'}</span>,
      sortValue: (lock) => lock.unlockedBy ?? '',
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (lock) => <span className="text-muted">{lock.unlockReason ?? '—'}</span>,
      sortValue: (lock) => lock.unlockReason ?? '',
    },
  ]

  /* The lock settings, shared by the month form and the custom-dates modal so
     the modal can show exactly what will be applied. */
  const lockFields = (
    <>
      <Field label="Type">
        <Select
          value={lockType}
          onChange={(e) => setLockType(e.target.value as 'hard' | 'soft')}
        >
          <option value="hard">Hard — refuse postings</option>
          <option value="soft">Soft — warn only</option>
        </Select>
      </Field>
      <Field label="Covers">
        <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          {Object.entries(SCOPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
    </>
  )

  const reasonField = (
    <Field label="Reason" hint="Optional">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="VAT return filed"
      />
    </Field>
  )

  return (
    <>
      <Card>
        <CardHeader
          title="Close a period"
          description="Choose the month whose figures are final."
          action={
            <Button variant="secondary" size="sm" onClick={() => setCustomOpen(true)}>
              Custom dates
            </Button>
          }
        />
        <CardBody>
          {/* Short answers get short fields; the free-text reason gets the row. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Month">
              <Select value={String(month)} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Year">
              <Input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
              />
            </Field>
            {lockFields}
          </div>
          <div className="mt-4 max-w-xl">{reasonField}</div>
        </CardBody>
        <CardFooter>
          <Button
            disabled={pending}
            onClick={() =>
              run(() =>
                lockMonthAction(year, month, {
                  lockType,
                  scope,
                  reason: reason.trim() || undefined,
                }),
              )
            }
          >
            <Icons.Lock size={15} />
            Close {MONTHS[month - 1]} {year}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Closed periods" description="Nothing may be posted into these." />
        <DataTable
          columns={activeColumns}
          rows={active}
          getRowKey={(lock) => lock.id}
          actionsOnHover
          actions={(lock) => (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Reopen ${lock.periodFrom} to ${lock.periodTo}`}
              disabled={pending}
              onClick={() => {
                setUnlocking(lock)
                setUnlockReason('')
                setUnlockTouched(false)
              }}
            >
              <Icons.Reverse size={15} />
            </Button>
          )}
          empty={{
            title: 'No periods are closed',
            hint: 'Close a month once its VAT return has been filed, so nothing can be posted into it afterwards.',
          }}
        />
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader
            title="Reopened periods"
            description="Kept on record — who reopened a closed period, and why, is what an auditor asks."
          />
          <DataTable columns={historyColumns} rows={history} getRowKey={(lock) => lock.id} />
        </Card>
      )}

      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Close a custom period"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !customFrom || !customTo}
              onClick={() => {
                run(() =>
                  lockPeriodAction({
                    periodFrom: customFrom,
                    periodTo: customTo,
                    lockType,
                    scope,
                    reason: reason.trim() || undefined,
                  }),
                )
                setCustomOpen(false)
              }}
            >
              Close period
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From">
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </Field>
            <Field label="To">
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </Field>
          </div>
          {/* The same settings as the month form, repeated here so what is
              about to be applied is visible, not remembered. */}
          <div className="grid gap-4 sm:grid-cols-2">{lockFields}</div>
          {reasonField}
        </div>
      </Modal>

      <Modal
        open={unlocking !== null}
        onClose={() => setUnlocking(null)}
        title="Reopen this period"
        footer={
          <>
            <Button variant="secondary" onClick={() => setUnlocking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !unlockReason.trim()}
              onClick={() => {
                if (unlocking) {
                  run(() => unlockPeriodAction(unlocking.id, unlockReason.trim()))
                }
                setUnlocking(null)
              }}
            >
              Reopen
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Reopening {unlocking?.periodFrom} to {unlocking?.periodTo} lets postings be dated
            into it again. This is recorded against your name.
          </p>
          <Field label="Why is it being reopened?" error={unlockError}>
            <Input
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
              onBlur={() => setUnlockTouched(true)}
              placeholder="e.g. A supplier invoice arrived late and must be included"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
