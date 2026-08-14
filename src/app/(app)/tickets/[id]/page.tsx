import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getTicket, listLanes, ticketTime } from '@/lib/site/tickets'
import { listComments } from '@/lib/site/partyComments'
import { listActivity } from '@/lib/site/activityLog'
import { listUsers } from '@/lib/site/users'
import { PageHeader, PageBody, Badge, type BadgeTone } from '@/components/ui'
import { TICKET_PRIORITY_LABEL, TICKET_PRIORITY_TONE } from '@/lib/ticketModel'
import TicketDetail from './TicketDetail'

export const dynamic = 'force-dynamic'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { siteId, capabilities } = await requireCapability('tickets.view')
  const { id } = await params
  const ticketId = Number(id)
  if (!Number.isFinite(ticketId)) notFound()

  const ticket = await getTicket(siteId, ticketId)
  if (!ticket) notFound()

  const [lanes, segments, comments, activity, users] = await Promise.all([
    listLanes(siteId, false),
    ticketTime(siteId, ticketId),
    /*
     * Comments and activity come from the SHARED tables, through the widened
     * CommentEntity — no ticket comment table. Three copies would be three
     * places for an internal note to leak.
     */
    listComments(siteId, 'ticket', ticketId).catch(() => []),
    listActivity(siteId, 'ticket', ticketId, 60).catch(() => []),
    listUsers(siteId).catch(() => []),
  ])

  return (
    <>
      <PageHeader
        title={ticket.documentNumber ?? `Ticket #${ticket.id}`}
        subtitle={ticket.subject}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={TONE[ticket.statusTone] ?? 'neutral'}>{ticket.statusName}</Badge>
            <Badge tone={TICKET_PRIORITY_TONE[ticket.priority] as BadgeTone}>
              {TICKET_PRIORITY_LABEL[ticket.priority]}
            </Badge>
          </div>
        }
      />
      <PageBody>
        <TicketDetail
          ticket={ticket}
          lanes={lanes}
          segments={segments}
          comments={comments}
          activity={activity}
          // Back-office and active only: an escalation or an assignment goes to
          // somebody who can act on it, and a POS-only account cannot open this
          // screen at all.
          users={users
            .filter((u) => u.isActive && u.userType === 'back_office')
            .map((u) => ({ id: u.id, name: u.name }))}
          canEdit={can(capabilities, 'tickets.edit')}
          canAssign={can(capabilities, 'tickets.assign')}
        />
      </PageBody>
    </>
  )
}
