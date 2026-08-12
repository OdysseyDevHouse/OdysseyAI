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
  SettingGroup,
  SettingRow,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  DEFAULT_OPENING_HOURS,
  WEEKDAY_LABEL,
  parseHm,
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
        {/* Nested inside the card above, which draws the heading and the rule.
            tone="default" keeps this group from drawing a second one. */}
        <SettingGroup tone="default" title="" description="">
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
        </SettingGroup>

        <CardBody>
          {blocker ? (
            <Callout tone="warning" title="Before you can switch this on">
              {blocker}
            </Callout>
          ) : null}

          <div className="mt-4 flex items-end gap-2">
            <Field
              label="Your booking link"
              hint="Put this behind a “Book a table” button, or print it as a QR code."
              className="flex-1"
            >
              <Input value={bookingUrl} readOnly />
            </Field>
            <Button
              variant="secondary"
              className="mb-6"
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
              <DayRow
                key={label}
                label={label}
                ranges={form.openingHours[String(day)] ?? []}
                onChange={(ranges) => setDay(day, ranges)}
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
function DayRow({
  label,
  ranges,
  onChange,
}: {
  label: string
  ranges: TimeRange[]
  onChange: (ranges: TimeRange[]) => void
}) {
  function setRange(i: number, which: 0 | 1, value: string) {
    const next = ranges.map((r, idx) =>
      idx === i ? ((which === 0 ? [value, r[1]] : [r[0], value]) as TimeRange) : r,
    )
    onChange(next)
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-card border border-border px-4 py-2.5">
      <span className="w-24 shrink-0 pt-2 text-sm font-medium text-ink">{label}</span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {ranges.length === 0 ? (
          <span className="pt-2 text-sm text-muted">Closed</span>
        ) : (
          ranges.map((r, i) => {
            // A backwards range is dropped on save, so say so while it is still
            // on screen rather than silently discarding the manager's typing.
            const from = parseHm(r[0])
            const to = parseHm(r[1])
            const bad = from !== null && to !== null && to <= from
            return (
              <div key={i} className="flex items-center gap-2">
                {/* The width lives on a wrapper, not on the Input: CONTROL sets
                    w-full, and Tailwind resolves that by stylesheet order, so a
                    w-32 passed to the control itself loses. */}
                <div className="w-32 shrink-0">
                  <Input
                    type="time"
                    value={r[0]}
                    aria-label={`${label} sitting ${i + 1} first seating`}
                    onChange={(e) => setRange(i, 0, e.target.value)}
                  />
                </div>
                <span className="shrink-0 text-sm text-muted">to</span>
                <div className="w-32 shrink-0">
                  <Input
                    type="time"
                    value={r[1]}
                    aria-label={`${label} sitting ${i + 1} last seating`}
                    invalid={bad}
                    onChange={(e) => setRange(i, 1, e.target.value)}
                  />
                </div>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${label} sitting ${i + 1}`}
                  onClick={() => onChange(ranges.filter((_, idx) => idx !== i))}
                >
                  <Icons.Close size={15} />
                </Button>
                {bad ? (
                  <span className="text-xs text-danger">
                    The last seating must be after the first.
                  </span>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...ranges, ['18:00', '21:00']])}
      >
        <Icons.Plus size={15} />
        {ranges.length === 0 ? 'Open this day' : 'Add a sitting'}
      </Button>
    </div>
  )
}
