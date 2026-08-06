import { requireCapability } from '@/lib/auth'
import { listRecurring } from '@/lib/site/recurringExpenses'
import { listCategories } from '@/lib/site/expenseCategories'
import { listSuppliers } from '@/lib/site/suppliers'
import { listAccounts } from '@/lib/site/bankAccounts'
import { siteQueryOne } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { PageHeader, PageBody, Card, CardHeader, CardBody } from '@/components/ui'
import { RecurringClient } from './RecurringClient'

export const dynamic = 'force-dynamic'

/**
 * Recurring expenses — the ones that arrive every month.
 *
 * The month somebody forgets to capture rent, the P&L is simply wrong and
 * nothing reports it. A schedule removes the typing; it deliberately does not
 * remove the judgement, so it produces drafts for review rather than postings.
 */
export default async function RecurringExpensesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.edit')

  const [schedules, categories, suppliers, accounts, defaultRate] = await Promise.all([
    listRecurring(siteId, { includeInactive: true }),
    listCategories(siteId),
    listSuppliers(siteId, { statuses: ['active'], limit: 500 }),
    listAccounts(siteId),
    siteQueryOne<{ rate: number }>(
      siteId,
      "SELECT rate FROM vat_rates WHERE vat_type = 'purchase' AND is_default = 1 LIMIT 1",
    ),
  ])

  return (
    <>
      <PageHeader
        title="Recurring expenses"
        subtitle={`${schedules.filter((s) => s.isActive).length} active`}
      />
      <PageBody>
        <RecurringClient
          schedules={schedules.map((s) => ({
            id: s.id,
            name: s.name,
            frequency: s.frequency,
            frequencyLabel: s.frequencyLabel,
            dayOfMonth: s.dayOfMonth,
            dayOfWeek: s.dayOfWeek,
            paymentType: s.paymentType,
            supplierId: s.supplierId,
            supplierName: s.supplierName,
            bankAccountId: s.bankAccountId,
            bankAccountName: s.bankAccountName ?? null,
            description: s.description,
            totalIncl: s.totalIncl,
            startsOn: s.startsOn,
            endsOn: s.endsOn,
            nextDue: s.nextDue,
            due: s.due,
            isActive: s.isActive,
          }))}
          categories={categories.map((c) => ({
            id: c.id,
            accountCode: c.accountCode,
            name: c.name,
            defaultVatRatePct: c.defaultVatRatePct,
          }))}
          suppliers={suppliers.items.map((s) => ({ id: s.id, name: s.name }))}
          bankAccounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          defaultVatRate={toNum(defaultRate?.rate, 15)}
        />

        <Card>
          <CardHeader title="How a schedule works" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-medium text-ink">It creates drafts, never postings</dt>
                <dd className="text-muted">
                  An amount that changed, a bill that never arrived, a lease that ended are all
                  things somebody must see before money moves. The schedule removes the typing,
                  not the judgement.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Missed months are caught up</dt>
                <dd className="text-muted">
                  A schedule left alone for three months produces three drafts, not one —
                  otherwise those months simply never appear in the figures.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">It cannot produce the same period twice</dt>
                <dd className="text-muted">
                  Each schedule records the last period it generated, so pressing the button
                  again does nothing until the next one falls due.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Month-ends are handled</dt>
                <dd className="text-muted">
                  A schedule set to the 31st falls on the 28th in February and returns to the
                  31st in March, rather than drifting backwards through the year.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
