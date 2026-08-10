'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Switch,
  useToast,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
} from '@/components/ui'
import type { Holiday } from '@/lib/holidayModel'
import type { HolidayOverride } from '@/lib/site/holidays'
import { savePayRulesAction, saveHolidayAction, deleteHolidayAction } from './actions'

/**
 * Pay rules — what an hour outside ordinary time costs, and which days count.
 *
 * Two cards rather than two screens, because they answer one question between
 * them: what this store pays for a Sunday, a holiday and an extra hour. Split
 * across separate pages, somebody would set the multipliers and never find the
 * calendar that decides which days they apply to.
 */
export default function PayRulesScreen({
  rates,
  overrides,
  calendar,
  year,
  canEdit,
}: {
  rates: { overtime: string; sunday: string; sundayOrdinary: string; holiday: string }
  overrides: HolidayOverride[]
  calendar: Holiday[]
  year: number
  canEdit: boolean
}) {
  const [overtime, setOvertime] = useState(rates.overtime)
  const [sunday, setSunday] = useState(rates.sunday)
  const [sundayOrdinary, setSundayOrdinary] = useState(rates.sundayOrdinary)
  const [holiday, setHoliday] = useState(rates.holiday)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function saveRates() {
    setError(null)
    startTransition(async () => {
      const result = await savePayRulesAction({ overtime, sunday, sundayOrdinary, holiday })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
    })
  }

  function removeOverride(id: number) {
    startTransition(async () => {
      const result = await deleteHolidayAction(id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  const overrideByDate = new Map(overrides.map((o) => [o.date, o]))

  return (
    <>
      <Card>
        <CardHeader
          title="What an hour costs"
          description="Multiples of the ordinary rate. The defaults are the BCEA minimums; raise them if an agreement says so."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Overtime"
              hint="Above the ordinary week. One and a half under section 10."
            >
              <NumberInput
                value={overtime}
                disabled={!canEdit}
                onChange={(e) => setOvertime(e.target.value)}
                className="max-w-[10rem]"
              />
            </Field>

            <Field
              label="Public holiday"
              hint="A holiday that is not an ordinary working day. Double under section 18."
            >
              <NumberInput
                value={holiday}
                disabled={!canEdit}
                onChange={(e) => setHoliday(e.target.value)}
                className="max-w-[10rem]"
              />
            </Field>

            <Field
              label="Sunday"
              hint="For somebody who does not ordinarily work Sundays. Double under section 16(1)."
            >
              <NumberInput
                value={sunday}
                disabled={!canEdit}
                onChange={(e) => setSunday(e.target.value)}
                className="max-w-[10rem]"
              />
            </Field>

            <Field
              label="Sunday, for a Sunday worker"
              hint="For somebody whose normal week includes Sundays. One and a half under section 16(2). Set this per person on their record."
            >
              <NumberInput
                value={sundayOrdinary}
                disabled={!canEdit}
                onChange={(e) => setSundayOrdinary(e.target.value)}
                className="max-w-[10rem]"
              />
            </Field>
          </div>

          {error && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}

          {canEdit && (
            <div className="mt-6">
              <Button variant="primary" onClick={saveRates} disabled={pending}>
                Save pay rules
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Public holidays in ${year}`}
          description="The twelve statutory days are worked out automatically, Easter included. Add a day this store observes, or mark one it trades through."
          action={
            canEdit ? (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <Icons.Plus size={16} />
                Add a day
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {calendar.length === 0 ? (
            <EmptyState
              title="No holidays in this year"
              hint="That should not happen — the statutory calendar always has twelve days."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Day</th>
                    <th className={TABLE_TH}>Holiday</th>
                    <th className={TABLE_TH}>Where it comes from</th>
                    {canEdit && <th className={TABLE_TH} />}
                  </tr>
                </thead>
                <tbody>
                  {calendar.map((day) => {
                    const override = overrideByDate.get(day.date)
                    return (
                      <tr key={day.date} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <span className="numeric text-ink">{day.date}</span>
                        </td>
                        <td className={TABLE_TD}>
                          <span className="text-ink-2">
                            {/* Explicit locale: an undefined one resolves to the
                                server's on the way out and the browser's on the
                                way in, and the mismatch fails hydration. */}
                            {new Date(`${day.date}T12:00:00`).toLocaleDateString('en-ZA', {
                              weekday: 'long',
                            })}
                          </span>
                        </td>
                        <td className={TABLE_TD}>
                          <span className="text-ink">{day.name}</span>
                        </td>
                        <td className={TABLE_TD}>
                          {override ? (
                            <Badge tone="brand">Added by this store</Badge>
                          ) : day.observed ? (
                            <Badge tone="neutral">Observed — it fell on a Sunday</Badge>
                          ) : (
                            <span className="text-muted">Statutory</span>
                          )}
                        </td>
                        {canEdit && (
                          <td className={TABLE_TD}>
                            {override && (
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                onClick={() => removeOverride(override.id)}
                                disabled={pending}
                              >
                                Remove
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Days the store has excluded do not appear above — they are no
              longer holidays — so they are listed separately or they would
              vanish with no way to undo the decision. */}
          {overrides.some((o) => o.isWorkingDay) && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-medium text-ink">Days this store trades through</p>
              <div className="flex flex-wrap gap-2">
                {overrides
                  .filter((o) => o.isWorkingDay)
                  .map((o) => (
                    <span
                      key={o.id}
                      className="flex items-center gap-2 rounded-pill bg-surface-2 px-3 py-1 text-sm text-ink-2"
                    >
                      <span className="numeric">{o.date}</span>
                      <span>{o.name}</span>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Stop trading through ${o.date}`}
                          onClick={() => removeOverride(o.id)}
                          disabled={pending}
                        >
                          <Icons.Close size={14} />
                        </Button>
                      )}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {adding && <HolidayForm year={year} onClose={() => setAdding(false)} />}
    </>
  )
}

/** Adding a day the computed calendar cannot know about, or removing one. */
function HolidayForm({ year, onClose }: { year: number; onClose: () => void }) {
  const [date, setDate] = useState(`${year}-01-01`)
  const [name, setName] = useState('')
  const [isWorkingDay, setIsWorkingDay] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveHolidayAction({
        date,
        name: name.trim(),
        isWorkingDay,
        note: note.trim() || null,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="A day of your own"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field
          label="What it is called"
          hint="Shown on the timesheet, so somebody reading it later knows why the day was paid differently."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Election day"
          />
        </Field>

        <Switch
          checked={isWorkingDay}
          onChange={setIsWorkingDay}
          label="This is an ordinary working day"
          hint="Turn this on to trade through a day the calendar treats as a public holiday. Hours then band as ordinary rather than premium."
        />

        <Field label="Note" hint="Optional. Why the decision was made.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
