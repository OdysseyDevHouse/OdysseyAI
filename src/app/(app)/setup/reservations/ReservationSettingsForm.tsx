'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Icons,
  Input,
  NumberInput,
  Select,
  SettingRow,
  Switch,
  Textarea,
  WeekHoursDay,
  useToast,
  type HoursRange,
} from '@/components/ui'
import {
  DEFAULT_OPENING_HOURS,
  WEEKDAY_LABEL,
  type OpeningHours,
  type ReservationSettings,
  type TimeRange,
} from '@/lib/reservationTypes'
import { saveReservationSettingsAction } from './actions'

/**
 * The reservation settings screen.
 *
 * ── THE WEEK IS THE HARD PART ─────────────────────────────────────────────
 *
 * A restaurant's week is genuinely irregular — lunch and dinner on Saturday,
 * dinner only midweek, closed Monday — so each day holds a LIST of sittings
 * rather than one pair of times. That is why the stored shape is JSON and why
 * this editor lets a day have two rows.
 *
 * ── THE RANGE END IS THE LAST SEATING ─────────────────────────────────────
 *
 * Said on the screen, not just in the schema comment: "18:00 to 21:30" means
 * the last table goes out AT 21:30. A manager who reads it as "we close at
 * 21:30" would shorten the range and quietly lose the booking they wanted.
 */
export default function ReservationSettingsForm({
  settings,
  reservePath,
}: {
  settings: ReservationSettings
  reservePath: string
}) {
  const toast = useToast()
  const [saving, startSaving] = useTransition()
  const [form, setForm] = useState<ReservationSettings>(settings)

  function patch(next: Partial<ReservationSettings>) {
    setForm((f) => ({ ...f, ...next }))
  }

  /** Days with at least one usable sitting — what "open for bookings" means. */
  const openDays = useMemo(
    () => Object.values(form.openingHours).filter((r) => r.length > 0).length,
    [form.openingHours],
  )

  // Stated before they try to save, not as a save error: the owner should see
  // the work remaining rather than be refused after pressing the button.
  const blocker = form.isEnabled && openDays === 0 ? 'Add at least one day below.' : ''

  function setDay(day: number, ranges: TimeRange[]) {
    setForm((f) => {
      const next: OpeningHours = { ...f.openingHours }
      if (ranges.length === 0) delete next[String(day)]
      else next[String(day)] = ranges
      return { ...f, openingHours: next }
    })
  }

  function save() {
    startSaving(async () => {
      const result = await saveReservationSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        form.isEnabled ? 'Guests can now book a table online.' : 'Reservation settings saved.',
      )
    })
  }

  const bookingUrl =
    typeof window === 'undefined' ? reservePath : `${window.location.origin}${reservePath}`

  return (
    <>
      <Card>
        <CardHeader
          title="Online bookings"
          description="The link you put on your website or a QR code on the door."
        />
        {/* The rows sit straight in the card. A SettingGroup here drew a second
            rounded border inside the card's own, and its heading block — which
            it renders whether or not it is given a title — left an empty banded
            strip between the header and the first row. */}
        <div>
          <SettingRow
            icon={<Icons.CalendarClock size={18} />}
            label="Take bookings online"
            description="Guests book from the link below. Off, the page tells them to call you instead."
          >
            <Switch
              checked={form.isEnabled}
              onChange={(next) => patch({ isEnabled: next })}
              label="Take bookings online"
              disabled={openDays === 0 && !form.isEnabled}
            />
          </SettingRow>

          <SettingRow
            icon={<Icons.Check size={18} />}
            label="Confirm bookings automatically"
            description="Off, a booking arrives as a request and someone accepts it. Leave it off until you are enforcing how full the room is — auto-confirm can promise a table you do not have."
          >
            <Switch
              checked={form.autoConfirm}
              onChange={(next) => patch({ autoConfirm: next })}
              label="Confirm bookings automatically"
            />
          </SettingRow>
        </div>

        <CardBody>
          {blocker ? (
            <Callout tone="warning" title="Before you can switch this on">
              {blocker}
            </Callout>
          ) : null}

          {/* The button sits INSIDE the field, beside the input, rather than
              beside the whole field pushed down by a hardcoded margin — that
              offset only lined up while the hint stayed on one line. */}
          <Field
            label="Your booking link"
            hint="Put this behind a “Book a table” button, or print it as a QR code."
            /* Only spaced off the Callout when there IS one — CardBody's own
               padding is the gap when the field is the first thing in it. */
            className={blocker ? 'mt-4' : ''}
          >
            <div className="flex items-center gap-2">
              <Input value={bookingUrl} readOnly className="flex-1" />
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(bookingUrl)
                    toast.success('Link copied.')
                  } catch {
                    // Clipboard access is refused outside a secure context.
                    toast.info('Select the link and copy it.')
                  }
                }}
              >
                <Icons.Copy size={15} />
                Copy
              </Button>
            </div>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="When you take bookings"
          description="The times a guest may choose. A range runs from the first seating to the LAST — “18:00 to 21:30” means the last table goes out at 21:30."
          action={
            openDays === 0 ? (
              <Button
                variant="secondary"
                onClick={() => patch({ openingHours: DEFAULT_OPENING_HOURS })}
              >
                Use a typical week
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          <div className="flex flex-col gap-3">
            {WEEKDAY_LABEL.map((label, day) => (
              <WeekHoursDay
                key={label}
                label={label}
                ranges={(form.openingHours[String(day)] ?? []) as HoursRange[]}
                onChange={(ranges) => setDay(day, ranges as TimeRange[])}
                rangeNoun="sitting"
                addFirstLabel="Open this day"
                defaultRange={['18:00', '21:00']}
              />
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="The rules that keep the form honest"
          description="What the public page will and will not promise on your behalf."
        />
        <CardBody>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Times are offered every"
              hint="How far apart the bookable times are."
            >
              <Select
                value={String(form.slotMinutes)}
                onChange={(e) => patch({ slotMinutes: Number(e.target.value) || 30 })}
              >
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes</option>
              </Select>
            </Field>

            <Field
              label="A table is held for"
              hint="Minutes. Used for planning — it does not shorten the last sitting."
            >
              <NumberInput
                value={form.defaultDurationMinutes}
                min={15}
                max={600}
                onChange={(e) => patch({ defaultDurationMinutes: Number(e.target.value) || 90 })}
              />
            </Field>

            <Field
              label="Earliest a guest may book"
              hint="Minutes from now. Stops a booking arriving for twenty minutes' time, which nobody is watching for."
            >
              <NumberInput
                value={form.leadTimeMinutes}
                min={0}
                max={40320}
                onChange={(e) => patch({ leadTimeMinutes: Number(e.target.value) || 0 })}
              />
            </Field>

            <Field label="How far ahead" hint="Days. Stops a table being booked for next Christmas.">
              <NumberInput
                value={form.horizonDays}
                min={1}
                max={365}
                onChange={(e) => patch({ horizonDays: Number(e.target.value) || 60 })}
              />
            </Field>

            <Field
              label="Largest party online"
              hint="Bigger groups are told to call, where a person can decide."
            >
              <NumberInput
                value={form.maxPartySize}
                min={1}
                max={500}
                onChange={(e) => patch({ maxPartySize: Number(e.target.value) || 12 })}
              />
            </Field>

            <Field
              label="Bookings per number per day"
              hint="Abuse control on a form with no login. 0 means no limit."
            >
              <NumberInput
                value={form.maxPerPhonePerDay}
                min={0}
                max={100}
                onChange={(e) => patch({ maxPerPhonePerDay: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>

          <div className="mt-5">
            <Field
              label="What the booking page says"
              hint="Optional — dress code, parking, “large groups please call”."
            >
              <Textarea
                value={form.blurb}
                rows={3}
                maxLength={500}
                placeholder="e.g. Smart casual. Parking behind the building."
                onChange={(e) => patch({ blurb: e.target.value })}
              />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <Button onClick={save} disabled={saving || !!blocker}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </CardFooter>
      </Card>
    </>
  )
}

/**
 * One weekday, and the sittings it takes bookings in.
 *
 * A day with no rows is closed — there is no separate "open" checkbox, because
 * two controls that mean the same thing is how a day ends up switched on with
 * no times in it.
 */
