'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmModal,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  TextLink,
  Textarea,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import { FREQUENCIES, FREQUENCY_LABELS, type RecurringFrequency } from '@/lib/expenseModel'
import type { JobSeries, SeriesRun } from '@/lib/site/jobSeries'
import {
  saveSeriesAction,
  deleteSeriesAction,
  raiseSeriesNowAction,
  seriesRunsAction,
  customerAddressesAction,
  customerAssetsAction,
} from '../actions'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * Recurring schedules: the list, the editor, and what each has raised.
 *
 * ── WHY "RAISE NOW" EXISTS AT ALL ──────────────────────────────────────────
 *
 * Because a schedule is a promise about the future, and nobody trusts one they
 * cannot test. Pressing it runs the same generator the cron runs, against the same
 * claim table — so it cannot double-raise, and what it produces is exactly what the
 * nightly run would have produced. It also overrides the auto switch, because
 * somebody pressing a button IS the decision that switch guards.
 *
 * ── WHY THE RUNS HISTORY IS ON DEMAND ──────────────────────────────────────
 *
 * A schedule running monthly for three years has 36 rows nobody looks at until
 * something goes wrong. Fetching them per row on every page load would be a query
 * per schedule for a table usually left closed.
 */
export default function RecurringClient({
  series,
  headlines,
  customers,
  canEdit,
  canSetup,
}: {
  series: JobSeries[]
  headlines: { id: number; name: string; itemCount: number }[]
  customers: { id: number; name: string }[]
  canEdit: boolean
  canSetup: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<JobSeries | 'new' | null>(null)
  const [name, setName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [addressId, setAddressId] = useState('')
  const [assetId, setAssetId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly')
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [leadDays, setLeadDays] = useState(0)
  const [isActive, setIsActive] = useState(true)
  const [autoCreate, setAutoCreate] = useState(false)
  const [note, setNote] = useState('')
  const [chosenHeadlines, setChosenHeadlines] = useState<number[]>([])

  const [addresses, setAddresses] = useState<{ id: number; name: string }[]>([])
  const [assets, setAssets] = useState<{ id: number; label: string }[]>([])

  const [showingRuns, setShowingRuns] = useState<JobSeries | null>(null)
  const [runs, setRuns] = useState<SeriesRun[]>([])
  const [deleting, setDeleting] = useState<JobSeries | null>(null)

  function open(target: JobSeries | 'new') {
    setEditing(target)
    if (target === 'new') {
      setName('')
      setCustomerId('')
      setAddressId('')
      setAssetId('')
      setTitle('')
      setDescription('')
      setPriority('normal')
      setFrequency('monthly')
      setDayOfMonth(1)
      setDayOfWeek(1)
      setStartsOn(new Date().toISOString().slice(0, 10))
      setEndsOn('')
      setLeadDays(0)
      setIsActive(true)
      // OFF for a new schedule, matching the column default. See the page header.
      setAutoCreate(false)
      setNote('')
      setChosenHeadlines([])
      setAddresses([])
      setAssets([])
      return
    }
    setName(target.name)
    setCustomerId(String(target.customerId))
    setAddressId(target.serviceAddressId === null ? '' : String(target.serviceAddressId))
    setAssetId(target.assetId === null ? '' : String(target.assetId))
    setTitle(target.title)
    setDescription(target.description ?? '')
    setPriority(target.priority)
    setFrequency(target.frequency)
    setDayOfMonth(target.dayOfMonth)
    setDayOfWeek(target.dayOfWeek ?? 1)
    setStartsOn(target.startsOn)
    setEndsOn(target.endsOn ?? '')
    setLeadDays(target.leadDays)
    setIsActive(target.isActive)
    setAutoCreate(target.autoCreate)
    setNote(target.note ?? '')
    setChosenHeadlines(target.headlineIds)
    loadFor(target.customerId)
  }

  function loadFor(id: number) {
    start(async () => {
      const [addr, ass] = await Promise.all([
        customerAddressesAction(id),
        customerAssetsAction(id),
      ])
      setAddresses(addr.map((a) => ({ id: a.id, name: a.name })))
      setAssets(ass)
    })
  }

  function chooseCustomer(next: string) {
    setCustomerId(next)
    // Both belonged to the old customer, so neither can survive the change.
    setAddressId('')
    setAssetId('')
    if (next === '') {
      setAddresses([])
      setAssets([])
      return
    }
    loadFor(Number(next))
  }

  function save() {
    if (editing === null) return
    start(async () => {
      const result = await saveSeriesAction({
        id: editing === 'new' ? null : editing.id,
        name,
        customerId: customerId === '' ? null : Number(customerId),
        serviceAddressId: addressId === '' ? null : Number(addressId),
        assetId: assetId === '' ? null : Number(assetId),
        title,
        description: description.trim() || null,
        priority: priority as never,
        ownerUserId: editing === 'new' ? null : editing.ownerUserId,
        ownerName: editing === 'new' ? null : editing.ownerName,
        locationId: editing === 'new' ? null : editing.locationId,
        frequency,
        dayOfMonth,
        dayOfWeek: frequency === 'weekly' ? dayOfWeek : null,
        startsOn,
        endsOn: endsOn || null,
        leadDays,
        isActive,
        autoCreate,
        note: note.trim() || null,
        headlineIds: chosenHeadlines,
      })
      if (result.ok) {
        toast.success(editing === 'new' ? 'Schedule added.' : 'Schedule saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function raiseNow(target: JobSeries) {
    start(async () => {
      const result = await raiseSeriesNowAction(target.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.created.length === 0) {
        // Not a failure: nothing is due, or every due period is already claimed.
        toast.success('Nothing was due — every period up to today has already been raised.')
      } else {
        toast.success(
          `Raised ${result.created.length} job${result.created.length === 1 ? '' : 's'}: ${result.created.map((c) => c.documentNumber ?? `#${c.jobId}`).join(', ')}.`,
        )
      }
      if (result.skipped.length > 0) {
        toast.error(result.skipped.map((s) => s.reason).join(' '))
      }
      router.refresh()
    })
  }

  function showRuns(target: JobSeries) {
    setShowingRuns(target)
    setRuns([])
    start(async () => {
      setRuns(await seriesRunsAction(target.id))
    })
  }

  function remove() {
    if (!deleting) return
    start(async () => {
      const result = await deleteSeriesAction(deleting.id)
      if (result.ok) {
        toast.success('Schedule deleted. The jobs it raised are untouched.')
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <>
      {series.length > 0 && (
        <Card>
          <CardHeader
            title="Schedules"
            description="Each raises a job when it falls due. Lead time raises it early so somebody can plan and order parts."
            action={
              canEdit ? (
                <Button variant="primary" onClick={() => open('new')} disabled={pending}>
                  <Icons.Plus size={15} />
                  New schedule
                </Button>
              ) : undefined
            }
          />
          <CardBody className="p-0">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Schedule</th>
                  <th className={TABLE_TH}>For</th>
                  <th className={TABLE_TH}>How often</th>
                  <th className={TABLE_TH}>Next due</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Raised</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`} />
                </tr>
              </thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.id}>
                    <td className={TABLE_TD}>
                      <div className="flex flex-col">
                        <span className="text-ink">
                          {s.name}
                          {!s.isActive && (
                            <Badge tone="neutral" className="ml-2">
                              Off
                            </Badge>
                          )}
                          {s.isActive && !s.autoCreate && (
                            // The distinction that matters: set up but not running.
                            <Badge tone="warning" className="ml-2">
                              Not raising
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted">{s.title}</span>
                      </div>
                    </td>
                    <td className={TABLE_TD}>
                      <div className="flex flex-col">
                        <TextLink href={`/customers/${s.customerId}`}>{s.customerName}</TextLink>
                        {s.assetDescription && (
                          <TextLink href={`/jobs/equipment/${s.assetId}`}>
                            <span className="text-xs">{s.assetDescription}</span>
                          </TextLink>
                        )}
                      </div>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-ink-2">{s.frequencyLabel}</span>
                      {s.leadDays > 0 && (
                        <span className="ml-2 text-xs text-muted">
                          {s.leadDays} days early
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {s.nextDueOn === null ? (
                        <span className="text-muted">{s.isActive ? 'finished' : '—'}</span>
                      ) : s.nextDueOn <= today ? (
                        <Badge tone="warning">due {s.nextDueOn}</Badge>
                      ) : (
                        <span className="text-ink-2">{s.nextDueOn}</span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {s.jobCount === 0 ? (
                        <span className="text-muted">none yet</span>
                      ) : (
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() => showRuns(s)}
                        >
                          {s.jobCount}
                        </button>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <div className="flex items-center justify-end gap-1.5">
                        {canEdit && s.isActive && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => raiseNow(s)}
                          >
                            Raise now
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Edit ${s.name}`}
                            onClick={() => open(s)}
                          >
                            <Icons.Pencil size={15} />
                          </Button>
                        )}
                        {canSetup && (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Delete ${s.name}`}
                            disabled={pending}
                            onClick={() => setDeleting(s)}
                          >
                            <Icons.Trash size={15} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {series.length === 0 && canEdit && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => open('new')} disabled={pending}>
            <Icons.Plus size={15} />
            New schedule
          </Button>
        </div>
      )}

      {/* ── The editor ─────────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'A new schedule' : `Edit ${editing?.name ?? ''}`}
        size="lg"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={pending || !name.trim() || !title.trim() || customerId === ''}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="min-w-56 flex-1">
              <Field label="Name" hint="What this schedule is called on this screen.">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Northgate — six-monthly aircon service"
                  maxLength={120}
                />
              </Field>
            </div>
            <Field label="Priority">
              <div className="w-32">
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </div>
            </Field>
          </div>

          <Field
            label="What the job will be called"
            hint="Every occurrence gets this title. The date is on the job itself."
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Six-monthly service"
              maxLength={190}
            />
          </Field>

          <div className="flex flex-wrap gap-4">
            <Field
              label="Customer"
              hint="Required — a schedule with nobody to serve raises work for nobody."
            >
              <div className="w-56">
                <Select value={customerId} onChange={(e) => chooseCustomer(e.target.value)}>
                  <option value="">Choose a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Which site" hint={customerId === '' ? 'Choose a customer first.' : ''}>
              <div className="w-48">
                <Select
                  value={addressId}
                  onChange={(e) => setAddressId(e.target.value)}
                  disabled={customerId === '' || addresses.length === 0}
                >
                  <option value="">Not specified</option>
                  {addresses.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field
              label="Which equipment"
              hint="The commonest reason to have a schedule at all."
            >
              <div className="w-56">
                <Select
                  value={assetId}
                  onChange={(e) => setAssetId(e.target.value)}
                  disabled={customerId === '' || assets.length === 0}
                >
                  <option value="">Not specified</option>
                  {assets.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          </div>

          {/* ── When ───────────────────────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <div className="flex flex-wrap gap-4">
              <Field label="How often">
                <div className="w-44">
                  <Select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {FREQUENCY_LABELS[f]}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>

              {frequency === 'weekly' ? (
                <Field label="On">
                  <div className="w-36">
                    <Select
                      value={String(dayOfWeek)}
                      onChange={(e) => setDayOfWeek(Number(e.target.value))}
                    >
                      {WEEKDAYS.map((d, i) => (
                        <option key={d} value={String(i + 1)}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Field>
              ) : (
                <Field
                  label="On day"
                  hint="31 falls on the last day in a short month, never into the next one."
                >
                  <div className="w-24">
                    <NumberInput
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)}
                      min={1}
                      max={31}
                    />
                  </div>
                </Field>
              )}

              <Field label="Starting">
                <div className="w-40">
                  <Input
                    type="date"
                    value={startsOn}
                    onChange={(e) => setStartsOn(e.target.value)}
                  />
                </div>
              </Field>
              <Field label="Until" hint="Blank runs until switched off.">
                <div className="w-40">
                  <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                </div>
              </Field>
            </div>

            <div className="mt-4">
              <Field
                label="Raise it this many days early"
                hint="The job still carries the due date — this only decides when it appears, so somebody can schedule it and order parts."
              >
                <div className="w-24">
                  <NumberInput
                    value={leadDays}
                    onChange={(e) => setLeadDays(Number(e.target.value) || 0)}
                    min={0}
                    max={90}
                  />
                </div>
              </Field>
            </div>
          </div>

          {/* ── What each occurrence brings ────────────────────────────── */}
          {headlines.length > 0 && (
            <div className="border-t border-border pt-4">
              <p className="text-sm font-medium text-ink">Kinds of work</p>
              <p className="mb-2 text-xs text-muted">
                Each job arrives already carrying the tasks and checks these bring. Editing a kind
                changes what FUTURE occurrences get — the jobs already raised keep what they were
                given.
              </p>
              <div className="flex flex-col gap-1.5">
                {headlines.map((h) => (
                  <Checkbox
                    key={h.id}
                    checked={chosenHeadlines.includes(h.id)}
                    onChange={(e) =>
                      setChosenHeadlines((prev) =>
                        e.target.checked ? [...prev, h.id] : prev.filter((id) => id !== h.id),
                      )
                    }
                    label={`${h.name}${h.itemCount > 0 ? ` — ${h.itemCount} task${h.itemCount === 1 ? '' : 's'}` : ''}`}
                  />
                ))}
              </div>
            </div>
          )}

          <Field label="Note" hint="Optional — anything whoever picks the job up should know.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={190} rows={2} />
          </Field>

          <div className="border-t border-border pt-4">
            <Switch
              checked={isActive}
              onChange={setIsActive}
              label="In use"
              hint="A retired schedule stops raising anything. The jobs it already raised stay."
            />
            <div className="mt-3">
              <Switch
                checked={autoCreate}
                onChange={setAutoCreate}
                label="Raise jobs automatically"
                hint="Off by default on purpose: a new schedule raises nothing until you turn this on, so it cannot surprise you with a run of back-dated jobs. Raise now works either way."
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* ── What it has raised ─────────────────────────────────────────── */}
      <Modal
        open={showingRuns !== null}
        onClose={() => setShowingRuns(null)}
        title={`What ${showingRuns?.name ?? ''} has raised`}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setShowingRuns(null)}>
            Close
          </Button>
        }
      >
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{pending ? 'Loading…' : 'Nothing raised yet.'}</p>
        ) : (
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Due</th>
                <th className={TABLE_TH}>Job</th>
                <th className={TABLE_TH}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className={TABLE_TD}>
                    <span className="text-ink-2">{r.forDate}</span>
                  </td>
                  <td className={TABLE_TD}>
                    {r.jobId === null ? (
                      // A claim with no job. See reconcileJobSeries — the period is
                      // blocked and will never be retried, so it is worth flagging.
                      <span className="text-muted">no job</span>
                    ) : (
                      <TextLink href={`/jobs/${r.jobId}`}>
                        {r.documentNumber ?? `#${r.jobId}`}
                      </TextLink>
                    )}
                  </td>
                  <td className={TABLE_TD}>
                    {r.status === 'failed' ? (
                      <Badge tone="danger">{r.error ?? 'failed'}</Badge>
                    ) : r.jobId === null ? (
                      <Badge tone="warning">claimed but never raised</Badge>
                    ) : (
                      <span className="text-muted">raised</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Delete ${deleting?.name ?? ''}?`}
        message={
          deleting && deleting.jobCount > 0
            ? `The ${deleting.jobCount} job${deleting.jobCount === 1 ? '' : 's'} it has raised stay exactly as they are — they just stop saying which schedule produced them. A schedule is a plan; the jobs are the record.`
            : 'It has raised nothing, so there is nothing to unlink.'
        }
        confirmLabel="Delete the schedule"
        busy={pending}
      />
    </>
  )
}
