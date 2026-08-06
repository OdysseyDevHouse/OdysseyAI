import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can, listRoles, capabilityMatrix, CAPABILITY_GROUPS } from '@/lib/site/permissions'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import RolesScreen from './RolesScreen'

export const dynamic = 'force-dynamic'

export default async function RolesPage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'setup.users')) redirect('/not-allowed')

  const [roles, matrix] = await Promise.all([listRoles(site.id), capabilityMatrix(site.id)])

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role may do — name them after the jobs people actually do"
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

        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">A missing permission means denied.</p>
              <p className="text-muted">
                Nothing defaults to allowed. The owner role always keeps every permission — if the
                last person who could restore one were denied it, the only way back would be editing
                the database by hand. Changes take effect on the next screen a user opens.
              </p>
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
