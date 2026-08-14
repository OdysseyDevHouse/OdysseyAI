import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { customerAccount, customerStatement } from '@/lib/site/customerAuth'
import { getCustomerSession } from '@/lib/customerSession'
import { Badge, Card, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { PayInvoiceButton } from './StatementClient'

/**
 * The shopper's own statement: what they owe, invoice by invoice, with a Pay
 * button on each open one. Payment rides the same debtor_invoice rails as an
 * emailed pay link, so the money lands and allocates exactly as if the shop
 * had sent one.
 */

export const dynamic = 'force-dynamic'

export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ all?: string }>
}) {
  const { token } = await params
  const { all } = await searchParams

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context || !context.settings.allowAccount) notFound()

  const session = await getCustomerSession(siteId)
  if (!session) redirect(`/store/${token}/account`)

  const showAll = all === '1'
  const [account, lines] = await Promise.all([
    customerAccount(siteId, session.customerId),
    customerStatement(siteId, session.customerId, { openOnly: !showAll, limit: 200 }),
  ])
  if (!account) redirect(`/store/${token}/account`)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Your statement</h1>
          <p className="mt-0.5 text-sm text-muted">
            Balance{' '}
            <span className="numeric font-semibold text-ink">
              {formatMoney(account.position.balance)}
            </span>
          </p>
        </div>
        <a
          href={`/store/${token}/account/statement/pdf`}
          className="text-sm text-brand hover:underline"
        >
          Download statement (PDF)
        </a>
      </div>

      <div className="flex gap-3 text-sm">
        <Link
          href={`/store/${token}/account/statement`}
          className={showAll ? 'text-brand hover:underline' : 'font-semibold text-ink'}
        >
          Still owing
        </Link>
        <Link
          href={`/store/${token}/account/statement?all=1`}
          className={showAll ? 'font-semibold text-ink' : 'text-brand hover:underline'}
        >
          Everything
        </Link>
      </div>

      {lines.length === 0 ? (
        <EmptyState
          icon={<Icons.Receipt size={22} />}
          title={showAll ? 'Nothing on the account yet' : 'Nothing owing'}
          hint={showAll ? 'Invoices and payments will show up here.' : 'Every invoice is settled.'}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {lines.map((line) => (
              <li key={line.transactionId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="numeric block text-sm font-medium text-ink">
                    {line.docNumber || line.description}
                  </span>
                  <span className="block text-xs text-muted">
                    {line.docDate}
                    {line.dueDate ? ` · due ${line.dueDate}` : ''} ·{' '}
                    {DOC_LABEL[line.docType] ?? line.docType}
                  </span>
                </span>
                {line.amountOutstanding > 0.005 && <Badge tone="warning">Open</Badge>}
                <span className="numeric text-sm font-medium text-ink">
                  {formatMoney(line.amountSigned)}
                </span>
                {line.docType === 'invoice' && line.sourceDocId && (
                  <a
                    href={`/store/${token}/account/invoice/${line.sourceDocId}`}
                    className="text-xs text-brand hover:underline"
                  >
                    PDF
                  </a>
                )}
                {line.docType === 'invoice' &&
                  line.amountOutstanding > 0.005 &&
                  line.sourceDocId && (
                    <PayInvoiceButton
                      token={token}
                      transactionId={line.transactionId}
                      amount={line.amountOutstanding}
                    />
                  )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Link href={`/store/${token}/account`} className="text-sm text-brand hover:underline">
        ← Back to your account
      </Link>
    </div>
  )
}

const DOC_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  interest: 'Interest',
  write_off: 'Write-off',
  opening: 'Opening balance',
}
