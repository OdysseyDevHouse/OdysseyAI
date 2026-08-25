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
  HtmlEditor,
  Icons,
  Input,
  Modal,
  Radio,
  Select,
  Switch,
  useToast,
} from '@/components/ui'
import { MERGE_FIELDS, starterTemplate } from '@/lib/orderEmailTemplate'
import {
  NOTIFY_KIND_LABEL,
  ROLE_LABEL,
  STATUS_NOTIFY_KINDS,
  type OrderStatus,
  type OrderStatusInput,
  type StatusNotifyKind,
  // The pure model, NOT lib/site/onlineStore — importing the server module
  // here would pull the database layer into the browser bundle.
} from '@/lib/orderStatusModel'
import { deleteStatusAction, reorderStatusesAction, saveStatusAction } from './actions'

/**
 * The order pipeline, and what each step tells the customer.
 *
 * ── TOP TO BOTTOM IS THE ORDER AN ORDER MOVES IN ─────────────────────────
 *
 * Reordered with arrows rather than drag. There are seven of these, they are
 * moved once when a shop is set up and rarely again, and arrows work on a
 * touch screen and with a keyboard without any of drag's failure modes.
 *
 * ── A ROLE IS THE JOB, NOT THE NAME ──────────────────────────────────────
 *
 * Code has to find "where a new order lands" without knowing whether this shop
 * calls it New, Received or In the queue. Roles carry that, which is why one
 * can only be held by a single status and why three of them cannot be given up
 * without handing them to someone else first.
 */

const TONES: OrderStatus['tone'][] = ['neutral', 'brand', 'success', 'warning', 'danger']

type Draft = OrderStatusInput

function emptyDraft(): Draft {
  return {
    id: null,
    name: '',
    tone: 'neutral',
    role: '',
    isActive: true,
    notifyKind: '',
    useTemplate: false,
    emailSubject: '',
    emailHtml: '',
  }
}

/** Which of the three things a status does when an order reaches it. */
type MessageMode = 'silent' | 'standard' | 'custom'
const modeOf = (d: Draft): MessageMode =>
  d.useTemplate ? 'custom' : d.notifyKind ? 'standard' : 'silent'

export default function OrderStatuses({
  statuses,
  orderCounts,
  mailConfigured,
}: {
  statuses: OrderStatus[]
  /** How many orders sit in each, so deletion can explain itself first. */
  orderCounts: Record<number, number>
  /** False when no SMTP is set up — every message would silently go nowhere. */
  mailConfigured: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, start] = useTransition()
  const [rows, setRows] = useState(statuses)
  const [draft, setDraft] = useState<Draft | null>(null)

  // The local copy is what the arrows move, so a nudge is instant. The server
  // is told afterwards and a failure snaps it back.
  function nudge(index: number, delta: -1 | 1) {
    const to = index + delta
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    ;[next[index], next[to]] = [next[to], next[index]]
    setRows(next)
    start(async () => {
      const result = await reorderStatusesAction(next.map((s) => s.id))
      if (!result.ok) {
        toast.error(result.error)
        setRows(statuses)
      }
      router.refresh()
    })
  }

  function save() {
    if (!draft) return
    start(async () => {
      const result = await saveStatusAction(draft)
      if (!result.ok) {
        // The full server message, verbatim: the reason IS the instruction.
        toast.error(result.error)
        return
      }
      toast.success(`“${draft.name.trim()}” saved.`)
      setDraft(null)
      router.refresh()
    })
  }

  function remove(status: OrderStatus) {
    start(async () => {
      const result = await deleteStatusAction(status.id, status.name)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`“${status.name}” deleted.`)
      router.refresh()
    })
  }

  return (
    <>
      {!mailConfigured && (
        <Card>
          <CardBody>
            <p className="text-sm text-warning-ink">
              Email is not set up on this system, so nothing here will actually send yet. The
              settings below are saved either way.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Your order statuses"
          description="Top to bottom is the order an order moves in. Rename them, add your own steps, and say what each one tells the customer."
          action={
            <Button onClick={() => setDraft(emptyDraft())} disabled={busy}>
              <Icons.Plus size={15} />
              Add a status
            </Button>
          }
        />
        <CardBody>
          <ul className="flex flex-col gap-2">
            {rows.map((status, index) => {
              const count = orderCounts[status.id] ?? 0
              return (
                <li
                  key={status.id}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-3 py-2.5"
                >
                  <span className="flex flex-col">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${status.name} earlier`}
                      disabled={index === 0 || busy}
                      onClick={() => nudge(index, -1)}
                    >
                      <Icons.ChevronUp size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${status.name} later`}
                      disabled={index === rows.length - 1 || busy}
                      onClick={() => nudge(index, 1)}
                    >
                      <Icons.ChevronDown size={14} />
                    </Button>
                  </span>

                  <span className="numeric w-6 shrink-0 text-right text-sm text-muted">
                    {index + 1}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={status.tone}>{status.name}</Badge>
                      {/* Suppressed when the label just repeats the name, so
                          "Out for delivery" does not read twice. */}
                      {status.role &&
                        ROLE_LABEL[status.role].toLowerCase() !== status.name.toLowerCase() && (
                          <span className="text-xs font-medium text-ink-2">
                            {ROLE_LABEL[status.role]}
                          </span>
                        )}
                      {!status.isActive && <span className="text-xs text-muted">Switched off</span>}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                      <span>
                        {count} {count === 1 ? 'order' : 'orders'}
                      </span>
                      {status.useTemplate ? (
                        <span className="text-brand">Sends your own email</span>
                      ) : status.notifyKind ? (
                        <span>Tells the customer: {NOTIFY_KIND_LABEL[status.notifyKind]}</span>
                      ) : (
                        <span>Says nothing</span>
                      )}
                    </span>
                  </span>

                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Edit ${status.name}`}
                      disabled={busy}
                      onClick={() => setDraft({ ...status, id: status.id })}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Delete ${status.name}`}
                      disabled={busy}
                      onClick={() => remove(status)}
                    >
                      <Icons.Trash size={15} />
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>

          <p className="mt-3 text-xs text-muted">
            A status you no longer use can be switched off — it disappears from the buttons on your
            order queue, and orders already in it keep their label. Deleting is only possible once
            no orders are left in it.
          </p>
        </CardBody>
      </Card>

      {draft && (
        <StatusModal
          draft={draft}
          setDraft={setDraft}
          statuses={rows}
          busy={busy}
          onSave={save}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  )
}

function StatusModal({
  draft,
  setDraft,
  statuses,
  busy,
  onSave,
  onClose,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  statuses: OrderStatus[]
  busy: boolean
  onSave: () => void
  onClose: () => void
}) {
  const patch = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes })
  const mode = modeOf(draft)

  function setMode(next: MessageMode) {
    if (next === 'silent') return patch({ useTemplate: false, notifyKind: '' })
    if (next === 'standard') {
      // Land on a real choice rather than an empty select the owner then has
      // to notice is empty.
      return patch({ useTemplate: false, notifyKind: draft.notifyKind || 'accepted' })
    }
    // Seed a starting email, but only when there is nothing written — moving
    // away and back must not wipe a template someone spent time on.
    const starter = starterTemplate(draft.name)
    patch({
      useTemplate: true,
      emailSubject: draft.emailSubject || starter.subject,
      emailHtml: draft.emailHtml.trim() ? draft.emailHtml : starter.html,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? 'Edit status' : 'Add a status'}
      description="What you call this step, and what your customer hears when an order reaches it."
      size="lg"
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy || !draft.name.trim()}>
            {busy ? 'Saving…' : draft.id ? 'Save' : 'Add status'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="What your staff see on the order queue.">
          <Input
            value={draft.name}
            maxLength={60}
            placeholder="e.g. In the kitchen"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>

        <Field label="Colour">
          <div className="flex flex-wrap items-center gap-2">
            {TONES.map((tone) => (
              <button
                key={tone}
                type="button"
                aria-label={tone}
                aria-pressed={draft.tone === tone}
                onClick={() => patch({ tone })}
                /* Not a kit Button: this is a colour swatch showing the actual
                   badge it will produce, which every Button variant would
                   restyle out of existence. */
                data-kit-ok
                className={`rounded-control p-0.5 transition ${
                  draft.tone === tone ? 'ring-2 ring-brand' : 'hover:opacity-80'
                }`}
              >
                <Badge tone={tone}>{draft.name.trim() || 'Preview'}</Badge>
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="What this status means"
          hint="Only one status can hold each of these. Choosing one moves it off whichever status has it now."
        >
          <Select
            value={draft.role}
            onChange={(e) => patch({ role: e.target.value as OrderStatus['role'] })}
          >
            <option value="">Just a step in your process</option>
            {(Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]).map((role) => {
              const holder = statuses.find((s) => s.role === role && s.id !== draft.id)
              return (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                  {holder ? ` (currently “${holder.name}”)` : ''}
                </option>
              )
            })}
          </Select>
        </Field>

        {/* ── What it tells the customer ─────────────────────────────── */}
        <div className="rounded-card border border-border bg-surface-2 p-3">
          <p className="text-sm font-medium text-ink">When an order reaches this status</p>

          <div className="mt-3 flex flex-col gap-2">
            <ModeChoice
              selected={mode === 'silent'}
              onSelect={() => setMode('silent')}
              label="Say nothing"
              hint="Right for your own internal steps — a message per step trains customers to ignore them."
            />

            <ModeChoice
              selected={mode === 'standard'}
              onSelect={() => setMode('standard')}
              label="Send the standard message"
              hint="A short, plain message written for you."
            >
              <Select
                value={draft.notifyKind}
                aria-label="Which standard message"
                onChange={(e) => patch({ notifyKind: e.target.value as StatusNotifyKind })}
              >
                {STATUS_NOTIFY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {NOTIFY_KIND_LABEL[kind]}
                  </option>
                ))}
              </Select>
            </ModeChoice>

            <ModeChoice
              selected={mode === 'custom'}
              onSelect={() => setMode('custom')}
              label="Send my own email"
              hint="Write it yourself. Use Insert… to drop in the order number, the items and the total."
            >
              <div className="flex flex-col gap-3">
                <Field label="Subject">
                  <Input
                    value={draft.emailSubject}
                    maxLength={255}
                    placeholder="Order {{order_number}} is ready"
                    onChange={(e) => patch({ emailSubject: e.target.value })}
                  />
                </Field>
                <Field label="Message">
                  {/* Shorter than the editor's own default: this sits inside
                      a modal whose body scrolls at 60vh, and a 240px editor
                      plus the fields above it pushes the Save button out of
                      reach on a laptop screen. */}
                  <HtmlEditor
                    value={draft.emailHtml}
                    onChange={(emailHtml) => patch({ emailHtml })}
                    tokens={MERGE_FIELDS}
                    placeholder="Hi {{first_name}}, your order is…"
                    minHeight={160}
                  />
                </Field>
                <p className="text-xs text-muted">
                  Anything in double braces is filled in when the email is sent — so{' '}
                  <code>{'{{first_name}}'}</code> becomes the customer&rsquo;s name. Scripts are
                  stripped when you save.
                </p>
              </div>
            </ModeChoice>
          </div>
        </div>

        <Field hint="Switch off to retire a status without touching the orders already in it.">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">In use</span>
            <Switch
              checked={draft.isActive}
              onChange={(next) => patch({ isActive: next })}
              ariaLabel="In use"
            />
          </div>
        </Field>
      </div>
    </Modal>
  )
}

/** One of the three choices, revealing its own fields only when selected. */
function ModeChoice({
  selected,
  onSelect,
  label,
  hint,
  children,
}: {
  selected: boolean
  onSelect: () => void
  label: string
  hint: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={`rounded-card border px-3 py-2.5 ${
        selected ? 'border-brand bg-surface' : 'border-border'
      }`}
    >
      {/* The hint rides inside the label so the whole block is one click
          target — a radio whose explanation is not clickable is a smaller
          target than it looks. */}
      <Radio
        name="status-message-mode"
        checked={selected}
        onChange={onSelect}
        className="items-start"
        label={
          <span className="min-w-0">
            <span className="block font-medium text-ink">{label}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
        }
      />
      {selected && children && <div className="mt-3 pl-6">{children}</div>}
    </div>
  )
}
