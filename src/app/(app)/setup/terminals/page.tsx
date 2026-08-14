import { requireCapability } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listLicences } from '@/lib/control/devices'
import { PageHeader, PageBody } from '@/components/ui'
import TerminalsClient from './TerminalsClient'
import LicencesPanel from './LicencesPanel'

export const dynamic = 'force-dynamic'

export default async function TerminalsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const terminals = await listTerminals(siteId, true)
  /* Licences come from the CONTROL database, not this shop's own. Read here
     rather than in the client so a manager sees them on first paint — this is
     the screen somebody opens when a till will not start. */
  const licences = await listLicences(siteId)

  return (
    <>
      <PageHeader
        title="Tills"
        subtitle="Which register rang up a sale, and which machine is which."
      />
      <PageBody>
        <div className="flex flex-col gap-4">
          <TerminalsClient terminals={terminals} />
          {/* BELOW the tills, because a manager comes here to add a till far
              more often than to release a licence — and the licence list is the
              one they need when something is already wrong. */}
          <LicencesPanel licences={licences} terminals={terminals} />
        </div>
      </PageBody>
    </>
  )
}
