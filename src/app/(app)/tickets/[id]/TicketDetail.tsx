'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Select,
  Tabs,
  Textarea,
  TextLink,
  useToast,
  type BadgeTone,
} from '@/components/ui'
import type { Ticket, TicketLane, TimeSegment } from '@/lib/site/tickets'
import type { PartyComment } from '@/lib/site/partyComments'
import type { ActivityEvent } from '@/lib/site/activityLog'
import { TICKET_PRIORITY_LABEL, TICKET_PRIORITY_TONE } from '@/lib/ticketModel'
import { moveTicketAction, assignTicketAction, commentOnTicketAction } from '../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/**
 * One ticket.
 *
 * ── TWO COLUMNS, NOT TABS ──────────────────────────────────────────────────
 *
 * The job card uses tabs because it has eight areas of genuinely separate work
 * — costs, visits, quotes, parts. A ticket has two: the conversation, and the
 * facts about it. Tabs would hide half of a screen that fits.
 *
 * So the left is the thread (description, a box to reply, then comments and
 * activity as tabs beneath), and the right rail holds the facts somebody
 * changes: who has it, how urgent, and the clock.
 *
 * Comments and Activity are TABS ON ONE PANEL rather than two stacked lists —
 * they answer the same question ("what has happened here") from two angles,
 * and stacking them puts the older one below a fold nobody scrolls to.
 */

/**
 * Business minutes as a person reads them.
 *
 * Zero is `0m`, not "None yet". A running clock showing "None yet" reads as
 * broken — it is a total, and a total of nothing is a number.
 */
function readMinutes(total: number): string {
  if (total === 0) return '0m'
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function readStamp(value: string | Date | null): string {
  if (!value) return '—'
  const raw = value instanceof Date ? value.toISOString() : value
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw)
  if (!m) return String(raw)
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}`
}

export default function TicketDetail({
  ticket,
  lanes,
  segments,
  comments,
  activity,
  users,
  canEdit,
  canAssign,
}: {
  ticket: Ticket
  lanes: TicketLane[]
  segments: TimeSegment[]
  comments: PartyComment[]
  activity: ActivityEvent[]
  users: { id: number; name: string }[]
  canEdit: boolean
  canAssign: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [body, setBody] = useState('')
  const [tab, setTab] = useState<'comments' | 'activity'>('comments')

  function move(statusId: number) {
    start(async () => {
      const result = await moveTicketAction(ticket.id, statusId)
      if (result.ok) {
        // The clock is the thing somebody wants confirmed, so say which
        // happened rather than a generic "saved".
        toast.success(
          result.started ? 'Clock started.' : result.stopped ? 'Clock stopped.' : 'Moved.',
        )
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function assign(value: string) {
    const userId = value === '' ? null : Number(value)
    const name = users.find((u) => u.id === userId)?.name ?? ''
    start(async () => {
      const result = await assignTicketAction(ticket.id, userId, name)
      if (result.ok) {
        toast.success(userId === null ? 'Unassigned.' : `Assigned to ${name}.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function comment() {
    if (!body.trim()) return
    start(async () => {
      const result = await commentOnTicketAction(ticket.id, body)
      if (result.ok) {
        toast.success('Comment added.')
        setBody('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      {/* ── The thread ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader
            title="What was asked"
            description={ticket.description ? undefined : 'Nothing was written down.'}
          />
          {ticket.description && (
            <CardBody>
              <p className="whitespace-pre-wrap text-sm text-ink-2">{ticket.description}</p>
            </CardBody>
          )}
        </Card>

        {canEdit && (
          <Card>
            <CardBody className="space-y-3">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Add a comment…"
              />
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={comment} disabled={pending || !body.trim()}>
                  <Icons.Send size={14} />
                  Send
                </Button>
              </div>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody className="p-0">
            <div className="border-b border-border px-4 pt-3">
              <Tabs
                value={tab}
                onChange={(v) => setTab(v as 'comments' | 'activity')}
                items={[
                  { value: 'comments', label: `Comments (${comments.length})` },
                  { value: 'activity', label: `Activity (${activity.length})` },
                ]}
              />
            </div>

            {tab === 'comments' ? (
              comments.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted">
                  Nothing said yet. A comment here is what the next person reads first.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {comments.map((c) => (
                    <li key={c.id} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-ink">{c.authorName}</span>
                        <span className="text-xs text-muted">{readStamp(c.createdAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )
            ) : activity.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <span className="text-sm text-ink-2">
                      {a.detail || a.action}
                      <span className="ml-2 text-xs text-muted">{a.userName}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{readStamp(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ── The facts ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-5">
        <Card>
          <CardBody className="space-y-4">
            <Field label="Lane" hint="Moving it here does the same as dragging it on the board.">
              <Select
                value={String(ticket.statusId)}
                disabled={!canEdit || pending}
                onChange={(e) => move(Number(e.target.value))}
              >
                {lanes.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.clock === 'start' ? ' — starts the clock' : ''}
                    {l.clock === 'pause' ? ' — pauses it' : ''}
                    {l.clock === 'end' ? ' — ends it' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Technician"
              hint="Whose clock runs on this ticket, and whose figures it counts towards."
            >
              <Select
                value={ticket.assigneeUserId === null ? '' : String(ticket.assigneeUserId)}
                disabled={!canAssign || pending || ticket.isClosed}
                onChange={(e) => assign(e.target.value)}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <span className="text-xs text-muted">Priority</span>
              <div className="mt-1">
                <Badge tone={TICKET_PRIORITY_TONE[ticket.priority] as BadgeTone}>
                  {TICKET_PRIORITY_LABEL[ticket.priority]}
                </Badge>
              </div>
            </div>

            {ticket.customerId !== null && (
              <div>
                <span className="text-xs text-muted">Customer</span>
                <p className="mt-1 text-sm">
                  <TextLink href={`/customers/${ticket.customerId}`}>
                    {ticket.customerName ?? 'A customer'}
                  </TextLink>
                </p>
              </div>
            )}

            {ticket.jobCardId !== null && (
              <div>
                <span className="text-xs text-muted">Became a job</span>
                <p className="mt-1 text-sm">
                  <TextLink href={`/jobs/${ticket.jobCardId}`}>
                    {ticket.jobNumber ?? `Job #${ticket.jobCardId}`}
                  </TextLink>
                </p>
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Time tracking ────────────────────────────────────────────────
            The ledger, not just a total. "3h 20m" answers one question;
            "Sarah 2h, then Tom 1h20 after the handover" answers the one a
            manager actually asked, and is the whole reason for a ledger. */}
        <Card>
          <CardHeader
            title="Time tracking"
            description={
              ticket.isRunning
                ? 'The clock is running now. Counted in business hours only.'
                : 'Counted in business hours only — the same clock the service targets use.'
            }
          />
          <CardBody className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span
                className={`numeric text-2xl ${ticket.isRunning ? 'text-success' : 'text-ink'}`}
              >
                {readMinutes(ticket.workedMinutes)}
              </span>
              {ticket.isRunning && (
                <Badge tone="success">
                  <Icons.Play size={10} />
                  Running
                </Badge>
              )}
            </div>

            {segments.length > 0 && (
              <ul className="space-y-1.5 border-t border-border pt-3">
                {segments.map((s) => (
                  <li key={s.id} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-ink-2">
                      {s.userName || 'Somebody'}
                      {s.toStatusName ? ` · ${s.toStatusName}` : ''}
                    </span>
                    <span
                      className={`numeric shrink-0 ${s.isRunning ? 'text-success' : 'text-muted'}`}
                    >
                      {readMinutes(s.minutes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-2 text-xs">
            <Row label="Logged" value={readStamp(ticket.reportedAt)} />
            <Row label="First reply" value={readStamp(ticket.respondedAt)} />
            {ticket.respondBy && <Row label="Reply due" value={readStamp(ticket.respondBy)} />}
            {ticket.closedAt && <Row label="Closed" value={readStamp(ticket.closedAt)} />}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-ink-2">{value}</span>
    </div>
  )
}
