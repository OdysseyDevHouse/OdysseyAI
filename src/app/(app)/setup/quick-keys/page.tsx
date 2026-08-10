import { requireCapability } from '@/lib/auth'
import { listQuickKeys, ensureSupervisorGroup } from '@/lib/site/quickKeys'
import { siteQuery } from '@/lib/siteDb'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import QuickKeyCanvas from './QuickKeyCanvas'

export const dynamic = 'force-dynamic'

/**
 * Arranging the till's quick keys.
 *
 * ── WHY THIS LIVES IN SETUP AND NOT ON THE TILL ───────────────────────────
 *
 * It is configuration a manager does once, so it belongs beside tender types and
 * terminals — and it needs the back-office chrome the till deliberately does not have.
 * Putting a drag-and-drop designer on a full-screen touch till would also mean a cashier
 * could rearrange the bar mid-shift by holding a key half a second too long.
 *
 * ── THE NAMES ARE RESOLVED HERE ───────────────────────────────────────────
 *
 * A product key with no caption reads its product's name, so the canvas needs those
 * names — and it is a client component that cannot query. Fetched as two flat maps
 * rather than joined into each key, because a key's caption is allowed to be empty and
 * the fallback belongs in one pure function (`quickKeyLabel`) that the till uses too.
 */
export default async function QuickKeysPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  /* Created on load rather than seeded by the migration: a shop that has never opened
     this screen would otherwise have one lonely folder on an empty canvas, and the
     migration would have to know what to call it. Idempotent by signature. */
  await ensureSupervisorGroup(siteId)

  const keys = await listQuickKeys(siteId, 'main')

  /* Only the products and departments actually ON a key. The alternative — shipping the
     whole product file so the canvas can look one up — is 12 MB to label six buttons. */
  const productIds = [...new Set(keys.map((k) => k.productId).filter((id): id is number => !!id))]
  const departmentIds = [
    ...new Set(keys.map((k) => k.departmentId).filter((id): id is number => !!id)),
  ]

  const [products, departments] = await Promise.all([
    productIds.length
      ? siteQuery<{ id: number; description: string }>(
          siteId,
          `SELECT id, description FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
          productIds,
        )
      : Promise.resolve([]),
    departmentIds.length
      ? siteQuery<{ id: number; name: string }>(
          siteId,
          `SELECT id, name FROM departments WHERE id IN (${departmentIds.map(() => '?').join(',')})`,
          departmentIds,
        )
      : Promise.resolve([]),
  ])

  const productNames = Object.fromEntries(products.map((p) => [p.id, p.description]))
  const departmentNames = Object.fromEntries(departments.map((d) => [d.id, d.name]))

  return (
    <>
      <PageHeader
        title="Quick keys"
        subtitle="The buttons on the till, arranged the way this shop works"
      />

      <PageBody>
        <Callout tone="neutral" title="What a cashier sees">
          These appear on the till’s catalogue pane. A key can add a product, open a
          department, or do something — take a payment, print a bill, cash up. Group the
          ones that belong together: a folder of eight reads faster than sixty in a row.
        </Callout>

        <QuickKeyCanvas
          initialKeys={keys}
          productNames={productNames}
          departmentNames={departmentNames}
        />
      </PageBody>
    </>
  )
}
