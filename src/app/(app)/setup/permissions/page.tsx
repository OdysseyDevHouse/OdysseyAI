import { requireSite } from '@/lib/auth'
import { capabilityMatrix, CAPABILITIES, CAPABILITY_LABELS } from '@/lib/site/permissions'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import PermissionsGrid from './PermissionsGrid'

export const dynamic = 'force-dynamic'

export default async function PermissionsPage() {
  const site = await requireSite()
  const matrix = await capabilityMatrix(site.id)

  return (
    <>
      <PageHeader
        title="Permissions"
        subtitle="What each role may do at the till and on a finalised sale"
      />

      <PageBody>
        {site.role !== 'owner' && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="font-medium text-ink">You can see this, but not change it.</p>
                <p className="text-sm text-muted">
                  Only an owner can grant or remove a permission. Otherwise anyone could grant
                  themselves the rights they were denied.
                </p>
              </div>
            </div>
          </Card>
        )}

        <PermissionsGrid
          matrix={matrix}
          capabilities={CAPABILITIES.map((id) => ({ id, ...CAPABILITY_LABELS[id] }))}
          canEdit={site.role === 'owner'}
        />

        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">A missing permission means denied.</p>
              <p className="text-muted">
                Nothing defaults to allowed. An owner always keeps every permission — if the last
                person who could restore one were denied it, the only way back would be editing the
                database by hand.
              </p>
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
