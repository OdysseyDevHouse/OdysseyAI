import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can, listRoles, capabilityMatrix, CAPABILITY_GROUPS } from '@/lib/site/permissions'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import RolesScreen from './RolesScreen'

export const dynamic = 'force-dynamic'

export default async function RolesPage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'setup.users')) redirect('/not-allowed')

  const [roles, matrix] = await Promise.all([listRoles(site.id), capabilityMatrix(site.id)])

  return (
    <>
      {/* `backHref` because this screen is reached from Users now rather than
          from a hub tile of its own — without it the only way back is the
          browser's own button. */}
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role may do — name them after the jobs people actually do"
        backHref="/setup/users"
        backLabel="Back to users"
      />

      <PageBody>
        <RolesScreen
          roles={roles}
          matrix={matrix}
          groups={CAPABILITY_GROUPS.map((g) => ({
            key: g.key,
            label: g.label,
            capabilities: g.capabilities.map((c) => ({ ...c })),
          }))}
        />

        <Callout tone="neutral" title="A missing permission means denied.">
          Nothing defaults to allowed. The owner role always keeps every permission — if the last
          person who could restore one were denied it, the only way back would be editing the
          database by hand. Changes take effect on the next screen a user opens.
        </Callout>
      </PageBody>
    </>
  )
}
