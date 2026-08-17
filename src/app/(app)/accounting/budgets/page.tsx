import { requireModuleCapability } from '@/lib/auth'
import { budgetGrid } from '@/lib/site/budgets'
import { today } from '@/lib/site/ledger'
import { PageHeader, PageBody } from '@/components/ui'
import { BudgetGrid } from './BudgetGrid'

export const dynamic = 'force-dynamic'

/**
 * Budgets — what each account is expected to do, month by month.
 *
 * The grid is the whole screen: every postable income and expense account
 * against twelve months. The comparison against what actually happened lives
 * on the income statement, where the actuals are.
 */
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')
  const params = await searchParams

  const currentYear = Number(today().slice(0, 4))
  const parsed = Number(params.year)
  // A year wildly outside trading history is a typo, not a plan.
  const year =
    Number.isInteger(parsed) && parsed >= currentYear - 10 && parsed <= currentYear + 5
      ? parsed
      : currentYear

  const grid = await budgetGrid(siteId, year)

  return (
    <>
      <PageHeader
        title="Budgets"
        subtitle={`What each account is expected to do in ${year}, month by month.`}
      />
      <PageBody>
        <BudgetGrid grid={grid} currentYear={currentYear} />
      </PageBody>
    </>
  )
}
