'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column, type BadgeTone } from '@/components/ui'
import type { JobCard } from '@/lib/site/jobCards'
import { PRIORITY_LABEL, PRIORITY_TONE, storedDate, type JobPriority } from '@/lib/jobStatusModel'

/**
 * The job list.
 *
 * ── WHY THE COLUMNS ARE THESE SEVEN ────────────────────────────────────────
 *
 * A job card knows thirty things. Seven of them are what somebody scans a list
 * FOR: which job, whose, where, what stage, how urgent, who is doing it, when it
 * is due. Everything else — the description, the costs, the documents — is on the
 * job's own screen, because a list that shows everything shows nothing
 * prominently.
 *
 * ── WHAT THE COLOUR IS SPENT ON ────────────────────────────────────────────
 *
 * Two things only: the workflow status, whose tone the business chose itself, and
 * a due date that has passed. Priority is a badge but takes a tone only above
 * Normal — a column where every row is coloured is a column where colour has
 * stopped meaning anything, and most jobs are normal.
 *
 * A closed job is deliberately quieter than an open one: it is history, and it
 * should not compete with today's work for attention.
 */

/** The status tone the business picked, mapped onto the Badge's vocabulary. */
const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

function dueLabel(job: JobCard): { text: string; overdue: boolean } | null {
  if (!job.dueAt) return null

  /*
   * DATETIME columns are read back as UTC by this pool, so the wall-clock parts
   * come off with getUTC* — getHours() would shift a 16:00 appointment by two
   * hours on a South African machine.
   *
   * storedDate() handles both shapes the value arrives in; see its header for why
   * hand-appending 'Z' is a trap.
   */
  const due = storedDate(job.dueAt)
  if (!due) return null

  const day = String(due.getUTCDate()).padStart(2, '0')
  const month = due.toLocaleString('en-ZA', { month: 'short', timeZone: 'UTC' })
  const hh = String(due.getUTCHours()).padStart(2, '0')
  const mm = String(due.getUTCMinutes()).padStart(2, '0')

  const text = hh === '00' && mm === '00' ? `${day} ${month}` : `${day} ${month}, ${hh}:${mm}`

  // Only an OPEN job can be late. A closed one that ran over is history, and
  // colouring it red forever would leave the list permanently alarming.
  return { text, overdue: !job.isClosed && due.getTime() < Date.now() }
}

export default function JobsTable({ jobs }: { jobs: JobCard[] }) {
  const router = useRouter()

  const columns: Column<JobCard>[] = [
    {
      key: 'number',
      header: 'Job',
      cell: (job) => (
        <span className={job.isClosed ? 'text-muted' : 'text-ink'}>
          {job.documentNumber ?? `#${job.id}`}
        </span>
      ),
      sortValue: (job) => job.documentNumber ?? '',
    },
    {
      key: 'title',
      header: 'Work',
      cell: (job) => (
        <span className="text-ink-2">{job.title}</span>
      ),
      sortValue: (job) => job.title,
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (job) =>
        job.customerName ? (
          <span className="text-ink-2">{job.customerName}</span>
        ) : (
          // A walk-in with no account is a legitimate job, not missing data.
          <span className="text-faint">Walk-in</span>
        ),
      sortValue: (job) => job.customerName ?? '',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (job) => <Badge tone={TONE[job.statusTone] ?? 'neutral'}>{job.statusName}</Badge>,
      sortValue: (job) => job.statusName,
    },
    {
      key: 'priority',
      header: 'Priority',
      cell: (job) => {
        const priority = job.priority as JobPriority
        // Normal and Low are the majority, so they stay plain text. Spending a
        // badge on them would drown the two that mean something.
        if (priority === 'normal' || priority === 'low') {
          return <span className="text-muted">{PRIORITY_LABEL[priority]}</span>
        }
        return <Badge tone={TONE[PRIORITY_TONE[priority]] ?? 'neutral'}>{PRIORITY_LABEL[priority]}</Badge>
      },
      // Sorted by urgency, not alphabetically: "Urgent, High, Normal, Low" is
      // the order somebody means when they click this heading.
      sortValue: (job) => ({ urgent: 0, high: 1, normal: 2, low: 3 })[job.priority] ?? 9,
    },
    {
      key: 'owner',
      header: 'Assigned to',
      cell: (job) =>
        job.ownerName ? (
          <span className="text-ink-2">{job.ownerName}</span>
        ) : (
          // The one piece of missing data on this screen worth flagging: an open
          // job nobody owns is work that will not get done.
          <span className="text-warning">Nobody</span>
        ),
      sortValue: (job) => job.ownerName || 'zzz',
    },
    {
      key: 'due',
      header: 'Due',
      cell: (job) => {
        const due = dueLabel(job)
        if (!due) return <span className="text-faint">—</span>
        return (
          <span className={due.overdue ? 'text-danger-ink' : 'text-ink-2'}>{due.text}</span>
        )
      },
      sortValue: (job) => job.dueAt ?? '9999',
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={jobs}
      getRowKey={(job) => job.id}
      onRowClick={(job) => router.push(`/jobs/${job.id}`)}
      empty={{
        title: 'No jobs here',
        hint: 'A job card holds everything about one piece of work — what was asked for, who is doing it, what was used, and what it cost. Start one when the phone rings.',
        icon: <Icons.Wrench size={22} />,
      }}
    />
  )
}
