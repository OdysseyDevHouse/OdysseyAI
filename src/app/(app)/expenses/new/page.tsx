import { requireCapability } from '@/lib/auth'
import { listCategories } from '@/lib/site/expenseCategories'
import { listSuppliers } from '@/lib/site/suppliers'
import { listAccounts } from '@/lib/site/bankAccounts'
import { listDepartments } from '@/lib/site/departments'
import { siteQueryOne } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { PageHeader, PageBody, Card, CardBody, EmptyState, ButtonLink, Icons } from '@/components/ui'
import { ExpenseForm } from '../ExpenseForm'

export const dynamic = 'force-dynamic'

export default async function NewExpensePage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.edit')

  const [categories, suppliers, accounts, departments, defaultRate] = await Promise.all([
    listCategories(siteId),
    listSuppliers(siteId, { statuses: ['active'], limit: 500 }),
    listAccounts(siteId),
    listDepartments(siteId).catch(() => []),
    siteQueryOne<{ rate: number }>(
      siteId,
      "SELECT rate FROM vat_rates WHERE vat_type = 'purchase' AND is_default = 1 LIMIT 1",
    ),
  ])

  if (categories.length === 0 || accounts.length === 0) {
    return (
      <>
        <PageHeader title="Capture an expense" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title={categories.length === 0 ? 'No expense categories' : 'No accounts to pay from'}
                hint={
                  categories.length === 0
                    ? 'Expense categories say where the money went. Set them up first.'
                    : 'Add the bank or cash account the money comes out of.'
                }
                action={
                  <ButtonLink
                    href={categories.length === 0 ? '/setup/expense-categories' : '/cashbook/new'}
                  >
                    <Icons.Plus size={15} />
                    {categories.length === 0 ? 'Set up categories' : 'Add an account'}
                  </ButtonLink>
                }
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
        title="Capture an expense"
        subtitle="Anything the business spends that is not stock"
      />
      <PageBody>
        <ExpenseForm
          categories={categories.map((c) => ({
            id: c.id,
            accountCode: c.accountCode,
            name: c.name,
            categoryType: c.categoryType,
            vatClaimable: c.vatClaimable,
            defaultVatRatePct: c.defaultVatRatePct,
          }))}
          suppliers={suppliers.items.map((s) => ({ id: s.id, name: s.name, code: s.code }))}
          bankAccounts={accounts.map((a) => ({ id: a.id, name: a.name, code: a.code }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          defaultVatRate={toNum(defaultRate?.rate, 15)}
        />
      </PageBody>
    </>
  )
}
