import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listLanes, listTickets } from '@/lib/site/tickets'
import { storedMillis } from '@/lib/jobStatusModel'
import { PageHeader, PageBody, LinkTabs, PrimaryLink, Icons } from '@/components/ui'
import TicketBoard from './TicketBoard'

export const dynamic = 'force-dynamic'

/**
 * The board: lanes across, tickets down, and dragging drives the clock.
 *
 * ── WHY THE BOARD AND THE LIST ARE TWO ROUTES ──────────────────────────────
 *
 * They answer different questions. The board answers "what is the desk doing
 * right now" and is the screen somebody leaves open; the list answers "find me
 * the ticket about the printer" and is the one they visit. The job module made
 * the same split for the same reason, and a toggle inside one route would mean
 * one of the two could never be linked to.
 *
 * ── WHAT THE BOARD SHOWS, AND THE BUG THAT TAUGHT IT ──────────────────────
 *
 * The first version filtered to `state: 'open'`, which is what a job board
 * does. On a ticket board it is wrong: dragging a card into "Resolved" sets the
 * state to closed, so the card VANISHED at the moment of the drop. The lane
 * existed to be dragged to, and arriving there made the ticket disappear —
 * which reads as a failed drop, not a completed one.
 *
 * So the board shows everything RECENT instead: every open ticket, plus
 * anything closed in the last fortnight. A support desk still wants yesterday's
 * resolved work visible — it is what gets reopened — and two years of it is
 * what makes a board unscannable. The list is where the full history lives.
 */
export default async function TicketBoardPage() {
  const { siteId, capabilities } = await requireCapability('tickets.view')

  const [lanes, everything] = await Promise.all([
    listLanes(siteId, false),
    listTickets(siteId, { state: 'all', limit: 500 }),
  ])

  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
  const tickets = everything.filter((t) => {
    if (!t.isClosed) return true
    if (!t.closedAt) return true
    return storedMillis(t.closedAt) >= cutoff
  })

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="What the desk is working on. Dragging a card starts and stops its clock."
        action={
          can(capabilities, 'tickets.edit') ? (
            <PrimaryLink href="/tickets/new">
              <Icons.Plus size={16} />
              New ticket
            </PrimaryLink>
          ) : undefined
        }
      />
      <PageBody>
        <LinkTabs
          value="board"
          aria-label="How to view tickets"
          items={[
            { value: 'board', label: 'Board', href: '/tickets/board' },
            { value: 'list', label: 'List', href: '/tickets' },
          ]}
        />
        <TicketBoard
          lanes={lanes}
          tickets={tickets}
          canEdit={can(capabilities, 'tickets.edit')}
        />
      </PageBody>
    </>
  )
}
