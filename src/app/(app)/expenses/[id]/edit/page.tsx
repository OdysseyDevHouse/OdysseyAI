import { notFound, redirect } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getExpense } from '@/lib/site/expenses'
import { listCategories } from '@/lib/site/expenseCategories'
import { listSuppliers } from '@/lib/site/suppliers'
import { listAccounts } from '@/lib/site/bankAccounts'
import { listDepartments } from '@/lib/site/departments'
import { siteQueryOne } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { PageHeader, PageBody } from '@/components/ui'
import { ExpenseForm } from '../../ExpenseForm'

export const dynamic = 'force-dynamic'

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.edit')
  const { id } = await params
  const expenseId = Number(id)
  if (!Number.isFinite(expenseId)) notFound()

  const expense = await getExpense(siteId, expenseId)
  if (!expense) notFound()

  // A posted expense is a record of something that happened. Correcting it
  // means voiding and recapturing, so there is a trail of both.
  if (expense.status !== 'draft') redirect(`/expenses/${expenseId}`)

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

  return (
    <>
      <PageHeader title="Edit draft expense" subtitle={expense.expenseDate} />
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
          existing={{
            id: expense.id,
            expenseDate: expense.expenseDate,
            paymentType: expense.paymentType,
            supplierId: expense.supplierId,
            supplierName: expense.supplierName ?? '',
            supplierInvoiceNo: expense.supplierInvoiceNo ?? '',
            bankAccountId: expense.bankAccountId,
            reference: expense.reference ?? '',
            description: expense.description ?? '',
            notes: expense.notes ?? '',
            lines: expense.lines.map((l) => ({
              key: `line-${l.id}`,
              categoryId: l.categoryId,
              description: l.description ?? '',
              departmentId: l.departmentId,
              amountIncl: l.lineIncl,
              vatRatePct: l.vatRatePct,
            })),
          }}
        />
      </PageBody>
    </>
  )
}
