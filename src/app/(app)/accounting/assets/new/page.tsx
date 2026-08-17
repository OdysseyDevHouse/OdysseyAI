import { requireModuleCapability } from '@/lib/auth'
import { listCategories } from '@/lib/site/fixedAssets'
import { getExpense } from '@/lib/site/expenses'
import { PageHeader, PageBody, Card, CardBody, EmptyState } from '@/components/ui'
import { AssetForm } from '../AssetForm'

export const dynamic = 'force-dynamic'

export default async function NewAssetPage({
  searchParams,
}: {
  searchParams: Promise<{ expense?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'setup.edit')
  const params = await searchParams

  const categories = await listCategories(siteId)

  // Arriving from a capital expense: the cost and date come from the invoice
  // rather than being re-keyed, and the asset links back to it for an auditor.
  const expenseId = Number(params.expense)
  const expense = Number.isFinite(expenseId) ? await getExpense(siteId, expenseId) : null

  const fromExpense =
    expense && expense.status === 'finalised'
      ? {
          cost: expense.subtotalExcl,
          acquiredOn: expense.expenseDate,
          description: expense.description ?? expense.lines[0]?.description ?? '',
          supplierName: expense.supplierName,
        }
      : undefined

  if (categories.length === 0) {
    return (
      <>
        <PageHeader title="Add an asset" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="No asset categories"
                hint="Categories decide the default life and which ledger accounts an asset posts to. They are seeded with the system — if this is empty, the fixed assets migration has not run."
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Add an asset"
        subtitle="Something the business owns and uses, rather than sells"
      />
      <PageBody>
        <AssetForm
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            defaultLifeMonths: c.defaultLifeMonths,
            defaultResidualPct: c.defaultResidualPct,
          }))}
          fromExpense={fromExpense}
        />
      </PageBody>
    </>
  )
}
