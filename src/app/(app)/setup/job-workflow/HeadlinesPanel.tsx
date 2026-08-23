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
import type { JobHeadline } from '@/lib/site/jobHeadlines'
import { saveHeadlineAction, deleteHeadlineAction } from '../../jobs/actions'

/**
 * What kind of work this business does, and what each kind requires.
 *
 * ── THE QUESTIONS ARE NOT EDITED HERE ──────────────────────────────────────
 *
 * This panel used to carry a checklist editor: a row per task or check, with its
 * response type, its phase and its arrows. 224 retired that. What a kind of work
 * ASKS is now a form, forms are built and attached on /setup/job-forms, and this
 * screen only reports how many a headline brings.
 *
 * The split is deliberate rather than a move. A form is reused across several
 * kinds of work, so it cannot belong to any one of them — editing it inside this
 * modal would mean editing every other headline that shares it, from a dialog
 * that gives no hint that is happening.
 *
 * What is left here is what a headline has always been on its own: its code and
 * name, the defaults it suggests, and the standard parts it consumes.
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
        // Always empty since 224. saveHeadline still ACCEPTS items — it runs them
        // through validateHeadline in the same pass as the code and duration
        // rules — but writes nothing from them, and there is no longer any way to
        // author one.
        items: [],
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
          description="What a job can be. Each kind brings its own forms and standard parts, so nobody retypes them."
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
                      {/* A count rather than a list, because neither is attached
                          here: forms come from /setup/job-forms and parts from the
                          product side. This column says what a job of this kind
                          picks up, and where to go if that is wrong. */}
                      <td className={TABLE_TD}>
                        {h.formCount === 0 && h.parts.length === 0 ? (
                          <span className="text-muted">Nothing yet</span>
                        ) : (
                          <span className="text-ink-2">
                            {h.formCount > 0 && `${h.formCount} form${h.formCount === 1 ? '' : 's'}`}
                            {h.parts.length > 0 && (
                              <span className={h.formCount > 0 ? 'ml-2 text-xs text-muted' : 'text-xs text-muted'}>
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

          {/* ── What it asks ───────────────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-ink">Forms</p>
            <p className="text-xs text-muted">
              {editing !== null && editing !== 'new' && editing.formCount > 0
                ? `This kind of work brings ${editing.formCount} form${editing.formCount === 1 ? '' : 's'}. A technician fills them in on the job.`
                : 'This kind of work brings no forms yet. A form is what a job of this kind asks — the readings, the yes or no answers, the photographs.'}
            </p>
            <p className="mt-1 text-xs text-muted">
              Forms are built and attached under Setup › Job forms, not here: the same form is
              usually asked by several kinds of work, so editing it inside one of them would
              silently change the rest.
            </p>
          </div>
        </div>
      </Modal>
    </>
  )
}
