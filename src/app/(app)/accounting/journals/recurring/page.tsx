import { requireModuleCapability } from '@/lib/auth'
import { listRecurringJournals, getRecurringJournal } from '@/lib/site/recurringJournals'
import { listAccounts } from '@/lib/site/chartOfAccounts'
import { PageHeader, PageBody, Icons } from '@/components/ui'
import { RecurringJournalsClient } from './RecurringJournalsClient'

export const dynamic = 'force-dynamic'

/**
 * Recurring journals — the entries that are the same every period.
 *
 * A schedule holds a balanced template; Generate turns everything due into
 * DRAFTS on the journal list (or posts it, where a schedule opted in). The
 * month nobody presses Generate, the drafts are simply waiting when they do —
 * the catch-up rule means nothing is ever silently skipped.
 */
export default async function RecurringJournalsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')

  const [summaries, accounts] = await Promise.all([
    listRecurringJournals(siteId),
    listAccounts(siteId, { postableOnly: true }),
  ])

  // The editor needs each schedule's lines; the list alone does not carry
  // them. A site has a handful of schedules, so loading all is fine.
  const schedules = (
    await Promise.all(summaries.map((s) => getRecurringJournal(siteId, s.id)))
  ).filter((s): s is NonNullable<typeof s> => s !== null)

  return (
    <>
      <PageHeader
        title="Recurring journals"
        icon={<Icons.Repeat size={18} />}
        subtitle="Accruals, releases and recharges that repeat — drafted for review, posted by a person."
        backHref="/accounting/journals"
        backLabel="Journals"
      />
      <PageBody>
        <RecurringJournalsClient
          schedules={schedules.map((s) => ({
            id: s.id,
            name: s.name,
            frequency: s.frequency,
            dayOfMonth: s.dayOfMonth,
            dayOfWeek: s.dayOfWeek,
            description: s.description,
            reference: s.reference,
            startsOn: s.startsOn,
            endsOn: s.endsOn,
            lastGeneratedFor: s.lastGeneratedFor,
            nextDue: s.nextDue,
            due: s.due,
            autoPost: s.autoPost,
            isActive: s.isActive,
            lines: s.lines.map((l) => ({
              accountId: l.accountId,
              amount: l.amount,
              description: l.description,
            })),
          }))}
          accounts={accounts.map((a) => ({
            id: a.id,
            accountCode: a.accountCode,
            name: a.name,
          }))}
        />
      </PageBody>
    </>
  )
}
