import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { menuFilters } from '@/lib/site/menuVisibility'
import { PageHeader, PageBody } from '@/components/ui'
import SettingsHome from './SettingsHome'
import { settingsTabsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * System settings.
 *
 * The settings that used to be their own /setup screens, as tabs of one route.
 * The gear in the top bar comes here; the sidebar's Setup row still reaches
 * /setup, which keeps the screens that have not moved. A setting lives in
 * exactly one of the two — see the header of catalogue.ts.
 *
 * Gated on `setup.view`, the same capability the setup hub opens on, so this
 * route grants nothing /setup did not already. Every panel's own load and save
 * actions guard on `setup.edit` independently, which is the real boundary —
 * this check only decides whether the screen opens at all.
 *
 * The TABS are filtered here rather than in the browser, so a tab for a module
 * this shop has not bought is never sent to it. Same arrangement as the setup
 * hub, and for the same reason.
 *
 * `?tab=` opens a named tab, so a screen elsewhere can link AT its settings
 * rather than at the rail: /sales/cashup's "Cash-up settings" button is the
 * first, and it used to reach a page of its own. An unknown value — or one this
 * shop cannot see — falls through to the first tab rather than erroring, since
 * a stale bookmark should land on settings rather than on a 404.
 */
export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { site, capabilities, modules } = await requireSiteUser()
  if (!can(capabilities, 'setup.view')) redirect('/not-allowed')

  const { holds } = await menuFilters(site.id, modules)
  const tabs = settingsTabsFor(
    (c) => can(capabilities, c as Parameters<typeof can>[1]),
    holds,
  )
  if (tabs.length === 0) redirect('/not-allowed')

  const { tab } = await searchParams
  const initialTab = tabs.some((c) => c.key === tab) ? tab : undefined

  return (
    <>
      <PageHeader
        title="System Settings"
        subtitle="Every setting that decides how this shop works — in one place"
      />
      <PageBody>
        <SettingsHome tabs={tabs} initialTab={initialTab} />
      </PageBody>
    </>
  )
}
