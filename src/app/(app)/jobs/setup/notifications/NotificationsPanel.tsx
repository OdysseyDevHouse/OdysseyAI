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
import { saveJobSettingsAction } from '../../actions'

/**
 * Who hears about a job, and what it does on its own.
 *
 * ── WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * This was one card of twenty-two settings whose heading read "Closing, parts,
 * telling people, and what happens on its own" — four nouns, which is four
 * cards. It keeps the two that belong together: telling people, and the
 * automations that do the telling. The other two went to /jobs/setup/signoff and
 * /jobs/setup/parts-stock.
 *
 * Feedback is here rather than on a screen of its own because it IS an
 * automation — something that happens when a job closes — and it is last within
 * the group because it is the only one that emails a CUSTOMER rather than staff.
 *
 * The save sends only these keys. `saveJobSettingsAction` takes a patch, so the
 * eighteen settings this screen does not show cannot be reverted by it.
 *
 * ── THE CRON WARNINGS ARE THE POINT ────────────────────────────────────────
 *
 * Three of these settings do nothing without a cron job, and their failure is
 * silent: escalation, reminders and feedback simply never happen, and every
 * screen still looks healthy. So the panel says so, rather than letting somebody
 * switch them on and believe they are covered.
 */
export default function NotificationsPanel({
  notifyEnabled: initialNotify,
  notifyAssignee: initialAssignee,
  notifyEvents: initialEvents,
  autoEscalate: initialEscalate,
  autoVisitReminder: initialReminder,
  autoVisitHours: initialHours,
  autoInvoice: initialInvoice,
  feedbackEnabled: initialFeedback,
  feedbackIntro: initialFeedbackIntro,
  mailConfigured,
  cronConfigured,
}: {
  notifyEnabled: boolean
  notifyAssignee: boolean
  notifyEvents: string[]
  autoEscalate: boolean
  autoVisitReminder: boolean
  autoVisitHours: number
  autoInvoice: boolean
  feedbackEnabled: boolean
  feedbackIntro: string
  /** SMTP is set up. Without it every switch below is decoration. */
  mailConfigured: boolean
  /** JOB_AUTOMATION_CRON_SECRET is set, so something can call the daily run. */
  cronConfigured: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [notify, setNotify] = useState(initialNotify)
  const [assignee, setAssignee] = useState(initialAssignee)
  const [events, setEvents] = useState<string[]>(initialEvents)
  const [escalate, setEscalate] = useState(initialEscalate)
  const [reminder, setReminder] = useState(initialReminder)
  const [hours, setHours] = useState(String(initialHours))
  const [invoice, setInvoice] = useState(initialInvoice)
  const [feedback, setFeedback] = useState(initialFeedback)
  const [feedbackIntro, setFeedbackIntro] = useState(initialFeedbackIntro)

  function toggleEvent(key: string, on: boolean) {
    setEvents((prev) => (on ? [...new Set([...prev, key])] : prev.filter((e) => e !== key)))
  }

  function save() {
    start(async () => {
      // Only the nine keys this screen owns. See the action for why a patch.
      const result = await saveJobSettingsAction({
        notifyEnabled: notify,
        notifyAssignee: assignee,
        notifyEvents: events,
        autoEscalate: escalate,
        autoVisitReminder: reminder,
        autoVisitHours: Number(hours),
        autoInvoice: invoice,
        feedbackEnabled: feedback,
        feedbackIntro,
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
        title="Telling people, and what happens on its own"
        description="Who hears about a job, at which moment, and what the system does without being asked."
        action={
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <CardBody>
        <div className="space-y-6">
          {/* ── Telling people ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Telling people
            </p>

            {!mailConfigured && (
              <Callout tone="warning" title="No mail server is set up">
                Nothing below can send anything until SMTP is configured. The switches will save,
                and every email will be quietly skipped.
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
                Not every edit — a message on every change is how people learn to ignore all of
                them.
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
                These are switched on, but JOB_AUTOMATION_CRON_SECRET is not set, so nothing can
                trigger them. They will never fire, and no screen will say so — which is why this
                one does.
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
                A draft, never a finalised invoice — somebody still finalises it on the invoicing
                screen. But a job closed by mistake will leave an invoice against a real customer
                that has to be found and voided.
              </Callout>
            )}

            {/* Feedback sits with the automations because that is what it is:
                something the system does on its own when a job closes. It is
                last because it is the only one that emails a CUSTOMER. */}
            <Switch
              checked={feedback}
              onChange={setFeedback}
              label="Ask the customer to rate the work"
              hint="One email when a job closes, with a link to one star rating and a comment box."
            />
            {feedback && (
              <>
                <Callout tone="warning" title="This one emails your customers">
                  Every customer whose job closes gets an email from your address. Nobody is asked
                  twice about the same job, and the link stops working after two months.
                </Callout>
                <Field
                  label="How the email opens"
                  hint="Your own words. The rating link follows underneath."
                >
                  <Input
                    value={feedbackIntro}
                    onChange={(e) => setFeedbackIntro(e.target.value)}
                    maxLength={190}
                  />
                </Field>
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
