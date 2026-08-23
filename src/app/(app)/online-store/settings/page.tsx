import { redirect } from 'next/navigation'
import { requireModule } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { onlineStoreSetupGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * Online Store — Setup.
 *
 * The five screens that decide how the shop RUNS, split out of the operational
 * hub and out of the general Setup hub, which used to list them as well.
 *
 * The route is /online-store/settings rather than /setup, because
 * /online-store/setup is already one of the screens listed here — the shop's
 * own name, domain and delivery rules.
 */
export default async function OnlineStoreSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireModule('online_store')

  const groups = onlineStoreSetupGroupsFor((c) => can(capabilities, c as Parameters<typeof can>[1]))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Online store setup"
        subtitle="Whether the shop is open, how it takes money, and what happens after an order"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="store settings"
          emptyHint="Your role does not include changing the online store. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
