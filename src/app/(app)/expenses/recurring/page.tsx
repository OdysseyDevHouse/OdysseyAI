import { requireCapability } from '@/lib/auth'
import { listRecurring } from '@/lib/site/recurringExpenses'
import { listCategories } from '@/lib/site/expenseCategories'
import { listSuppliers } from '@/lib/site/suppliers'
import { listAccounts } from '@/lib/site/bankAccounts'
import { siteQuery, siteQueryOne } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { RecurringClient } from './RecurringClient'

export const dynamic = 'force-dynamic'

/**
 * Recurring expenses — the ones that arrive every month.
 *
 * The month somebody forgets to capture rent, the P&L is simply wrong and
 * nothing reports it. A schedule removes the typing; it deliberately does not
 * remove the judgement, so it produces drafts for review rather than postings.
 *
 * The header and layout live in RecurringClient, because the screen's primary
 * action — New schedule — opens a modal only a Client Component can hold.
 */
export default async function RecurringExpensesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.edit')

  const [schedules, categories, suppliers, accounts, defaultRate, firstLines] = await Promise.all([
    listRecurring(siteId, { includeInactive: true }),
    listCategories(siteId),
    listSuppliers(siteId, { statuses: ['active'], limit: 500 }),
    listAccounts(siteId),
    siteQueryOne<{ rate: number }>(
      siteId,
      "SELECT rate FROM vat_rates WHERE vat_type = 'purchase' AND is_default = 1 LIMIT 1",
    ),
    // listRecurring does not load lines, but the edit modal needs each
    // schedule's category — without it, saving an edit silently rewrote the
    // category to the first in the list. One query covers every schedule.
    siteQuery<{ recurring_id: number; category_id: number }>(
      siteId,
      `SELECT recurring_id, category_id FROM recurring_expense_lines
        ORDER BY recurring_id, line_number`,
    ),
  ])

  const categoryBySchedule = new Map<number, number>()
  for (const line of firstLines) {
    const recurringId = Number(line.recurring_id)
    if (!categoryBySchedule.has(recurringId)) {
      categoryBySchedule.set(recurringId, Number(line.category_id))
    }
  }

  return (
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
        categoryId: categoryBySchedule.get(s.id) ?? null,
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
  )
}
