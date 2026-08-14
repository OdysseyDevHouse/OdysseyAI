'use client'

import Link from 'next/link'
import {
  Badge,
  DataTable,
  Icons,
  type BadgeTone,
  type Column,
} from '@/components/ui'
import type { Ticket } from '@/lib/site/tickets'
import { TICKET_PRIORITY_LABEL, TICKET_PRIORITY_TONE } from '@/lib/ticketModel'

/**
 * The ticket list.
 *
 * ── WHY THIS IS A CLIENT COMPONENT ─────────────────────────────────────────
 *
 * A DataTable `Column` carries render FUNCTIONS, and a function cannot cross
 * the server/client boundary. Defining these on a server page typechecks, the
 * build passes, and the route then 500s at request time — which is how this
 * caught somebody out before. The columns live here, with 'use client' above
 * them, and the page passes plain data.
 *
 * ── SIX COLUMNS, NOT TWELVE ────────────────────────────────────────────────
 *
 * Identity, state, who, the numbers, then actions. A ticket has plenty more on
 * it — source, category, contact, due date, SLA — and putting them all here
 * would make nothing prominent. They are on the ticket's own screen, one click
 * away, which is where somebody goes once they have found the row.
 */

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/** Business minutes as a person reads them. */
function readMinutes(total: number): string {
  if (total === 0) return '—'
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`
}

/** A stored stamp as a date somebody can read. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function readDate(value: string | null): string {
  if (!value) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return value
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

export default function TicketList({ tickets }: { tickets: Ticket[] }) {
  const columns: Column<Ticket>[] = [
    {
      key: 'number',
      header: 'Ticket',
      sortValue: (t) => t.documentNumber ?? String(t.id),
      cell: (t) => (
        <div className="min-w-0">
          <Link href={`/tickets/${t.id}`} className="text-sm font-medium text-ink hover:underline">
            {t.subject}
          </Link>
          <p className="numeric truncate text-xs text-muted">
            {t.documentNumber ?? `#${t.id}`}
            {t.customerName ? ` · ${t.customerName}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'lane',
      header: 'Lane',
      sortValue: (t) => t.statusName,
      cell: (t) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={TONE[t.statusTone] ?? 'neutral'}>{t.statusName}</Badge>
          {/* A running clock is the exception worth marking — it means somebody
              is on this right now. */}
          {t.isRunning && <Icons.Play size={11} className="text-success" aria-label="Clock running" />}
        </div>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      sortValue: (t) => ['urgent', 'high', 'normal', 'low'].indexOf(t.priority),
      cell: (t) => (
        <Badge tone={TICKET_PRIORITY_TONE[t.priority] as BadgeTone}>
          {TICKET_PRIORITY_LABEL[t.priority]}
        </Badge>
      ),
    },
    {
      key: 'assignee',
      header: 'Who',
      sortValue: (t) => t.assigneeName,
      cell: (t) =>
        t.assigneeName ? (
          <span className="text-sm text-ink-2">{t.assigneeName}</span>
        ) : (
          <span className="text-sm text-muted">Unassigned</span>
        ),
    },
    {
      key: 'worked',
      header: 'Worked',
      numeric: true,
      sortValue: (t) => t.workedMinutes,
      cell: (t) => (
        <span className={`numeric text-sm ${t.isRunning ? 'text-success' : 'text-ink-2'}`}>
          {readMinutes(t.workedMinutes)}
        </span>
      ),
    },
    {
      key: 'reported',
      header: 'Logged',
      sortValue: (t) => t.reportedAt ?? '',
      cell: (t) => <span className="text-sm text-muted">{readDate(t.reportedAt)}</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={tickets}
      getRowKey={(t) => t.id}
      empty={{
        title: 'No tickets match',
        hint: 'Change the filter above, or log the first ticket to get started.',
      }}
    />
  )
}
