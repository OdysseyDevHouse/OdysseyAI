'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Switch,
  TextLink,
  useToast,
} from '@/components/ui'
import { saveJobSettingsAction } from '../../actions'

/**
 * The two doors this business opens to people outside it.
 *
 * ── WHY INTAKE AND THE PORTAL SHARE A SCREEN ───────────────────────────────
 *
 * Everything else in job setup decides what the business does internally. These
 * two are the only settings that let somebody who does not work here reach in:
 * one lets a stranger ASK for work, the other lets an existing customer WATCH
 * theirs. Both are public URLs, both are things a shop should be able to see the
 * whole of before switching either on, and both were buried in a card whose
 * heading mentioned neither.
 *
 * They stay two cards within the one screen, because the risk is different in
 * kind: intake accepts input from anybody, the portal exposes existing records
 * to somebody identified. Merging them into one list of switches would let a
 * shop turn on the second while reading the warning for the first.
 */
export default function WebFormsPanel({
  intakeEnabled: initialIntake,
  intakeBlurb: initialIntakeBlurb,
  intakeMaxPerPhone: initialIntakeCap,
  intakeShowHeadlines: initialIntakeHeadlines,
  portalEnabled: initialPortal,
  portalAllowComments: initialPortalComments,
  portalAllowUploads: initialPortalUploads,
  portalAllowQuoteAccept: initialPortalQuotes,
  portalUrl,
}: {
  intakeEnabled: boolean
  intakeBlurb: string
  intakeMaxPerPhone: number
  intakeShowHeadlines: boolean
  portalEnabled: boolean
  portalAllowComments: boolean
  portalAllowUploads: boolean
  portalAllowQuoteAccept: boolean
  /** The link a customer signs in at. Null if the token could not be minted. */
  portalUrl: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [intake, setIntake] = useState(initialIntake)
  const [intakeBlurb, setIntakeBlurb] = useState(initialIntakeBlurb)
  const [intakeCap, setIntakeCap] = useState(String(initialIntakeCap))
  const [intakeHeadlines, setIntakeHeadlines] = useState(initialIntakeHeadlines)
  const [portal, setPortal] = useState(initialPortal)
  const [portalComments, setPortalComments] = useState(initialPortalComments)
  const [portalUploads, setPortalUploads] = useState(initialPortalUploads)
  const [portalQuotes, setPortalQuotes] = useState(initialPortalQuotes)

  function save() {
    start(async () => {
      // Only the eight keys this screen owns. See the action for why a patch.
      const result = await saveJobSettingsAction({
        intakeEnabled: intake,
        intakeBlurb,
        intakeMaxPerPhone: Number(intakeCap),
        intakeShowHeadlines: intakeHeadlines,
        portalEnabled: portal,
        portalAllowComments: portalComments,
        portalAllowUploads: portalUploads,
        portalAllowQuoteAccept: portalQuotes,
      })
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  /* One save for both cards, because they are one form — two Save buttons on one
     screen is two things to remember to press. It sits on the first card's
     header, where the eye lands. */
  const saveButton = (
    <Button onClick={save} disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )

  return (
    <>
      <Card>
        <CardHeader
          title="Requests from outside"
          description="A form anybody can fill in to ask for work."
          action={saveButton}
        />
        <CardBody>
          <div className="space-y-3">
            <Switch
              checked={intake}
              onChange={setIntake}
              label="Let people ask for work through a public link"
              hint="What arrives waits in Jobs › Requests until somebody accepts it."
            />

            {intake && (
              <>
                <Callout tone="warning" title="This one is open to the internet">
                  Nothing that arrives is a job, a customer or a figure in any report until
                  somebody in the business accepts it — that is what makes it safe. Find the link
                  to share on <TextLink href="/jobs/requests">Jobs &rsaquo; Requests</TextLink>.
                </Callout>

                <Field
                  label="What the form says"
                  hint="Shown above the fields."
                  /* The action refuses an empty blurb when the switch is being
                     turned on, so the field says so before the save does. */
                  error={intakeBlurb.trim() ? undefined : 'The public form needs a line.'}
                >
                  <Input
                    value={intakeBlurb}
                    onChange={(e) => setIntakeBlurb(e.target.value)}
                    maxLength={190}
                  />
                </Field>

                <div className="w-64">
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
                </div>

                <Switch
                  checked={intakeHeadlines}
                  onChange={setIntakeHeadlines}
                  label="Offer the kinds of work you do"
                  hint="Puts your kinds of work in a dropdown on the form. Off keeps what you offer private."
                />
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── The portal ─────────────────────────────────────────────────────
          Its own card, because it is the only thing here that shows a customer
          their own commercial history rather than taking a message from a
          stranger. */}
      <Card>
        <CardHeader
          title="The customer portal"
          description="Where an existing customer signs in to watch their own jobs."
        />
        <CardBody>
          <div className="space-y-3">
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
                  technician is assigned, your staff notes, hours worked, or anything belonging to
                  another customer.
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
        </CardBody>
      </Card>
    </>
  )
}
