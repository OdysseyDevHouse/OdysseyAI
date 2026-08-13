'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  ConfirmModal,
  CurrencyInput,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  useToast,
  type Column,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD_INPUT,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { journalTotals, refuseJournal } from '@/lib/glModel'
import { FREQUENCY_LABELS, type RecurringFrequency } from '@/lib/expenseModel'
import {
  saveRecurringJournalAction,
  setRecurringActiveAction,
  deleteRecurringJournalAction,
  generateRecurringJournalsAction,
} from '../actions'

type Account = { id: number; accountCode: string; name: string }

type ScheduleRow = {
  id: number
  name: string
  frequency: RecurringFrequency
  dayOfMonth: number | null
  dayOfWeek: number | null
  description: string
  reference: string | null
  startsOn: string
  endsOn: string | null
  lastGeneratedFor: string | null
  nextDue: string | null
  due: boolean
  autoPost: boolean
  isActive: boolean
  lines: { accountId: number; amount: number; description: string | null }[]
}

type FormLine = {
  key: string
  accountId: number
  description: string
  debit: number
  credit: number
}

/**
 * Schedules on the left of the screen's life; the editor is the same
 * balanced-lines discipline as the manual journal — the running difference
 * always visible, Save refusing while it is non-zero. A template that cannot
 * post must be refused at SAVE, because the person who finds out otherwise is
 * whoever presses Generate three months from now.
 */
export function RecurringJournalsClient({
  schedules,
  accounts,
}: {
  schedules: ScheduleRow[]
  accounts: Account[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ScheduleRow | null>(null)

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

  const dueCount = schedules.filter((s) => s.isActive && s.due).length

  const columns: readonly Column<ScheduleRow>[] = [
    {
      key: 'name',
      header: 'Schedule',
      sortable: true,
      sortValue: (s) => s.name,
      cell: (s) => (
        <>
          <span className="text-ink">{s.name}</span>
          <div className="text-xs text-muted">{s.description}</div>
        </>
      ),
    },
    {
      key: 'frequency',
      header: 'Repeats',
      sortable: true,
      sortValue: (s) => s.frequency,
      cell: (s) => FREQUENCY_LABELS[s.frequency] ?? s.frequency,
    },
    {
      key: 'value',
      header: 'Debits',
      sortable: true,
      sortValue: (s) => journalTotals(s.lines).totalDebit,
      cell: (s) => <span className="numeric">{formatMoney(journalTotals(s.lines).totalDebit)}</span>,
    },
    {
      key: 'next',
      header: 'Next due',
      sortable: true,
      sortValue: (s) => s.nextDue ?? '',
      cell: (s) =>
        !s.isActive ? (
          <Badge>Paused</Badge>
        ) : s.due ? (
          <Badge tone="warning">Due — generate below</Badge>
        ) : (
          <span className="text-ink-2">{s.nextDue ?? 'Ended'}</span>
        ),
    },
    {
      key: 'mode',
      header: 'On generate',
      cell: (s) =>
        s.autoPost ? <Badge tone="brand">Posts itself</Badge> : <span className="text-muted">Drafts for review</span>,
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Schedules"
          description="Each holds a balanced template. Generate drafts everything due; the journal list is where drafts get posted."
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => run(() => generateRecurringJournalsAction())}
              >
                <Icons.Repeat size={15} />
                {dueCount > 0 ? `Generate what is due (${dueCount})` : 'Generate what is due'}
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Icons.Plus size={15} />
                New schedule
              </Button>
            </div>
          }
        />
        <DataTable
          columns={columns}
          rows={schedules}
          getRowKey={(s) => s.id}
          actions={(s) => (
            <div className="flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Edit ${s.name}`}
                onClick={() => setEditing(s)}
              >
                <Icons.Pencil size={15} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={s.isActive ? `Pause ${s.name}` : `Resume ${s.name}`}
                disabled={pending}
                onClick={() => run(() => setRecurringActiveAction(s.id, !s.isActive))}
              >
                {s.isActive ? <Icons.Pause size={15} /> : <Icons.Refresh size={15} />}
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                aria-label={`Delete ${s.name}`}
                onClick={() => setDeleting(s)}
              >
                <Icons.Trash size={15} />
              </Button>
            </div>
          )}
          empty={{
            title: 'No recurring journals yet',
            hint: 'The monthly accrual, the prepayment release — set them up once and Generate does the typing.',
            action: (
              <Button onClick={() => setCreating(true)}>
                <Icons.Plus size={15} />
                New schedule
              </Button>
            ),
          }}
        />
      </Card>

      {(creating || editing) && (
        <ScheduleEditor
          accounts={accounts}
          schedule={editing}
          pending={pending}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSave={(input, id) => {
            run(() => saveRecurringJournalAction(input, id))
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this schedule?"
        tone="danger"
        confirmLabel="Delete"
        onConfirm={() => {
          const s = deleting
          setDeleting(null)
          if (s) run(() => deleteRecurringJournalAction(s.id))
        }}
        message={
          deleting
            ? `${deleting.name} stops producing entries. Journals it already produced are untouched.`
            : ''
        }
      />
    </>
  )
}

const FREQUENCIES: RecurringFrequency[] = ['weekly', 'monthly', 'quarterly', 'annually']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function ScheduleEditor({
  accounts,
  schedule,
  pending,
  onClose,
  onSave,
}: {
  accounts: Account[]
  schedule: ScheduleRow | null
  pending: boolean
  onClose: () => void
  onSave: (
    input: {
      name: string
      frequency: RecurringFrequency
      dayOfMonth?: number | null
      dayOfWeek?: number | null
      description: string
      reference?: string | null
      startsOn: string
      endsOn?: string | null
      autoPost?: boolean
      lines: { accountId: number; amount: number; description?: string | null }[]
    },
    id?: number,
  ) => void
}) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [frequency, setFrequency] = useState<RecurringFrequency>(schedule?.frequency ?? 'monthly')
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1)
  const [dayOfWeek, setDayOfWeek] = useState(schedule?.dayOfWeek ?? 0)
  const [description, setDescription] = useState(schedule?.description ?? '')
  const [reference, setReference] = useState(schedule?.reference ?? '')
  const [startsOn, setStartsOn] = useState(schedule?.startsOn ?? todayIso())
  const [endsOn, setEndsOn] = useState(schedule?.endsOn ?? '')
  const [autoPost, setAutoPost] = useState(schedule?.autoPost ?? false)
  const [lines, setLines] = useState<FormLine[]>(
    schedule && schedule.lines.length > 0
      ? schedule.lines.map((l) => ({
          key: `line-${Math.random().toString(36).slice(2)}`,
          accountId: l.accountId,
          description: l.description ?? '',
          debit: l.amount > 0 ? l.amount : 0,
          credit: l.amount < 0 ? -l.amount : 0,
        }))
      : [blankLine(accounts[0]?.id ?? 0), blankLine(accounts[0]?.id ?? 0)],
  )

  const modelLines = lines
    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0))
    .map((l) => ({ accountId: l.accountId, amount: l.debit !== 0 ? l.debit : -l.credit }))
  const totals = journalTotals(modelLines)
  const refusal =
    refuseJournal({ journalDate: startsOn, description, lines: modelLines }) ??
    (name.trim() ? null : 'Name the schedule.')

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, ...patch }
        // One side or the other, never both — the journal form's rule.
        if (patch.debit !== undefined && patch.debit !== 0) next.credit = 0
        if (patch.credit !== undefined && patch.credit !== 0) next.debit = 0
        return next
      }),
    )
  }

  return (
    <Modal open onClose={onClose} title={schedule ? `Edit ${schedule.name}` : 'New recurring journal'}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="What the list calls it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly rent accrual" />
          </Field>
          <Field label="Journal description" hint="What the generated entries say.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Rent accrual"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Repeats">
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </Select>
          </Field>
          {frequency === 'weekly' ? (
            <Field label="On">
              <Select value={String(dayOfWeek)} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Day of month">
              <Select value={String(dayOfMonth)} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Starts on">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Ends on" hint="Optional.">
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" hint="Optional — carried onto every entry.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field
            label="Post without review"
            hint="Only for an entry that never varies by a cent. A refused post still leaves a draft."
          >
            <Checkbox
              label="Post each occurrence automatically"
              checked={autoPost}
              onChange={(e) => setAutoPost(e.target.checked)}
            />
          </Field>
        </div>

        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Account</th>
                <th className={TABLE_TH}>Description</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-32`}>Debit</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-32`}>Credit</th>
                <th className={`${TABLE_TH} w-12`} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className={TABLE_ROW}>
                  <td className={TABLE_TD_INPUT}>
                    <Select
                      value={String(line.accountId)}
                      onChange={(e) => updateLine(line.key, { accountId: Number(e.target.value) })}
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.accountCode} · {a.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className={TABLE_TD_INPUT}>
                    <Input
                      value={line.description}
                      onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      placeholder="Optional"
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                    <CurrencyInput
                      value={line.debit}
                      onChange={(e) =>
                        updateLine(line.key, { debit: Number(String(e.target.value).replace(',', '.')) || 0 })
                      }
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                    <CurrencyInput
                      value={line.credit}
                      onChange={(e) =>
                        updateLine(line.key, { credit: Number(String(e.target.value).replace(',', '.')) || 0 })
                      }
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} text-right`}>
                    {lines.length > 2 && (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label="Remove this line"
                        onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLines((c) => [...c, blankLine(accounts[0]?.id ?? 0)])}
          >
            <Icons.Plus size={15} />
            Add line
          </Button>
          <dl className="flex items-center gap-6 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">Debits</dt>
              <dd className="numeric text-ink">{formatMoney(totals.totalDebit)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Credits</dt>
              <dd className="numeric text-ink">{formatMoney(totals.totalCredit)}</dd>
            </div>
          </dl>
        </div>

        {refusal !== null && (
          <Callout
            tone="danger"
            title={
              totals.balanced ? 'This schedule cannot be saved yet' : `Out by ${formatMoney(Math.abs(totals.difference))}`
            }
          >
            {refusal}
          </Callout>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || refusal !== null}
            onClick={() =>
              onSave(
                {
                  name: name.trim(),
                  frequency,
                  dayOfMonth: frequency === 'weekly' ? null : dayOfMonth,
                  dayOfWeek: frequency === 'weekly' ? dayOfWeek : null,
                  description: description.trim(),
                  reference: reference.trim() || null,
                  startsOn,
                  endsOn: endsOn || null,
                  autoPost,
                  lines: lines
                    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0))
                    .map((l) => ({
                      accountId: l.accountId,
                      amount: l.debit !== 0 ? l.debit : -l.credit,
                      description: l.description.trim() || null,
                    })),
                },
                schedule?.id,
              )
            }
          >
            <Icons.Save size={15} />
            {schedule ? 'Save schedule' : 'Create schedule'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function blankLine(accountId: number): FormLine {
  return {
    key: `line-${Math.random().toString(36).slice(2)}`,
    accountId,
    description: '',
    debit: 0,
    credit: 0,
  }
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
