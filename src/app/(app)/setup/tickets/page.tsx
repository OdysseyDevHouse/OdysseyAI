import { requireCapability } from '@/lib/auth'
import { listLanes } from '@/lib/site/tickets'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import LanesPanel from './LanesPanel'
import TicketSettingsPanel from './TicketSettingsPanel'

export const dynamic = 'force-dynamic'

/**
 * How the ticket board runs.
 *
 * Its own screen rather than a panel on Setup → Job workflow, for the same
 * reason tickets are their own capability group: a support desk and a field
 * team are usually different people, and the settings that govern one are
 * noise to the other.
 */
export default async function TicketSetupPage() {
  const { siteId } = await requireCapability('tickets.setup')

  const [lanes, settings] = await Promise.all([
    listLanes(siteId, true),
    getSettings(siteId, ['ticket_max_running_per_user']),
  ])

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="The lanes on the board, what each one does to the clock, and how many tickets one person may run at once."
      />
      <PageBody>
        <LanesPanel lanes={lanes} />
        <TicketSettingsPanel
          maxRunning={Number(settings.ticket_max_running_per_user ?? '0') || 0}
        />
      </PageBody>
    </>
  )
}
