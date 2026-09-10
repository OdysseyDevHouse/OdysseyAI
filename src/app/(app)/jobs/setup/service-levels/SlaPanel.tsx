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
  Select,
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
import type { JobPriority } from '@/lib/jobStatusModel'
import type { SlaPolicy } from '@/lib/site/jobSla'
import {
  savePolicyAction,
  createPolicyAction,
  deletePolicyAction,
  saveTradingHoursAction,
} from '../../actions'

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
  customers,
  users,
  tradingDays,
  opensAt,
  closesAt,
  skipHolidays,
  untargetedCount,
}: {
  policies: SlaPolicy[]
  /** For the per-customer promise picker (164). */
  customers: { id: number; name: string }[]
  /** Who an escalation can be addressed to. */
  users: { id: number; name: string }[]
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
  // Escalation (164), on both the edit and the create dialog: a business
  // default can escalate too, and restricting it to per-customer promises
  // would be an arbitrary rule nobody could guess.
  const [escalateHours, setEscalateHours] = useState('')
  const [escalateTo, setEscalateTo] = useState('')

  /* Creating a promise for one customer (164). Its own dialog state, because
     `editing` being null is what tells the edit dialog to stay shut. */
  const [creating, setCreating] = useState(false)
  const [newCustomer, setNewCustomer] = useState('')
  const [newPriority, setNewPriority] = useState<JobPriority>('high')

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
    setEscalateHours(
      policy.escalateAfterMinutes === null ? '' : String(policy.escalateAfterMinutes / 60),
    )
    setEscalateTo(policy.escalateToUserId === null ? '' : String(policy.escalateToUserId))
  }

  function openNew() {
    setCreating(true)
    setNewCustomer('')
    setNewPriority('high')
    setName('')
    setRespondHours('')
    setResolveHours('')
    setActive(true)
    setEscalateHours('')
    setEscalateTo('')
  }

  /** Hours as typed, to stored minutes. Blank is "no promise", never zero. */
  function hoursToMinutes(text: string): number | null {
    const trimmed = text.trim()
    if (trimmed === '') return null
    const hours = Number(trimmed)
    return Number.isFinite(hours) ? Math.round(hours * 60) : NaN
  }

  function createForCustomer() {
    if (newCustomer === '') return
    const respond = hoursToMinutes(respondHours)
    const resolve = hoursToMinutes(resolveHours)
    const escalate = hoursToMinutes(escalateHours)
    if (Number.isNaN(respond) || Number.isNaN(resolve) || Number.isNaN(escalate)) {
      toast.error('Those hours are not a number.')
      return
    }
    start(async () => {
      const result = await createPolicyAction({
        priority: newPriority,
        name: name.trim() || `${customers.find((c) => String(c.id) === newCustomer)?.name ?? 'Customer'} — ${newPriority}`,
        respondMinutes: respond,
        resolveMinutes: resolve,
        isActive: active,
        note: null,
        customerId: Number(newCustomer),
        escalateAfterMinutes: escalate,
        escalateToUserId: escalateTo === '' ? null : Number(escalateTo),
      })
      if (result.ok) {
        toast.success('Promise added.')
        setCreating(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(policy: SlaPolicy) {
    start(async () => {
      const result = await deletePolicyAction(policy.id)
      if (result.ok) {
        toast.success('Promise removed.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function savePolicy() {
    if (!editing) return
    const respond = hoursToMinutes(respondHours)
    const resolve = hoursToMinutes(resolveHours)
    const escalate = hoursToMinutes(escalateHours)
    if (Number.isNaN(respond) || Number.isNaN(resolve) || Number.isNaN(escalate)) {
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
        escalateAfterMinutes: escalate,
        escalateToUserId: escalateTo === '' ? null : Number(escalateTo),
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
          description="Two promises per priority: how fast somebody answers, and how fast it is fixed. Both count business hours only. A customer with their own agreement can be given a promise of their own."
          action={
            <Button variant="secondary" size="sm" onClick={openNew}>
              <Icons.Plus size={14} />
              Promise to a customer
            </Button>
          }
        />
        <CardBody className="p-0">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Priority</th>
                <th className={TABLE_TH}>Applies to</th>
                <th className={TABLE_TH}>First response</th>
                <th className={TABLE_TH}>Resolved</th>
                <th className={TABLE_TH}>Escalates</th>
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
                  {/* "Everybody" rather than a blank: a row that applied to
                      nobody would look like a mistake, and this is the promise
                      most jobs are actually measured against. */}
                  <td className={TABLE_TD}>
                    {policy.customerId === null ? (
                      <span className="text-muted">Everybody</span>
                    ) : (
                      <span className="text-ink-2">{policy.customerName ?? 'A customer'}</span>
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
                  {/* BOTH a delay and a person, or nothing happens — a
                      half-filled rule is incomplete rather than instant, and
                      the row says which it is. */}
                  <td className={TABLE_TD}>
                    {policy.escalateAfterMinutes === null || policy.escalateToUserId === null ? (
                      <span className="text-muted">No</span>
                    ) : (
                      <span className="text-ink-2">
                        after {formatBusinessMinutes(policy.escalateAfterMinutes, hoursPerDay)}
                      </span>
                    )}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Edit ${policy.name}`}
                        onClick={() => openPolicy(policy)}
                      >
                        <Icons.Pencil size={15} />
                      </Button>
                      {/* Only a per-customer promise can go. The four business
                          defaults are what every job with no customer policy is
                          measured against; the action refuses it too. */}
                      {policy.customerId !== null && (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${policy.name}`}
                          disabled={pending}
                          onClick={() => remove(policy)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      )}
                    </div>
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

          <EscalationFields
            hours={escalateHours}
            onHours={setEscalateHours}
            userId={escalateTo}
            onUserId={setEscalateTo}
            users={users}
          />
        </div>
      </Modal>

      {/* ── A promise made to ONE customer (164, §17.5) ───────────────────── */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Promise to a customer"
        size="sm"
        /* Five fields plus two mapped lists in an `sm` panel — the narrow width
           makes it taller, so this hits the cap sooner than a wide dialog. */
        bodyGrows
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={createForCustomer}
              disabled={pending || newCustomer === ''}
            >
              {pending ? 'Saving…' : 'Add promise'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            This customer&apos;s jobs at this priority will be measured against these figures
            instead of the business-wide promise. Every other customer is unaffected.
          </p>

          <Field label="Customer">
            <Select value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)}>
              <option value="">Choose…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Priority" hint="One promise per priority, per customer.">
            <Select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as JobPriority)}
            >
              {(['urgent', 'high', 'normal', 'low'] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Name" hint="Optional. Left blank it is named after the customer.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>

          <Field label="Respond within" hint="Business hours. Blank for no promise.">
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

          <Field label="Resolved within" hint="Business hours. Blank is common.">
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

          <EscalationFields
            hours={escalateHours}
            onHours={setEscalateHours}
            userId={escalateTo}
            onUserId={setEscalateTo}
            users={users}
          />
        </div>
      </Modal>
    </>
  )
}

/**
 * Escalation, on both dialogs.
 *
 * Extracted because the edit and create forms ask exactly the same two
 * questions, and two copies is how the hint on one goes stale.
 *
 * BOTH fields or neither: the sweep skips a policy with only one of them, so
 * the hint says so rather than leaving somebody to discover that a half-filled
 * rule silently does nothing.
 */
function EscalationFields({
  hours,
  onHours,
  userId,
  onUserId,
  users,
}: {
  hours: string
  onHours: (next: string) => void
  userId: string
  onUserId: (next: string) => void
  users: { id: number; name: string }[]
}) {
  return (
    <>
      <Field
        label="Tell somebody after"
        hint="Business hours from when the job was logged. Below the response promise warns before it is due; above chases it after. Blank for never."
      >
        <div className="flex items-center gap-2">
          <div className="w-24">
            <Input
              value={hours}
              onChange={(e) => onHours(e.target.value)}
              inputMode="decimal"
              placeholder="2"
            />
          </div>
          <span className="text-sm text-muted">hours</span>
        </div>
      </Field>

      <Field
        label="Tell who"
        hint="They get a notification, once per job. Both this and the hours are needed before anything is sent."
      >
        <Select value={userId} onChange={(e) => onUserId(e.target.value)}>
          <option value="">Nobody</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  )
}
