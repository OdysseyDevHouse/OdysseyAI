import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { getExpense } from '@/lib/site/expenses'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  Badge,
  ButtonLink,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { ExpenseActions } from './ExpenseActions'

export const dynamic = 'force-dynamic'

/**
 * One expense: what it was, where it went, and what it did.
 *
 * The "what it did" section is the point — a posted expense has moved money
 * somewhere, and being able to click through to the bank line or the supplier
 * account is what makes the record trustworthy rather than merely present.
 */
export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.view')
  const { id } = await params
  const expenseId = Number(id)
  if (!Number.isFinite(expenseId)) notFound()

  const expense = await getExpense(siteId, expenseId)
  if (!expense) notFound()

  const isBill = expense.paymentType === 'on_account'

  return (
    <>
      <PageHeader
        title={expense.documentNumber ?? 'Draft expense'}
        subtitle={`${expense.expenseDate} · ${expense.supplierName ?? 'No payee stated'}`}
        action={
          <div className="flex items-center gap-2">
            {expense.status === 'draft' && (
              <ButtonLink href={`/expenses/${expense.id}/edit`} variant="secondary">
                <Icons.Pencil size={15} />
                Edit
              </ButtonLink>
            )}
            <ExpenseActions
              id={expense.id}
              status={expense.status}
              documentNumber={expense.documentNumber}
            />
          </div>
        }
      />

      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          {expense.status === 'draft' && (
            <Badge tone="warning">Draft — not in any figures yet</Badge>
          )}
          {expense.status === 'void' && <Badge tone="default">Void</Badge>}
          {expense.status === 'finalised' && <Badge tone="success">Posted</Badge>}
          <Badge tone={isBill ? 'warning' : 'default'}>
            {isBill ? 'Bill on account' : 'Paid directly'}
          </Badge>
          {expense.vatClaimable < expense.vatTotal && (
            <Badge tone="warning">Some VAT not claimable</Badge>
          )}
        </div>

        <Card>
          <CardHeader title="What it was spent on" />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Category</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={TABLE_TH}>Department</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Excl</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>VAT</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {expense.lines.map((line) => (
                  <tr key={line.id} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <span className="text-ink">{line.categoryName}</span>
                      <span className="ml-2 text-xs text-muted">{line.categoryCode}</span>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{line.description ?? '—'}</span>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{line.departmentName ?? '—'}</span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(line.lineExcl)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {line.lineVat === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className={line.vatClaimable ? '' : 'text-warning-ink'}>
                          {formatMoney(line.lineVat)}
                        </span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(line.lineIncl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <CardBody>
            <div className="flex justify-end">
              <dl className="w-64 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Excluding VAT</dt>
                  <dd className="numeric text-ink-2">{formatMoney(expense.subtotalExcl)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">VAT</dt>
                  <dd className="numeric text-ink-2">{formatMoney(expense.vatTotal)}</dd>
                </div>
                {expense.vatClaimable !== expense.vatTotal && (
                  <div className="flex justify-between">
                    <dt className="text-muted">…claimable on the return</dt>
                    <dd className="numeric text-warning-ink">
                      {formatMoney(expense.vatClaimable)}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-1">
                  <dt className="font-medium text-ink">Total</dt>
                  <dd className="numeric text-lg font-semibold text-ink">
                    {formatMoney(expense.totalIncl)}
                  </dd>
                </div>
              </dl>
            </div>
          </CardBody>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Date" value={expense.expenseDate} />
                {expense.dueDate && <Row label="Due" value={expense.dueDate} />}
                <Row label="Paid to" value={expense.supplierName ?? 'Not stated'} />
                {expense.supplierInvoiceNo && (
                  <Row label="Their invoice" value={expense.supplierInvoiceNo} />
                )}
                {expense.reference && <Row label="Reference" value={expense.reference} />}
                {expense.description && <Row label="Description" value={expense.description} />}
                <Row label="Captured by" value={expense.userName} />
                {expense.recurringId && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Raised by</dt>
                    <dd>
                      <Link
                        href="/expenses/recurring"
                        className="text-brand hover:underline"
                      >
                        a recurring schedule
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
              {expense.notes && (
                <p className="mt-4 rounded-control bg-surface-2 px-3 py-2 text-sm text-ink-2">
                  {expense.notes}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What it did"
              description={
                expense.status === 'finalised'
                  ? 'Where the money was recorded.'
                  : 'Nothing yet — this is still a draft.'
              }
            />
            <CardBody>
              {expense.status !== 'finalised' ? (
                <p className="text-sm text-muted">
                  {expense.status === 'void'
                    ? 'This expense was voided. Anything it posted has been backed out.'
                    : isBill
                      ? 'When posted, this will appear on the supplier account and in the payables age analysis.'
                      : 'When posted, this will come out of the chosen account.'}
                </p>
              ) : isBill ? (
                <div className="space-y-2 text-sm">
                  <p className="text-ink-2">
                    Posted to{' '}
                    <Link
                      href={`/suppliers/${expense.supplierId}`}
                      className="text-brand hover:underline"
                    >
                      {expense.supplierName}
                    </Link>
                    &apos;s account as an invoice.
                  </p>
                  <p className="text-muted">
                    It appears in the payables age analysis and can be settled by a payment run.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 text-sm">
                  <p className="text-ink-2">
                    {formatMoney(expense.totalIncl)} came out of{' '}
                    <Link
                      href={`/cashbook/${expense.bankAccountId}`}
                      className="text-brand hover:underline"
                    >
                      {expense.bankAccountName ?? 'the account'}
                    </Link>
                    .
                  </p>
                  <p className="text-muted">
                    It will appear on the bank reconciliation for that account.
                  </p>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
