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
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import {
  ITEM_KIND_LABEL,
  ITEM_KINDS,
  RESPONSE_TYPE_LABEL,
  RESPONSE_TYPES,
  WORK_PHASE_LABEL,
  WORK_PHASES,
  responseHasUnit,
  responseIsEvidence,
  type ItemKind,
  type ResponseType,
  type WorkPhase,
} from '@/lib/jobStatusModel'
import type { JobHeadline } from '@/lib/site/jobHeadlines'
import { saveHeadlineAction, deleteHeadlineAction } from '../../jobs/actions'

type Draft = {
  id: number | null
  kind: ItemKind
  name: string
  hint: string | null
  responseType: ResponseType
  unit: string | null
  workPhase: WorkPhase
  isRequired: boolean
  evidenceRequired: boolean
}

/**
 * What kind of work this business does, and what each kind requires.
 *
 * ── WHY THE ITEM EDITOR IS A FLAT LIST AND NOT THREE SECTIONS ──────────────
 *
 * Items belong to a work phase — before, during, after — and the technician's list
 * IS grouped by phase. Here they stay in one list with the phase as a field,
 * because editing a template means adding a row and picking where it goes, and
 * three drop zones would make moving an item between phases a drag rather than a
 * dropdown. The grouping is a reading concern, not an editing one.
 *
 * ── NO DRAG TO REORDER ─────────────────────────────────────────────────────
 *
 * Order is the row order, and the arrows move a row. dnd-kit is installed and the
 * board uses it, but a checklist is edited rarely and read constantly: arrows work
 * on a phone, need no hydration gate, and cannot leave a row mid-flight. The board
 * earns its DnD because dragging a job between columns IS the gesture.
 */
export default function HeadlinesPanel({
  headlines,
  boards,
}: {
  headlines: JobHeadline[]
  boards: { id: number; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<JobHeadline | 'new' | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('')
  const [boardId, setBoardId] = useState('')
  const [minutes, setMinutes] = useState(0)
  const [skills, setSkills] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [items, setItems] = useState<Draft[]>([])

  function open(headline: JobHeadline | 'new') {
    setEditing(headline)
    if (headline === 'new') {
      setCode('')
      setName('')
      setDescription('')
      setPriority('')
      setBoardId('')
      setMinutes(0)
      setSkills('')
      setIsActive(true)
      setItems([])
      return
    }
    setCode(headline.code)
    setName(headline.name)
    setDescription(headline.description ?? '')
    setPriority(headline.defaultPriority ?? '')
    setBoardId(headline.defaultBoardId === null ? '' : String(headline.defaultBoardId))
    setMinutes(headline.suggestedMinutes ?? 0)
    setSkills(headline.requiredSkills ?? '')
    setIsActive(headline.isActive)
    setItems(
      headline.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        name: i.name,
        hint: i.hint,
        responseType: i.responseType,
        unit: i.unit,
        workPhase: i.workPhase,
        isRequired: i.isRequired,
        evidenceRequired: i.evidenceRequired,
      })),
    )
  }

  function addRow() {
    setItems((prev) => [
      ...prev,
      {
        id: null,
        kind: 'check',
        name: '',
        hint: null,
        responseType: 'none',
        unit: null,
        workPhase: 'during',
        isRequired: false,
        evidenceRequired: false,
      },
    ])
  }

  function patch(index: number, change: Partial<Draft>) {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        const next = { ...item, ...change }
        // A unit only belongs on a measurement. Clearing it here means the save
        // cannot be refused for a leftover unit the user cannot see any more.
        if (!responseHasUnit(next.responseType)) next.unit = null
        // The same rule for the evidence flag, in the same place, for the same
        // reason: validateHeadline refuses "must attach" on a yes/no, and a refusal
        // naming a switch that is no longer on screen reads as a broken dialog.
        if (!responseIsEvidence(next.responseType)) next.evidenceRequired = false
        return next
      }),
    )
  }

  function move(index: number, by: -1 | 1) {
    setItems((prev) => {
      const next = [...prev]
      const to = index + by
      if (to < 0 || to >= next.length) return prev
      ;[next[index], next[to]] = [next[to], next[index]]
      return next
    })
  }

  function save() {
    if (editing === null) return
    start(async () => {
      const result = await saveHeadlineAction({
        id: editing === 'new' ? null : editing.id,
        code,
        name,
        description: description.trim() || null,
        defaultPriority: priority === '' ? null : (priority as never),
        defaultBoardId: boardId === '' ? null : Number(boardId),
        suggestedMinutes: minutes > 0 ? minutes : null,
        requiredSkills: skills.trim() || null,
        sortOrder: editing === 'new' ? headlines.length : editing.sortOrder,
        isActive,
        items: items.map((i) => ({ ...i, name: i.name.trim() })),
        // Standard parts are edited on the product side, not here: a picker over
        // 40,000 products inside a modal that is already editing a list is two
        // jobs in one dialog. The table below reports what is linked.
        parts: (editing === 'new' ? [] : editing.parts).map((p) => ({
          productId: p.productId,
          qty: p.qty,
          lineKind: p.lineKind,
        })),
      })
      if (result.ok) {
        toast.success(editing === 'new' ? 'Headline added.' : 'Headline saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(headline: JobHeadline) {
    start(async () => {
      const result = await deleteHeadlineAction(headline.id)
      if (result.ok) {
        toast.success('Headline deleted.')
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
          title="Kinds of work"
          description="What a job can be. Each kind brings its own tasks, checks and standard parts, so nobody retypes them."
          action={
            <Button variant="primary" onClick={() => open('new')} disabled={pending}>
              <Icons.Plus size={15} />
              Add a kind of work
            </Button>
          }
        />

        {headlines.length === 0 ? (
          <EmptyState
            icon={<Icons.Wrench size={22} />}
            title="No kinds of work yet"
            hint="Add one for each thing this business does — Annual Service, Repair, Site Survey. Whatever a job of that kind always needs, attach it once here."
            action={
              <Button variant="secondary" onClick={() => open('new')} disabled={pending}>
                <Icons.Plus size={15} />
                Add a kind of work
              </Button>
            }
          />
        ) : (
          <CardBody className="p-0">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Kind of work</th>
                  <th className={TABLE_TH}>Brings with it</th>
                  <th className={TABLE_TH}>Sets</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Used on</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`} />
                </tr>
              </thead>
              <tbody>
                {headlines.map((h) => {
                  const required = h.items.filter((i) => i.isRequired).length
                  return (
                    <tr key={h.id}>
                      <td className={TABLE_TD}>
                        <div className="flex flex-col">
                          <span className="text-ink">
                            {h.name}
                            {!h.isActive && (
                              <Badge tone="neutral" className="ml-2">
                                Off
                              </Badge>
                            )}
                          </span>
                          <span className="text-xs text-muted">{h.code}</span>
                        </div>
                      </td>
                      <td className={TABLE_TD}>
                        {h.items.length === 0 && h.parts.length === 0 ? (
                          <span className="text-muted">Nothing yet</span>
                        ) : (
                          <span className="text-ink-2">
                            {h.items.length > 0 &&
                              `${h.items.length} task${h.items.length === 1 ? '' : 's'} and check${h.items.length === 1 ? '' : 's'}`}
                            {required > 0 && (
                              <span className="ml-2 text-xs text-warning-ink">
                                {required} required
                              </span>
                            )}
                            {h.parts.length > 0 && (
                              <span className="ml-2 text-xs text-muted">
                                {h.parts.length} standard part{h.parts.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">
                          {[
                            h.defaultPriority ? `${h.defaultPriority} priority` : null,
                            h.defaultBoardName,
                            h.suggestedMinutes ? `${h.suggestedMinutes} min` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </span>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <span className={h.jobCount > 0 ? 'text-ink-2' : 'text-muted'}>
                          {h.jobCount === 0 ? 'no jobs' : `${h.jobCount} job${h.jobCount === 1 ? '' : 's'}`}
                        </span>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Edit ${h.name}`}
                            onClick={() => open(h)}
                          >
                            <Icons.Pencil size={15} />
                          </Button>
                          {/* Only offered while nothing has used it. Once a job
                              carries it, the FK refuses and the action explains
                              why — so the button would only ever produce a toast. */}
                          {h.jobCount === 0 && (
                            <Button
                              variant="danger-ghost"
                              size="sm"
                              iconOnly
                              aria-label={`Delete ${h.name}`}
                              disabled={pending}
                              onClick={() => remove(h)}
                            >
                              <Icons.Trash size={15} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardBody>
        )}
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'A new kind of work' : `Edit ${editing?.name ?? ''}`}
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
              disabled={pending || !name.trim() || !code.trim()}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field
              label="Code"
              hint={
                editing !== null && editing !== 'new'
                  ? 'Fixed once created, so renaming relabels every job rather than stranding it.'
                  : 'Short handle for reports. e.g. SERVICE'
              }
            >
              <div className="w-40">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={40}
                  disabled={editing !== null && editing !== 'new'}
                />
              </div>
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Annual service"
                maxLength={120}
              />
            </Field>
          </div>

          <Field label="Description" hint="Optional — what this kind of work covers.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={190}
              rows={2}
            />
          </Field>

          {/* What choosing it decides. Blank means no opinion, which is why every
              one of these is optional rather than defaulted. */}
          <div className="flex flex-wrap gap-4">
            <Field label="Priority" hint="Blank leaves the job at its own.">
              <div className="w-36">
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">No opinion</option>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </div>
            </Field>
            <Field label="Board" hint="Where this work belongs.">
              <div className="w-44">
                <Select value={boardId} onChange={(e) => setBoardId(e.target.value)}>
                  <option value="">No opinion</option>
                  {boards.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Usually takes" hint="Minutes. Feeds the appointment length.">
              <div className="w-28">
                <NumberInput
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value) || 0)}
                  min={0}
                />
              </div>
            </Field>
          </div>

          <Field
            label="Needs"
            hint="Free text for whoever assigns the job — a gas licence, working at height. Not checked against anything."
          >
            <Input value={skills} onChange={(e) => setSkills(e.target.value)} maxLength={190} />
          </Field>

          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="In use"
            hint="A retired kind of work stops appearing when logging a job. Jobs already using it keep it."
          />

          {/* ── The items ──────────────────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Tasks and checks</p>
                <p className="text-xs text-muted">
                  A task is ticked off. A check records something — a reading, a yes or no, a
                  photograph. Required ones stop the job being closed.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={addRow} disabled={pending}>
                <Icons.Plus size={15} />
                Add a row
              </Button>
            </div>

            {items.length === 0 ? (
              <p className="py-3 text-sm text-muted">
                Nothing yet. A kind of work with no tasks is still useful — it categorises the job
                and sets the defaults above.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map((item, index) => (
                  <div
                    key={index}
                    className="flex flex-wrap items-end gap-2 rounded-card border border-border p-2"
                  >
                    <div className="w-28">
                      <Field label={index === 0 ? 'Kind' : ''}>
                        <Select
                          value={item.kind}
                          onChange={(e) => patch(index, { kind: e.target.value as ItemKind })}
                        >
                          {ITEM_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {ITEM_KIND_LABEL[k]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    <div className="min-w-48 flex-1">
                      <Field label={index === 0 ? 'What' : ''}>
                        <Input
                          value={item.name}
                          onChange={(e) => patch(index, { name: e.target.value })}
                          placeholder="Check gas pressure"
                          maxLength={190}
                        />
                      </Field>
                    </div>

                    <div className="w-44">
                      <Field label={index === 0 ? 'Records' : ''}>
                        <Select
                          value={item.responseType}
                          onChange={(e) => {
                            const next = e.target.value as ResponseType
                            // Switching TO a photo or signature turns the flag on, so
                            // the strict reading is the default and relaxing it is
                            // the deliberate act. patch() handles the reverse.
                            patch(index, {
                              responseType: next,
                              evidenceRequired: responseIsEvidence(next),
                            })
                          }}
                        >
                          {RESPONSE_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {RESPONSE_TYPE_LABEL[t]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    {/* Only a measurement carries a unit, and the model refuses a
                        unit on anything else — so the field appears exactly when
                        it is legal. */}
                    {responseHasUnit(item.responseType) && (
                      <div className="w-20">
                        <Field label={index === 0 ? 'Unit' : ''}>
                          <Input
                            value={item.unit ?? ''}
                            onChange={(e) => patch(index, { unit: e.target.value })}
                            placeholder="bar"
                            maxLength={20}
                          />
                        </Field>
                      </div>
                    )}

                    <div className="w-40">
                      <Field label={index === 0 ? 'When' : ''}>
                        <Select
                          value={item.workPhase}
                          onChange={(e) => patch(index, { workPhase: e.target.value as WorkPhase })}
                        >
                          {WORK_PHASES.map((p) => (
                            <option key={p} value={p}>
                              {WORK_PHASE_LABEL[p]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    {/* Same rule as the unit field above: the switch appears exactly
                        when it is legal, because the model refuses it on any other
                        type. Default on — a photo check whose photo is optional is
                        a note, and the point of asking for one is having it. */}
                    {responseIsEvidence(item.responseType) && (
                      <div className="flex items-center pb-1">
                        <Switch
                          checked={item.evidenceRequired}
                          onChange={(v) => patch(index, { evidenceRequired: v })}
                          label={item.responseType === 'signature' ? 'Must sign' : 'Must attach'}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 pb-1">
                      <Switch
                        checked={item.isRequired}
                        onChange={(v) => patch(index, { isRequired: v })}
                        label="Required"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <Icons.ChevronUp size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Move down"
                        disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <Icons.ChevronDown size={15} />
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label="Remove row"
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}
