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
  CurrencyInput,
  Badge,
  Icons,
  Modal,
  EmptyState,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  type ExpensePaymentType,
  type RecurringFrequency,
} from '@/lib/expenseModel'
import {
  saveRecurringAction,
  setRecurringActiveAction,
  deleteRecurringAction,
  generateDueAction,
} from '../actions'

type Schedule = {
  id: number
  name: string
  frequency: RecurringFrequency
  frequencyLabel: string
  dayOfMonth: number | null
  dayOfWeek: number | null
  paymentType: ExpensePaymentType
  supplierId: number | null
  supplierName: string | null
  bankAccountId: number | null
  bankAccountName: string | null
  description: string | null
  totalIncl: number
  startsOn: string
  endsOn: string | null
  nextDue: string | null
  due: boolean
  isActive: boolean
}

type Category = { id: number; accountCode: string; name: string; defaultVatRatePct: number | null }
type Option = { id: number; name: string }

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function RecurringClient({
  schedules,
  categories,
  suppliers,
  bankAccounts,
  defaultVatRate,
}: {
  schedules: Schedule[]
  categories: Category[]
  suppliers: Option[]
  bankAccounts: Option[]
  defaultVatRate: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [creating, setCreating] = useState(false)

  const due = schedules.filter((s) => s.due && s.isActive)

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

  return (
    <>
      {due.length > 0 && (
        <Card>
          <CardHeader
            title={`${due.length} schedule${due.length === 1 ? '' : 's'} due`}
            description="Creating the drafts does not post anything — you review each one first."
            action={
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => generateDueAction())}
              >
                <Icons.Plus size={15} />
                Create the drafts
              </Button>
            }
          />
        </Card>
      )}

      <Card>
        <CardHeader
          title="Schedules"
          description="Rent, insurance, subscriptions — anything that arrives on a cycle."
          action={
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Icons.Plus size={15} />
              New schedule
            </Button>
          }
        />

        {schedules.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No recurring expenses set up"
              hint="Rent on the first, the insurance debit order on the fifteenth — set them up once and they stop being something to remember."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Icons.Plus size={15} />
                  New schedule
                </Button>
              }
            />
          </CardBody>
        ) : (
          <CardBody>
            <ul className="divide-y divide-border">
              {schedules.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={s.isActive ? 'text-ink' : 'text-muted line-through'}>
                        {s.name}
                      </span>
                      {s.due && s.isActive && <Badge tone="warning">Due</Badge>}
                      {!s.isActive && <Badge tone="default">Paused</Badge>}
                      <Badge tone={s.paymentType === 'on_account' ? 'warning' : 'default'}>
                        {s.paymentType === 'on_account' ? 'Bill' : 'Paid'}
                      </Badge>
                    </div>
                    <span className="mt-0.5 block text-xs text-muted">
                      {s.frequencyLabel.toLowerCase()}
                      {s.dayOfMonth ? ` on day ${s.dayOfMonth}` : ''}
                      {s.dayOfWeek ? ` on ${WEEKDAYS[s.dayOfWeek - 1]}` : ''}
                      {' · '}
                      {s.supplierName ?? s.bankAccountName ?? 'no payee'}
                      {s.isActive && s.nextDue ? ` · next ${s.nextDue}` : ''}
                      {s.endsOn ? ` · ends ${s.endsOn}` : ''}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <span className="numeric text-sm text-ink">{formatMoney(s.totalIncl)}</span>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => setRecurringActiveAction(s.id, !s.isActive))}
                    >
                      {s.isActive ? 'Pause' : 'Resume'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>

      <ScheduleModal
        open={creating || editing !== null}
        schedule={editing}
        categories={categories}
        suppliers={suppliers}
        bankAccounts={bankAccounts}
        defaultVatRate={defaultVatRate}
        pending={pending}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onDelete={(id) => {
          if (!window.confirm('Delete this schedule? The expenses it produced are kept.')) return
          run(() => deleteRecurringAction(id))
          setEditing(null)
        }}
        onSave={(input, id) => {
          run(() => saveRecurringAction(input, id))
          setCreating(false)
          setEditing(null)
        }}
      />
    </>
  )
}

function ScheduleModal({
  open,
  schedule,
  categories,
  suppliers,
  bankAccounts,
  defaultVatRate,
  pending,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  schedule: Schedule | null
  categories: Category[]
  suppliers: Option[]
  bankAccounts: Option[]
  defaultVatRate: number
  pending: boolean
  onClose: () => void
  onSave: (input: Parameters<typeof saveRecurringAction>[0], id?: number) => void
  onDelete: (id: number) => void
}) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [frequency, setFrequency] = useState<RecurringFrequency>(schedule?.frequency ?? 'monthly')
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1)
  const [dayOfWeek, setDayOfWeek] = useState(schedule?.dayOfWeek ?? 1)
  const [paymentType, setPaymentType] = useState<ExpensePaymentType>(
    schedule?.paymentType ?? 'direct',
  )
  const [supplierId, setSupplierId] = useState<number | null>(schedule?.supplierId ?? null)
  const [bankAccountId, setBankAccountId] = useState<number | null>(
    schedule?.bankAccountId ?? bankAccounts[0]?.id ?? null,
  )
  const [categoryId, setCategoryId] = useState<number>(categories[0]?.id ?? 0)
  const [amount, setAmount] = useState(schedule?.totalIncl ?? 0)
  const [startsOn, setStartsOn] = useState(schedule?.startsOn ?? todayIso())
  const [endsOn, setEndsOn] = useState(schedule?.endsOn ?? '')

  // Re-seed when a different schedule is opened for editing.
  const [seededFor, setSeededFor] = useState<number | null>(schedule?.id ?? null)
  if (open && schedule && seededFor !== schedule.id) {
    setSeededFor(schedule.id)
    setName(schedule.name)
    setFrequency(schedule.frequency)
    setDayOfMonth(schedule.dayOfMonth ?? 1)
    setDayOfWeek(schedule.dayOfWeek ?? 1)
    setPaymentType(schedule.paymentType)
    setSupplierId(schedule.supplierId)
    setBankAccountId(schedule.bankAccountId)
    setAmount(schedule.totalIncl)
    setStartsOn(schedule.startsOn)
    setEndsOn(schedule.endsOn ?? '')
  }

  const isBill = paymentType === 'on_account'
  const isWeekly = frequency === 'weekly'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={schedule ? 'Edit schedule' : 'New recurring expense'}
    >
      <div className="space-y-4">
        <Field label="Name" hint="What it is, in your words.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Shop rent"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How often">
            <Select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </Select>
          </Field>

          {isWeekly ? (
            <Field label="On which day">
              <Select value={String(dayOfWeek)} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field
              label="On which day of the month"
              hint="A 31 here falls on the last day in shorter months."
            >
              <Input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)}
                className="max-w-24"
              />
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind">
            <Select
              value={paymentType}
              onChange={(e) => setPaymentType(e.target.value as ExpensePaymentType)}
            >
              <option value="direct">Paid now — comes out of an account</option>
              <option value="on_account">Bill — goes on a supplier account</option>
            </Select>
          </Field>

          {isBill ? (
            <Field label="Supplier">
              <Select
                value={String(supplierId ?? '')}
                onChange={(e) => setSupplierId(Number(e.target.value) || null)}
              >
                <option value="">— Choose —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Paid from">
              <Select
                value={String(bankAccountId ?? '')}
                onChange={(e) => setBankAccountId(Number(e.target.value) || null)}
              >
                <option value="">— Choose —</option>
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <Select value={String(categoryId)} onChange={(e) => setCategoryId(Number(e.target.value))}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.accountCode} · {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Usual amount" hint="Corrected on the draft when the bill differs.">
            <CurrencyInput
              value={amount}
              onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Ends on" hint="Leave blank to run until paused.">
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>

        <div className="flex justify-between">
          {schedule ? (
            <Button variant="danger-ghost" onClick={() => onDelete(schedule.id)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || !name.trim() || amount <= 0}
              onClick={() =>
                onSave(
                  {
                    name: name.trim(),
                    frequency,
                    dayOfMonth: isWeekly ? null : dayOfMonth,
                    dayOfWeek: isWeekly ? dayOfWeek : null,
                    paymentType,
                    supplierId,
                    supplierName: suppliers.find((s) => s.id === supplierId)?.name ?? null,
                    bankAccountId: isBill ? null : bankAccountId,
                    startsOn,
                    endsOn: endsOn || null,
                    lines: [{ categoryId, vatRatePct: defaultVatRate, lineIncl: amount }],
                  },
                  schedule?.id,
                )
              }
            >
              {schedule ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
