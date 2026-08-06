'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Field,
  Input,
  Select,
  Badge,
  Icons,
  Modal,
  EmptyState,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
            <Field label="Reason" hint="Optional">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="VAT return filed"
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end">
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
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Closed periods" description="Nothing may be posted into these." />
        {active.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No periods are closed"
              hint="Close a month once its VAT return has been filed, so nothing can be posted into it afterwards."
            />
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Period</th>
                  <th className={TABLE_TH}>Type</th>
                  <th className={TABLE_TH}>Covers</th>
                  <th className={TABLE_TH}>Reason</th>
                  <th className={TABLE_TH}>Closed by</th>
                  <th className={`${TABLE_TH} w-28`} />
                </tr>
              </thead>
              <tbody>
                {active.map((lock) => (
                  <tr key={lock.id} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <span className="text-ink">
                        {lock.periodFrom} → {lock.periodTo}
                      </span>
                    </td>
                    <td className={TABLE_TD}>
                      <Badge tone={lock.lockType === 'hard' ? 'danger' : 'warning'}>
                        {lock.lockType === 'hard' ? 'Hard' : 'Soft'}
                      </Badge>
                    </td>
                    <td className={TABLE_TD}>{lock.scopeLabel}</td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{lock.reason ?? '—'}</span>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{lock.lockedBy}</span>
                    </td>
                    <td className={`${TABLE_TD} text-right`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setUnlocking(lock)
                          setUnlockReason('')
                        }}
                      >
                        Reopen
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader
            title="Reopened periods"
            description="Kept on record — who reopened a closed period, and why, is what an auditor asks."
          />
          <CardBody>
            <ul className="divide-y divide-border">
              {history.map((lock) => (
                <li key={lock.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-ink">
                      {lock.periodFrom} → {lock.periodTo}
                    </span>
                    <span className="text-xs text-muted">
                      reopened by {lock.unlockedBy ?? 'someone'}
                    </span>
                  </div>
                  {lock.unlockReason && (
                    <span className="text-xs text-muted">{lock.unlockReason}</span>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Close a custom period">
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
          <div className="flex justify-end gap-2">
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
          </div>
        </div>
      </Modal>

      <Modal
        open={unlocking !== null}
        onClose={() => setUnlocking(null)}
        title="Reopen this period"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Reopening {unlocking?.periodFrom} to {unlocking?.periodTo} lets postings be dated
            into it again. This is recorded against your name.
          </p>
          <Field label="Why is it being reopened?">
            <Input
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
              placeholder="e.g. A supplier invoice arrived late and must be included"
            />
          </Field>
          <div className="flex justify-end gap-2">
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
          </div>
        </div>
      </Modal>
    </>
  )
}
