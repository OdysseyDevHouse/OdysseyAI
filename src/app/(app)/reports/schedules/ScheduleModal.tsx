'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Checkbox,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { PERIOD_KEYS, PERIOD_LABELS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { saveScheduleAction } from './actions'

export type ReportOption = { id: string; name: string; group: string }
export type UserOption = { id: number; name: string; email: string }

export type ScheduleRow = {
  id: number
  name: string
  isActive: boolean
  reportId: string
  reportName: string
  cadence: string
  nextSend: string | null
  periodKey: string
  frequency: string
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
  recipientUserIds: number[]
  recipientEmails: string[]
  attachCsv: boolean
  includeHtml: boolean
  message: string
  createdByName: string
  lastRunAt: string | null
  lastRunStatus: string
  lastRunError: string
  recipientCount: number
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Creating or editing a schedule.
 *
 * Opened from the schedules screen and from a report's own toolbar — the second
 * is the path most people take, because "email me this" is a thought you have
 * while looking at a report, not while browsing a settings list.
 */
export default function ScheduleModal({
  schedule,
  reportOptions,
  users,
  reportId: fixedReportId,
  reportName,
  defaultPeriod,
  onClose,
}: {
  schedule?: ScheduleRow | null
  reportOptions?: ReportOption[]
  users?: UserOption[]
  /** Set when opened from a report — the report is then not choosable. */
  reportId?: string
  reportName?: string
  defaultPeriod?: PeriodKey
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  const [name, setName] = useState(
    schedule?.name ?? (reportName ? `${reportName} by email` : ''),
  )
  const [reportId, setReportId] = useState(
    schedule?.reportId ?? fixedReportId ?? reportOptions?.[0]?.id ?? '',
  )
  const [periodKey, setPeriodKey] = useState<string>(
    schedule?.periodKey ?? defaultPeriod ?? 'yesterday',
  )
  const [frequency, setFrequency] = useState(schedule?.frequency ?? 'daily')
  const [sendTime, setSendTime] = useState(schedule?.sendTime ?? '07:00')
  const [daysOfWeek, setDaysOfWeek] = useState(schedule?.daysOfWeek ?? '1111100')
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1)
  const [userIds, setUserIds] = useState<number[]>(schedule?.recipientUserIds ?? [])
  const [emailText, setEmailText] = useState((schedule?.recipientEmails ?? []).join(', '))
  const [attachCsv, setAttachCsv] = useState(schedule?.attachCsv ?? true)
  const [includeHtml, setIncludeHtml] = useState(schedule?.includeHtml ?? true)
  const [message, setMessage] = useState(schedule?.message ?? '')
  const [isActive, setIsActive] = useState(schedule?.isActive ?? true)

  /** Report options bucketed by category, so a long list stays navigable. */
  const grouped = useMemo(() => {
    const out = new Map<string, ReportOption[]>()
    for (const option of reportOptions ?? []) {
      const list = out.get(option.group) ?? []
      list.push(option)
      out.set(option.group, list)
    }
    return [...out.entries()]
  }, [reportOptions])

  function toggleDay(index: number) {
    const chars = daysOfWeek.split('')
    chars[index] = chars[index] === '1' ? '0' : '1'
    setDaysOfWeek(chars.join(''))
  }

  function save() {
    startSaving(async () => {
      const result = await saveScheduleAction({
        id: schedule?.id ?? null,
        name,
        reportId,
        periodKey,
        frequency,
        sendTime,
        daysOfWeek,
        dayOfMonth,
        recipientUserIds: userIds,
        recipientEmails: emailText.split(',').map((e) => e.trim()).filter(Boolean),
        attachCsv,
        includeHtml,
        message,
        isActive,
      })

      if (result.ok) {
        toast.success(schedule ? 'Schedule updated.' : 'Schedule created.')
        onClose()
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={schedule ? 'Edit schedule' : 'Schedule this report'}
      description="It will run and email itself on this timer, with nobody signed in."
      size="lg"
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      // Half-typed recipient lists are easy to lose to a stray backdrop click.
      closeOnBackdrop={false}
      footer={
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={isActive} onChange={setIsActive} aria-label="Schedule is active" />
            {isActive ? 'On' : 'Off'}
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              <Icons.Save size={16} />
              {saving ? 'Saving…' : schedule ? 'Save changes' : 'Create schedule'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Daily cash-up to the owner"
            maxLength={120}
          />
        </Field>

        {fixedReportId ? (
          <Field label="Report">
            <div className="flex h-control items-center rounded-control border border-border bg-surface-2 px-3 text-sm text-ink-2">
              {reportName}
            </div>
          </Field>
        ) : (
          <Field label="Report">
            <Select value={reportId} onChange={(e) => setReportId(e.target.value)}>
              {grouped.map(([group, options]) => (
                <optgroup key={group} label={group}>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Period it covers"
          hint="Worked out fresh on every send, so “yesterday” always means the day before it goes."
        >
          <Select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
            {PERIOD_KEYS.filter((k) => k !== 'custom').map((k) => (
              <option key={k} value={k}>
                {PERIOD_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        {/* ── when ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="How often">
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              <option value="daily">Every day</option>
              <option value="weekly">Certain days of the week</option>
              <option value="monthly">Once a month</option>
            </Select>
          </Field>
          <Field label="Time">
            <Input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
          </Field>
        </div>

        {frequency === 'weekly' && (
          <Field label="Days">
            <div className="flex flex-wrap gap-1.5">
              {DAY_NAMES.map((day, i) => (
                <Button
                  key={day}
                  variant={daysOfWeek[i] === '1' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => toggleDay(i)}
                  aria-pressed={daysOfWeek[i] === '1'}
                >
                  {day}
                </Button>
              ))}
            </div>
          </Field>
        )}

        {frequency === 'monthly' && (
          <Field
            label="Day of the month"
            hint="A day later than the month has is moved to its last day, so month-end always sends."
          >
            <Input
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)}
              className="w-24"
            />
          </Field>
        )}

        {/* ── who ───────────────────────────────────────────────────────── */}
        <Field
          label="Send to"
          hint="People are looked up fresh each time, so someone who changes their email keeps receiving it."
        >
          {/* Bounded on purpose: a recipient picker among the schedule's other
               fields. Unbounded, a long list would push the form off screen. */}
          <div className="flex max-h-[24vh] min-h-40 flex-col gap-1 overflow-y-auto rounded-control border border-border p-2">
            {(users ?? []).length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted">
                Nobody here has an email address on their profile yet.
              </p>
            ) : (
              (users ?? []).map((u) => (
                <label
                  key={u.id}
                  className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 hover:bg-surface-2"
                >
                  <Checkbox
                    checked={userIds.includes(u.id)}
                    onChange={() =>
                      setUserIds((ids) =>
                        ids.includes(u.id) ? ids.filter((i) => i !== u.id) : [...ids, u.id],
                      )
                    }
                    aria-label={u.name}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{u.name}</span>
                  <span className="truncate text-xs text-muted">{u.email}</span>
                </label>
              ))
            )}
          </div>
        </Field>

        <Field
          label="Also send to these addresses"
          hint="For an accountant or bookkeeper who does not have a login here. Separate with commas."
        >
          <Input
            value={emailText}
            onChange={(e) => setEmailText(e.target.value)}
            placeholder="accountant@example.com, owner@example.com"
          />
        </Field>

        {/* ── what ──────────────────────────────────────────────────────── */}
        <Field label="Message" hint="Optional line above the figures in the email.">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="e.g. Yesterday's takings — any variance over R100 needs a note."
          />
        </Field>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={includeHtml} onChange={() => setIncludeHtml(!includeHtml)} />
            Show the figures in the email itself
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={attachCsv} onChange={() => setAttachCsv(!attachCsv)} />
            Attach the full report as a spreadsheet
          </label>
        </div>
      </div>
    </Modal>
  )
}
