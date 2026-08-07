import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listCustomers } from '@/lib/site/customers'
import { searchProductsForPicker } from '@/lib/site/products'
import { canTakePayments } from '@/lib/site/payments'
import { siteQueryOne } from '@/lib/siteDb'
import { isConfigured as mailConfigured } from '@/lib/mail'
import { toNum } from '@/lib/decimals'
import { ContractForm } from '../ContractForm'
import { todayIso } from '@/lib/site/salesDocuments'

export const dynamic = 'force-dynamic'

/**
 * A new contract.
 *
 * Customers and products are loaded here rather than fetched per keystroke: a
 * contract has a handful of lines, chosen once, and a type-ahead round trip per
 * character would be slower and more fragile than filtering a list the page
 * already has. The picker filters client-side over these.
 */
export default async function NewContractPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('contracts.edit')

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
        name: '',
        customerId: 0,
        frequency: 'monthly',
        billingDay: 1,
        startsOn: todayIso(),
        endsOn: '',
        escalationPct: 0,
        escalationMonth: null,
        // OFF by default, deliberately — a contract earns automation after
        // somebody has watched it produce one correct invoice. See 061.
        autoSend: false,
        offerPaymentLink: paymentsOn,
        paymentTermsDays: 30,
        reference: '',
        notes: '',
        internalNote: '',
        lines: [],
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
