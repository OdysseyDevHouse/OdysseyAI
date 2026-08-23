import { redirect } from 'next/navigation'
import { requireModule } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has } from '@/lib/control/modules'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { onlineStoreGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * The online store centre.
 *
 * /online-store had no landing page — eleven menu rows mixing three operational
 * screens with eight settings, in a section most shops never switch on. This is
 * the same move Setup and Accounting made: one link in the menu, everything
 * behind it grouped by the job it does.
 *
 * Gated on the weakest capability any tile requires, so anyone who can see one
 * screen gets in and the catalogue drops the rest. Filtering happens HERE rather
 * than in the browser, so a screen somebody may not open is never sent to them.
 */
export default async function OnlineStorePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  /* The whole hub is behind the module, so this is one check rather than a
     `module` on each of its twelve tiles. A hidden menu entry is not a
     boundary — this URL is typeable. */
  const { capabilities, modules } = await requireModule('online_store')
  const allow = (c: string) => can(capabilities, c as Parameters<typeof can>[1])

  /* One tile — the loyalty members list — is a separate purchase, so the hub
     asks about modules as well as capabilities. Free to ask: the check above
     has already resolved this shop's entitlements for the request. */
  const groups = onlineStoreGroupsFor(allow, (m) => has(modules, m as Parameters<typeof has>[1]))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Online Store"
        subtitle="The shop as a customer sees it — what it sells, and how it takes an order"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="store screens"
          emptyHint="Your role does not include access to the online store. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
