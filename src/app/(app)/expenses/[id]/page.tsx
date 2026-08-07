import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getExpense } from '@/lib/site/expenses'
import { siteQueryOne } from '@/lib/siteDb'
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
  TextLink,
  SettingRow,
  SettingGroup,
  SummaryList,
  SummaryRow,
  SummaryTotal,
} from '@/components/ui'
import { ExpenseActions } from './ExpenseActions'
import { ExpenseLinesTable } from './ExpenseLinesTable'
import { listAttachments } from '@/lib/site/attachments'
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel'
import { can } from '@/lib/site/permissions'

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
  const { siteId, capabilities } = await requireCapability('cashbook.view')
  const { id } = await params
  const expenseId = Number(id)
  if (!Number.isFinite(expenseId)) notFound()

  const expense = await getExpense(siteId, expenseId)
  if (!expense) notFound()

  const attachments = await listAttachments(siteId, 'expense', expenseId)

  const isBill = expense.paymentType === 'on_account'

  // Whether any line is capital, and whether the asset already exists. Two
  // small lookups rather than widening the expense type: this is the only
  // screen that asks, and the asset register is the thing that knows.
  const [capitalCheck, assetCheck] = await Promise.all([
    siteQueryOne<{ n: number }>(
      siteId,
      `SELECT COUNT(*) AS n FROM expense_lines l
         JOIN expense_categories c ON c.id = l.category_id
        WHERE l.expense_id = ? AND c.category_type = 'capital'`,
      [expense.id],
    ).catch(() => null),
    siteQueryOne<{ id: number }>(
      siteId,
      'SELECT id FROM fixed_assets WHERE expense_id = ? LIMIT 1',
      [expense.id],
    ).catch(() => null),
  ])

  const isCapital = Number(capitalCheck?.n ?? 0) > 0
  const assetExists = assetCheck !== null

  // The one status badge, placed with the header where the record is named.
  const statusBadge =
    expense.status === 'draft' ? (
      <Badge tone="warning">Draft — not in any figures yet</Badge>
    ) : expense.status === 'void' ? (
      <Badge tone="default">Void</Badge>
    ) : (
      <Badge tone="success">Posted</Badge>
    )

  return (
    <>
      <PageHeader
        title={expense.documentNumber ?? 'Draft expense'}
        subtitle={`${expense.expenseDate} · ${expense.supplierName ?? 'No payee stated'}`}
        action={
          <div className="flex items-center gap-2">
            {statusBadge}
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
        {/* Capital spending is on the balance sheet but depreciates nothing
            until the thing itself is on the asset register. Nowhere else will
            prompt for this, so the expense that created it does. */}
        {isCapital && !assetExists && expense.status === 'finalised' && (
          <Card>
            <CardHeader
              title="This is a capital purchase"
              description="It is on the balance sheet as an asset, but nothing is depreciating it. Record it on the fixed asset register so it becomes a cost over the years it is used."
              action={
                <ButtonLink href={`/accounting/assets/new?expense=${expense.id}`} size="sm">
                  <Icons.Plus size={15} />
                  Record as an asset
                </ButtonLink>
              }
            />
          </Card>
        )}

        {isCapital && assetExists && (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">
                This capital purchase is on the{' '}
                <TextLink href="/accounting/assets">fixed asset register</TextLink> and
                depreciating.
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="What it was spent on" />
          <ExpenseLinesTable rows={expense.lines} />

          <CardBody>
            <div className="flex justify-end">
              <SummaryList className="w-64">
                <SummaryRow label="Excluding VAT" value={formatMoney(expense.subtotalExcl)} />
                <SummaryRow label="VAT" value={formatMoney(expense.vatTotal)} />
                {expense.vatClaimable !== expense.vatTotal && (
                  <SummaryRow
                    label="…claimable on the return"
                    value={formatMoney(expense.vatClaimable)}
                    tone="warning"
                  />
                )}
                <SummaryTotal label="Total" value={formatMoney(expense.totalIncl)} />
              </SummaryList>
            </div>
          </CardBody>
        </Card>

        <div className="grid items-start gap-5 lg:grid-cols-2">
          <SettingGroup title="Details">
            <SettingRow label="Date">
              <span className="text-sm text-ink-2">{expense.expenseDate}</span>
            </SettingRow>
            {expense.dueDate && (
              <SettingRow label="Due">
                <span className="text-sm text-ink-2">{expense.dueDate}</span>
              </SettingRow>
            )}
            <SettingRow label="Paid to">
              <span className="text-sm text-ink-2">{expense.supplierName ?? 'Not stated'}</span>
            </SettingRow>
            <SettingRow
              label="Kind"
              description={
                isBill ? 'Owed on the supplier account.' : 'Paid straight from an account.'
              }
            >
              <span className="text-sm text-ink-2">{isBill ? 'Bill on account' : 'Paid directly'}</span>
            </SettingRow>
            {expense.supplierInvoiceNo && (
              <SettingRow label="Their invoice">
                <span className="text-sm text-ink-2">{expense.supplierInvoiceNo}</span>
              </SettingRow>
            )}
            {expense.reference && (
              <SettingRow label="Reference">
                <span className="text-sm text-ink-2">{expense.reference}</span>
              </SettingRow>
            )}
            {expense.description && (
              <SettingRow label="Description">
                <span className="text-sm text-ink-2">{expense.description}</span>
              </SettingRow>
            )}
            <SettingRow label="Captured by">
              <span className="text-sm text-ink-2">{expense.userName}</span>
            </SettingRow>
            {expense.recurringId && (
              <SettingRow label="Raised by">
                <TextLink href="/expenses/recurring" className="text-sm">
                  a recurring schedule
                </TextLink>
              </SettingRow>
            )}
            {expense.notes && (
              <SettingRow label="Notes" description={expense.notes}>
                <span />
              </SettingRow>
            )}
          </SettingGroup>

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
                    <TextLink href={`/suppliers/${expense.supplierId}`}>
                      {expense.supplierName}
                    </TextLink>
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
                    <TextLink href={`/cashbook/${expense.bankAccountId}`}>
                      {expense.bankAccountName ?? 'the account'}
                    </TextLink>
                    .
                  </p>
                  <p className="text-muted">
                    It will appear on the bank reconciliation for that account.
                  </p>
                </div>
              )}
            </CardBody>
          </Card>

          {/* The receipt. This is what an auditor asks for when they query a
              VAT input claim, and without it the answer is someone walking to
              a filing cabinet. */}
          <Card>
            <CardHeader
              title="Receipt"
              description="The slip or bill this expense was captured from."
            />
            <CardBody>
              <AttachmentsPanel
                entity="expense"
                entityId={expenseId}
                canEdit={can(capabilities, 'cashbook.edit')}
                hint="Attach the receipt or supplier bill. It is the support for this expense — and for the VAT claimed on it."
                attachments={attachments.map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  description: a.description,
                  sizeBytes: a.sizeBytes,
                  uploadedName: a.uploadedName,
                  createdAt: a.createdAt.toISOString(),
                }))}
              />
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  )
}
