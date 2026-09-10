import { requireModuleCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { listJobStatuses } from '@/lib/site/jobStatuses'
import { PageHeader, PageBody } from '@/components/ui'
import PartsStockPanel from './PartsStockPanel'

export const dynamic = 'force-dynamic'

/** How parts and stock get onto a job. */
export default async function JobPartsStockPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [settings, statuses] = await Promise.all([
    getSettings(siteId, ['job_stock_warn_mode', 'job_auto_awaiting_parts']),
    listJobStatuses(siteId, true).catch(() => []),
  ])

  /*
   * By CODE and active, exactly as `awaitingPartsStatusId` finds it — anything
   * else would report the switch as working on a shop where it does nothing, or
   * warn on one where it works fine. Deliberately duplicating that query's shape
   * rather than its result, because the helper is private to jobPartRequests.
   */
  const awaitingPartsStage =
    statuses.find((s) => s.code === 'parts' && s.isActive)?.name ?? null

  return (
    <>
      <PageHeader
        title="Parts & stock"
        subtitle="How parts and stock get onto a job, and who signs them out."
      />
      <PageBody>
        <PartsStockPanel
          stockWarnMode={settings.job_stock_warn_mode ?? 'inform'}
          autoAwaitingParts={settings.job_auto_awaiting_parts !== '0'}
          awaitingPartsStage={awaitingPartsStage}
        />
      </PageBody>
    </>
  )
}
