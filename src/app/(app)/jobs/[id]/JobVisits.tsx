'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  CardBody,
  Checkbox,
  EmptyState,
  Field,
  Input,
  NumberInput,
  Modal,
  Select,
  SummaryList,
  SummaryRow,
  Textarea,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
  type BadgeTone,
} from '@/components/ui'
import type { JobAppointment, Conflict } from '@/lib/site/jobAppointments'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  APPOINTMENT_STATUS_TONE,
  appointmentNeedsReason,
  storedDate,
  RECORDED_SOURCES,
  RECORDED_SOURCE_LABEL,
  type AppointmentStatus,
  type RecordedSource,
} from '@/lib/jobStatusModel'
import { formatMoney } from '@/lib/decimals'
import type { JobTimeSummary } from '@/lib/site/jobTime'
import type { JobTravel } from '@/lib/site/jobTravel'
import {
  saveAppointmentAction,
  setVisitStatusAction,
  deleteAppointmentAction,
  schedulableUsersAction,
  startTimerAction,
  stopTimerAction,
  addTimeAction,
  deleteTimeAction,
  saveTravelAction,
  verifyTravelAction,
  deleteTravelAction,
} from '../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/**
 * The visits on a job.
 *
 * ── A LIST HERE, A SCREEN OF ITS OWN LATER ─────────────────────────────────
 *
 * This tab answers "how many times have we been, and when are we going next",
 * which is a job-level question. What a technician does ON a visit — arrive,
 * record time, take photographs, get a signature — is a visit-level screen, and
 * it is not built yet. So the actions here are the ones a dispatcher or a
 * technician needs from the job: book one, move one, say what happened.
 *
 * ── CONFLICTS ARE SHOWN, NOT ENFORCED ──────────────────────────────────────
 *
 * Saving returns the clashes; the dialog shows them and asks for a reason to
 * proceed. That is the PRD's answer and the right one — a dispatcher
 * double-booking somebody because two jobs are next door knows something the
 * scheduler does not, and a hard refusal would make them book it as a fake job,
 * which is worse than a warning nobody reads.
 */
export default function JobVisits({
  jobId,
  jobClosed,
  defaultAddressId,
  defaultAddressName,
  defaultMinutes,
  visits,
  time,
  travel,
  travelRate,
  canAssign,
  canEdit,
  canCost,
  canDecide,
}: {
  jobId: number
  jobClosed: boolean
  defaultAddressId: number | null
  /** Snapshotted onto a trip as its to-label, so a renamed address does not
      restate where somebody drove. */
  defaultAddressName: string | null
  defaultMinutes: number
  visits: JobAppointment[]
  time: JobTimeSummary
  travel: JobTravel[]
  travelRate: number
  canAssign: boolean
  canEdit: boolean
  /** Whether the hourly and per-kilometre figures may be shown at all. */
  canCost: boolean
  /** Verifying a distance decides what a customer is charged. Its own permission. */
  canDecide: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<JobAppointment | 'new' | null>(null)
  const [startsAt, setStartsAt] = useState('')
  const [minutes, setMinutes] = useState(defaultMinutes)
  const [visitType, setVisitType] = useState('')
  const [notes, setNotes] = useState('')
  const [chosen, setChosen] = useState<number[]>([])
  const [leadId, setLeadId] = useState<number | null>(null)

  const [people, setPeople] = useState<{ id: number; name: string }[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [override, setOverride] = useState('')

  const [outcome, setOutcome] = useState<{ visit: JobAppointment; status: AppointmentStatus } | null>(
    null,
  )
  const [outcomeReason, setOutcomeReason] = useState('')

  const [stopping, setStopping] = useState(false)
  const [stopNote, setStopNote] = useState('')
  const [booking, setBooking] = useState(false)
  const [bookWho, setBookWho] = useState<number | null>(null)
  const [bookAt, setBookAt] = useState('')
  const [bookMinutes, setBookMinutes] = useState(60)
  const [bookNote, setBookNote] = useState('')

  const [trip, setTrip] = useState(false)
  const [tripWho, setTripWho] = useState<number | null>(null)
  const [tripOn, setTripOn] = useState('')
  const [tripKm, setTripKm] = useState(0)
  const [tripSource, setTripSource] = useState<RecordedSource>('odometer')
  const [tripReturn, setTripReturn] = useState(true)
  const [tripMinutes, setTripMinutes] = useState(0)
  const [tripNote, setTripNote] = useState('')

  const [verifying, setVerifying] = useState<JobTravel | null>(null)
  const [verifyKm, setVerifyKm] = useState('')
  const [verifyNote, setVerifyNote] = useState('')

  useEffect(() => {
    if (!canAssign) return
    let live = true
    schedulableUsersAction()
      .then((found) => {
        if (live) setPeople(found)
      })
      .catch(() => {
        if (live) setPeople([])
      })
    return () => {
      live = false
    }
  }, [canAssign])

  function openVisit(visit: JobAppointment | 'new') {
    setEditing(visit)
    setConflicts([])
    setOverride('')
    if (visit === 'new') {
      // Tomorrow morning, because the commonest booking is "not today", and a
      // field prefilled with now means somebody books a visit in the past.
      const at = new Date()
      at.setDate(at.getDate() + 1)
      at.setHours(9, 0, 0, 0)
      setStartsAt(localInput(at))
      setMinutes(defaultMinutes)
      setVisitType('')
      setNotes('')
      setChosen([])
      setLeadId(null)
    } else {
      setStartsAt(visit.startsAt.replace(' ', 'T').slice(0, 16))
      setMinutes(visit.durationMinutes)
      setVisitType(visit.visitType ?? '')
      setNotes(visit.notes ?? '')
      setChosen(visit.assignees.map((a) => a.userId))
      setLeadId(visit.assignees.find((a) => a.isLead)?.userId ?? null)
    }
  }

  function save() {
    start(async () => {
      const result = await saveAppointmentAction({
        id: editing === 'new' || editing === null ? null : editing.id,
        jobCardId: jobId,
        startsAt: startsAt.replace('T', ' ') + ':00',
        durationMinutes: minutes,
        serviceAddressId:
          editing === 'new' || editing === null ? defaultAddressId : editing.serviceAddressId,
        visitType: visitType || null,
        notes: notes || null,
        assignees: chosen.map((id) => ({
          userId: id,
          userName: people.find((p) => p.id === id)?.name ?? '',
          // With one person going they lead it by default — asking would be a
          // question with one possible answer.
          isLead: chosen.length === 1 ? true : leadId === id,
        })),
        overrideReason: override || null,
      })

      if (!result.ok) {
        if (result.conflicts?.length) {
          // First pass: show what is wrong and let them decide.
          setConflicts(result.conflicts)
          return
        }
        toast.error(result.error)
        return
      }

      toast.success(
        result.conflicts.length > 0
          ? `Booked over ${result.conflicts.length} warning${result.conflicts.length === 1 ? '' : 's'}.`
          : editing === 'new'
            ? 'Visit booked.'
            : 'Visit moved.',
      )
      setEditing(null)
      setConflicts([])
      setOverride('')
      router.refresh()
    })
  }

  function move(visit: JobAppointment, status: AppointmentStatus) {
    if (appointmentNeedsReason(status)) {
      setOutcome({ visit, status })
      setOutcomeReason('')
      return
    }
    start(async () => {
      const result = await setVisitStatusAction(jobId, visit.id, status)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(APPOINTMENT_STATUS_LABEL[status] + '.')
      router.refresh()
    })
  }

  function applyOutcome() {
    if (!outcome) return
    start(async () => {
      const result = await setVisitStatusAction(jobId, outcome.visit.id, outcome.status, outcomeReason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Recorded.')
      setOutcome(null)
      router.refresh()
    })
  }

  function startTimer() {
    start(async () => {
      const result = await startTimerAction(jobId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Say what was stopped, not just what started: a technician who switched
      // jobs needs to know the previous one is recorded and unpriced.
      toast.success(
        result.stoppedOther
          ? `Clock started. Stopped ${hoursMinutes(result.stoppedOther.minutes)} on ${result.stoppedOther.jobNumber ?? 'the other job'} — it still needs costing.`
          : 'Clock started.',
      )
      router.refresh()
    })
  }

  function stopTimer() {
    start(async () => {
      const result = await stopTimerAction(jobId, stopNote || undefined)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.minutes === 0
          ? 'Stopped — less than a minute, so no labour line was made.'
          : result.priced
            ? `${hoursMinutes(result.minutes)} recorded and costed.`
            : `${hoursMinutes(result.minutes)} recorded. The labour line needs pricing — check the pay rate and the labour product.`,
      )
      setStopping(false)
      setStopNote('')
      router.refresh()
    })
  }

  function openTime() {
    setBooking(true)
    setBookWho(people[0]?.id ?? null)
    const at = new Date()
    at.setHours(at.getHours() - 1, 0, 0, 0)
    setBookAt(localInput(at))
    setBookMinutes(60)
    setBookNote('')
  }

  function bookTime() {
    if (bookWho === null) return
    start(async () => {
      const result = await addTimeAction(jobId, {
        userId: bookWho,
        userName: people.find((p) => p.id === bookWho)?.name ?? '',
        startedAt: bookAt.replace('T', ' ') + ':00',
        minutes: bookMinutes,
        note: bookNote || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${hoursMinutes(result.minutes)} booked${result.priced ? ' and costed' : ' — needs pricing'}.`)
      setBooking(false)
      router.refresh()
    })
  }

  function removeTime(entry: JobTimeSummary['entries'][number]) {
    start(async () => {
      const result = await deleteTimeAction(jobId, entry.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Time entry removed.')
      router.refresh()
    })
  }

  function openTrip() {
    setTrip(true)
    setTripWho(people[0]?.id ?? null)
    setTripOn(new Date().toISOString().slice(0, 10))
    setTripKm(0)
    setTripSource('odometer')
    setTripReturn(true)
    setTripMinutes(0)
    setTripNote('')
  }

  function saveTrip() {
    if (tripWho === null) return
    start(async () => {
      const result = await saveTravelAction({
        id: null,
        jobCardId: jobId,
        appointmentId: null,
        userId: tripWho,
        userName: people.find((p) => p.id === tripWho)?.name ?? '',
        travelledOn: tripOn,
        fromLabel: 'Base',
        toLabel: defaultAddressName,
        serviceAddressId: defaultAddressId,
        recordedKm: tripKm,
        recordedSource: tripSource,
        isReturn: tripReturn,
        travelMinutes: tripMinutes,
        note: tripNote || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Say when a claim needs checking, rather than letting it sit unnoticed.
      toast.success(
        result.breached
          ? `${result.chargeableKm} km recorded — that is past the expected ${result.expectedKm} km, so it needs a signature.`
          : `${result.chargeableKm} km recorded.`,
      )
      setTrip(false)
      router.refresh()
    })
  }

  function verifyTrip() {
    if (!verifying) return
    start(async () => {
      const result = await verifyTravelAction(
        jobId,
        verifying.id,
        Number(verifyKm),
        verifyNote || null,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Recorded.')
      setVerifying(null)
      router.refresh()
    })
  }

  function removeTrip(target: JobTravel) {
    start(async () => {
      const result = await deleteTravelAction(jobId, target.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Trip removed.')
      router.refresh()
    })
  }

  function remove(visit: JobAppointment) {
    start(async () => {
      const result = await deleteAppointmentAction(jobId, visit.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Visit removed.')
      router.refresh()
    })
  }

  return (
    <>
      {/* ── The clock ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Time on this job"
          description={
            time.openEntry
              ? `${time.openEntry.userName} has the clock running since ${clock(time.openEntry.startedAt)}.`
              : 'Start the clock when you begin. Stopping it records the hours and makes a labour line.'
          }
          action={
            canEdit && !jobClosed ? (
              <div className="flex items-center gap-2">
                {canAssign && (
                  <Button variant="secondary" size="sm" onClick={openTime} disabled={pending}>
                    <Icons.Plus size={14} />
                    Book time
                  </Button>
                )}
                {time.openEntry ? (
                  <Button variant="danger" size="sm" onClick={() => setStopping(true)} disabled={pending}>
                    <Icons.Pause size={14} />
                    Stop the clock
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={startTimer} disabled={pending}>
                    <Icons.Play size={14} />
                    Start the clock
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
        <CardBody className={time.entries.length === 0 ? '' : 'p-0'}>
          {time.entries.length === 0 ? (
            <p className="text-sm text-muted">No time recorded yet.</p>
          ) : (
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Who</th>
                  <th className={TABLE_TH}>Started</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Time</th>
                  <th className={TABLE_TH}>Costed</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {time.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className={TABLE_TD}>
                      <span className="text-ink-2">{entry.userName}</span>
                      {entry.note && <span className="ml-2 text-xs text-muted">{entry.note}</span>}
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{when(entry.startedAt, entry.minutes ?? 0)}</span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {entry.isOpen ? (
                        <Badge tone="warning">Running</Badge>
                      ) : (
                        <span className="numeric text-ink">{hoursMinutes(entry.minutes ?? 0)}</span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {entry.isOpen ? (
                        <span className="text-faint">—</span>
                      ) : entry.lineId === null ? (
                        /* Time with no line is an hour the job cost that nobody
                           will bill. The one thing on this table worth a colour. */
                        <span className="text-warning">Not costed yet</span>
                      ) : (
                        <span className="text-muted">On the costs tab</span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {canAssign && !jobClosed && !entry.isOpen && (
                        <div className="flex justify-end">
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            iconOnly
                            aria-label="Remove this time entry"
                            disabled={pending}
                            onClick={() => removeTime(entry)}
                          >
                            <Icons.Trash size={14} />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {time.recordedMinutes > 0 && (
                <tfoot>
                  <tr className={TABLE_TOTAL_ROW}>
                    <td className={TABLE_TD} colSpan={2}>
                      Recorded
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <span className="numeric text-ink">{hoursMinutes(time.recordedMinutes)}</span>
                    </td>
                    <td className={TABLE_TD} colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </CardBody>
      </Card>

      {/* ── The road ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Travel"
          description={
            travelRate > 0
              ? `Charged at ${formatMoney(travelRate)} a kilometre. What is billed is the chargeable figure, not the claim.`
              : 'No kilometre rate is set yet, so trips record distance but bill nothing.'
          }
          action={
            canEdit && !jobClosed ? (
              <Button variant="secondary" size="sm" onClick={openTrip} disabled={pending}>
                <Icons.Plus size={14} />
                Record a trip
              </Button>
            ) : undefined
          }
        />
        <CardBody className={travel.length === 0 ? '' : 'flex flex-col gap-3'}>
          {travel.length === 0 ? (
            <p className="text-sm text-muted">No travel recorded.</p>
          ) : (
            travel.map((trip) => (
              <article
                key={trip.id}
                className={`flex flex-col gap-2 rounded-card border p-3 ${
                  trip.needsVerifying ? 'border-warning bg-warning-soft' : 'border-border bg-surface'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink">{trip.userName}</span>
                    <span className="text-xs text-muted">
                      {trip.travelledOn}
                      {trip.toLabel ? ` · ${trip.fromLabel ?? 'Base'} → ${trip.toLabel}` : ''}
                      {trip.isReturn ? ' · return' : ' · one way'}
                    </span>
                    {trip.needsVerifying && <Badge tone="warning">Needs a signature</Badge>}
                    {trip.verifiedAt !== null && <Badge tone="success">Verified</Badge>}
                  </div>
                  {canCost && (
                    <span className="numeric text-sm text-ink">{formatMoney(trip.chargeIncl)}</span>
                  )}
                </div>

                {/* The four figures, side by side, exactly as the PRD sets them
                    out — because the whole point is that they can differ and a
                    reader needs to see which. */}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted">Recorded</dt>
                    <dd className="numeric text-ink-2">
                      {trip.recordedKm} km
                      <span className="ml-1 text-faint">
                        {RECORDED_SOURCE_LABEL[trip.recordedSource].toLowerCase()}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Expected</dt>
                    <dd className="numeric text-ink-2">
                      {trip.expectedKm === null ? (
                        <span className="text-faint">not known</span>
                      ) : (
                        <>
                          {trip.expectedKm} km
                          {/* Says ESTIMATED, always. Labelling a haversine as a
                              measurement is how somebody gets accused of padding
                              by an arithmetic artefact. */}
                          <span className="ml-1 text-faint">estimated</span>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Verified</dt>
                    <dd className="numeric text-ink-2">
                      {trip.verifiedKm === null ? (
                        <span className="text-faint">nobody has looked</span>
                      ) : (
                        `${trip.verifiedKm} km`
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Chargeable</dt>
                    <dd className="numeric text-ink">{trip.chargeableKm} km</dd>
                  </div>
                </dl>

                {trip.verifyNote && (
                  <p className="text-xs text-ink-2">
                    {trip.verifiedByName}: {trip.verifyNote}
                  </p>
                )}
                {trip.note && <p className="text-sm text-ink-2">{trip.note}</p>}

                <div className="flex gap-1">
                  {canDecide && !jobClosed && trip.lineId !== null && (
                    <Button
                      variant={trip.needsVerifying ? 'primary' : 'ghost'}
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setVerifying(trip)
                        setVerifyKm(String(trip.verifiedKm ?? trip.recordedKm))
                        setVerifyNote('')
                      }}
                    >
                      <Icons.Check size={13} />
                      {trip.verifiedAt === null ? 'Check it' : 'Change the figure'}
                    </Button>
                  )}
                  {canAssign && !jobClosed && (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => removeTrip(trip)}
                    >
                      <Icons.Trash size={13} />
                      Remove
                    </Button>
                  )}
                </div>
              </article>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Visits"
          description="A job can take several trips. Each one records who went, when, and what happened."
          action={
            canAssign && !jobClosed ? (
              <Button variant="primary" size="sm" onClick={() => openVisit('new')} disabled={pending}>
                <Icons.Plus size={14} />
                Book a visit
              </Button>
            ) : undefined
          }
        />
        <CardBody className={visits.length === 0 ? '' : 'flex flex-col gap-3'}>
          {visits.length === 0 ? (
            <EmptyState
              title="No visits booked"
              hint="Book one so the technician knows when to go and the job stops showing as unscheduled."
              icon={<Icons.CalendarClock size={22} />}
            />
          ) : (
            visits.map((visit) => (
              <article
                key={visit.id}
                className={`flex flex-col gap-2 rounded-card border p-3 ${
                  visit.isLive ? 'border-border bg-surface' : 'border-border bg-surface-2'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">Visit {visit.visitNumber}</span>
                    <span className="text-sm text-ink">{when(visit.startsAt, visit.durationMinutes)}</span>
                    <Badge tone={TONE[APPOINTMENT_STATUS_TONE[visit.status]] ?? 'neutral'}>
                      {APPOINTMENT_STATUS_LABEL[visit.status]}
                    </Badge>
                    {visit.visitType && <span className="text-xs text-muted">{visit.visitType}</span>}
                  </div>

                  {canEdit && !jobClosed && visit.isLive && (
                    <div className="flex flex-wrap items-center gap-1">
                      {/* Only the next step forward, plus the two ways it can go
                          wrong. A row of seven buttons is a row nobody reads. */}
                      {nextSteps(visit.status).map((step) => (
                        <Button
                          key={step}
                          variant={step === 'on_site' ? 'primary' : 'secondary'}
                          size="sm"
                          disabled={pending}
                          onClick={() => move(visit, step)}
                        >
                          {APPOINTMENT_STATUS_LABEL[step]}
                        </Button>
                      ))}
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => move(visit, 'no_show')}
                      >
                        Nobody there
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => move(visit, 'cancelled')}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {visit.assignees.length === 0 ? (
                    <span className="text-warning">Nobody assigned</span>
                  ) : (
                    <span className="text-ink-2">
                      {visit.assignees
                        .map((a) => (a.isLead && visit.assignees.length > 1 ? `${a.userName} (lead)` : a.userName))
                        .join(', ')}
                    </span>
                  )}
                  {visit.serviceAddressName && (
                    <span className="text-muted">· {visit.serviceAddressName}</span>
                  )}
                  {/* What actually happened, against what was booked — the
                      figures every on-time report is built from. */}
                  {visit.arrivedAt && (
                    <span className="text-muted">· arrived {clock(visit.arrivedAt)}</span>
                  )}
                  {visit.departedAt && <span className="text-muted">· left {clock(visit.departedAt)}</span>}
                </div>

                {visit.notes && <p className="text-sm text-ink-2">{visit.notes}</p>}
                {visit.outcomeReason && (
                  <p className="text-sm text-danger-ink">{visit.outcomeReason}</p>
                )}
                {visit.overrideReason && (
                  <p className="text-xs text-warning">
                    Booked over a warning: {visit.overrideReason}
                  </p>
                )}

                {canAssign && !jobClosed && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openVisit(visit)} disabled={pending}>
                      <Icons.Pencil size={13} />
                      Change
                    </Button>
                    {/* No delete once somebody attended — the record of the day
                        stands, and cancelling with a reason is the way to undo it. */}
                    {visit.arrivedAt === null && visit.status !== 'completed' && (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => remove(visit)}
                        disabled={pending}
                      >
                        <Icons.Trash size={13} />
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </article>
            ))
          )}
        </CardBody>
      </Card>

      {/* ── Book or move ──────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing === 'new' || editing === null
            ? 'Book a visit'
            : `Change visit ${editing.visitNumber}`
        }
        size="md"
      >
        <div className="flex flex-col gap-4">
          {conflicts.length > 0 && (
            <Callout tone="warning" title={`${conflicts.length} problem${conflicts.length === 1 ? '' : 's'} with that slot`}>
              <ul className="flex flex-col gap-1">
                {conflicts.map((conflict, index) => (
                  <li key={index}>{conflict.message}</li>
                ))}
              </ul>
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="When">
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => {
                  setStartsAt(e.target.value)
                  // A changed slot is a different question, so the old answer
                  // stops applying.
                  setConflicts([])
                  setOverride('')
                }}
              />
            </Field>
            <Field label="How long" hint="Minutes.">
              <NumberInput
                value={minutes}
                onChange={(e) => {
                  setMinutes(Number(e.target.value))
                  setConflicts([])
                  setOverride('')
                }}
                className="numeric"
              />
            </Field>
          </div>

          <Field
            label="Who is going"
            hint="Leave it empty to hold the slot before you know who is free — it shows as unassigned until you do."
          >
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {people.length === 0 ? (
                <span className="text-sm text-muted">No active users to assign.</span>
              ) : (
                people.map((person) => (
                  <Checkbox
                    key={person.id}
                    label={person.name}
                    checked={chosen.includes(person.id)}
                    onChange={(e) => {
                      setChosen((current) =>
                        e.target.checked
                          ? [...current, person.id]
                          : current.filter((id) => id !== person.id),
                      )
                      setConflicts([])
                      setOverride('')
                    }}
                  />
                ))
              )}
            </div>
          </Field>

          {chosen.length > 1 && (
            <Field label="Who leads it" hint="One person answerable for this visit.">
              <Select
                value={leadId === null ? '' : String(leadId)}
                onChange={(e) => setLeadId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Choose…</option>
                {chosen.map((id) => (
                  <option key={id} value={id}>
                    {people.find((p) => p.id === id)?.name ?? `#${id}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind of visit" hint="First look, repair, follow-up.">
              <Input value={visitType} onChange={(e) => setVisitType(e.target.value)} placeholder="Repair" />
            </Field>
            <Field label="Notes for the technician">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tenant home mornings only" />
            </Field>
          </div>

          {conflicts.length > 0 && (
            <Field
              label="Book it anyway — why?"
              hint="Recorded on the visit and in the job history."
            >
              <Textarea
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                rows={2}
                placeholder="Both jobs are on the same street."
              />
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={conflicts.length > 0 ? 'danger' : 'primary'}
              onClick={save}
              disabled={pending || !startsAt || (conflicts.length > 0 && !override.trim())}
            >
              {conflicts.length > 0 ? 'Book it anyway' : editing === 'new' ? 'Book it' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Stopping the clock ────────────────────────────────────────── */}
      <Modal open={stopping} onClose={() => setStopping(false)} title="Stop the clock" size="sm">
        <div className="flex flex-col gap-4">
          {time.openEntry && (
            <p className="text-sm text-muted">
              Running since {clock(time.openEntry.startedAt)}. Stopping records the hours and makes a
              labour line on the costs tab.
            </p>
          )}
          <Field label="What was done" hint="Optional. Goes on the labour line.">
            <Textarea
              value={stopNote}
              onChange={(e) => setStopNote(e.target.value)}
              rows={2}
              placeholder="Replaced the capacitor and tested."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStopping(false)} disabled={pending}>
              Keep running
            </Button>
            <Button variant="primary" onClick={stopTimer} disabled={pending}>
              Stop and record
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Booking time somebody forgot ──────────────────────────────── */}
      <Modal open={booking} onClose={() => setBooking(false)} title="Book time" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            For hours somebody worked without pressing start. Recorded against them, with your name as
            who booked it.
          </p>
          <Field label="Who worked">
            <Select
              value={bookWho === null ? '' : String(bookWho)}
              onChange={(e) => setBookWho(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Choose…</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Started">
              <Input
                type="datetime-local"
                value={bookAt}
                onChange={(e) => setBookAt(e.target.value)}
              />
            </Field>
            <Field label="How long" hint="Minutes.">
              <NumberInput
                value={bookMinutes}
                onChange={(e) => setBookMinutes(Number(e.target.value))}
                className="numeric"
              />
            </Field>
          </div>
          <Field label="What was done" hint="Optional.">
            <Input value={bookNote} onChange={(e) => setBookNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBooking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={bookTime}
              disabled={pending || bookWho === null || !bookAt || bookMinutes <= 0}
            >
              Book it
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Recording a trip ──────────────────────────────────────────── */}
      <Modal open={trip} onClose={() => setTrip(false)} title="Record a trip" size="sm">
        <div className="flex flex-col gap-4">
          <Field label="Who drove">
            <Select
              value={tripWho === null ? '' : String(tripWho)}
              onChange={(e) => setTripWho(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Choose…</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="When">
              <Input type="date" value={tripOn} onChange={(e) => setTripOn(e.target.value)} />
            </Field>
            <Field label="Kilometres" hint="What was actually driven.">
              <NumberInput
                value={tripKm}
                onChange={(e) => setTripKm(Number(e.target.value))}
                className="numeric"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How it was measured">
              <Select
                value={tripSource}
                onChange={(e) => setTripSource(e.target.value as RecordedSource)}
              >
                {RECORDED_SOURCES.map((value) => (
                  <option key={value} value={value}>
                    {RECORDED_SOURCE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Time on the road" hint="Minutes. Optional.">
              <NumberInput
                value={tripMinutes}
                onChange={(e) => setTripMinutes(Number(e.target.value))}
                className="numeric"
              />
            </Field>
          </div>

          {/* Which decides what the expectation is compared against, so it is a
              question rather than an assumption. */}
          <Checkbox
            label="There and back"
            checked={tripReturn}
            onChange={(e) => setTripReturn(e.target.checked)}
          />

          <Field label="Note" hint="A detour, a second call on the way. Optional.">
            <Input value={tripNote} onChange={(e) => setTripNote(e.target.value)} />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTrip(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={saveTrip}
              disabled={pending || tripWho === null || !tripOn || (tripKm <= 0 && tripMinutes <= 0)}
            >
              Record it
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Checking a claim ──────────────────────────────────────────── */}
      <Modal
        open={verifying !== null}
        onClose={() => setVerifying(null)}
        title="Check the distance"
        size="sm"
      >
        {verifying && (
          <div className="flex flex-col gap-4">
            <SummaryList>
              <SummaryRow label="Claimed" value={`${verifying.recordedKm} km`} />
              <SummaryRow
                label="Expected (estimated)"
                value={verifying.expectedKm === null ? '—' : `${verifying.expectedKm} km`}
                tone={verifying.toleranceBreached ? 'warning' : 'default'}
              />
            </SummaryList>

            <Field
              label="Accept this many kilometres"
              hint="Leave it as claimed to accept. Change it and you will be asked why."
            >
              <NumberInput
                value={verifyKm}
                onChange={(e) => setVerifyKm(e.target.value)}
                className="numeric"
              />
            </Field>

            {Number(verifyKm) !== verifying.recordedKm && (
              <Field
                label="Why the change"
                hint="Recorded against the job. The technician is entitled to see it."
              >
                <Textarea
                  value={verifyNote}
                  onChange={(e) => setVerifyNote(e.target.value)}
                  rows={2}
                  placeholder="Route is 30 km each way."
                />
              </Field>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setVerifying(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={verifyTrip}
                disabled={
                  pending ||
                  verifyKm === '' ||
                  (Number(verifyKm) !== verifying.recordedKm && !verifyNote.trim())
                }
              >
                Record it
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── What went wrong ───────────────────────────────────────────── */}
      <Modal
        open={outcome !== null}
        onClose={() => setOutcome(null)}
        title={outcome?.status === 'cancelled' ? 'Cancel the visit' : 'Nobody was there'}
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <Field
            label={outcome?.status === 'cancelled' ? 'Why was it called off?' : 'What happened?'}
            hint="A missed visit with no reason is what the customer phones about."
          >
            <Textarea
              value={outcomeReason}
              onChange={(e) => setOutcomeReason(e.target.value)}
              rows={2}
              placeholder={
                outcome?.status === 'cancelled'
                  ? 'Customer rescheduled to next week.'
                  : 'Knocked at 09:10, phoned twice, no answer.'
              }
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOutcome(null)} disabled={pending}>
              Back
            </Button>
            <Button
              variant="danger"
              onClick={applyOutcome}
              disabled={pending || !outcomeReason.trim()}
            >
              Record it
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

/**
 * The steps forward from a status, in the order a visit really goes.
 *
 * Deliberately not every status: a technician wants one obvious button, and
 * offering all seven makes them read a menu on a phone in the rain. Cancel and
 * no-show are separate, and always available, because those are the two things
 * that can happen at any point.
 */
function nextSteps(status: AppointmentStatus): AppointmentStatus[] {
  switch (status) {
    case 'scheduled':
      return ['confirmed', 'en_route']
    case 'confirmed':
      return ['en_route']
    case 'en_route':
      return ['on_site']
    case 'on_site':
      return ['completed']
    default:
      return []
  }
}

/**
 * "2h 30m", the way a timesheet reads it.
 *
 * A local copy of formatDuration() from timeModel.ts rather than an import: that
 * module is reached through site/jobTime.ts, which is `server-only`, and pulling
 * it in here would drag mysql2 into the browser bundle. Four lines of formatting
 * with no dependencies — the same trade quotesModel.ts makes for today().
 */
function hoursMinutes(minutes: number): string {
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** A datetime-local value from a Date, in the browser's own zone. */
function localInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/*
 * The pool stores DATETIME as a UTC wall clock, so these read it back with
 * getUTC* rather than getHours() — which on a South African machine would shift
 * every appointment two hours. See the note in jobAppointments.ts.
 */
function clock(value: string): string {
  const at = storedDate(value)
  if (!at) return value
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`
}

function when(value: string, minutes: number): string {
  const at = storedDate(value)
  if (!at) return value
  const day = at.toLocaleDateString('en-ZA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  const end = new Date(at.getTime() + minutes * 60_000)
  const hm = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  return `${day}, ${hm(at)}–${hm(end)}`
}

/** Re-exported for the schedule screen, which draws the same status chips. */
export { APPOINTMENT_STATUSES }
