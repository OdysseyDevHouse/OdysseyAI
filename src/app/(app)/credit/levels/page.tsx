import { requireCapability } from '@/lib/auth'
import { listLevels } from '@/lib/site/creditControl'
import { PageHeader, PageBody } from '@/components/ui'
import { LevelsClient, type LevelRow } from './LevelsClient'

export const dynamic = 'force-dynamic'

/**
 * The escalation ladder.
 *
 * Configurable because the sequence is a commercial decision, not a technical
 * one — a hardware wholesaler on 30-day terms and a studio invoicing monthly
 * retainers do not chase on the same clock.
 *
 * Guarded by customers.credit rather than customers.view: editing these
 * rewrites what customers will be told and can decide when an account stops
 * being able to buy.
 */
export default async function LevelsPage() {
  const { siteId } = await requireCapability('customers.credit')

  const levels = await listLevels(siteId)

  const rows: LevelRow[] = levels.map((l) => ({
    id: l.id,
    step: l.step,
    name: l.name,
    minDaysOverdue: l.minDaysOverdue,
    minAmount: l.minAmount,
    subject: l.subject,
    body: l.body,
    channel: l.channel,
    smsBody: l.smsBody ?? '',
    blocksAccount: l.blocksAccount,
    requiresCall: l.requiresCall,
    isActive: l.isActive,
  }))

  return (
    <>
      <PageHeader
        title="Reminder levels"
        subtitle="What each reminder says, and when it is sent"
      />

      <PageBody>
        <LevelsClient levels={rows} />
      </PageBody>
    </>
  )
}
