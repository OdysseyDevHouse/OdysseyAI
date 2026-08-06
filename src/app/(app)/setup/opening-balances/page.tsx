import { requireCapability } from '@/lib/auth'
import { customerSummary } from '@/lib/site/customers'
import { supplierSummary } from '@/lib/site/suppliers'
import { PageHeader, PageBody } from '@/components/ui'
import ImportClient from './ImportClient'

export const dynamic = 'force-dynamic'

export default async function OpeningBalancesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [customers, suppliers] = await Promise.all([
    customerSummary(siteId),
    supplierSummary(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Opening balances"
        subtitle="Carry in what is already owed on the day you switch over"
        backHref="/setup/style-guide"
        backLabel="Setup"
      />

      <PageBody>
        <ImportClient
          customerCount={customers.total}
          supplierCount={suppliers.total}
          customerOwing={customers.totalOwed}
          supplierOwing={suppliers.totalOwed}
        />
      </PageBody>
    </>
  )
}
