import { requireCapability } from '@/lib/auth'
import { listCategories } from '@/lib/site/expenseCategories'
import { spendByCategory } from '@/lib/site/expenseReports'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import { siteQuery } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { PageHeader, PageBody, Card, CardHeader, CardBody } from '@/components/ui'
import { CategoriesClient } from './CategoriesClient'

export const dynamic = 'force-dynamic'

/**
 * Expense categories — and the seed of the chart of accounts.
 *
 * Every category carries an account code from the day it is created, so that
 * when a general ledger lands these rows become its expense section and every
 * expense already posted has somewhere to go.
 */
export default async function ExpenseCategoriesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const to = today()
  const from = addDays(to, -365)

  const [categories, spend, vatRates] = await Promise.all([
    listCategories(siteId, { includeInactive: true }),
    spendByCategory(siteId, { from, to }),
    siteQuery<{ id: number; name: string; rate: number }>(
      siteId,
      "SELECT id, name, rate FROM vat_rates WHERE vat_type = 'purchase' AND is_active = 1 ORDER BY rate DESC",
    ),
  ])

  const spendById = new Map(spend.rows.map((r) => [r.categoryId, r.total]))

  return (
    <>
      <PageHeader
        title="Expense categories"
        subtitle={`${categories.filter((c) => c.isActive).length} active`}
      />
      <PageBody>
        <CategoriesClient
          categories={categories.map((c) => ({
            id: c.id,
            accountCode: c.accountCode,
            name: c.name,
            categoryType: c.categoryType,
            categoryTypeLabel: c.categoryTypeLabel,
            defaultVatRateId: c.defaultVatRateId,
            vatClaimable: c.vatClaimable,
            isActive: c.isActive,
            sortOrder: c.sortOrder,
            yearSpend: spendById.get(c.id) ?? 0,
          }))}
          vatRates={vatRates.map((v) => ({
            id: Number(v.id),
            name: String(v.name),
            rate: toNum(v.rate),
          }))}
        />

        <Card>
          <CardHeader title="Why the account code matters" />
          <CardBody>
            <p className="text-sm text-muted">
              Each category carries an account code so that these rows can become the expense
              section of a chart of accounts later, without anyone having to go back and
              re-code historical expenses by hand. The codes follow ordinary South African
              practice — 4000&ndash;4999 for cost of sales, 5000&ndash;5999 for operating
              expenses, 6000&ndash;6999 for financial costs, 7000+ for capital items — but
              nothing enforces that and you can renumber them to match your accountant.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
