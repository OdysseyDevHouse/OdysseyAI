import { requireCapability, requireSite } from '@/lib/auth'
import { recentSessions, trainingSummary } from '@/lib/site/trainingMode'
import { PageHeader, PageBody } from '@/components/ui'
import TrainingModePanel from './TrainingModePanel'

/**
 * Training mode.
 *
 * force-dynamic because the whole screen is a live answer to "is this store
 * pretending right now" and how much has been rung up since it started. A cached
 * render of this page showing "off" while the till is in training is the single
 * most misleading thing it could do.
 */
export const dynamic = 'force-dynamic'

export default async function TrainingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()

  const [summary, history] = await Promise.all([
    trainingSummary(site.id),
    recentSessions(site.id),
  ])

  return (
    <>
      <PageHeader
        title="Training mode"
        subtitle="Practise on the real system, then remove everything that was practised"
      />

      <PageBody>
        <TrainingModePanel
          initial={{
            /* Reshaped, not passed through. `summary.session` carries a Date and
               the watermark manifest — neither belongs on the client, and the
               marks in particular are an implementation detail that would sit in
               the page source for no reason. */
            summary: {
              active: summary.active,
              session: summary.session
                ? {
                    id: summary.session.id,
                    startedAt: summary.session.startedAt.toISOString(),
                    startedName: summary.session.startedName,
                  }
                : null,
              pending: summary.pending,
              pendingTotal: summary.pendingTotal,
            },
            history: history.map((h) => ({
              id: h.id,
              startedAt: h.startedAt.toISOString(),
              endedAt: h.endedAt === null ? null : h.endedAt.toISOString(),
              startedName: h.startedName,
              endedName: h.endedName,
              removedTotal: h.removedTotal,
            })),
          }}
        />
      </PageBody>
    </>
  )
}
