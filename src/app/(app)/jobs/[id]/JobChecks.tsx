'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  SignaturePad,
  Switch,
  TextLink,
  buttonClass,
  useToast,
} from '@/components/ui'
import {
  ITEM_KIND_LABEL,
  ITEM_KINDS,
  RESPONSE_TYPE_LABEL,
  RESPONSE_TYPES,
  WORK_PHASES,
  WORK_PHASE_LABEL,
  describeItemProgress,
  responseHasUnit,
  responseOptions,
  storedDate,
  type ItemKind,
  type ResponseType,
  type WorkPhase,
} from '@/lib/jobStatusModel'
import type { JobItem } from '@/lib/site/jobHeadlines'
import {
  addJobItemAction,
  applyHeadlinesAction,
  captureEvidenceAction,
  deleteJobItemAction,
  recordItemAction,
} from '../actions'

/**
 * The work, as a list somebody works down.
 *
 * ── GROUPED BY PHASE, WHICH THE EDITOR IS NOT ──────────────────────────────
 *
 * The setup screen edits items as one flat list with the phase as a field. Here
 * they are grouped into Before / While / Before leaving, because that is the order
 * a technician does them in and a safety check buried between two readings is a
 * safety check somebody skips.
 *
 * ── ONE FIELD PER RESPONSE TYPE, NOT A GENERIC BOX ─────────────────────────
 *
 * A yes/no gets two buttons, a measurement gets a number field with its unit
 * beside it, a signature gets a name box. The model already knows which, so the
 * screen asks the model rather than carrying its own copy of the mapping — the
 * alternative is a text input for everything, which on a phone in a plant room is
 * how a reading of 12 gets typed as "twleve".
 */
export default function JobChecks({
  jobId,
  jobClosed,
  items,
  headlines,
  selectedHeadlineIds,
  canEdit,
  signatureStatement,
}: {
  jobId: number
  jobClosed: boolean
  items: JobItem[]
  headlines: { id: number; name: string; itemCount: number }[]
  selectedHeadlineIds: number[]
  canEdit: boolean
  /** What the customer is agreeing to. A setting, not a string in this file. */
  signatureStatement: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [busyId, setBusyId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, string>>({})

  const [pickingKinds, setPickingKinds] = useState(false)
  const [chosen, setChosen] = useState<number[]>(selectedHeadlineIds)

  const [adding, setAdding] = useState(false)
  const [newKind, setNewKind] = useState<ItemKind>('task')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<ResponseType>('none')
  const [newUnit, setNewUnit] = useState('')
  const [newPhase, setNewPhase] = useState<WorkPhase>('during')
  const [newRequired, setNewRequired] = useState(false)

  // The same two clauses outstandingRequiredTx uses, so the count on screen and the
  // reason the close is refused cannot disagree. The second one catches an item whose
  // attachment was deleted after it was ticked.
  const outstanding = items.filter(
    (i) =>
      i.isRequired &&
      (i.completedAt === null || (i.evidenceRequired && i.attachmentId === null)),
  )
  const failing = items.filter((i) => i.isFailed)

  // Which item's signature pad is open. One at a time: two pads on screen is two
  // customers signing, which is not a thing that happens.
  const [signing, setSigning] = useState<JobItem | null>(null)

  function upload(item: JobItem, file: File, caption: string) {
    setBusyId(item.id)
    const form = new FormData()
    form.set('file', file)
    if (caption) form.set('caption', caption)
    start(async () => {
      const result = await captureEvidenceAction(jobId, item.id, form)
      if (result.ok) {
        toast.success(item.responseType === 'signature' ? 'Signed.' : 'Photo attached.')
        setSigning(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
      setBusyId(null)
    })
  }

  function record(item: JobItem, complete: boolean, responseOverride?: string) {
    setBusyId(item.id)
    const response = responseOverride ?? drafts[item.id] ?? item.response ?? null
    start(async () => {
      const result = await recordItemAction(jobId, item.id, {
        response: response === '' ? null : response,
        note: item.note,
        complete,
      })
      if (result.ok) router.refresh()
      else toast.error(result.error)
      setBusyId(null)
    })
  }

  function applyKinds() {
    start(async () => {
      const result = await applyHeadlinesAction(jobId, chosen)
      if (result.ok) {
        // The merge report is the point of saying anything at all: two kinds of
        // work sharing a check produce one item, and somebody who counted the
        // template rows would otherwise think it went missing.
        const merged = result.merged
          .map((m) => `${m.name} (from ${m.from.join(' and ')})`)
          .join('; ')
        toast.success(
          merged
            ? `${result.added} added. Combined: ${merged}.`
            : result.added === 0
              ? 'Nothing new to add.'
              : `${result.added} task${result.added === 1 ? '' : 's'} added.`,
        )
        setPickingKinds(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function addOne() {
    start(async () => {
      const result = await addJobItemAction(jobId, {
        kind: newKind,
        name: newName,
        responseType: newType,
        unit: responseHasUnit(newType) ? newUnit || null : null,
        workPhase: newPhase,
        isRequired: newRequired,
      })
      if (result.ok) {
        toast.success('Added.')
        setAdding(false)
        setNewName('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(item: JobItem) {
    setBusyId(item.id)
    start(async () => {
      const result = await deleteJobItemAction(jobId, item.id)
      if (result.ok) router.refresh()
      else toast.error(result.error)
      setBusyId(null)
    })
  }

  const when = (value: string | null): string => {
    const date = storedDate(value)
    if (!date) return ''
    return date.toLocaleString('en-ZA', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
  }

  /** The input for one item, chosen by what it records. */
  function responseField(item: JobItem) {
    const options = responseOptions(item.responseType)
    const value = drafts[item.id] ?? item.response ?? ''
    const disabled = pending || jobClosed || !canEdit

    if (item.responseType === 'none') return null

    // Two buttons rather than a dropdown: on a phone, answering a yes/no should be
    // one tap, and a tap that both answers and completes it is the whole gesture.
    if (options) {
      return (
        <div className="flex gap-1.5">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={value.toLowerCase() === option ? 'primary' : 'secondary'}
              disabled={disabled}
              onClick={() => record(item, true, option)}
            >
              {option === 'yes' ? 'Yes' : option === 'no' ? 'No' : option === 'pass' ? 'Pass' : 'Fail'}
            </Button>
          ))}
        </div>
      )
    }

    /*
     * A photo takes a photo and a signature takes a signature. Before 119 both of
     * these were the text box below, which recorded a technician typing that they
     * had taken one — and for a gas certificate or a customer sign-off, the file IS
     * the record.
     */
    if (item.responseType === 'photo') {
      return (
        <div className="flex items-center gap-1.5">
          {/* entity and entityId are REQUIRED on the href, not decoration: the route
              looks up (id, entity, entity_id) so a guessed id returns 404 rather than
              somebody else's paperwork. A bare id link 404s, correctly. */}
          {item.attachmentId !== null && (
            <TextLink
              href={`/api/attachments/${item.attachmentId}?entity=job_card&entityId=${jobId}`}
              target="_blank"
            >
              <Icons.Picture size={14} />
              {item.attachmentName ?? 'Photo'}
            </TextLink>
          )}
          {/* capture="environment" opens the rear camera straight from the list on a
              phone. It is ignored on a desktop, which falls back to a file picker —
              a technician back at the office attaching what they took earlier. */}
          <label className={disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              disabled={disabled}
              onChange={(e) => {
                const file = e.target.files?.[0]
                // Cleared so re-picking the SAME file fires change again — otherwise a
                // failed upload cannot be retried without choosing something else.
                e.target.value = ''
                if (file) upload(item, file, drafts[item.id] ?? '')
              }}
            />
            {/* A styled <label> rather than a Button, because only a real file input
                can open the camera — and buttonClass is the kit's own string, so it
                still looks like every other secondary button. */}
            <span className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <Icons.Upload size={15} />
              {item.attachmentId === null ? 'Take photo' : 'Replace'}
            </span>
          </label>
        </div>
      )
    }

    if (item.responseType === 'signature') {
      return (
        <div className="flex items-center gap-1.5">
          {item.attachmentId !== null && (
            <TextLink
              href={`/api/attachments/${item.attachmentId}?entity=job_card&entityId=${jobId}`}
              target="_blank"
            >
              <Icons.Pencil size={14} />
              {item.response?.trim() || 'Signed'}
            </TextLink>
          )}
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setSigning(item)}>
            <Icons.Pencil size={15} />
            {item.attachmentId === null ? 'Sign' : 'Sign again'}
          </Button>
        </div>
      )
    }

    return (
      <div className="flex items-center gap-1.5">
        <div className="w-32">
          <Input
            value={value}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
            placeholder={
              item.responseType === 'measure' || item.responseType === 'number' ? '0' : ''
            }
            inputMode={
              item.responseType === 'measure' || item.responseType === 'number'
                ? 'decimal'
                : undefined
            }
            disabled={disabled}
          />
        </div>
        {item.unit && <span className="text-xs text-muted">{item.unit}</span>}
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => record(item, true)}>
          Save
        </Button>
      </div>
    )
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Tasks and checks"
          description={describeItemProgress(items)}
          action={
            canEdit && !jobClosed ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setAdding(true)} disabled={pending}>
                  <Icons.Plus size={15} />
                  Add one
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setChosen(selectedHeadlineIds)
                    setPickingKinds(true)
                  }}
                  disabled={pending}
                >
                  <Icons.Wrench size={15} />
                  Kind of work
                </Button>
              </div>
            ) : undefined
          }
        />

        {/* Above the list: a failing check is the thing somebody needs to see
            before they read anything else on the tab. */}
        {failing.length > 0 && (
          <Callout tone="danger" title={failing.length === 1 ? 'A check failed' : `${failing.length} checks failed`}>
            {failing.map((i) => i.name).join(', ')}. A failed check does not stop the job — it is
            recorded so somebody decides what to do about it.
          </Callout>
        )}

        {outstanding.length > 0 && (
          <Callout tone="warning" title="Still required before this job can be closed">
            {outstanding.map((i) => i.name).join(', ')}.
          </Callout>
        )}

        {items.length === 0 ? (
          <EmptyState
            icon={<Icons.Check size={22} />}
            title="Nothing to do yet"
            hint={
              headlines.length === 0
                ? 'No kinds of work have been set up, so there is nothing to attach. Add one under Setup and every job of that kind gets its checks automatically.'
                : 'Choose what kind of work this is and its tasks and checks land here. Anything one-off can be added by hand.'
            }
            action={
              canEdit && !jobClosed && headlines.length > 0 ? (
                <Button variant="secondary" onClick={() => setPickingKinds(true)}>
                  <Icons.Wrench size={15} />
                  Kind of work
                </Button>
              ) : undefined
            }
          />
        ) : (
          <CardBody className="p-0">
            {WORK_PHASES.map((phase) => {
              const group = items.filter((i) => i.workPhase === phase)
              if (group.length === 0) return null
              return (
                <div key={phase} className="border-b border-border last:border-b-0">
                  <p className="bg-surface-2 px-6 py-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                    {WORK_PHASE_LABEL[phase]}
                  </p>
                  <div className="flex flex-col">
                    {group.map((item) => {
                      const done = item.completedAt !== null
                      return (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3 last:border-b-0"
                        >
                          <Checkbox
                            checked={done}
                            disabled={
                              pending || jobClosed || !canEdit ||
                              // A check that records something is completed by
                              // answering it, not by ticking a box — otherwise
                              // "done" would mean somebody pressed a button.
                              (!done && item.responseType !== 'none')
                            }
                            onChange={(e) => record(item, e.target.checked)}
                            label=""
                          />

                          <div className="min-w-40 flex-1">
                            {/* Not struck through while the file is missing: the item is
                                not actually finished, whatever completed_at says. */}
                            <span
                              className={
                                done && !(item.evidenceRequired && item.attachmentId === null)
                                  ? 'text-muted line-through'
                                  : 'text-ink'
                              }
                            >
                              {item.name}
                            </span>
                            {item.isRequired && !done && (
                              <Badge tone="warning" className="ml-2">
                                Required
                              </Badge>
                            )}
                            {item.isFailed && (
                              <Badge tone="danger" className="ml-2">
                                Failed
                              </Badge>
                            )}
                            {item.hint && (
                              <p className="text-xs text-muted">{item.hint}</p>
                            )}
                            {done && item.completedByName && (
                              <p className="text-xs text-muted">
                                {item.response ? `${item.response}${item.unit ? ` ${item.unit}` : ''} — ` : ''}
                                {item.completedByName}, {when(item.completedAt)}
                              </p>
                            )}
                          </div>

                          {/* Also shown when an item is ticked but its file has gone:
                              that state blocks the close, so the fix has to be
                              reachable without unticking first. */}
                          {(!done || (item.evidenceRequired && item.attachmentId === null)) &&
                            responseField(item)}

                          {/* A completed item normally shows no controls — its answer
                              is in the line above. Evidence is the exception: the
                              answer IS a file, and a photograph that cannot be opened
                              from the check that demanded it may as well not have been
                              taken. The link stays after the job closes, because that
                              is exactly when somebody comes looking for it. */}
                          {done && item.attachmentId !== null && (
                            <TextLink
                              href={`/api/attachments/${item.attachmentId}?entity=job_card&entityId=${jobId}`}
                              target="_blank"
                            >
                              {item.responseType === 'signature' ? (
                                <Icons.Pencil size={14} />
                              ) : (
                                <Icons.Picture size={14} />
                              )}
                              {item.responseType === 'signature'
                                ? 'View signature'
                                : (item.attachmentName ?? 'View photo')}
                            </TextLink>
                          )}

                          {/* Ticked but the file is gone — the FK nulled the link and
                              left the tick standing. Named on the row rather than only
                              on the reconciliation screen, because this is where
                              somebody can fix it. */}
                          {done && item.evidenceRequired && item.attachmentId === null && (
                            <Badge tone="danger">File missing</Badge>
                          )}

                          {/* A signed-off item cannot be deleted — the action
                              refuses it. Untick first, which is a deliberate act. */}
                          {canEdit && !jobClosed && !done && (
                            <Button
                              variant="danger-ghost"
                              size="sm"
                              iconOnly
                              aria-label={`Remove ${item.name}`}
                              disabled={pending && busyId === item.id}
                              onClick={() => remove(item)}
                            >
                              <Icons.Trash size={15} />
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </CardBody>
        )}
      </Card>

      {/* ── What kind of work is this? ─────────────────────────────────── */}
      <Modal
        open={pickingKinds}
        onClose={() => setPickingKinds(false)}
        title="What kind of work is this?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPickingKinds(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={applyKinds} disabled={pending}>
              {pending ? 'Saving…' : 'Apply'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            More than one is fine — replacing a compressor and surveying the site can be one visit.
            Anything two kinds both require is added once.
          </p>
          {headlines.length === 0 ? (
            <p className="text-sm text-muted">
              None set up yet. <TextLink href="/setup/job-workflow">Add one under Setup</TextLink>.
            </p>
          ) : (
            headlines.map((h) => (
              <Checkbox
                key={h.id}
                checked={chosen.includes(h.id)}
                onChange={(e) =>
                  setChosen((prev) =>
                    e.target.checked ? [...prev, h.id] : prev.filter((id) => id !== h.id),
                  )
                }
                label={`${h.name}${h.itemCount > 0 ? ` — ${h.itemCount} task${h.itemCount === 1 ? '' : 's'}` : ''}`}
              />
            ))
          )}
          {/* The thing somebody will otherwise be surprised by. */}
          <p className="text-xs text-muted">
            Removing a kind of work clears only its untouched tasks. Anything already signed off, and
            anything added by hand, stays.
          </p>
        </div>
      </Modal>

      {/* ── One-off ─────────────────────────────────────────────────────── */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a task or check"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={addOne} disabled={pending || !newName.trim()}>
              {pending ? 'Saving…' : 'Add'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            For this job only. It survives a change of work kind, because nobody templated it.
          </p>
          <Field label="What">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Fetch the long ladder"
              maxLength={190}
            />
          </Field>
          <div className="flex flex-wrap gap-4">
            <Field label="Kind">
              <div className="w-28">
                <Select value={newKind} onChange={(e) => setNewKind(e.target.value as ItemKind)}>
                  {ITEM_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ITEM_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Records">
              <div className="w-44">
                <Select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as ResponseType)}
                >
                  {RESPONSE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {RESPONSE_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            {responseHasUnit(newType) && (
              <Field label="Unit">
                <div className="w-20">
                  <Input
                    value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value)}
                    placeholder="bar"
                    maxLength={20}
                  />
                </div>
              </Field>
            )}
          </div>
          <Field label="When">
            <div className="w-48">
              <Select value={newPhase} onChange={(e) => setNewPhase(e.target.value as WorkPhase)}>
                {WORK_PHASES.map((p) => (
                  <option key={p} value={p}>
                    {WORK_PHASE_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <Switch
            checked={newRequired}
            onChange={setNewRequired}
            label="Required"
            hint="The job cannot be closed until it is done."
          />
        </div>
      </Modal>

      {/* ── Signature ───────────────────────────────────────────────────────
          In a modal rather than inline in the list, because the customer is handed
          the device and should see one thing: what they are agreeing to, and the
          pad. A list of other people's readings around it invites a signature on
          the wrong row. */}
      <Modal
        open={signing !== null}
        onClose={() => setSigning(null)}
        title={signing?.name ?? 'Signature'}
        size="md"
      >
        {signing && (
          <SignaturePad
            statement={signatureStatement}
            busy={pending}
            onCancel={() => setSigning(null)}
            onCapture={(png, name) => {
              // Named for the item so the Files tab reads sensibly on its own.
              const file = new File([png], `signature-${signing.id}.png`, { type: 'image/png' })
              upload(signing, file, name)
            }}
          />
        )}
      </Modal>
    </>
  )
}
