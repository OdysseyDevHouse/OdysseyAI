import { requireSiteId } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { PageHeader, PageBody } from '@/components/ui'
import TerminalsClient from './TerminalsClient'

export const dynamic = 'force-dynamic'

export default async function TerminalsPage() {
  const siteId = await requireSiteId()
  const terminals = await listTerminals(siteId, true)

  return (
    <>
      <PageHeader
        title="Tills"
        subtitle="Which register rang up a sale, and which machine is which."
      />
      <PageBody>
        <TerminalsClient terminals={terminals} />
      </PageBody>
    </>
  )
}
