'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  useToast,
} from '@/components/ui'
import {
  ALERT_KINDS,
  ALERT_KIND_DEFAULT_NAMES,
  ALERT_KIND_DESCRIPTIONS,
  ALERT_KIND_LABELS,
  ALERT_KIND_SUMMARIES,
  defaultConfigFor,
  type AlertConfig,
  type AlertKind,
  type Frequency,
} from '@/lib/alerts/types'
import { saveAlertAction } from './actions'

/** The flattened rule the list hands the modal — everything the editor needs. */
export type AlertRow = {
  id: number
  kind: AlertKind
  kindLabel: string
  name: string
  isActive: boolean
  frequency: Frequency
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
  cadence: string
  nextCheck: string | null
  config: AlertConfig
  notifyBell: boolean
  notifyEmail: boolean
  notifyWhatsapp: boolean
  notifySms: boolean
  recipientUserIds: number[]
  recipientEmails: string[]
  whatsappNumbers: string[]
  smsNumbers: string[]
  recipientCount: number
  createdByName: string
  lastRunAt: string | null
  lastRunStatus: string
  lastRunError: string
}

export type UserOption = { id: number; name: string; email: string | null }

/** Which channels this shop has actually set up — resolved on the server. */
export type ChannelReadiness = { email: boolean; whatsapp: boolean; sms: boolean }

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Creating and editing one rule.
 *
 * Ordered the way somebody describes what they want: WATCH this, CHECK it then,
 * TELL these people. The per-kind knobs sit directly under the kind, because
 * they only make sense next to the thing they qualify.
 */
export default function AlertModal({
  rule,
  users,
  channels,
  onClose,
}: {
  rule: AlertRow | null
  users: UserOption[]
  channels: ChannelReadiness
  onClose: () => void
}) {
  const toast = useToast()
  const router = useRouter()
  const [saving, startSaving] = useTransition()

  const [kind, setKind] = useState<AlertKind>(rule?.kind ?? 'low_stock')
  const [name, setName] = useState(rule?.name ?? ALERT_KIND_DEFAULT_NAMES.low_stock)
  const [isActive, setIsActive] = useState(rule?.isActive ?? true)
  const [config, setConfig] = useState<AlertConfig>(rule?.config ?? defaultConfigFor('low_stock'))

  const [frequency, setFrequency] = useState<Frequency>(rule?.frequency ?? 'daily')
  const [sendTime, setSendTime] = useState(rule?.sendTime ?? '07:00')
  const [daysOfWeek, setDaysOfWeek] = useState(rule?.daysOfWeek ?? '1111100')
  const [dayOfMonth, setDayOfMonth] = useState(rule?.dayOfMonth ?? 1)

  const [notifyBell, setNotifyBell] = useState(rule?.notifyBell ?? true)
  const [notifyEmail, setNotifyEmail] = useState(rule?.notifyEmail ?? false)
  const [notifyWhatsapp, setNotifyWhatsapp] = useState(rule?.notifyWhatsapp ?? false)
  const [notifySms, setNotifySms] = useState(rule?.notifySms ?? false)

  const [userIds, setUserIds] = useState<number[]>(rule?.recipientUserIds ?? [])
  const [emails, setEmails] = useState((rule?.recipientEmails ?? []).join(', '))
  const [whatsapp, setWhatsapp] = useState((rule?.whatsappNumbers ?? []).join(', '))
  const [sms, setSms] = useState((rule?.smsNumbers ?? []).join(', '))

  /**
   * Changing the kind reseeds the name and knobs.
   *
   * The name only when it is still the previous kind's default — somebody who
   * typed "Fresh produce check" must not lose it because they changed their
   * mind about which check it is.
   */
  function onKindChange(next: AlertKind) {
    const wasDefault = Object.values(ALERT_KIND_DEFAULT_NAMES).includes(name.trim())
    setKind(next)
    setConfig(defaultConfigFor(next))
    if (!name.trim() || wasDefault) setName(ALERT_KIND_DEFAULT_NAMES[next])
  }

  function toggleDay(index: number) {
    const mask = daysOfWeek.split('')
    mask[index] = mask[index] === '1' ? '0' : '1'
    setDaysOfWeek(mask.join(''))
  }

  function toggleUser(id: number) {
    setUserIds((current) =>
      current.includes(id) ? current.filter((u) => u !== id) : [...current, id],
    )
  }

  function save() {
    startSaving(async () => {
      const result = await saveAlertAction(rule?.id ?? null, {
        kind,
        name,
        isActive,
        frequency,
        sendTime,
        daysOfWeek,
        dayOfMonth,
        config,
        notifyBell,
        notifyEmail,
        notifyWhatsapp,
        notifySms,
        recipientUserIds: userIds,
        recipientEmails: splitList(emails),
        whatsappNumbers: splitList(whatsapp),
        smsNumbers: splitList(sms),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(rule ? 'Alert saved.' : 'Alert created — it starts at the next check.')
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      size="lg"
      title={rule ? 'Edit alert' : 'New alert'}
      onClose={onClose}
      closeOnBackdrop={false}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Switch
            checked={isActive}
            onChange={setIsActive}
            label={isActive ? 'Watching' : 'Paused'}
          />
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save alert'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What to watch">
          <Select value={kind} onChange={(e) => onKindChange(e.target.value as AlertKind)}>
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ALERT_KIND_LABELS[k]} — {ALERT_KIND_SUMMARIES[k]}
              </option>
            ))}
          </Select>
          <p className="mt-2 text-sm text-muted">{ALERT_KIND_DESCRIPTIONS[kind]}</p>
        </Field>

        <KindConfig kind={kind} config={config} onChange={setConfig} />

        <Field label="Call it" hint="What you will see on the list and in the message.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="How often">
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              <option value="daily">Every day</option>
              <option value="weekly">Certain days of the week</option>
              <option value="monthly">Once a month</option>
            </Select>
          </Field>
          <Field label="At" hint="The shop's own clock.">
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
          <Field label="Day of the month" hint="The 31st runs on the last day of a short month.">
            <NumberInput
              value={dayOfMonth}
              onChange={(v) => setDayOfMonth(Number(v) || 1)}
              min={1}
              max={31}
              className="w-24"
            />
          </Field>
        )}

        <Field label="How to tell you" hint="A check that finds nothing tells nobody.">
          <div className="flex flex-col gap-2">
            <Checkbox
              checked={notifyBell}
              onChange={(e) => setNotifyBell(e.target.checked)}
              label="In the app, on the bell"
            />
            <Checkbox
              checked={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.checked)}
              label={channels.email ? 'By email' : 'By email — not set up for this shop'}
            />
            <Checkbox
              checked={notifyWhatsapp}
              onChange={(e) => setNotifyWhatsapp(e.target.checked)}
              label={channels.whatsapp ? 'On WhatsApp' : 'On WhatsApp — not set up for this shop'}
            />
            <Checkbox
              checked={notifySms}
              onChange={(e) => setNotifySms(e.target.checked)}
              label={channels.sms ? 'By SMS' : 'By SMS — not set up for this shop'}
            />
          </div>
        </Field>

        {(notifyBell || notifyEmail) && (
          <Field
            label="Who to tell"
            hint="Their email is looked up fresh each time, so a change of address keeps working."
          >
            <div className="max-h-40 overflow-y-auto rounded-control border border-border p-2">
              {users.length === 0 ? (
                <p className="p-2 text-sm text-muted">No back-office users to notify.</p>
              ) : (
                users.map((u) => (
                  <label
                    key={u.id}
                    className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 hover:bg-surface-2"
                  >
                    <Checkbox
                      checked={userIds.includes(u.id)}
                      onChange={() => toggleUser(u.id)}
                      aria-label={u.name}
                    />
                    <span className="text-sm text-ink">{u.name}</span>
                    <span className="truncate text-xs text-muted">
                      {u.email ?? 'no email on file'}
                    </span>
                  </label>
                ))
              )}
            </div>
          </Field>
        )}

        {notifyEmail && (
          <Field
            label="Other email addresses"
            hint="Separate them with commas. For somebody who is not a user here — a bookkeeper, say."
          >
            <Input
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="accounts@example.co.za"
            />
          </Field>
        )}

        {notifyWhatsapp && (
          <Field label="WhatsApp numbers" hint="Separate them with commas.">
            <Input
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="082 123 4567"
            />
          </Field>
        )}

        {notifySms && (
          <Field label="SMS numbers" hint="Separate them with commas.">
            <Input
              value={sms}
              onChange={(e) => setSms(e.target.value)}
              placeholder="082 123 4567"
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}

/**
 * The knobs one kind owns.
 *
 * Only the fields that kind actually reads — a screen offering "how many days
 * is dead" on a cash-up check would be inviting somebody to set a number that
 * does nothing, which is worse than not offering it.
 */
function KindConfig({
  kind,
  config,
  onChange,
}: {
  kind: AlertKind
  config: AlertConfig
  onChange: (config: AlertConfig) => void
}) {
  const set = (patch: Partial<AlertConfig>) => onChange({ ...config, ...patch })

  switch (kind) {
    case 'low_stock':
      return (
        <Field label="What it should do about it">
          <div className="flex flex-col gap-2">
            <Checkbox
              checked={config.createOrders}
              onChange={(e) => set({ createOrders: e.target.checked })}
              label="Draft the purchase orders, one per supplier"
            />
            {config.createOrders && (
              <>
                <p className="text-sm text-muted">
                  They are DRAFTS. Nothing goes to a supplier until somebody issues them, and what
                  is already on an unsent draft is not ordered again.
                </p>
                <Checkbox
                  checked={config.roundToPack}
                  onChange={(e) => set({ roundToPack: e.target.checked })}
                  label="Round quantities up to the supplier's pack size"
                />
              </>
            )}
          </div>
        </Field>
      )

    case 'dead_stock':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Not sold in" hint="Days.">
            <NumberInput
              value={config.days}
              onChange={(v) => set({ days: Number(v) || 90 })}
              min={1}
              max={3650}
              className="w-28"
            />
          </Field>
          <Field label="Worth at least" hint="Ignore anything holding less than this. 0 = all.">
            <NumberInput
              value={config.minValue}
              onChange={(v) => set({ minValue: Number(v) || 0 })}
              min={0}
              className="w-32"
            />
          </Field>
        </div>
      )

    case 'price_below_cost':
      return (
        <Field
          label="Flag anything under this margin"
          hint="Percent, against the price excluding VAT. 0 reports only what sells below cost."
        >
          <NumberInput
            value={config.minGpPct}
            onChange={(v) => set({ minGpPct: Number(v) || 0 })}
            min={-100}
            max={99}
            className="w-28"
          />
        </Field>
      )

    case 'cashup_variance':
      return (
        <div className="flex flex-col gap-3">
          <Field label="Out by more than" hint="Rands.">
            <NumberInput
              value={config.threshold}
              onChange={(v) => set({ threshold: Number(v) || 0 })}
              min={0}
              className="w-32"
            />
          </Field>
          <Checkbox
            checked={config.shortagesOnly}
            onChange={(e) => set({ shortagesOnly: e.target.checked })}
            label="Only when the drawer is short"
          />
          {!config.shortagesOnly && (
            <p className="text-sm text-muted">
              Overages count too. A drawer that is over usually means a sale was keyed wrong, which
              is a customer charged wrong.
            </p>
          )}
        </div>
      )

    case 'credit_limit':
      return (
        <Field
          label="Warn at"
          hint="Percent of the limit. 90 catches accounts before they are refused at the till."
        >
          <NumberInput
            value={config.warnAtPct}
            onChange={(v) => set({ warnAtPct: Number(v) || 90 })}
            min={1}
            max={200}
            className="w-28"
          />
        </Field>
      )

    case 'unprocessed_grvs':
      return (
        <Field
          label="Waiting longer than"
          hint="Days. Long enough that somebody still capturing yesterday's delivery is not nagged."
        >
          <NumberInput
            value={config.days}
            onChange={(v) => set({ days: Number(v) || 2 })}
            min={1}
            max={365}
            className="w-28"
          />
        </Field>
      )

    // Nothing to configure: "below zero" and "never counted" are not thresholds
    // anybody tunes.
    case 'negative_stock':
    case 'missing_cashup':
      return null
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}
