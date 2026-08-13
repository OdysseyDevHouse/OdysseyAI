'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Icons,
  Input,
  Modal,
  Switch,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import {
  DAY_MASK_LABELS,
  describeDayMask,
  formatBusinessMinutes,
  isDayMask,
  parseClock,
} from '@/lib/jobStatusModel'
import type { SlaPolicy } from '@/lib/site/jobSla'
import { savePolicyAction, saveTradingHoursAction } from '../../jobs/actions'

/**
 * What this business promises, and the week it promises it in.
 *
 * ── WHY THE TARGETS ARE TYPED IN HOURS AND STORED IN MINUTES ───────────────
 *
 * Nobody says "respond within 240 minutes". Minutes are the right storage unit —
 * a 90-minute promise is real and 1.5 hours is a rounding argument waiting to
 * happen — but the field takes hours because that is the unit the promise is made
 * in. The conversion happens here, once, and the row shows both.
 *
 * ── WHY BUSINESS HOURS ARE SPELLED OUT ON THE SCREEN ───────────────────────
 *
 * The whole reason to use business hours is that a job logged Friday afternoon is
 * not breached by Monday morning. The cost is that the deadline is no longer
 * obvious from the logged time, so somebody staring at "due Monday 11:00" needs to
 * be able to work out why. The worked example under the trading hours is that
 * explanation, and it recalculates as the fields change rather than being a static
 * sentence that goes stale.
 */
export default function SlaPanel({
  policies,
  tradingDays,
  opensAt,
  closesAt,
  skipHolidays,
  untargetedCount,
}: {
  policies: SlaPolicy[]
  tradingDays: string
  opensAt: string
  closesAt: string
  skipHolidays: boolean
  untargetedCount: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [days, setDays] = useState(isDayMask(tradingDays) ? tradingDays : '1111100')
  const [opens, setOpens] = useState(opensAt)
  const [closes, setCloses] = useState(closesAt)
  const [skip, setSkip] = useState(skipHolidays)

  const [editing, setEditing] = useState<SlaPolicy | null>(null)
  const [name, setName] = useState('')
  const [respondHours, setRespondHours] = useState('')
  const [resolveHours, setResolveHours] = useState('')
  const [active, setActive] = useState(true)

  const openMins = parseClock(opens)
  const closeMins = parseClock(closes)
  const hoursPerDay =
    openMins !== null && closeMins !== null && closeMins > openMins
      ? (closeMins - openMins) / 60
      : 0

  function toggleDay(index: number) {
    setDays((prev) => {
      const next = [...prev]
      next[index] = next[index] === '1' ? '0' : '1'
      return next.join('')
    })
  }

  function saveHours() {
    start(async () => {
      const result = await saveTradingHoursAction({
        days,
        opensAt: opens,
        closesAt: closes,
        skipHolidays: skip,
      })
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function openPolicy(policy: SlaPolicy) {
    setEditing(policy)
    setName(policy.name)
    // Blank, not '0': no promise and an instant promise are different statements.
    setRespondHours(policy.respondMinutes === null ? '' : String(policy.respondMinutes / 60))
    setResolveHours(policy.resolveMinutes === null ? '' : String(policy.resolveMinutes / 60))
    setActive(policy.isActive)
  }

  function savePolicy() {
    if (!editing) return
    const toMinutes = (text: string): number | null => {
      const trimmed = text.trim()
      if (trimmed === '') return null
      const hours = Number(trimmed)
      return Number.isFinite(hours) ? Math.round(hours * 60) : NaN
    }
    const respond = toMinutes(respondHours)
    const resolve = toMinutes(resolveHours)
    if (Number.isNaN(respond) || Number.isNaN(resolve)) {
      toast.error('A target has to be a number of hours, or blank for no promise.')
      return
    }

    start(async () => {
      const result = await savePolicyAction(editing.id, {
        priority: editing.priority,
        name,
        respondMinutes: respond,
        resolveMinutes: resolve,
        isActive: active,
        note: null,
      })
      if (result.ok) {
        toast.success('Target saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="What we promise"
          description="Two promises per priority: how fast somebody answers, and how fast it is fixed. Both count business hours only."
        />
        <CardBody className="p-0">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Priority</th>
                <th className={TABLE_TH}>First response</th>
                <th className={TABLE_TH}>Resolved</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`} />
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td className={TABLE_TD}>
                    <span className="text-ink">{policy.name}</span>
                    {!policy.isActive && (
                      <Badge tone="neutral" className="ml-2">
                        Off
                      </Badge>
                    )}
                  </td>
                  <td className={TABLE_TD}>
                    {policy.respondMinutes === null ? (
                      <span className="text-muted">No promise</span>
                    ) : (
                      <span className="text-ink-2">
                        {formatBusinessMinutes(policy.respondMinutes, hoursPerDay)}
                      </span>
                    )}
                  </td>
                  <td className={TABLE_TD}>
                    {policy.resolveMinutes === null ? (
                      <span className="text-muted">No promise</span>
                    ) : (
                      <span className="text-ink-2">
                        {formatBusinessMinutes(policy.resolveMinutes, hoursPerDay)}
                      </span>
                    )}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Edit ${policy.name}`}
                      onClick={() => openPolicy(policy)}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>

        {/* Not a warning tone: a job logged before targets existed was never
            promised anything, and back-dating one would invent a promise. */}
        {untargetedCount > 0 && (
          <p className="border-t border-border px-6 py-3 text-xs text-muted">
            {untargetedCount === 1
              ? 'One open job carries no target'
              : `${untargetedCount} open jobs carry no target`}{' '}
            — they were logged before these promises were set up, so nothing was promised for them.
            They are listed on the reconciliation screen and will clear as they close.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="When the clock runs"
          description="A promise of four hours means four hours the doors were open. Work left at closing time resumes at the next opening."
        />
        <CardBody>
          <div className="flex flex-col gap-4">
            <Field label="Open days" hint={describeDayMask(days)}>
              <div className="flex flex-wrap gap-1.5">
                {DAY_MASK_LABELS.map((label, index) => (
                  <Button
                    key={label}
                    variant={days[index] === '1' ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => toggleDay(index)}
                    disabled={pending}
                    aria-pressed={days[index] === '1'}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </Field>

            <div className="flex flex-wrap gap-4">
              <Field label="Opens at">
                <div className="w-28">
                  <Input value={opens} onChange={(e) => setOpens(e.target.value)} placeholder="08:00" />
                </div>
              </Field>
              <Field label="Closes at">
                <div className="w-28">
                  <Input value={closes} onChange={(e) => setCloses(e.target.value)} placeholder="17:00" />
                </div>
              </Field>
            </div>

            <Checkbox
              label="Public holidays stop the clock"
              checked={skip}
              onChange={(e) => setSkip(e.target.checked)}
            />

            {/*
              The worked example, recalculated live.
              This is the screen paying for the choice it made: business hours are
              the right clock but they hide the arithmetic, so the arithmetic is
              shown rather than left for somebody to reverse-engineer from a badge.
            */}
            {hoursPerDay > 0 ? (
              <p className="text-sm text-muted">
                That is <span className="text-ink-2">{hoursPerDay}</span> hours a day,{' '}
                <span className="text-ink-2">{describeDayMask(days)}</span>. A four-hour promise on a
                job logged an hour before closing is due{' '}
                <span className="text-ink-2">three hours into the next open day</span>.
              </p>
            ) : (
              <p className="text-sm text-warning-ink">
                The closing time has to be after the opening one, or no job can be given a target.
              </p>
            )}

            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={saveHours}
                disabled={pending || hoursPerDay <= 0 || !days.includes('1')}
              >
                {pending ? 'Saving…' : 'Save trading hours'}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.name} targets` : 'Targets'}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={savePolicy} disabled={pending || !name.trim()}>
              {pending ? 'Saving…' : 'Save target'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" hint="What this level of urgency is called on screen.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>

          <Field
            label="Respond within"
            hint="Business hours until somebody has to have picked the job up. Blank for no promise."
          >
            <div className="flex items-center gap-2">
              <div className="w-24">
                <Input
                  value={respondHours}
                  onChange={(e) => setRespondHours(e.target.value)}
                  inputMode="decimal"
                  placeholder="4"
                />
              </div>
              <span className="text-sm text-muted">hours</span>
            </div>
          </Field>

          <Field
            label="Resolved within"
            hint="Business hours until the job has to be closed. Blank is common — a fix often waits on a part."
          >
            <div className="flex items-center gap-2">
              <div className="w-24">
                <Input
                  value={resolveHours}
                  onChange={(e) => setResolveHours(e.target.value)}
                  inputMode="decimal"
                  placeholder="24"
                />
              </div>
              <span className="text-sm text-muted">hours</span>
            </div>
          </Field>

          <Switch
            checked={active}
            onChange={setActive}
            label="In use"
            hint="A retired target stops applying to new jobs. Jobs already measured against it keep the deadlines they were given."
          />
        </div>
      </Modal>
    </>
  )
}
