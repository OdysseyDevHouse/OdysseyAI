import { requireCapability } from '@/lib/auth'
import {
  listActivityLog,
  listActivityActors,
  type ActivityEntity,
  type ActivityLogFilter,
} from '@/lib/site/activityLog'
import { listSignIns } from '@/lib/signinLog'
import { PageHeader, PageBody } from '@/components/ui'
import AuditScreen from './AuditScreen'

export const dynamic = 'force-dynamic'

/**
 * The whole trail in one place. activity_log has been written by every
 * module since 011; this is the first screen that reads it ACROSS records —
 * who changed what, filtered by person, entity, date and word — plus who
 * signed in, from the control-side log (003).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string
    entity?: string
    user?: string
    q?: string
    from?: string
    to?: string
    beforeAt?: string
    beforeId?: string
  }>
}) {
  const { siteId } = await requireCapability('setup.audit')
  const params = await searchParams

  const filter: ActivityLogFilter = {
    entity: (params.entity as ActivityEntity) || undefined,
    userId: Number(params.user) > 0 ? Number(params.user) : undefined,
    search: params.q || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    before:
      params.beforeAt && Number(params.beforeId) > 0
        ? { createdAt: params.beforeAt, id: Number(params.beforeId) }
        : undefined,
  }

  const [activity, actors, signIns] = await Promise.all([
    listActivityLog(siteId, filter),
    listActivityActors(siteId),
    listSignIns(siteId, 100).catch(() => []),
  ])

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Every change anyone made, and who signed in when. Written as things happened — this screen only reads."
        backHref="/setup"
        backLabel="Setup"
      />
      <PageBody>
        <AuditScreen
          events={activity.events.map((e) => ({
            id: e.id,
            entity: e.entity,
            entityId: e.entityId,
            action: e.action,
            detail: e.detail,
            changes: e.changes,
            userName: e.userName,
            userId: e.userId,
            at: e.createdAt.toISOString(),
          }))}
          hasMore={activity.hasMore}
          actors={actors}
          signIns={signIns.map((s) => ({
            id: s.id,
            email: s.email,
            event: s.event,
            ip: s.ip,
            at: s.at.toISOString(),
          }))}
          tab={params.tab === 'signins' ? 'signins' : 'activity'}
          filter={{
            entity: params.entity ?? '',
            user: params.user ?? '',
            q: params.q ?? '',
            from: params.from ?? '',
            to: params.to ?? '',
          }}
        />
      </PageBody>
    </>
  )
}
