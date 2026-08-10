import { requireCapability } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { listDepartments } from '@/lib/site/departments'
import { listSuppliers } from '@/lib/site/suppliers'
import { PageHeader, PageBody } from '@/components/ui'
import NewStockTakeScreen from './NewStockTakeScreen'

export const dynamic = 'force-dynamic'

export default async function NewStockTakePage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('stock.adjust')

  const [locations, departments, suppliers] = await Promise.all([
    listLocations(siteId, false),
    listDepartments(siteId),
    listSuppliers(siteId, { limit: 500 }),
  ])

  return (
    <>
      <PageHeader
        title="New stock take"
        subtitle="Choose what to count. The sheet records what the system believes right now, so you have something to count against."
        backHref="/stock-takes"
        backLabel="Stock takes"
      />
      <PageBody>
        {/* Only plain data crosses to the client screen — functions cannot. */}
        <NewStockTakeScreen
          locations={locations.map((l) => ({ id: l.id, code: l.code, name: l.name }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          suppliers={suppliers.items.map((s) => ({ id: s.id, name: s.name }))}
        />
      </PageBody>
    </>
  )
}
