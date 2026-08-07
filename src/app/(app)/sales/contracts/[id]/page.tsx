import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getContract, contractInvoices } from '@/lib/site/contracts'
import { isConfigured as mailConfigured } from '@/lib/mail'
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Icons,
  PageBody,
  PageHeader,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  TextLink,
  TABLE_HEAD_ROW,
  TABLE_TD,
  TABLE_TH,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { CONTRACT_STATE_LABELS, MONTH_NAMES } from '@/lib/contractModel'
import { ContractActions } from './ContractActions'
import { InvoiceHistory } from './InvoiceHistory'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

/**
 * One contract.
 *
 * Answers, in order: what does this bill and to whom, what is it going to do
 * next, and what has it actually done. The last of those is the one people come
 * back for — "did March go out, and did they get it".
 */
export default async function ContractDetailPage({ params }: Props) {
  const { siteId, capabilities } = await requireCapability('contracts.view')

  const { id } = await params
  const contractId = Number(id)
  if (!Number.isFinite(contractId) || contractId <= 0) notFound()

  const [contract, history] = await Promise.all([
    getContract(siteId, contractId),
    contractInvoices(siteId, contractId),
  ])
  if (!contract) notFound()

  const canEdit = can(capabilities, 'contracts.edit')
  const billedToDate = history
    .filter((h) => h.status === 'posted')
    .reduce((sum, h) => sum + h.totalIncl, 0)

  return (
    <>
      <PageHeader
        title={contract.name}
        // PageHeader's subtitle is a plain string by design, so the state
        // badges live in the body rather than being smuggled in as JSX.
        subtitle={[
          contract.contractNumber,
          contract.customerName,
          `${contract.frequencyLabel.toLowerCase()} on day ${contract.billingDay}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        action={
          canEdit ? (
            <div className="flex gap-2">
              <ButtonLink variant="secondary" href={`/sales/contracts/${contract.id}/edit`}>
                <Icons.Pencil size={15} />
                Edit
              </ButtonLink>
              <ContractActions
                contractId={contract.id}
                name={contract.name}
                isActive={contract.isActive}
                autoSend={contract.autoSend}
                due={contract.due}
                canAutoSend={can(capabilities, 'contracts.auto_send')}
              />
            </div>
          ) : null
        }
      />

      <PageBody>
        {!mailConfigured() && contract.autoSend ? (
          <Card>
            <CardBody>
              <p className="text-sm text-warning">
                This contract is set to send itself, but email is not configured on
                this system — invoices will be raised and posted, and will wait to be
                sent by hand.
              </p>
            </CardBody>
          </Card>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-3">
          {/* ── What it bills ──────────────────────────────────────────── */}
          <Card className="lg:col-span-2">
            <CardHeader
              title="What is billed"
              description={`${contract.frequencyLabel.toLowerCase()} on day ${contract.billingDay}`}
            />
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Description</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Qty</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Unit price</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contract.lines.map((line) => (
                      <tr key={line.id} className="border-b border-border last:border-0">
                        <td className={TABLE_TD}>
                          <span className="text-ink-2">{line.description}</span>
                          {line.productCode ? (
                            <span className="mt-0.5 block text-xs text-muted">
                              {line.productCode}
                              {/* The original price, when escalation has moved it.
                                  Proof of what was agreed, which is what a customer
                                  disputes. */}
                              {line.unitPriceIncl !== line.basePriceIncl
                                ? ` · originally ${formatMoney(line.basePriceIncl)}`
                                : ''}
                            </span>
                          ) : null}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric text-ink-2`}>
                          {trim(line.qty)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric text-ink-2`}>
                          {formatMoney(line.unitPriceIncl)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric text-ink`}>
                          {formatMoney(line.lineTotalIncl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-baseline justify-end gap-6 border-t border-border pt-4">
                <span className="text-sm text-muted">Per invoice</span>
                <span className="numeric text-xl font-semibold text-ink">
                  {formatMoney(contract.totalIncl)}
                </span>
              </div>
            </CardBody>
          </Card>

          {/* ── The agreement ──────────────────────────────────────────── */}
          <Card>
            <CardHeader title="The agreement" />
            <CardBody>
              {/* State lives here rather than in the header, where PageHeader
                  takes a plain string. It is also the first thing anyone opening
                  a contract wants to know. */}
              <div className="mb-4 flex flex-wrap gap-2">
                <Badge
                  tone={
                    contract.due
                      ? 'warning'
                      : contract.state === 'active'
                        ? 'success'
                        : contract.state === 'paused'
                          ? 'warning'
                          : 'default'
                  }
                >
                  {contract.due ? 'Due to bill' : CONTRACT_STATE_LABELS[contract.state]}
                </Badge>
                {contract.autoSend ? (
                  <Badge tone="success">Sends automatically</Badge>
                ) : (
                  <Badge tone="default">Review before sending</Badge>
                )}
              </div>

              <SummaryList>
                <SummaryRow
                  label="Customer"
                  value={
                    <TextLink href={`/customers/${contract.customerId}`}>
                      {contract.customerName ?? '—'}
                    </TextLink>
                  }
                />
                <SummaryRow
                  label="Runs"
                  value={`${contract.startsOn}${contract.endsOn ? ` to ${contract.endsOn}` : ' until cancelled'}`}
                />
                <SummaryRow label="Next invoice" value={contract.nextDue ?? '—'} />
                <SummaryRow
                  label="Escalation"
                  value={
                    contract.escalationPct > 0 && contract.escalationMonth
                      ? `${trim(contract.escalationPct)}% every ${MONTH_NAMES[contract.escalationMonth - 1]}`
                      : 'None'
                  }
                />
                {contract.escalation ? (
                  <SummaryRow
                    label="Next increase"
                    tone="warning"
                    value={`${contract.escalation.on} · ${formatMoney(contract.escalation.from)} → ${formatMoney(contract.escalation.to)}`}
                  />
                ) : null}
                <SummaryRow
                  label="Payment terms"
                  value={
                    contract.paymentTermsDays === 0
                      ? 'Cash on delivery'
                      : `${contract.paymentTermsDays} days`
                  }
                />
                {contract.reference ? (
                  <SummaryRow label="Their reference" value={contract.reference} />
                ) : null}
                <SummaryTotal label="Value a year" value={formatMoney(contract.annualValue)} />
              </SummaryList>

              {contract.internalNote ? (
                <p className="mt-4 rounded-control bg-surface-2 px-3 py-2 text-xs text-muted">
                  {contract.internalNote}
                </p>
              ) : null}
            </CardBody>
          </Card>
        </div>

        {/* ── What it has done ───────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Billing history"
            // "R0.00 posted" reads as a fault when in fact nothing has been
            // released yet. Say which it is.
            description={
              history.length === 0
                ? 'Nothing has been billed yet.'
                : billedToDate > 0
                  ? `${history.length} period${history.length === 1 ? '' : 's'} · ${formatMoney(billedToDate)} posted to the account`
                  : `${history.length} period${history.length === 1 ? '' : 's'} raised, none posted yet — release one with Post.`
            }
          />
          <InvoiceHistory
            contractId={contract.id}
            customerId={contract.customerId}
            rows={history}
            canAct={canEdit}
            emailConfigured={mailConfigured()}
          />
        </Card>
      </PageBody>
    </>
  )
}

/** 2 rather than 2.000 — a quantity reads as a count. */
function trim(value: number): string {
  return String(Number(value.toFixed(3)))
}
