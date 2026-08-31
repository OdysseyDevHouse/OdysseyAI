import { requireCapability } from '@/lib/auth'
import { listQuickKeys, ensureSupervisorGroup } from '@/lib/site/quickKeys'
import { listTerminals } from '@/lib/site/terminals'
import { listDepartments } from '@/lib/site/departments'
import { siteQuery } from '@/lib/siteDb'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import QuickKeyCanvas from './QuickKeyCanvas'

export const dynamic = 'force-dynamic'

/**
 * Arranging the till's quick keys.
 *
 * ── WHY THIS IS NOT ON THE TILL ───────────────────────────────────────────
 *
 * It needs the back-office chrome the till deliberately does not have. Putting a
 * drag-and-drop designer on a full-screen touch till would also mean a cashier could
 * rearrange the bar mid-shift by holding a key half a second too long.
 *
 * ── WHY IT IS REACHED FROM SETUP ──────────────────────────────────────────
 *
 * It spent a while as a menu row under Sales, directly below Point of sale, on the
 * argument that a quick key is changed BECAUSE of what happened at the till — a line
 * rung up twenty times a day that sits three taps deep — and so belongs to the same
 * visit as serving. The flaw was the capability: this screen needs `setup.edit`, and
 * most of the people standing at a till do not have it, so the row was a permanent
 * tease to exactly the audience the placement was arguing for.
 *
 * It is a setup hub tile again, in Store & stock beside Tills and Rotating menus —
 * the other two screens that decide what a till SHOWS rather than what it sells, so
 * one visit finds any of them. The trail reads "Setup › Quick keys", resolved by
 * `hubFor` on the /setup prefix now that the menu no longer names it.
 *
 * The ROUTE has never moved, so no existing link breaks. The capability stays
 * `setup.edit` for the reason it always was: arranging what every till shows is a
 * manager's decision, whoever else may serve on one.
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

  /*
   * Both bars, in one payload.
   *
   * The 'tables' section has existed in the ENUM since the table was created and
   * nothing has ever written to it — every call site passed 'main'. A restaurant till
   * needs its own bar, because the keys that matter with a table open (print the bill,
   * move it, split it) are not the ones that matter at a counter.
   *
   * Fetched together rather than per-tab so switching tabs is instant and the canvas
   * holds one list: every action already returns the whole section, and a tab that
   * had to round-trip before drawing would feel like a page load.
   */
  const [mainKeys, tableKeys, terminals, allDepartments] = await Promise.all([
    listQuickKeys(siteId, 'main'),
    listQuickKeys(siteId, 'tables'),
    listTerminals(siteId, false),
    listDepartments(siteId),
  ])

  /* A retail shop is never shown the tables bar — it has no tables, so a second tab
     would be a permanently empty screen inviting somebody to fill it.

     Asked of the TILLS rather than of a shop setting: the mode is per register
     now, so a merchant with three retail lanes and one restaurant counter still
     arranges that counter's bar here. One till running tables is enough. */
  const hospitality = terminals.some((t) => t.posMode === 'hospitality')
  const keys = hospitality ? [...mainKeys, ...tableKeys] : mainKeys

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

  /* The whole tree, narrowed on the way out exactly as the till's page narrows it: an
     id, a parent, a name and an order. `color` and the image ids are deliberately left
     behind — a tile painting itself from a stored hex puts a raw colour in a component,
     and tile colour comes from `toneForId` on both screens.

     Shipped with the page rather than fetched when the Depts tab is opened. A shop has
     a few dozen departments, they change about never, and the library's drill reads
     better when the first tap draws instantly instead of after a round trip. */
  const departmentTree = allDepartments.map((d) => ({
    id: d.id,
    parentId: d.parentId,
    name: d.name,
    sortOrder: d.sortOrder,
  }))
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
          departmentTree={departmentTree}
          hospitality={hospitality}
        />
      </PageBody>
    </>
  )
}
