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
  Select,
  Switch,
  TextLink,
  useToast,
} from '@/components/ui'
import { saveJobSettingsAction } from '../../actions'
import {
  STOCK_WARN_MODES,
  STOCK_WARN_LABEL,
  STOCK_WARN_HINT,
  type StockWarnMode,
} from '@/lib/jobStatusModel'

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
  feedbackEnabled: initialFeedback,
  feedbackIntro: initialFeedbackIntro,
  intakeEnabled: initialIntake,
  intakeBlurb: initialIntakeBlurb,
  intakeMaxPerPhone: initialIntakeCap,
  intakeShowHeadlines: initialIntakeHeadlines,
  portalEnabled: initialPortal,
  portalAllowComments: initialPortalComments,
  portalAllowUploads: initialPortalUploads,
  portalAllowQuoteAccept: initialPortalQuotes,
  stockWarnMode: initialWarnMode,
  autoAwaitingParts: initialAwaitingParts,
  portalUrl,
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
  feedbackEnabled: boolean
  feedbackIntro: string
  intakeEnabled: boolean
  intakeBlurb: string
  intakeMaxPerPhone: number
  intakeShowHeadlines: boolean
  portalEnabled: boolean
  portalAllowComments: boolean
  portalAllowUploads: boolean
  portalAllowQuoteAccept: boolean
  /** What happens when a job asks for more of a part than the shop has (§26.7). */
  stockWarnMode: string
  /** Whether a job moves itself in and out of Awaiting Parts (§28). */
  autoAwaitingParts: boolean
  /** The link a customer signs in at. Null if the token could not be minted. */
  portalUrl: string | null
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
  const [feedback, setFeedback] = useState(initialFeedback)
  const [feedbackIntro, setFeedbackIntro] = useState(initialFeedbackIntro)
  const [intake, setIntake] = useState(initialIntake)
  const [intakeBlurb, setIntakeBlurb] = useState(initialIntakeBlurb)
  const [intakeCap, setIntakeCap] = useState(String(initialIntakeCap))
  const [intakeHeadlines, setIntakeHeadlines] = useState(initialIntakeHeadlines)
  const [portal, setPortal] = useState(initialPortal)
  const [portalComments, setPortalComments] = useState(initialPortalComments)
  const [portalUploads, setPortalUploads] = useState(initialPortalUploads)
  const [portalQuotes, setPortalQuotes] = useState(initialPortalQuotes)
  const [warnMode, setWarnMode] = useState(initialWarnMode)
  const [awaitingParts, setAwaitingParts] = useState(initialAwaitingParts)

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
        feedbackEnabled: feedback,
        feedbackIntro,
        intakeEnabled: intake,
        intakeBlurb,
        intakeMaxPerPhone: Number(intakeCap),
        intakeShowHeadlines: intakeHeadlines,
        portalEnabled: portal,
        portalAllowComments: portalComments,
        portalAllowUploads: portalUploads,
        portalAllowQuoteAccept: portalQuotes,
        stockWarnMode: warnMode,
        autoAwaitingParts: awaitingParts,
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
        title="Closing, parts, telling people, and what happens on its own"
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

          {/* ── Parts and stock ────────────────────────────────────────── */}
          <div className="space-y-3 border-t border-border pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Parts and stock
            </p>

            <Field
              label="When a job needs more of a part than the shop has"
              hint="The shelf still has the last word: none of these can conjure stock that is not there."
            >
              <Select
                value={warnMode}
                onChange={(e) => setWarnMode(e.target.value)}
                disabled={pending}
                className="max-w-[20rem]"
              >
                {STOCK_WARN_MODES.map((m) => (
                  <option key={m} value={m}>
                    {STOCK_WARN_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            {/* The chosen mode explains itself, rather than four hints stacked
                up where three of them are always wrong. */}
            <p className="text-xs text-muted">
              {STOCK_WARN_HINT[(warnMode as StockWarnMode) in STOCK_WARN_LABEL ? (warnMode as StockWarnMode) : 'inform']}
            </p>

            <Switch
              checked={awaitingParts}
              onChange={setAwaitingParts}
              label="Move a job to Awaiting Parts by itself"
              hint="In when somebody asks for a part, and back out once every request is settled. A job that could only leave by hand would be a trap."
            />
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
                  Every customer whose job closes gets an email from your address. Nobody is
                  asked twice about the same job, and the link stops working after two months.
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

          {/* Its own group, because it is the only setting on this screen that
              opens a door INWARDS. Everything above decides what the business
              sends out; this decides who may write to it. */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Requests from outside
            </p>

            <Switch
              checked={intake}
              onChange={setIntake}
              label="Let people ask for work through a public link"
              hint="A form anybody can fill in. What arrives waits in Jobs › Requests until somebody accepts it."
            />

            {intake && (
              <>
                <Callout tone="warning" title="This one is open to the internet">
                  Nothing that arrives is a job, a customer or a figure in any report until
                  somebody in the business accepts it — that is what makes it safe. Find the link
                  to share on{' '}
                  <TextLink href="/jobs/requests">Jobs &rsaquo; Requests</TextLink>.
                </Callout>

                <Field label="What the form says" hint="Shown above the fields.">
                  <Input
                    value={intakeBlurb}
                    onChange={(e) => setIntakeBlurb(e.target.value)}
                    maxLength={190}
                  />
                </Field>

                <Field
                  label="How many one phone number may send in a day"
                  hint="The only limit there is. Zero switches it off, which is not advised on a public form."
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    value={intakeCap}
                    onChange={(e) => setIntakeCap(e.target.value)}
                  />
                </Field>

                <Switch
                  checked={intakeHeadlines}
                  onChange={setIntakeHeadlines}
                  label="Offer the kinds of work you do"
                  hint="Puts your kinds of work in a dropdown on the form. Off keeps what you offer private."
                />
              </>
            )}
          </div>

          {/* ── The portal ─────────────────────────────────────────────────
              Last, and its own group, because it is the only thing here that
              shows a customer their own commercial history rather than sending
              them a message about one job. */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              The customer portal
            </p>

            <Switch
              checked={portal}
              onChange={setPortal}
              label="Let customers sign in and see their own jobs"
              hint="They sign in with a link sent to the email address you have for them — there is no password."
            />

            {portal && (
              <>
                <Callout tone="warning" title="What a customer can see">
                  Their own jobs and what stage each is at, booked visits, issued quotes and
                  finalised invoices. <strong>Never</strong> your costs, your margins, which
                  technician is assigned, your staff notes, hours worked, or anything belonging
                  to another customer.
                </Callout>

                {portalUrl && (
                  <Field
                    label="The link to put on your website"
                    hint="It does not change. Signing in still needs a link emailed to an address you already hold."
                  >
                    <Input value={portalUrl} readOnly onFocus={(e) => e.target.select()} />
                  </Field>
                )}

                <Switch
                  checked={portalComments}
                  onChange={setPortalComments}
                  label="They may write on their own job"
                  hint="Their message appears on the job for your staff. Your own notes stay private unless you share one."
                />

                <Switch
                  checked={portalUploads}
                  onChange={setPortalUploads}
                  label="They may send a photo"
                  hint="Pictures and PDFs only, capped per job. A photo of the fault before anybody drives out."
                />

                <Switch
                  checked={portalQuotes}
                  onChange={setPortalQuotes}
                  label="They may accept a quote themselves"
                  hint="Off by default. This one is legally meaningful — it records who accepted, when, and that it came from the portal."
                />
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
