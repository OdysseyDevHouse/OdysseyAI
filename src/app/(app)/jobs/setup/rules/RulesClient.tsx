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
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import {
  RULE_EVENTS,
  RULE_EVENT_LABEL,
  EVENTS_WITH_STATUS,
  ruleProblem,
  describeRule,
  type JobRule,
  type RuleEvent,
} from '@/lib/jobRuleModel'
import { saveRuleAction, deleteRuleAction, setCooldownAction } from './actions'

type Option = { id: number; name: string }

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** A rule being edited, before it has an id. */
type Draft = Omit<JobRule, 'id'> & { id: number | null }

function blank(): Draft {
  return {
    id: null,
    name: '',
    isActive: true,
    event: 'status_entered',
    triggerStatusId: null,
    ifBoardId: null,
    ifPriority: null,
    ifHeadlineId: null,
    ifIdleHours: null,
    doNotify: false,
    doStatusId: null,
    doPriority: null,
    doFollowerUserId: null,
    message: '',
  }
}

/**
 * The rules list and its editor.
 *
 * ── WHY EACH RULE READS AS A SENTENCE ──────────────────────────────────────
 *
 * The list shows describeRule()'s sentence rather than a grid of trigger,
 * condition and action columns. A rule engine's real failure is not a rule that
 * breaks — it is fifteen rules nobody can read back, written by somebody who
 * has left, that between them do something no one intended.
 *
 * A sentence is checkable at a glance. A row of dropdown values is not, and the
 * same sentence shows live in the editor as somebody builds — so the thing they
 * agree to is the thing the list will say tomorrow.
 */
export default function RulesClient({
  rules,
  statuses,
  boards,
  headlines,
  users,
  cooldownMinutes,
}: {
  rules: JobRule[]
  statuses: Option[]
  boards: Option[]
  headlines: Option[]
  users: Option[]
  cooldownMinutes: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [cooldown, setCooldown] = useState(cooldownMinutes)

  const statusName = (id: number) => statuses.find((s) => s.id === id)?.name ?? 'a stage'
  const boardName = (id: number) => boards.find((b) => b.id === id)?.name ?? 'a board'
  const names = { status: statusName, board: boardName }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d === null ? d : { ...d, [key]: value }))
  }

  function save() {
    if (draft === null) return
    // The SAME function the server runs. See ruleProblem's own comment.
    const problem = ruleProblem(draft)
    if (problem) {
      toast.error(problem)
      return
    }
    start(async () => {
      const result = await saveRuleAction(draft)
      if (result.ok) {
        setDraft(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(rule: JobRule) {
    start(async () => {
      const result = await deleteRuleAction(rule.id)
      if (result.ok) {
        toast.success(`${rule.name} deleted.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function saveCooldown() {
    start(async () => {
      const result = await setCooldownAction(Number(cooldown))
      if (result.ok) toast.success('Saved.')
      else toast.error(result.error)
    })
  }

  /** The live sentence in the editor, built from the draft as it stands. */
  const preview = draft === null ? '' : describeRule({ ...draft, id: draft.id ?? 0 }, names)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Rules"
          action={
            <Button onClick={() => setDraft(blank())}>New rule</Button>
          }
        />
        <CardBody>
          {rules.length === 0 ? (
            <EmptyState
              icon={<Icons.Zap />}
              title="No rules yet"
              hint="A rule watches for something happening on a job — a stage reached, a quote accepted, a form filled in — and does something about it without anybody having to remember."
              action={<Button onClick={() => setDraft(blank())}>Write the first one</Button>}
            />
          ) : (
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TABLE_TH}>Rule</th>
                  <th className={TABLE_TH}>What it does</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className={TABLE_TD}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{rule.name}</span>
                        {!rule.isActive && <Badge tone="neutral">Off</Badge>}
                      </div>
                    </td>
                    <td className={`${TABLE_TD} text-muted`}>{describeRule(rule, names)}</td>
                    <td className={`${TABLE_TD} text-right whitespace-nowrap`}>
                      <Button variant="ghost" onClick={() => setDraft({ ...rule })} disabled={pending}>
                        Edit
                      </Button>
                      <Button
                        variant="danger-ghost"
                        onClick={() => remove(rule)}
                        disabled={pending}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Loop protection" />
        <CardBody>
          <div className="max-w-md space-y-3">
            <Field
              label="Wait before the same rule fires again on the same job"
              hint="Two rules that happen to move a job back and forth bounce once and then stop. Zero switches this off, which is useful while testing a rule and a bad thing to leave."
            >
              <NumberInput
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
                precision={0}
              />
            </Field>
            <p className="text-sm text-muted">
              A rule can also only set off three further rules in a chain. That limit is not a
              setting — a business that reaches it has a problem no number fixes, and raising it
              would only make the chain longer.
            </p>
            <Button onClick={saveCooldown} disabled={pending}>
              Save
            </Button>
          </div>
        </CardBody>
      </Card>

      {draft !== null && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.id === null ? 'New rule' : 'Edit rule'}
      /* A long form: the default 60vh cap made it read through a letterbox with
             empty desktop above and below. Still a MAX, so a short one stays short. */
          bodyGrows
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                Save rule
              </Button>
            </>
          }
        >
          <div className="space-y-5">
            <Field label="Name" hint="What this rule is for, so somebody can find it later.">
              <Input
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Tell the customer when the job is done"
              />
            </Field>

            <Checkbox
              label="Switched on"
              checked={draft.isActive}
              onChange={(e) => set('isActive', e.target.checked)}
            />

            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">When</h3>
              <Field label="This happens">
                <Select
                  value={draft.event}
                  onChange={(e) => {
                    const event = e.target.value as RuleEvent
                    setDraft((d) =>
                      d === null
                        ? d
                        : {
                            ...d,
                            event,
                            // A status only means something for two of the events;
                            // carrying a stale one forward would save a trigger the
                            // screen is no longer showing.
                            triggerStatusId: EVENTS_WITH_STATUS.includes(event)
                              ? d.triggerStatusId
                              : null,
                          },
                    )
                  }}
                >
                  {RULE_EVENTS.map((e) => (
                    <option key={e} value={e}>
                      {RULE_EVENT_LABEL[e]}
                    </option>
                  ))}
                </Select>
              </Field>

              {EVENTS_WITH_STATUS.includes(draft.event) && (
                <Field label="Which stage" hint="Leave on any stage to watch every move.">
                  <Select
                    value={draft.triggerStatusId ?? ''}
                    onChange={(e) =>
                      set('triggerStatusId', e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">Any stage</option>
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Only if</h3>
              <p className="text-sm text-muted">
                Every one of these is optional, and they all have to be true. To say either of two
                things, write two rules — it reads better a year from now than a condition builder
                does.
              </p>

              <Field label="Priority">
                <Select
                  value={draft.ifPriority ?? ''}
                  onChange={(e) => set('ifPriority', e.target.value || null)}
                >
                  <option value="">Any priority</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="On this board">
                <Select
                  value={draft.ifBoardId ?? ''}
                  onChange={(e) =>
                    set('ifBoardId', e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Any board</option>
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Carrying this headline">
                <Select
                  value={draft.ifHeadlineId ?? ''}
                  onChange={(e) =>
                    set('ifHeadlineId', e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Any headline</option>
                  {headlines.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Nothing has happened for this many hours"
                hint="Leave blank to ignore how long the job has been sitting."
              >
                <NumberInput
                  value={draft.ifIdleHours === null ? '' : String(draft.ifIdleHours)}
                  onChange={(e) =>
                    set('ifIdleHours', e.target.value === '' ? null : Number(e.target.value))
                  }
                  precision={0}
                />
              </Field>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Then</h3>

              <Checkbox
                label="Tell the people on the job"
                checked={draft.doNotify}
                onChange={(e) => set('doNotify', e.target.checked)}
              />

              {draft.doNotify && (
                <Field
                  label="What to say"
                  hint="Leave blank and it says the rule's name. Goes out on whichever channels each person has turned on."
                >
                  <Textarea
                    rows={2}
                    value={draft.message}
                    onChange={(e) => set('message', e.target.value)}
                  />
                </Field>
              )}

              <Field label="Move it to this stage">
                <Select
                  value={draft.doStatusId ?? ''}
                  onChange={(e) =>
                    set('doStatusId', e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Leave the stage alone</option>
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Set the priority to">
                <Select
                  value={draft.doPriority ?? ''}
                  onChange={(e) => set('doPriority', e.target.value || null)}
                >
                  <option value="">Leave the priority alone</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>

              {/*
                No "put it on a board" action, deliberately.

                A board is a saved view over statuses and holds no jobs — see
                104. The only honest way to move a job onto a board is to move
                it to a status that board lists, which the stage action above
                already does. A board dropdown here would promise something
                nothing stores.
              */}

              <Field
                label="Add this person as a follower"
                hint="They hear about the job from then on, without being made responsible for it."
              >
                <Select
                  value={draft.doFollowerUserId ?? ''}
                  onChange={(e) =>
                    set('doFollowerUserId', e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Nobody</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/*
              The sentence, live.

              The same string the list will show tomorrow, so what somebody
              agrees to here is what they read back later.
            */}
            <div className="rounded-card border border-border bg-surface-2 p-3 text-sm">
              {preview}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
