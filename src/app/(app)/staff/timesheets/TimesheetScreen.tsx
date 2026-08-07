'use client'

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  StatStrip,
  StatTile,
  TableToolbar,
  Textarea,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatClock, formatDuration, type TimeEntry } from '@/lib/timeModel'
import {
  canApprove,
  payrollHours,
  BCEA_MULTIPLIERS,
  type PayMultipliers,
  type PersonTimesheet,
} from '@/lib/timesheetModel'
import {
  approveAction,
  unapproveAction,
  editEntryAction,
  addEntryAction,
  deleteEntryAction,
} from './actions'

type Person = { id: number; name: string }

/**
 * The timesheet.
 *
 * One person per card, days down the side. A grid of everybody × every day
 * looks efficient and is unreadable at fifteen staff — and approval is a
 * per-person decision anyway, so the card is the unit of work.
 */
export default function TimesheetScreen({
  sheets,
  from,
  to,
  people,
  selectedUserId,
  rates = BCEA_MULTIPLIERS,
  canEdit,
  canApprove: mayApprove,
}: {
  sheets: PersonTimesheet[]
  from: string
  to: string
  people: Person[]
  selectedUserId: number | null
  /** What this store pays, which may differ from the BCEA defaults. */
  rates?: PayMultipliers
  canEdit: boolean
  canApprove: boolean
}) {
  const [editing, setEditing] = useState<TimeEntry | null>(null)
  const [adding, setAdding] = useState<{ userId: number; date: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()
  const params = useSearchParams()

  function go(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    router.push(`/staff/timesheets?${next.toString()}`)
  }

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) return toast.error(result.error ?? 'That did not work.')
      toast.success(result.message ?? 'Done.')
      router.refresh()
    })
  }

  const shift = (days: number) => {
    const move = (iso: string) => {
      const d = new Date(`${iso}T00:00:00`)
      d.setDate(d.getDate() + days)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    go({ from: move(from), to: move(to) })
  }

  const totals = sheets.reduce(
    (acc, s) => ({
      ordinary: acc.ordinary + s.ordinaryMinutes,
      overtime: acc.overtime + s.overtimeMinutes,
      premium: acc.premium + s.premiumMinutes,
    }),
    { ordinary: 0, overtime: 0, premium: 0 },
  )

  return (
    <>
      <TableToolbar
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" iconOnly aria-label="Previous week" onClick={() => shift(-7)}>
              <Icons.ChevronLeft size={16} />
            </Button>
            <Button variant="ghost" size="sm" iconOnly aria-label="Next week" onClick={() => shift(7)}>
              <Icons.ChevronRight size={16} />
            </Button>
          </div>
        }
      >
        <Field label="" className="min-w-[9rem]">
          <Input type="date" value={from} onChange={(e) => go({ from: e.target.value })} />
        </Field>
        <Field label="" className="min-w-[9rem]">
          <Input type="date" value={to} onChange={(e) => go({ to: e.target.value })} />
        </Field>

        {people.length > 0 && (
          <Field label="" className="min-w-[12rem]">
            <Select
              aria-label="Person"
              value={selectedUserId ? String(selectedUserId) : ''}
              onChange={(e) => go({ user: e.target.value || null })}
            >
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </TableToolbar>

      <StatStrip>
        <StatTile
          label="Ordinary"
          value={formatDuration(totals.ordinary)}
          icon={<Icons.Clock size={16} />}
        />
        <StatTile
          label="Overtime"
          value={formatDuration(totals.overtime)}
          hint={`Paid at ${rates.overtime}× — BCEA s10`}
          tone={totals.overtime > 0 ? 'warning' : 'default'}
          icon={<Icons.Clock size={16} />}
        />
        <StatTile
          label="Sunday & holidays"
          value={formatDuration(totals.premium)}
          hint={
            // A range, because s16(2) pays less to somebody who ordinarily
            // works Sundays. Collapses to a single figure when a store has
            // agreed the same rate for both, so it never reads as "1.5–1.5×".
            rates.sundayOrdinary === rates.sunday
              ? `${rates.sunday}× — BCEA s16`
              : `${rates.sundayOrdinary}–${rates.sunday}× — BCEA s16, s18`
          }
          tone={totals.premium > 0 ? 'warning' : 'default'}
          icon={<Icons.CalendarRange size={16} />}
        />
        <StatTile
          label="People"
          value={String(sheets.length)}
          icon={<Icons.Users size={16} />}
        />
      </StatStrip>

      {sheets.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing worked in this period"
            hint="Try a different week, or check that people are clocking in."
            icon={<Icons.Clock size={28} strokeWidth={1.75} />}
          />
        </Card>
      ) : (
        sheets.map((sheet) => (
          <PersonCard
            key={sheet.userId}
            sheet={sheet}
            from={from}
            to={to}
            canEdit={canEdit}
            canApprove={mayApprove}
            pending={pending}
            onEdit={setEditing}
            onAdd={(date) => setAdding({ userId: sheet.userId, date })}
            onApprove={() => run(() => approveAction(sheet.userId, from, to))}
            onUnapprove={() => run(() => unapproveAction(sheet.userId, from, to))}
            onDelete={(id) => run(() => deleteEntryAction(id))}
          />
        ))
      )}

      {editing && <EditModal entry={editing} onClose={() => setEditing(null)} />}
      {adding && (
        <AddModal
          userId={adding.userId}
          date={adding.date}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  )
}

function PersonCard({
  sheet,
  canEdit,
  canApprove: mayApprove,
  pending,
  onEdit,
  onAdd,
  onApprove,
  onUnapprove,
  onDelete,
}: {
  sheet: PersonTimesheet
  from: string
  to: string
  canEdit: boolean
  canApprove: boolean
  pending: boolean
  onEdit: (entry: TimeEntry) => void
  onAdd: (date: string) => void
  onApprove: () => void
  onUnapprove: () => void
  onDelete: (entryId: number) => void
}) {
  const hours = payrollHours(sheet)
  const allowed = canApprove(sheet)
  const fullyApproved = sheet.entryCount > 0 && sheet.approvedCount === sheet.entryCount

  return (
    <Card>
      <CardHeader
        title={sheet.userName}
        // Sundays and holidays are named apart now that they are banded
        // apart — they carry different rates, and "Sunday or holiday" left
        // somebody to work out which from the dates.
        description={`${hours.total} h — ${hours.ordinary} ordinary${
          hours.overtime ? `, ${hours.overtime} overtime` : ''
        }${hours.sunday ? `, ${hours.sunday} Sunday` : ''}${
          hours.holiday ? `, ${hours.holiday} public holiday` : ''
        }. Ordinary week ${sheet.ordinaryHoursPw} h.`}
        action={
          mayApprove ? (
            fullyApproved ? (
              <div className="flex items-center gap-2">
                <Badge tone="success">Approved</Badge>
                <Button variant="ghost" size="sm" disabled={pending} onClick={onUnapprove}>
                  Reopen
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={pending || !allowed.ok}
                title={allowed.ok ? undefined : allowed.reason}
                onClick={onApprove}
              >
                <Icons.Check size={15} />
                Approve
              </Button>
            )
          ) : undefined
        }
      />

      {!allowed.ok && !fullyApproved && sheet.entryCount > 0 && (
        <div className="px-5 pt-4">
          <Callout tone="warning">{allowed.reason}</Callout>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>Day</th>
              <th className={TABLE_TH}>Shifts</th>
              <th className={`${TABLE_TH} text-right`}>Worked</th>
              {canEdit && <th className={`${TABLE_TH} text-right`}>&nbsp;</th>}
            </tr>
          </thead>
          <tbody>
            {sheet.days.map((day) => (
              <tr key={day.date} className={TABLE_ROW}>
                <td className={TABLE_TD}>
                  <div className="flex items-center gap-2">
                    <span className={day.minutes > 0 ? 'text-ink' : 'text-muted'}>
                      {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    {/* Both carry their own rate, so both are named rather than
                        left for somebody to work out from the date. */}
                    {day.isPublicHoliday ? (
                      <Badge tone="warning">Public holiday</Badge>
                    ) : day.isSunday && day.minutes > 0 ? (
                      <Badge tone="warning">Sunday</Badge>
                    ) : null}
                    {day.approved && <Badge tone="success">Approved</Badge>}
                  </div>
                </td>

                <td className={TABLE_TD}>
                  {day.entries.length === 0 ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {day.entries.map((e) => (
                        <div key={e.id} className="flex items-center gap-2 text-sm">
                          <span className="text-ink-2">
                            {formatClock(e.startedAt)}–{e.endedAt ? formatClock(e.endedAt) : 'now'}
                          </span>
                          {e.breakMinutes > 0 && (
                            <span className="text-xs text-muted">
                              less {e.breakMinutes}m break
                            </span>
                          )}
                          {e.endedAt === null && <Badge tone="warning">Open</Badge>}
                          {/* An amendment is visible on the row, not buried in
                              an audit screen — that is what makes it trusted. */}
                          {e.editedReason && (
                            <span title={`${e.editedReason} — ${e.editedByName}`}>
                              <Icons.Pencil size={12} className="text-muted" />
                            </span>
                          )}
                          {e.source === 'manual' && <Badge tone="neutral">Entered</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                </td>

                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {day.minutes > 0 ? (
                    <span className="text-ink">{formatDuration(day.minutes)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>

                {canEdit && (
                  <td className={`${TABLE_TD} text-right`}>
                    <div className="flex justify-end gap-1">
                      {day.entries.map((e) => (
                        <span key={e.id} className="flex gap-1">
                          {!e.approvedAt && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                iconOnly
                                aria-label={`Edit ${formatClock(e.startedAt)}`}
                                onClick={() => onEdit(e)}
                              >
                                <Icons.Pencil size={14} />
                              </Button>
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                iconOnly
                                disabled={pending}
                                aria-label={`Remove ${formatClock(e.startedAt)}`}
                                onClick={() => onDelete(e.id)}
                              >
                                <Icons.Trash size={14} />
                              </Button>
                            </>
                          )}
                        </span>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Add a shift on ${day.date}`}
                        onClick={() => onAdd(day.date)}
                      >
                        <Icons.Plus size={14} />
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function EditModal({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  const [startedAt, setStartedAt] = useState(toLocalInput(new Date(entry.startedAt)))
  const [endedAt, setEndedAt] = useState(
    entry.endedAt ? toLocalInput(new Date(entry.endedAt)) : '',
  )
  const [breakMinutes, setBreakMinutes] = useState(String(entry.breakMinutes))
  const [note, setNote] = useState(entry.note ?? '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await editEntryAction(
        entry.id,
        {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: endedAt ? new Date(endedAt).toISOString() : null,
          breakMinutes: Number(breakMinutes) || 0,
          note: note.trim() || null,
        },
        reason,
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
      title={`Correct ${entry.userName}'s shift`}
      description="The change is recorded with your name and reason against it."
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

        {entry.editedReason && (
          <Callout tone="neutral" title="Already amended once">
            {entry.editedReason} — {entry.editedByName}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Started">
            <Input
              type="datetime-local"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
            />
          </Field>
          <Field label="Ended" hint="Leave blank to leave them on the clock.">
            <Input
              type="datetime-local"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Unpaid break (minutes)">
          <NumberInput
            value={breakMinutes}
            onChange={(e) => setBreakMinutes(e.target.value)}
            className="max-w-[8rem]"
          />
        </Field>

        <Field label="Reason" hint="Required. It appears beside the shift from now on.">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Forgot to clock out — left at 17:00"
          />
        </Field>

        <Field label="Note" hint="Optional.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}

function AddModal({
  userId,
  date,
  onClose,
}: {
  userId: number
  date: string
  onClose: () => void
}) {
  const [startedAt, setStartedAt] = useState(`${date}T08:00`)
  const [endedAt, setEndedAt] = useState(`${date}T17:00`)
  const [breakMinutes, setBreakMinutes] = useState('0')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await addEntryAction({
        userId,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: endedAt ? new Date(endedAt).toISOString() : null,
        breakMinutes: Number(breakMinutes) || 0,
        note: note.trim() || null,
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
      title="Add a shift"
      description="For somebody who worked but never clocked. It is marked as entered by hand."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Started">
            <Input
              type="datetime-local"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
            />
          </Field>
          <Field label="Ended">
            <Input
              type="datetime-local"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Unpaid break (minutes)">
          <NumberInput
            value={breakMinutes}
            onChange={(e) => setBreakMinutes(e.target.value)}
            className="max-w-[8rem]"
          />
        </Field>

        <Field label="Note" hint="Optional — why this was entered by hand.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}

/** A Date as the value a datetime-local input expects, in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
