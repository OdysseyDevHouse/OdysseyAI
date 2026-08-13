'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  Switch,
  useToast,
} from '@/components/ui'
import { saveJobSettingsAction } from '../../jobs/actions'

/**
 * How a job behaves, and who hears about it.
 *
 * ── WHY THESE ELEVEN ARE ONE PANEL ─────────────────────────────────────────
 *
 * They arrived across five phases and had no screen at all, so every one of them
 * has been whatever its migration seeded. Splitting them into a panel each would
 * make five cards nobody can hold in their head; a separate /setup/job-settings
 * route would split "how does this business run a job" across two screens a
 * person has to know about.
 *
 * They are grouped by the QUESTION they answer rather than by the phase that
 * shipped them: closing a job, telling people, and what happens on its own.
 *
 * ── THE CRON WARNINGS ARE THE POINT ────────────────────────────────────────
 *
 * Two of these settings do nothing without a cron job, and their failure is
 * silent: escalation and reminders simply never happen, and every screen still
 * looks healthy. So the panel says so, rather than letting somebody switch them
 * on and believe they are covered.
 */
export default function NotificationsPanel({
  itemsBlockClose: initialItemsBlockClose,
  headlineRequired: initialHeadlineRequired,
  signatureStatement: initialStatement,
  notifyEnabled: initialNotify,
  notifyAssignee: initialAssignee,
  notifyEvents: initialEvents,
  autoEscalate: initialEscalate,
  autoVisitReminder: initialReminder,
  autoVisitHours: initialHours,
  autoInvoice: initialInvoice,
  mailConfigured,
  cronConfigured,
}: {
  itemsBlockClose: boolean
  headlineRequired: boolean
  signatureStatement: string
  notifyEnabled: boolean
  notifyAssignee: boolean
  notifyEvents: string[]
  autoEscalate: boolean
  autoVisitReminder: boolean
  autoVisitHours: number
  autoInvoice: boolean
  /** SMTP is set up. Without it every switch below is decoration. */
  mailConfigured: boolean
  /** JOB_AUTOMATION_CRON_SECRET is set, so something can call the daily run. */
  cronConfigured: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [blockClose, setBlockClose] = useState(initialItemsBlockClose)
  const [needHeadline, setNeedHeadline] = useState(initialHeadlineRequired)
  const [statement, setStatement] = useState(initialStatement)
  const [notify, setNotify] = useState(initialNotify)
  const [assignee, setAssignee] = useState(initialAssignee)
  const [events, setEvents] = useState<string[]>(initialEvents)
  const [escalate, setEscalate] = useState(initialEscalate)
  const [reminder, setReminder] = useState(initialReminder)
  const [hours, setHours] = useState(String(initialHours))
  const [invoice, setInvoice] = useState(initialInvoice)

  function toggleEvent(key: string, on: boolean) {
    setEvents((prev) => (on ? [...new Set([...prev, key])] : prev.filter((e) => e !== key)))
  }

  function save() {
    start(async () => {
      const result = await saveJobSettingsAction({
        itemsBlockClose: blockClose,
        headlineRequired: needHeadline,
        signatureStatement: statement,
        notifyEnabled: notify,
        notifyAssignee: assignee,
        notifyEvents: events,
        autoEscalate: escalate,
        autoVisitReminder: reminder,
        autoVisitHours: Number(hours),
        autoInvoice: invoice,
      })
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Closing, telling people, and what happens on its own"
        description="Everything a job does without somebody deciding it there and then."
        action={
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <CardBody>
        <div className="space-y-6">
          {/* ── Closing ────────────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Before a job can be closed
            </p>
            <Switch
              checked={blockClose}
              onChange={setBlockClose}
              label="Required tasks and checks must be done"
              hint="A photo or signature check also needs its file, not just a tick."
            />
            <Switch
              checked={needHeadline}
              onChange={setNeedHeadline}
              label="Every job must say what kind of work it is"
              hint="Off by default — a job logged over the phone often does not know yet."
            />
            <Field
              label="What a customer is agreeing to when they sign"
              hint="Shown above the signature pad. A mark with nothing stating what it means is not worth capturing."
            >
              <Input
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                maxLength={400}
                disabled={pending}
              />
            </Field>
          </div>

          {/* ── Telling people ─────────────────────────────────────────── */}
          <div className="space-y-3 border-t border-border pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Telling people
            </p>

            {!mailConfigured && (
              <Callout tone="warning" title="No mail server is set up">
                Nothing below can send anything until SMTP is configured. The switches will
                save, and every email will be quietly skipped.
              </Callout>
            )}

            <Switch
              checked={notify}
              onChange={setNotify}
              label="Send emails about jobs"
              hint="Followers hold no extra access — an email is all following gets you."
            />
            <div className="pl-1">
              <p className="mb-1.5 text-sm text-muted">Send one when a job is…</p>
              <div className="flex flex-wrap gap-4">
                {/* Checkbox spreads native input props, so onChange carries the
                    event — unlike Switch, which hands back the boolean. */}
                <Checkbox
                  checked={events.includes('assigned')}
                  onChange={(e) => toggleEvent('assigned', e.target.checked)}
                  disabled={!notify || pending}
                  label="Given to somebody"
                />
                <Checkbox
                  checked={events.includes('status')}
                  onChange={(e) => toggleEvent('status', e.target.checked)}
                  disabled={!notify || pending}
                  label="Moved to a new stage"
                />
                <Checkbox
                  checked={events.includes('closed')}
                  onChange={(e) => toggleEvent('closed', e.target.checked)}
                  disabled={!notify || pending}
                  label="Closed"
                />
              </div>
              {/* Named rather than left implicit: "why am I not getting these"
                  is the commonest question a notification feature generates. */}
              <p className="mt-1.5 text-xs text-muted">
                Not every edit — a message on every change is how people learn to ignore all
                of them.
              </p>
            </div>
            <Switch
              checked={assignee}
              onChange={setAssignee}
              label="Tell somebody when work is handed to them"
              hint="Separate from the above: a follower opted in, an assignee has been given something."
              disabled={!notify}
            />
          </div>

          {/* ── On its own ─────────────────────────────────────────────── */}
          <div className="space-y-3 border-t border-border pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              What happens on its own
            </p>

            {!cronConfigured && (escalate || reminder || invoice) && (
              <Callout tone="warning" title="Nothing is calling the daily run">
                These are switched on, but JOB_AUTOMATION_CRON_SECRET is not set, so nothing
                can trigger them. They will never fire, and no screen will say so — which is
                why this one does.
              </Callout>
            )}

            <Switch
              checked={escalate}
              onChange={setEscalate}
              label="Escalate a job that has missed its promise"
              hint="Emails the owner and followers once a day, per promise missed."
            />
            <Switch
              checked={reminder}
              onChange={setReminder}
              label="Remind a technician before a booked visit"
            />
            {reminder && (
              <div className="w-48 pl-1">
                <Field label="How many hours before" hint="16 catches tomorrow morning.">
                  <Input
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    inputMode="numeric"
                    disabled={pending}
                  />
                </Field>
              </div>
            )}

            <Switch
              checked={invoice}
              onChange={setInvoice}
              label="Raise a draft invoice when a job is closed"
              hint="Only jobs closed in the last week, and only ones with something billable on them."
            />
            {invoice && (
              // Shown only when it is ON, so it reads as a consequence rather than
              // a warning about something nobody switched on.
              <Callout tone="warning" title="This one creates paperwork">
                A draft, never a finalised invoice — somebody still finalises it on the
                invoicing screen. But a job closed by mistake will leave an invoice against a
                real customer that has to be found and voided.
              </Callout>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
