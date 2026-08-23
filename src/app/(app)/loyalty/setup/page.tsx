import { redirect } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { loyaltySetupGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * Loyalty — Setup.
 *
 * The three screens that decide how the programme WORKS, which used to be
 * tiles in the general Setup hub. A shop that has not bought loyalty never
 * sees this, because the module gate below turns them away before the
 * catalogue is read.
 */
export default async function LoyaltySetupPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireModuleCapability('loyalty', 'loyalty.view')

  const groups = loyaltySetupGroupsFor((c) => can(capabilities, c as Parameters<typeof can>[1]))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Loyalty setup"
        subtitle="How the programme rewards people, and what a point is worth"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="loyalty settings"
          emptyHint="Your role does not include the loyalty programme. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
