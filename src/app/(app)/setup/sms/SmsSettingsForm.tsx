'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Field,
  Icons,
  Input,
  NumberInput,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { SMS_MAX_LENGTH } from '@/lib/sms/types'
import { saveSmsSettingsAction, sendTestSmsAction } from './actions'

type Settings = {
  provider: '' | 'log' | 'smsportal'
  clientId: string
  clientSecret: string
  statementNotify: boolean
  laybyReminderDays: number
  laybyReminderSms: string
}

/**
 * The SMS provider and everything that texts through it.
 *
 * The secret arrives as a mask when one is stored. Typing replaces it; leaving
 * it alone round-trips the mask, which the save action reads as "keep what you
 * have". That means Save is always safe to press — it can never blank a
 * working credential.
 */
export default function SmsSettingsForm({ settings: initial }: { settings: Settings }) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState(initial)
  const [testTo, setTestTo] = useState('')
  const [testing, startTesting] = useTransition()

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const dirty = JSON.stringify(form) !== JSON.stringify(saved)

  function save() {
    startTransition(async () => {
      const result = await saveSmsSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSaved(form)
      toast.success(result.message)
    })
  }

  function sendTest() {
    startTesting(async () => {
      const result = await sendTestSmsAction(testTo)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
    })
  }

  const reminderLength = form.laybyReminderSms.length

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="Provider"
        description="Who actually carries the messages. Reminders and dunning texts stay silently off until one is chosen."
      >
        <SettingRow
          icon={<Icons.MessageSquare size={16} />}
          label="SMS provider"
          description="SMSPortal sends real messages using your own account. The log provider writes to the server console — for trying things out."
          htmlFor="sms-provider"
        >
          <Select
            id="sms-provider"
            className="w-56"
            value={form.provider}
            onChange={(e) =>
              set(
                'provider',
                e.target.value === 'smsportal' || e.target.value === 'log' ? e.target.value : ''
              )
            }
          >
            <option value="">Off — no texting</option>
            <option value="smsportal">SMSPortal</option>
            <option value="log">Log only (testing)</option>
          </Select>
        </SettingRow>

        {form.provider === 'smsportal' && (
          <>
            <SettingRow
              icon={<Icons.KeyRound size={16} />}
              label="Client ID"
              description="From SMSPortal — under Settings, REST API on their site."
              htmlFor="sms-client-id"
            >
              <Input
                id="sms-client-id"
                className="w-72"
                value={form.clientId}
                onChange={(e) => set('clientId', e.target.value)}
                placeholder="e.g. 6d3f2c…"
                autoComplete="off"
              />
            </SettingRow>
            <SettingRow
              icon={<Icons.KeyRound size={16} />}
              label="API secret"
              description="Leave it untouched to keep the one already stored."
              htmlFor="sms-client-secret"
            >
              <Input
                id="sms-client-secret"
                type="password"
                className="w-72"
                value={form.clientSecret}
                onChange={(e) => set('clientSecret', e.target.value)}
                autoComplete="new-password"
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {form.provider === 'smsportal' && (
        <Callout tone="warning" title="The secret is stored as plain text">
          These credentials live in the site database like any other setting — anyone with
          database access can read them. Use a dedicated SMSPortal account for this shop, and
          rotate the secret from their side if it ever leaks.
        </Callout>
      )}

      <SettingGroup
        title="What gets texted"
        description="Each of these only fires while a provider is set."
      >
        <SettingRow
          icon={<Icons.FileText size={16} />}
          label="Statement notifications"
          description="After a statement is emailed, text the customer that it is on its way."
          htmlFor="statement-sms-notify"
        >
          <Switch
            id="statement-sms-notify"
            checked={form.statementNotify}
            onChange={(next) => set('statementNotify', next)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Clock size={16} />}
          label="Lay-by reminders"
          description="How close to the due date a lay-by must be before the reminder button includes it. Overdue ones are always included."
          htmlFor="layby-reminder-days"
        >
          <div className="flex items-center gap-2">
            <NumberInput
              id="layby-reminder-days"
              className="w-24"
              value={form.laybyReminderDays}
              precision={0}
              onChange={(e) => set('laybyReminderDays', Number(e.target.value) || 0)}
            />
            <span className="text-sm text-muted">days before due</span>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="Lay-by reminder message"
        description="Tokens: {customer}, {number}, {due_date}, {balance} and {company} are filled in per lay-by."
      >
        <div className="px-4 py-3">
          <Field
            label="Message"
            hint={`${reminderLength}/${SMS_MAX_LENGTH} characters${reminderLength > 160 ? ' — two messages per send' : ''}`}
            error={
              reminderLength > SMS_MAX_LENGTH
                ? `Over the ${SMS_MAX_LENGTH}-character cap — it would be cut off.`
                : undefined
            }
          >
            <Textarea
              rows={3}
              value={form.laybyReminderSms}
              onChange={(e) => set('laybyReminderSms', e.target.value)}
              placeholder="Hi {customer}, a reminder that lay-by {number} has {balance} outstanding, due {due_date}."
            />
          </Field>
        </div>
      </SettingGroup>

      <div className="flex items-center justify-end gap-3">
        {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
        <Button
          variant="primary"
          disabled={!dirty || pending || reminderLength > SMS_MAX_LENGTH}
          onClick={save}
        >
          <Icons.Save size={15} />
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>

      <SettingGroup
        title="Try it"
        description="Sends one real message through the SAVED settings — save first if you have just changed them."
      >
        <div className="flex items-end gap-3 px-4 py-3">
          <Field label="Mobile number" className="w-64">
            <Input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="082 123 4567"
              inputMode="tel"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={testing || !testTo.trim() || saved.provider === ''}
            onClick={sendTest}
          >
            <Icons.MessageSquare size={15} />
            {testing ? 'Sending…' : 'Send a test SMS'}
          </Button>
        </div>
      </SettingGroup>
    </div>
  )
}
