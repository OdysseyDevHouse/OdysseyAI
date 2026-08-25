'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmModal,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  TableToolbar,
  Textarea,
  useToast,
  type Column,
} from '@/components/ui'
import { belowStatutoryMinimum, type LeaveType } from '@/lib/leaveModel'
import { saveLeaveTypeAction, deleteLeaveTypeAction } from './actions'

/**
 * The leave types list.
 *
 * The entitlement column is the point of this screen — it says in words what
 * the four columns behind it (method, days, cycle, cap) add up to, because
 * "cycle_36m / 30 / 36" is not something anybody should have to assemble in
 * their head to check whether their sick leave is right.
 */
export default function LeaveTypesScreen({
  types,
  canEdit,
}: {
  types: LeaveType[]
  canEdit: boolean
}) {
  const [editing, setEditing] = useState<LeaveType | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<LeaveType | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function remove(type: LeaveType) {
    startTransition(async () => {
      const result = await deleteLeaveTypeAction(type.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      setRemoving(null)
      router.refresh()
    })
  }

  const columns: Column<LeaveType>[] = [
    {
      key: 'name',
      header: 'Leave type',
      sortValue: (t) => t.name,
      cell: (t) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{t.name}</span>
            {t.isSystem && <Badge tone="neutral">Standard</Badge>}
            {!t.isActive && <Badge tone="warning">Off</Badge>}
          </div>
          <div className="text-xs text-muted">{t.code}</div>
        </div>
      ),
    },
    {
      key: 'entitlement',
      header: 'What it grants',
      sortValue: (t) => t.accrualDays,
      cell: (t) => {
        const warning = belowStatutoryMinimum(t)
        return (
          <div>
            <span className="text-ink">{describeAccrual(t)}</span>
            {t.maxBalanceDays !== null && (
              <div className="text-xs text-muted">Capped at {t.maxBalanceDays} days</div>
            )}
            {/* The whole reason a store may go below the Act is that these
                numbers assume a five-day week — so this warns and does not
                refuse. It still has to be visible, or it is not a warning. */}
            {warning && (
              <div className="mt-0.5 flex items-start gap-1 text-xs text-warning-ink">
                <Icons.StatusWarning size={13} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
              </div>
            )}
          </div>
        )
      },
    },
    {
      key: 'paid',
      header: 'Paid',
      sortValue: (t) => (t.isPaid ? 1 : 0),
      cell: (t) =>
        t.isPaid ? (
          <Badge tone="success">Paid</Badge>
        ) : (
          <Badge tone="neutral">Unpaid</Badge>
        ),
    },
  ]

  return (
    <>
      {canEdit && (
        <TableToolbar>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icons.Plus size={16} />
            Add a leave type
          </Button>
        </TableToolbar>
      )}

      <Card>
        <DataTable
          columns={columns}
          rows={types}
          getRowKey={(t) => t.id}
          actions={
            canEdit
              ? (t) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Edit ${t.name}`}
                      onClick={() => setEditing(t)}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    {/* A standard type has no delete: it is the only way to
                        record something the Act requires, and the action
                        refuses it regardless of what the screen shows. */}
                    {!t.isSystem && (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        disabled={pending}
                        aria-label={`Delete ${t.name}`}
                        onClick={() => setRemoving(t)}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    )}
                  </div>
                )
              : undefined
          }
          empty={{
            title: 'No leave types',
            hint: 'Add one so leave can be booked against it.',
            icon: <Icons.CalendarRange size={28} strokeWidth={1.75} />,
          }}
        />
      </Card>

      {adding && <TypeForm onClose={() => setAdding(false)} />}
      {editing && <TypeForm type={editing} onClose={() => setEditing(null)} />}

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
        busy={pending}
        title="Delete this leave type?"
        confirmLabel="Delete"
        message={
          <p>
            “{removing?.name}” will be removed. If anybody has already taken leave under it, it
            will be kept and switched off instead — that history has to keep explaining itself.
          </p>
        }
      />
    </>
  )
}

/** "1.25 days a month" / "30 days per 36 months" / "does not accrue". */
function describeAccrual(t: Pick<LeaveType, 'accrualMethod' | 'accrualDays' | 'cycleMonths'>): string {
  const days = `${t.accrualDays} ${t.accrualDays === 1 ? 'day' : 'days'}`
  switch (t.accrualMethod) {
    case 'monthly':
      return `${days} a month`
    case 'annual_grant':
      return `${days} a year`
    case 'cycle_36m':
      return `${days} per ${t.cycleMonths} months`
    case 'none':
    default:
      return 'Does not accrue'
  }
}

const METHODS: { value: LeaveType['accrualMethod']; label: string; hint: string }[] = [
  { value: 'monthly', label: 'A little every month', hint: 'Annual leave. Days build up as the year is worked.' },
  { value: 'annual_grant', label: 'The whole year at once', hint: 'Family responsibility. The full allowance on each anniversary.' },
  { value: 'cycle_36m', label: 'A block per cycle', hint: 'Sick leave. One block per cycle, which does not carry over.' },
  { value: 'none', label: 'Nothing accrues', hint: 'Unpaid and maternity leave. Booked, but nothing is earned.' },
]

/**
 * Adds a type, or edits one.
 *
 * The BCEA warning appears LIVE as the number is typed rather than on save,
 * because a warning that only arrives after the fact reads as an error the
 * person has already made. It never blocks the save.
 */
function TypeForm({ type, onClose }: { type?: LeaveType; onClose: () => void }) {
  const [name, setName] = useState(type?.name ?? '')
  const [code, setCode] = useState(type?.code ?? '')
  const [isPaid, setIsPaid] = useState(type?.isPaid ?? true)
  const [method, setMethod] = useState<LeaveType['accrualMethod']>(type?.accrualMethod ?? 'monthly')
  const [accrualDays, setAccrualDays] = useState(String(type?.accrualDays ?? ''))
  const [cycleMonths, setCycleMonths] = useState(String(type?.cycleMonths ?? 12))
  const [maxBalance, setMaxBalance] = useState(
    type?.maxBalanceDays === null || type?.maxBalanceDays === undefined
      ? ''
      : String(type.maxBalanceDays),
  )
  const [isActive, setIsActive] = useState(type?.isActive ?? true)
  const [notes, setNotes] = useState(type?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const days = Number(accrualDays.replace(',', '.')) || 0
  const warning = type
    ? belowStatutoryMinimum({ code: type.code, accrualMethod: method, accrualDays: days })
    : null

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveLeaveTypeAction(type?.id ?? null, {
        name,
        // A system type's code is held by the server whatever is sent; this
        // only keeps the round-trip honest.
        code: type?.isSystem ? type.code : code.toUpperCase(),
        isPaid,
        accrualMethod: method,
        accrualDays: days,
        cycleMonths: Number(cycleMonths) || 12,
        maxBalanceDays: maxBalance.trim() === '' ? null : Number(maxBalance.replace(',', '.')),
        isActive,
        notes: notes.trim() || null,
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
      title={type ? `Edit ${type.name}` : 'Add a leave type'}
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      description="What this kind of leave grants, and how it arrives."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending || !name.trim()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Study leave" />
          </Field>
          <Field
            label="Code"
            hint={
              type?.isSystem
                ? 'A standard type keeps its code — the statutory minimums are matched on it.'
                : 'Capitals, numbers and underscores.'
            }
          >
            <Input
              value={type?.isSystem ? type.code : code}
              disabled={type?.isSystem}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="STUDY"
            />
          </Field>
        </div>

        <Field label="How entitlement arrives" hint={METHODS.find((m) => m.value === method)?.hint}>
          <Select value={method} onChange={(e) => setMethod(e.target.value as LeaveType['accrualMethod'])}>
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>

        {method !== 'none' && (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={method === 'monthly' ? 'Days a month' : 'Days'}>
              <NumberInput
                value={accrualDays}
                onChange={(e) => setAccrualDays(e.target.value)}
                placeholder="1.25"
              />
            </Field>
            {method === 'cycle_36m' && (
              <Field label="Cycle length" hint="In months. The Act measures sick leave over 36.">
                <NumberInput value={cycleMonths} onChange={(e) => setCycleMonths(e.target.value)} />
              </Field>
            )}
          </div>
        )}

        {/* Amber, not red, and outside the Field: this is a caution the person
            may override, and Field's only message tone is danger — which reads
            as a refusal when the save is going to go through. */}
        {warning && <Callout tone="warning">{warning}</Callout>}

        {method !== 'none' && (
          <Field
            label="Cap the balance"
            hint="Optional. Limits what accrues — it never erases days somebody has already earned, which the Act does not allow."
          >
            <NumberInput
              value={maxBalance}
              onChange={(e) => setMaxBalance(e.target.value)}
              placeholder="No cap"
            />
          </Field>
        )}

        <Switch
          checked={isPaid}
          onChange={setIsPaid}
          label="The employer pays for this leave"
          hint="Off for unpaid and maternity leave, where UIF pays instead."
        />

        {!type?.isSystem && (
          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="Available to book"
            hint="Switch off a type you no longer grant. Leave already taken under it is kept."
          />
        )}

        <Field label="Note" hint="Optional. Why this type is set the way it is.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
