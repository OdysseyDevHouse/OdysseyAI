import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { holder } from '@/lib/control/modules'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { setupGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * The setup centre.
 *
 * Setup had no landing page of its own — the sidebar group was the only way in,
 * which meant knowing the name of the screen you wanted before you could reach
 * it. This is the same idea as /reports: everything in one place, grouped by
 * the job it does, searchable by what it decides rather than what it is called.
 *
 * Gated on `setup.view` — the weakest capability any tile requires — so the hub
 * itself opens for anyone who can see at least one setting, and the catalogue
 * then drops the tiles they cannot. Filtering happens HERE rather than in the
 * browser, so a setting somebody may not open is never sent to them at all.
 *
 * `?q=` seeds the search: the sidebar's own box hands its term over when a
 * setting matches it, so that search carries on here instead of starting again.
 *
 * Tabbed, unlike the other two hubs. This catalogue is eight groups and fifty
 * settings, so somebody who came to change a loyalty tier scrolled past every
 * decision about pay, pricing and stock to reach it. The tabs cut that to one
 * group at a time; "All" stays first and is what the screen still opens on, so
 * the person who does not know which group holds their setting is unaffected.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { capabilities, modules } = await requireSiteUser()
  const allow = (c: string) => can(capabilities, c as Parameters<typeof can>[1])

  // A hidden menu entry is not a boundary — this URL is typeable.
  const groups = setupGroupsFor(allow, holder(modules))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Setup"
        subtitle="Everything that decides how this shop works — in one place"
      />
      <PageBody>
        <HubView
          groups={groups}
          tabs
          noun="settings"
          emptyHint="Your role does not include access to any setup screen. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
