import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getContract } from '@/lib/site/contracts'
import { listCustomers } from '@/lib/site/customers'
import { searchProductsForPicker } from '@/lib/site/products'
import { canTakePayments } from '@/lib/site/payments'
import { siteQueryOne } from '@/lib/siteDb'
import { isConfigured as mailConfigured } from '@/lib/mail'
import { toNum } from '@/lib/decimals'
import { ContractForm } from '../../ContractForm'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

/**
 * Editing a contract.
 *
 * Editing changes what WILL be billed, never what already was: the invoices it
 * has raised are posted tax documents and are not touched. A price changed here
 * applies from the next billing date onward.
 */
export default async function EditContractPage({ params }: Props) {
  const { siteId, capabilities } = await requireCapability('contracts.edit')

  const { id } = await params
  const contractId = Number(id)
  if (!Number.isFinite(contractId) || contractId <= 0) notFound()

  const contract = await getContract(siteId, contractId)
  if (!contract) notFound()

  const [customers, products, defaultVat, paymentsOn] = await Promise.all([
    listCustomers(siteId, { statuses: ['active'], limit: 500 }),
    searchProductsForPicker(siteId, { limit: 50 }),
    siteQueryOne<{ rate: number }>(
      siteId,
      "SELECT rate FROM vat_rates WHERE vat_type = 'sales' AND is_default = 1 LIMIT 1",
    ),
    canTakePayments(siteId),
  ])

  return (
    <ContractForm
      initial={{
        id: contract.id,
        name: contract.name,
        customerId: contract.customerId,
        frequency: contract.frequency,
        billingDay: contract.billingDay,
        startsOn: contract.startsOn,
        endsOn: contract.endsOn ?? '',
        escalationPct: contract.escalationPct,
        escalationMonth: contract.escalationMonth,
        autoSend: contract.autoSend,
        offerPaymentLink: contract.offerPaymentLink,
        paymentTermsDays: contract.paymentTermsDays,
        reference: contract.reference ?? '',
        notes: contract.notes ?? '',
        internalNote: contract.internalNote ?? '',
        lines: contract.lines.map((l) => ({
          productId: l.productId,
          productCode: l.productCode,
          description: l.description,
          qty: l.qty,
          unitPriceIncl: l.unitPriceIncl,
          vatRatePct: l.vatRatePct,
          departmentId: l.departmentId,
        })),
      }}
      customers={customers.items.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        email: c.email,
        status: c.status,
      }))}
      products={products.map((p) => ({
        id: p.id,
        code: p.code,
        description: p.description,
        sellingIncl: p.sellingIncl,
        departmentId: p.departmentId,
      }))}
      defaultVatRate={toNum(defaultVat?.rate, 15)}
      canAutoSend={can(capabilities, 'contracts.auto_send')}
      paymentsConfigured={paymentsOn}
      emailConfigured={mailConfigured()}
    />
  )
}
