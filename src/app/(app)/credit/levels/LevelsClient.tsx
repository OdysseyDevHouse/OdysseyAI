'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Callout,
  Badge,
  EmptyState,
  Modal,
  ConfirmModal,
  Field,
  Input,
  NumberInput,
  CurrencyInput,
  Select,
  Textarea,
  Checkbox,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { TEMPLATE_TOKENS } from '@/lib/creditModel'
import { SMS_MAX_LENGTH } from '@/lib/sms/types'
import { saveLevelAction, deleteLevelAction } from '../actions'

export type LevelRow = {
  id: number
  step: number
  name: string
  minDaysOverdue: number
  minAmount: number
  subject: string
  body: string
  channel: 'email' | 'sms' | 'both'
  smsBody: string
  blocksAccount: boolean
  requiresCall: boolean
  isActive: boolean
}

const BLANK: Omit<LevelRow, 'id'> = {
  step: 1,
  name: '',
  minDaysOverdue: 7,
  minAmount: 50,
  subject: '',
  body: '',
  channel: 'email',
  smsBody: '',
  blocksAccount: false,
  requiresCall: false,
  isActive: true,
}

/**
 * Editing the ladder.
 *
 * Shown as cards rather than a table: each level is mostly a paragraph of
 * letter text, and a table row cannot show a letter. The rungs read top to
 * bottom in the order an account climbs them, which is the thing being
 * designed here.
 */
export function LevelsClient({ levels }: { levels: LevelRow[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState<LevelRow | Omit<LevelRow, 'id'> | null>(null)
  const [deleting, setDeleting] = useState<LevelRow | null>(null)
  const [form, setForm] = useState<Omit<LevelRow, 'id'>>(BLANK)
  const [error, setError] = useState<string | null>(null)

  const editingId = editing && 'id' in editing ? editing.id : null

  function open(level: LevelRow | null) {
    const next = level ?? {
      ...BLANK,
      step: levels.length === 0 ? 1 : Math.max(...levels.map((l) => l.step)) + 1,
    }
    setEditing(next)
    setForm({
      step: next.step,
      name: next.name,
      minDaysOverdue: next.minDaysOverdue,
      minAmount: next.minAmount,
      subject: next.subject,
      body: next.body,
      channel: next.channel,
      smsBody: next.smsBody,
      blocksAccount: next.blocksAccount,
      requiresCall: next.requiresCall,
      isActive: next.isActive,
    })
    setError(null)
  }

  function save() {
    setError(null)
    start(async () => {
      const result = await saveLevelAction(editingId, form)
      if (!result.ok) {
        // Under the form, not only in a toast — a toast saying "invalid" with
        // nothing marked is a puzzle.
        setError(result.error)
        return
      }
      toast.success(result.message)
      setEditing(null)
      router.refresh()
    })
  }

  function remove() {
    const level = deleting
    if (!level) return
    start(async () => {
      const result = await deleteLevelAction(level.id)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      setDeleting(null)
      router.refresh()
    })
  }

  const active = levels.filter((l) => l.isActive)
  const blocking = active.filter((l) => l.blocksAccount)

  return (
    <>
      {active.length === 0 && (
        <Callout tone="warning" title="No levels are active">
          Reminder runs will find nobody to chase until at least one level is switched on.
        </Callout>
      )}

      {blocking.length > 1 && (
        <Callout tone="warning" title="More than one level suspends credit">
          An account is only held once, at whichever of these it reaches first. Usually only the
          last rung should suspend an account.
        </Callout>
      )}

      <Card>
        <CardHeader
          title="The ladder"
          description="An account climbs one rung at a time, and never gets the same reminder twice."
          action={<Button onClick={() => open(null)}>Add level</Button>}
        />

        {levels.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No reminder levels"
              hint="Add at least one so overdue accounts can be chased."
              action={<Button onClick={() => open(null)}>Add level</Button>}
            />
          </CardBody>
        ) : (
          <CardBody>
            <ul className="space-y-3">
              {levels.map((level) => (
                <li
                  key={level.id}
                  className={`rounded-card border border-border p-4 ${
                    level.isActive ? '' : 'opacity-60'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">
                          {level.step}. {level.name}
                        </span>
                        {!level.isActive && <Badge tone="default">Off</Badge>}
                        {level.channel !== 'email' && (
                          <Badge tone="brand">
                            {level.channel === 'sms' ? 'Texts' : 'Emails + texts'}
                          </Badge>
                        )}
                        {level.blocksAccount && <Badge tone="danger">Suspends credit</Badge>}
                        {level.requiresCall && <Badge tone="warning">Phone call</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        From {level.minDaysOverdue} days overdue, above{' '}
                        {formatMoney(level.minAmount)}
                      </p>
                      <p className="mt-2 truncate text-sm text-ink-2">{level.subject}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => open(level)}>
                        Edit
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => setDeleting(level)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editingId ? `Edit level ${form.step}` : 'Add a reminder level'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save level'}
            </Button>
          </>
        }
      >
        {error && (
          <Callout tone="danger" className="mb-4">
            {error}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Step" hint="The order accounts climb.">
            <NumberInput
              value={form.step}
              onChange={(e) => setForm({ ...form, step: Number(e.target.value) })}
              min={1}
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Friendly reminder"
            />
          </Field>
          <Field label="From days overdue" hint="Measured on the oldest unpaid item.">
            <NumberInput
              value={form.minDaysOverdue}
              onChange={(e) => setForm({ ...form, minDaysOverdue: Number(e.target.value) })}
              min={0}
            />
          </Field>
          <Field
            label="Minimum amount"
            hint="Below this, nothing is sent. Chasing a rounding difference reads as automated noise."
          >
            <CurrencyInput
              value={String(form.minAmount)}
              onChange={(e) => setForm({ ...form, minAmount: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>

        <div className="mt-4 space-y-4">
          <Field
            label="How it goes out"
            hint="Texting needs an SMS provider under Setup → Text messages. Without one, the text leg is recorded as skipped."
          >
            <Select
              value={form.channel}
              onChange={(e) =>
                setForm({
                  ...form,
                  channel:
                    e.target.value === 'sms' || e.target.value === 'both'
                      ? e.target.value
                      : 'email',
                })
              }
            >
              <option value="email">Email only</option>
              <option value="sms">Text message only</option>
              <option value="both">Email and text message</option>
            </Select>
          </Field>

          {form.channel !== 'sms' && (
            <>
              <Field label="Subject">
                <Input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="Your account with {company} — {overdue} outstanding"
                />
              </Field>

              <Field
                label="Message"
                hint="An unknown placeholder is left as written rather than blanked, so a typo is obvious instead of silently leaving a hole in the sentence."
              >
                <Textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  rows={10}
                />
              </Field>
            </>
          )}

          {form.channel !== 'email' && (
            <Field
              label="Text message"
              hint={`${form.smsBody.length}/${SMS_MAX_LENGTH} characters${form.smsBody.length > 160 ? ' — two messages per send' : ''}. Same placeholders as the email, but {lines} does not fit in a text.`}
              error={
                form.smsBody.length > SMS_MAX_LENGTH
                  ? `Over the ${SMS_MAX_LENGTH}-character cap — it would be cut off.`
                  : undefined
              }
            >
              <Textarea
                value={form.smsBody}
                onChange={(e) => setForm({ ...form, smsBody: e.target.value })}
                rows={3}
                placeholder="Hi {customer}, {overdue} is overdue at {company}. Please call us to settle."
              />
            </Field>
          )}

          <div className="rounded-card bg-surface-2 p-3">
            <p className="text-xs text-muted">Placeholders</p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {TEMPLATE_TOKENS.map((t) => (
                <li key={t.token} className="text-xs text-ink-2">
                  <code className="text-brand">{t.token}</code> — {t.hint}
                </li>
              ))}
            </ul>
          </div>

          <Checkbox
            checked={form.blocksAccount}
            onChange={(e) => setForm({ ...form, blocksAccount: e.target.checked })}
            label={
              <>
                Suspend the account&rsquo;s credit at this level
                <span className="mt-0.5 block text-xs text-muted">
                  Usually only the final rung. The account cannot buy on credit until someone
                  releases it.
                </span>
              </>
            }
          />
          <Checkbox
            checked={form.requiresCall}
            onChange={(e) => setForm({ ...form, requiresCall: e.target.checked })}
            label="Flag this level as needing a phone call"
          />
          <Checkbox
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            label={
              <>
                Active
                <span className="mt-0.5 block text-xs text-muted">
                  Inactive levels are skipped when a run is built.
                </span>
              </>
            }
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Delete level ${deleting?.step}?`}
        message="A level that has already been used in a run cannot be deleted — deactivate it instead so the history still reads."
        confirmLabel="Delete"
        busy={pending}
      />
    </>
  )
}
