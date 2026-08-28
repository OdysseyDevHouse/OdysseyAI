'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Field,
  Icons,
  Input,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import {
  saveMailSettingsAction,
  sendTestMailAction,
  SMTP_PASS_MASK,
  type MailSettingsInput,
} from './actions'

/**
 * The shop's outgoing mail account.
 *
 * ── WHY THE TEST BUTTON IS NOT AN AFTERTHOUGHT ──────────────────────────────
 *
 * SMTP settings are four fields that all have to be right at once, and every
 * way of getting them wrong produces the same symptom: nothing arrives, hours
 * later, silently. A shop cannot debug that from an invoice it thought it sent.
 *
 * So the test sends a real message and reports what the server actually said —
 * "535 authentication failed" is a sentence somebody can act on, and it is the
 * only feedback this screen can honestly offer.
 *
 * ── SAVE BEFORE TEST, DELIBERATELY ──────────────────────────────────────────
 *
 * The test reads what is STORED rather than what is on screen. That is one
 * extra click and it is the honest arrangement: what it proves is that the
 * saved account works, which is the account that will send tomorrow's invoices.
 * Testing the form would prove something about a state that may never be saved.
 */
export default function EmailSettingsClient({
  initial,
  systemFallback,
  suggestedTestAddress,
}: {
  initial: MailSettingsInput
  /** Whether a process-wide account exists to fall back to. */
  systemFallback: boolean
  suggestedTestAddress: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [testTo, setTestTo] = useState(suggestedTestAddress)

  const dirty = (Object.keys(form) as (keyof MailSettingsInput)[]).some(
    (k) => form[k] !== saved[k],
  )
  /* What is STORED, not what is typed — the banner describes the account that
     will actually send, and that only changes on save. */
  const usingOwn = saved.host.trim() !== ''

  function set<K extends keyof MailSettingsInput>(key: K, value: MailSettingsInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function save() {
    startTransition(async () => {
      const result = await saveMailSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      /* The password becomes a mask again: it is stored now, and the form must
         not keep holding the plaintext somebody typed. */
      const next = { ...form, pass: form.host.trim() && form.pass ? SMTP_PASS_MASK : '' }
      setForm(next)
      setSaved(next)
      toast.success(result.message)
      router.refresh()
    })
  }

  function sendTest() {
    startTransition(async () => {
      const result = await sendTestMailAction(testTo)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Which account is in force, said plainly. It decides whose name is on
          every invoice this business sends, and nobody should have to deduce it
          from whether the fields below happen to be filled in. */}
      {!usingOwn && (
        <Callout
          tone={systemFallback ? 'neutral' : 'warning'}
          title={
            systemFallback
              ? 'Your documents send from the system account'
              : 'This store cannot send email yet'
          }
        >
          {systemFallback ? (
            <>
              Invoices, statements and orders currently leave from the address this system was
              set up with — not from your own. Fill in your mail account below so customers
              receive them from you, and can reply to you.
            </>
          ) : (
            <>
              No mail account is configured, so nothing can be emailed — invoices, statements,
              orders and alerts will all be refused until one is set up here.
            </>
          )}
        </Callout>
      )}

      <SettingGroup
        title="Your mail server"
        description="The details your email provider gives you for sending. Your IT person or your host will have them."
      >
        <div className="grid gap-4 px-6 py-4 sm:grid-cols-2">
          <Field
            label="Mail server"
            hint="smtp.gmail.com, smtp.office365.com, mail.yourhost.co.za…"
          >
            <Input
              value={form.host}
              maxLength={200}
              placeholder="smtp.yourprovider.com"
              onChange={(e) => set('host', e.target.value)}
            />
          </Field>

          <Field label="Port" hint="587 for most providers, 465 where the connection is always encrypted.">
            <Input
              className="w-32"
              value={form.port}
              maxLength={5}
              inputMode="numeric"
              onChange={(e) => set('port', e.target.value)}
            />
          </Field>

          <Field label="Username" hint="Usually the full email address you are signing in as.">
            <Input
              value={form.user}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => set('user', e.target.value)}
            />
          </Field>

          <Field
            label="Password"
            hint={
              saved.pass
                ? 'A password is saved. Type a new one to replace it, or clear the box to remove it.'
                : 'Some providers want an app password rather than your account password.'
            }
          >
            <Input
              type="password"
              value={form.pass}
              maxLength={200}
              autoComplete="new-password"
              onChange={(e) => set('pass', e.target.value)}
            />
          </Field>

          <Field
            label="Send from"
            hint="What recipients see, and where their replies go. Often not the same as the username."
          >
            <Input
              type="email"
              value={form.from}
              maxLength={200}
              placeholder="accounts@yourshop.co.za"
              onChange={(e) => set('from', e.target.value)}
            />
          </Field>
        </div>

        <SettingRow
          icon={<Icons.Lock size={16} />}
          label="Always encrypted (SSL/TLS)"
          description="On for port 465, where the connection is encrypted from the first byte. Off for 587, which starts plain and upgrades — the usual setting."
          htmlFor="smtp-secure"
        >
          <Switch
            id="smtp-secure"
            checked={form.secure}
            onChange={(v) => set('secure', v)}
            ariaLabel="Always encrypted"
          />
        </SettingRow>

        <div className="flex items-center justify-end gap-3 px-6 py-4">
          {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
          <Button variant="primary" disabled={!dirty || pending} onClick={save}>
            <Icons.Save size={15} />
            {pending ? 'Saving…' : 'Save mail account'}
          </Button>
        </div>
      </SettingGroup>

      <SettingGroup
        title="Test it"
        description="Send yourself a message. It proves the settings connect AND that your provider will actually relay mail from that address — which a connection check alone cannot."
      >
        <div className="flex flex-wrap items-end gap-3 px-6 py-4">
          <Field label="Send a test to">
            <Input
              type="email"
              className="w-72"
              value={testTo}
              maxLength={200}
              placeholder="you@yourshop.co.za"
              onChange={(e) => setTestTo(e.target.value)}
            />
          </Field>
          <div className="pb-1">
            <Button variant="secondary" disabled={pending || !testTo.trim()} onClick={sendTest}>
              <Icons.Mail size={15} />
              Send test
            </Button>
          </div>
        </div>

        {dirty && (
          <div className="px-6 pb-4">
            <Callout tone="brand" title="Save first">
              The test uses the saved account, not what is on screen — so it tells you whether
              tomorrow's invoices will send, rather than whether these unsaved boxes would.
            </Callout>
          </div>
        )}

        <p className="px-6 pb-4 text-sm text-muted">
          Your password is stored on this system so documents can be sent while nobody is
          signed in. It is never shown on this screen once saved, and never sent to a browser —
          but it is stored as you typed it, so treat access to this screen as access to that
          mailbox.
        </p>
      </SettingGroup>
    </div>
  )
}
