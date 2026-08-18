'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Icons,
  Input,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { saveWhatsAppSettingsAction, sendTestWhatsAppAction } from './actions'



export type WhatsAppSettings = {
  enabled: boolean
  phoneId: string
  token: string
}

/**
 * WhatsApp, via the Meta WhatsApp Business Cloud API.
 *
 * Its own group beside SMS rather than its own screen: from the shop's side
 * these are one decision — "how do we reach people on their phone" — and a
 * separate page would mean discovering the second one by accident.
 *
 * The token round-trips MASKED, exactly as the SMS secret does: an unchanged
 * mask is not written back, so opening this page and pressing Save can never
 * blank a working credential.
 */
export default function WhatsAppSettingsForm({
  settings: initial,
}: {
  settings: WhatsAppSettings
}) {
  const toast = useToast()
  const [pending, startSaving] = useTransition()
  const [testing, startTesting] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState(initial)
  const [testTo, setTestTo] = useState('')

  const set = <K extends keyof WhatsAppSettings>(key: K, value: WhatsAppSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const dirty = JSON.stringify(form) !== JSON.stringify(saved)

  function save() {
    startSaving(async () => {
      const result = await saveWhatsAppSettingsAction(form)
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
      const result = await sendTestWhatsAppAction(testTo)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="WhatsApp"
        description="Messages through your own WhatsApp Business number. Alerts can use it once it is on."
      >
        <SettingRow
          icon={<Icons.MessageSquare size={16} />}
          label="Send on WhatsApp"
          description="Off until your Meta Business account is set up and the details below are filled in."
          htmlFor="whatsapp-enabled"
        >
          <Switch
            id="whatsapp-enabled"
            checked={form.enabled}
            onChange={(checked) => set('enabled', checked)}
            aria-label="Send on WhatsApp"
          />
        </SettingRow>

        {form.enabled && (
          <>
            <SettingRow
              icon={<Icons.KeyRound size={16} />}
              label="Phone number ID"
              description="From Meta — the number's ID under WhatsApp → API Setup. Not the phone number itself."
              htmlFor="whatsapp-phone-id"
            >
              <Input
                id="whatsapp-phone-id"
                className="w-72"
                value={form.phoneId}
                onChange={(e) => set('phoneId', e.target.value)}
                placeholder="e.g. 123456789012345"
                autoComplete="off"
              />
            </SettingRow>
            <SettingRow
              icon={<Icons.KeyRound size={16} />}
              label="Access token"
              description="Leave it untouched to keep the one already stored."
              htmlFor="whatsapp-token"
            >
              <Input
                id="whatsapp-token"
                type="password"
                className="w-72"
                value={form.token}
                onChange={(e) => set('token', e.target.value)}
                autoComplete="new-password"
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {form.enabled && (
        <Callout tone="warning" title="Meta only delivers free text within 24 hours">
          A plain message reaches someone only inside 24 hours of them last messaging your business
          number. Outside that window Meta requires a pre-approved template and rejects the send.
          For alerts to your own staff this is usually fine — a rejection is reported against the
          alert rather than swallowed. The access token is stored as plain text in the site
          database, like every other setting here.
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Secondary, not primary: the SMS form above owns this screen's one
            primary button, and two primaries is no primary at all. */}
        <Button variant="secondary" onClick={save} disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Save WhatsApp settings'}
        </Button>
        {!dirty && <span className="text-sm text-muted">No changes to save.</span>}

        {saved.enabled && (
          <>
            <Input
              className="w-56"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="082 123 4567"
              aria-label="Number to test with"
            />
            <Button variant="secondary" onClick={sendTest} disabled={testing || !testTo.trim()}>
              {testing ? 'Sending…' : 'Send a test'}
            </Button>
          </>
        )}
        {dirty && saved.enabled && (
          <span className="text-sm text-muted">Save first — the test sends what is stored.</span>
        )}
      </div>
    </div>
  )
}
