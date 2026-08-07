'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CurrencyInput,
  DataTable,
  Field,
  FieldGroup,
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
import { formatMoney } from '@/lib/decimals'
import {
  EMPLOYMENT_TYPES,
  PAY_BASES,
  BCEA_ORDINARY_HOURS_PW,
  EMPLOYMENT_TYPE_LABELS,
  type Employment,
  type EmploymentType,
  type PayBasis,
} from '@/lib/employmentModel'
import { saveEmploymentAction } from './actions'

type Unrecorded = { id: number; name: string }

/**
 * The staff list.
 *
 * Two groups, deliberately: people whose terms are on file, and people who
 * have a login but no terms yet. The second group is the one an owner needs to
 * see — a person with no hourly rate cannot be costed, and they would
 * otherwise appear only as a gap in a report months later.
 */
export default function StaffScreen({
  employment,
  unrecorded,
  canEdit,
}: {
  employment: Employment[]
  unrecorded: Unrecorded[]
  canEdit: boolean
}) {
  const [editing, setEditing] = useState<{ userId: number; name: string; current: Employment | null } | null>(
    null,
  )

  const columns: Column<Employment>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sortValue: (e) => e.userName,
      cell: (e) => (
        <div>
          <div className="font-medium text-ink">{e.userName}</div>
          {e.employeeNumber && <div className="text-xs text-muted">{e.employeeNumber}</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Employment',
      sortable: true,
      sortValue: (e) => e.employmentType,
      cell: (e) => <span className="text-ink-2">{EMPLOYMENT_TYPE_LABELS[e.employmentType]}</span>,
    },
    {
      key: 'hours',
      header: 'Ordinary hours',
      numeric: true,
      sortable: true,
      sortValue: (e) => e.ordinaryHoursPw,
      cell: (e) => (
        <span className="numeric text-ink-2">{e.ordinaryHoursPw}/wk</span>
      ),
    },
    ...(canEdit
      ? [
          {
            key: 'pay',
            header: 'Pay',
            numeric: true,
            sortable: true,
            sortValue: (e: Employment) =>
              e.payBasis === 'hourly' ? (e.hourlyRate ?? 0) : (e.monthlySalary ?? 0),
            cell: (e: Employment) =>
              e.payBasis === 'hourly' ? (
                <span className="numeric text-ink">{formatMoney(e.hourlyRate ?? 0)}/h</span>
              ) : (
                <span className="numeric text-ink">{formatMoney(e.monthlySalary ?? 0)}/m</span>
              ),
          },
        ]
      : []),
    {
      key: 'started',
      header: 'Started',
      sortable: true,
      sortValue: (e) => e.hiredOn ?? '',
      cell: (e) => <span className="text-muted">{e.hiredOn ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (e) => (e.isCurrent ? 1 : 0),
      cell: (e) =>
        e.isCurrent ? (
          <Badge tone="success">Employed</Badge>
        ) : (
          <Badge tone="neutral">Left {e.terminatedOn}</Badge>
        ),
    },
  ]

  return (
    <>
      {unrecorded.length > 0 && canEdit && (
        <Callout
          tone="warning"
          title={`${unrecorded.length} ${unrecorded.length === 1 ? 'person has' : 'people have'} no employment details yet`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>
              They can sign in, but cannot be costed until somebody records what
              they are paid.
            </span>
            <div className="flex flex-wrap gap-1.5">
              {unrecorded.map((u) => (
                <Button
                  key={u.id}
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditing({ userId: u.id, name: u.name, current: null })}
                >
                  <Icons.Plus size={14} />
                  {u.name}
                </Button>
              ))}
            </div>
          </div>
        </Callout>
      )}

      <Card>
        <DataTable
          columns={columns}
          rows={employment}
          getRowKey={(e) => e.userId}
          actions={
            canEdit
              ? (e) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit ${e.userName}`}
                    onClick={() =>
                      setEditing({ userId: e.userId, name: e.userName, current: e })
                    }
                  >
                    <Icons.Pencil size={15} />
                  </Button>
                )
              : undefined
          }
          actionsOnHover
          empty={{
            title: 'No employment details recorded',
            hint: 'Add terms for the people who work here — hours, pay and start date.',
            icon: <Icons.Users size={28} strokeWidth={1.75} />,
          }}
        />
      </Card>

      {editing && (
        <EmploymentForm
          userId={editing.userId}
          name={editing.name}
          current={editing.current}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function EmploymentForm({
  userId,
  name,
  current,
  onClose,
}: {
  userId: number
  name: string
  current: Employment | null
  onClose: () => void
}) {
  const [employeeNumber, setEmployeeNumber] = useState(current?.employeeNumber ?? '')
  const [employmentType, setEmploymentType] = useState<EmploymentType>(
    current?.employmentType ?? 'permanent',
  )
  const [payBasis, setPayBasis] = useState<PayBasis>(current?.payBasis ?? 'hourly')
  const [hourlyRate, setHourlyRate] = useState(current?.hourlyRate ?? 0)
  const [monthlySalary, setMonthlySalary] = useState(current?.monthlySalary ?? 0)
  const [ordinaryHoursPw, setOrdinaryHoursPw] = useState(
    String(current?.ordinaryHoursPw ?? BCEA_ORDINARY_HOURS_PW),
  )
  const [worksSundays, setWorksSundays] = useState(current?.worksSundays ?? false)
  const [hiredOn, setHiredOn] = useState(current?.hiredOn?.slice(0, 10) ?? '')
  const [terminatedOn, setTerminatedOn] = useState(current?.terminatedOn?.slice(0, 10) ?? '')
  const [leaveCycleStart, setLeaveCycleStart] = useState(
    current?.leaveCycleStart?.slice(0, 10) ?? '',
  )
  const [notes, setNotes] = useState(current?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveEmploymentAction(userId, {
        employeeNumber: employeeNumber.trim() || null,
        employmentType,
        payBasis,
        hourlyRate: Number(hourlyRate) || 0,
        monthlySalary: Number(monthlySalary) || 0,
        ordinaryHoursPw: Number(ordinaryHoursPw) || 0,
        worksSundays,
        hiredOn: hiredOn || null,
        terminatedOn: terminatedOn || null,
        leaveCycleStart: leaveCycleStart || null,
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
      title={name}
      description="Employment terms. These feed the hours, leave and cost figures."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        <FieldGroup title="Employment" hint="What kind of arrangement this is.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <Select
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
              >
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Employee number" hint="As it appears in your payroll system.">
              <Input
                value={employeeNumber}
                onChange={(e) => setEmployeeNumber(e.target.value)}
                placeholder="Optional"
              />
            </Field>
          </div>
        </FieldGroup>

        <FieldGroup
          title="Pay"
          hint="Gross, before any deduction. This system produces the figure your payroll takes — it does not calculate PAYE or UIF."
        >
          <Field label="Paid by">
            <Select value={payBasis} onChange={(e) => setPayBasis(e.target.value as PayBasis)}>
              {PAY_BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* Both are shown so a rate survives a change of basis, but only the
              one in force is required — see pay_basis in 053. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Hourly rate"
              hint={payBasis === 'hourly' ? undefined : 'Not in use on a salary.'}
            >
              <CurrencyInput
                value={hourlyRate}
                disabled={payBasis !== 'hourly'}
                onChange={(e) => setHourlyRate(Number(e.target.value) || 0)}
              />
            </Field>

            <Field
              label="Monthly salary"
              hint={payBasis === 'salaried' ? undefined : 'Not in use on an hourly rate.'}
            >
              <CurrencyInput
                value={monthlySalary}
                disabled={payBasis !== 'salaried'}
                onChange={(e) => setMonthlySalary(Number(e.target.value) || 0)}
              />
            </Field>
          </div>

          <Field
            label="Ordinary hours a week"
            hint={`Anything above this is overtime. ${BCEA_ORDINARY_HOURS_PW} is the maximum in section 9 of the BCEA; a part-timer's is lower.`}
          >
            <NumberInput
              value={ordinaryHoursPw}
              onChange={(e) => setOrdinaryHoursPw(e.target.value)}
              className="max-w-[10rem]"
            />
          </Field>

          <Switch
            checked={worksSundays}
            onChange={setWorksSundays}
            label="Ordinarily works Sundays"
            hint="Section 16 of the BCEA pays a Sunday at double, or at one and a half for somebody who ordinarily works them. Leave this off unless Sundays are part of their normal week."
          />
        </FieldGroup>

        <FieldGroup title="Dates">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Started">
              <Input type="date" value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} />
            </Field>

            <Field label="Left" hint="Leave blank while they are still employed.">
              <Input
                type="date"
                value={terminatedOn}
                onChange={(e) => setTerminatedOn(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Leave cycle starts"
            hint="Blank follows the start date, which is what the BCEA measures the annual entitlement from. Set it only if this store runs everybody on a common cycle."
          >
            <Input
              type="date"
              value={leaveCycleStart}
              onChange={(e) => setLeaveCycleStart(e.target.value)}
              className="max-w-[14rem]"
            />
          </Field>
        </FieldGroup>

        <Field label="Notes" hint="Optional.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}
