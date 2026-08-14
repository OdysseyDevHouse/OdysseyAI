import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listTickets, type TicketFilter } from '@/lib/site/tickets'
import {
  PageHeader,
  PageBody,
  Card,
  CardBody,
  LinkTabs,
  LinkSegmentedControl,
  PrimaryLink,
  StatStrip,
  StatTile,
  Icons,
} from '@/components/ui'
import TicketList from './TicketList'

export const dynamic = 'force-dynamic'

/**
 * Every ticket, as a list.
 *
 * The board answers "what is the desk doing"; this answers "find me the one
 * about the printer". Which is why closed tickets live here and not there — a
 * board carrying two years of resolved work is unscannable, and a list without
 * them cannot answer a question about last month.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string }>
}) {
  const { siteId, capabilities } = await requireCapability('tickets.view')
  const { show, q } = await searchParams

  const state: TicketFilter['state'] =
    show === 'closed' ? 'closed' : show === 'all' ? 'all' : 'open'

  const tickets = await listTickets(siteId, { state, search: q, limit: 500 })

  /*
   * Counts for the strip. Open and running are the two an operator acts on —
   * "how much is on the desk" and "how much is actually being worked" — and
   * the gap between them is the interesting number.
   */
  const running = tickets.filter((t) => t.isRunning).length
  const unassigned = tickets.filter((t) => t.assigneeUserId === null && !t.isClosed).length

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Inbound support: what was asked, who has it, and how long it has taken."
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
          value="list"
          aria-label="How to view tickets"
          items={[
            { value: 'board', label: 'Board', href: '/tickets/board' },
            { value: 'list', label: 'List', href: '/tickets' },
          ]}
        />

        {/* Unassigned is the one that wants acting on, so it is the one that
            carries a tone. Three tiles in the same ink is three tiles nobody
            reads. */}
        <StatStrip>
          <StatTile label="Showing" value={String(tickets.length)} />
          <StatTile label="Clock running" value={String(running)} />
          <StatTile
            label="Unassigned"
            value={String(unassigned)}
            tone={unassigned > 0 ? 'warning' : undefined}
          />
        </StatStrip>

        <Card>
          <CardBody className="p-0">
            <div className="border-b border-border px-4 py-3.5">
              <LinkSegmentedControl
                value={state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open'}
                aria-label="Which tickets to show"
                options={[
                  { value: 'open', label: 'Open', href: '/tickets' },
                  { value: 'closed', label: 'Closed', href: '/tickets?show=closed' },
                  { value: 'all', label: 'Everything', href: '/tickets?show=all' },
                ]}
              />
            </div>
            <TicketList tickets={tickets} />
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
