'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  TextLink,
  useToast,
} from '@/components/ui'
import {
  setJobAssetAction,
  customerAssetsAction,
  addJobAssetAction,
  removeJobAssetAction,
} from '../actions'

/**
 * Which piece of equipment this job is about, and what else was looked at.
 *
 * ── ONE PRIMARY ASSET, AND OTHERS ALONGSIDE (161) ──────────────────────────
 *
 * This card used to say "one asset, not many", and the reasoning behind that is
 * still why the shape is what it is: a job is a visit to fix a thing, and making
 * the asset a plain list would mean every cost, check and warranty question had
 * to say WHICH asset it belonged to.
 *
 * So the primary asset stays exactly where it was — `job_cards.asset_id`, one
 * per job, the answer whenever nothing says otherwise. 161 adds the OTHERS: the
 * three more units serviced on the same visit, which the PRD asks for in 18.4.
 * They get a service history and a "last serviced" date; they do not compete to
 * be the subject of the job.
 *
 * A part or a check MAY name one of them, and usually will not. That is why
 * `job_card_lines.asset_id` is nullable: NULL means the job's asset, which on
 * the overwhelming majority of jobs is the only possible answer.
 *
 * ── THE PICKER IS SCOPED TO THE CUSTOMER ───────────────────────────────────
 *
 * Two customers own the same model and the list is alphabetical, so an unscoped
 * picker is how a warranty claim lands against the wrong account. The action
 * refuses a mismatch as well — a filtered list is a convenience, not a boundary.
 */
export default function JobAssetCard({
  jobId,
  customerId,
  asset,
  others,
  canEdit,
  jobClosed,
}: {
  jobId: number
  customerId: number | null
  asset: {
    id: number
    description: string
    documentNumber: string | null
    serialText: string | null
    identifierLabel: string
    warrantyUntil: string | null
    nextServiceOn: string | null
    jobCount: number
  } | null
  /** The other units on this visit (161). Never includes the primary. */
  others: {
    id: number
    assetId: number
    description: string
    serialText: string | null
    identifierLabel: string
    note: string | null
  }[]
  canEdit: boolean
  jobClosed: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [picking, setPicking] = useState(false)
  const [options, setOptions] = useState<{ id: number; label: string }[]>([])
  const [chosen, setChosen] = useState(asset === null ? '' : String(asset.id))

  // Adding another unit (161). Its own dialog rather than a multi-select on the
  // one above, because the two answer different questions: that one changes what
  // the job IS about, this one adds to what was also looked at.
  const [adding, setAdding] = useState(false)
  const [addChoice, setAddChoice] = useState('')
  const [addNote, setAddNote] = useState('')

  function openAdd() {
    setAdding(true)
    setAddChoice('')
    setAddNote('')
    start(async () => {
      setOptions(await customerAssetsAction(customerId))
    })
  }

  function addOther() {
    if (addChoice === '') return
    start(async () => {
      const result = await addJobAssetAction(jobId, Number(addChoice), addNote.trim() || null)
      if (result.ok) {
        toast.success('Equipment added.')
        setAdding(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(assetId: number, description: string) {
    start(async () => {
      const result = await removeJobAssetAction(jobId, assetId)
      if (result.ok) {
        toast.success(`${description} removed.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const today = new Date().toISOString().slice(0, 10)
  const warrantyLive = asset?.warrantyUntil !== null && asset?.warrantyUntil !== undefined && asset.warrantyUntil >= today

  function open() {
    setPicking(true)
    setChosen(asset === null ? '' : String(asset.id))
    start(async () => {
      // Fetched on open rather than with the page: most visits to a job card never
      // touch this, and a customer with 200 units should not cost every render.
      setOptions(await customerAssetsAction(customerId))
    })
  }

  function save() {
    start(async () => {
      const result = await setJobAssetAction(jobId, chosen === '' ? null : Number(chosen))
      if (result.ok) {
        toast.success(chosen === '' ? 'Equipment cleared.' : 'Equipment set.')
        setPicking(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="What it is about"
          description={
            asset === null
              ? 'No equipment named. Naming it builds the unit a service history for free.'
              : 'The unit this visit is for. Its history is on the equipment record.'
          }
          action={
            canEdit && !jobClosed ? (
              <Button variant="secondary" onClick={open} disabled={pending}>
                <Icons.Wrench size={15} />
                {asset === null ? 'Name the equipment' : 'Change'}
              </Button>
            ) : undefined
          }
        />
        {asset !== null && (
          <CardBody>
            <div className="flex flex-col gap-1 text-sm">
              <TextLink href={`/jobs/equipment/${asset.id}`}>
                {asset.description}
                {asset.documentNumber ? ` · ${asset.documentNumber}` : ''}
              </TextLink>
              {asset.serialText && (
                <span className="text-muted">
                  {asset.identifierLabel}: {asset.serialText}
                </span>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {/* Warranty first: it decides who pays, which is the question a
                    technician standing in front of a broken unit has. */}
                {asset.warrantyUntil === null ? (
                  <span className="text-xs text-muted">No warranty recorded</span>
                ) : warrantyLive ? (
                  <Badge tone="success">Under warranty until {asset.warrantyUntil}</Badge>
                ) : (
                  <Badge tone="neutral">Warranty expired {asset.warrantyUntil}</Badge>
                )}
                {asset.jobCount > 1 && (
                  <TextLink href={`/jobs/equipment/${asset.id}`}>
                    {asset.jobCount - 1} previous visit{asset.jobCount === 2 ? '' : 's'}
                  </TextLink>
                )}
              </div>
            </div>
          </CardBody>
        )}

        {/* ── The other units on this visit (161, §18.4) ────────────────────
            Shown only once there is a primary, because "also looked at" has no
            meaning before the job says what it is about. */}
        {asset !== null && (others.length > 0 || (canEdit && !jobClosed)) && (
          <CardBody className="border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-2">
                {others.length === 0
                  ? 'Also on this visit'
                  : `Also on this visit (${others.length})`}
              </span>
              {canEdit && !jobClosed && (
                <Button variant="ghost" size="sm" onClick={openAdd} disabled={pending}>
                  <Icons.Plus size={13} />
                  Add equipment
                </Button>
              )}
            </div>

            {others.length === 0 ? (
              <p className="text-xs text-muted">
                Just the one unit. Add another if this visit covered more than one.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {others.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <TextLink href={`/jobs/equipment/${o.assetId}`}>{o.description}</TextLink>
                      {o.serialText && (
                        <span className="ml-2 text-xs text-muted">
                          {o.identifierLabel}: {o.serialText}
                        </span>
                      )}
                      {o.note && <p className="text-xs text-muted">{o.note}</p>}
                    </div>
                    {canEdit && !jobClosed && (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Remove ${o.description}`}
                        disabled={pending}
                        onClick={() => remove(o.assetId, o.description)}
                      >
                        <Icons.Trash size={14} />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        )}
      </Card>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Which piece of equipment?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPicking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {customerId === null ? (
            <p className="text-sm text-muted">
              This job has no customer, so only unclaimed equipment can be named — a unit in the
              workshop, for instance.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Only this customer&apos;s equipment, plus anything not yet claimed.
            </p>
          )}

          <Field label="Equipment">
            <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Nothing named</option>
              {options.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {options.length === 0 && !pending && (
            <p className="text-sm text-muted">
              Nothing on file yet.{' '}
              <TextLink href="/jobs/equipment/new">Add the equipment</TextLink> and come back.
            </p>
          )}
        </div>
      </Modal>

      {/* ── Another unit on the same visit (161) ─────────────────────────── */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add equipment to this visit"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={addOther}
              disabled={pending || addChoice === ''}
            >
              {pending ? 'Adding…' : 'Add'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Another unit looked at on this visit. It gets the service date and a history entry;
            the job stays about {asset?.description ?? 'the main unit'}.
          </p>

          <Field label="Equipment">
            <Select value={addChoice} onChange={(e) => setAddChoice(e.target.value)}>
              <option value="">Choose…</option>
              {options
                // The primary is not one of the others, and neither is anything
                // already added — the action refuses both, and offering them
                // would be offering a refusal.
                .filter(
                  (o) =>
                    o.id !== asset?.id && !others.some((x) => x.assetId === o.id),
                )
                .map((o) => (
                  <option key={o.id} value={String(o.id)}>
                    {o.label}
                  </option>
                ))}
            </Select>
          </Field>

          <Field
            label="What it needed"
            hint="Optional. The job as a whole may say 'annual service'; this says what this unit took."
          >
            <Input
              value={addNote}
              onChange={(e) => setAddNote(e.target.value)}
              placeholder="Gas top-up, filter replaced…"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
