import { requireCapability } from '@/lib/auth'
import { loadMenu } from '@/lib/site/menuDesigner'
import { Callout, PageBody, PageHeader } from '@/components/ui'
import { MenuDesigner } from './MenuDesigner'

export const dynamic = 'force-dynamic'

/**
 * The menu designer — the till's browse menu, arranged by dragging it.
 *
 * ── WHY THIS IS NOT ON THE TILL ────────────────────────────────────────────
 *
 * It needs the back-office chrome a full-screen touch till deliberately does
 * not have. Putting a drag-and-drop designer on the till would also let a
 * cashier rearrange the menu mid-shift by holding a tile half a second too
 * long.
 *
 * ── WHY IT IS REACHED FROM PRODUCTS, NOT FROM SETUP ────────────────────────
 *
 * It used to be a tile in the setup hub, beside the quick keys. It is a menu
 * row under Products now: this is not a set-once setting, it is edited whenever
 * the product file is, because a product filed in the wrong department is
 * spotted on /products and fixed here — the same visit.
 *
 * The ROUTE stayed under /setup so no existing link breaks. That is safe
 * because `breadcrumbFor` resolves a path the menu NAMES by its section scan
 * before it ever consults `hubFor`, so the trail reads "Products › Menu
 * designer". The capability stayed `setup.edit` for the same reason it always
 * was: arranging what every till shows is a manager's decision, whoever else
 * may edit a product.
 *
 * ── WHY IT IS NOT THE DEPARTMENTS SCREEN ───────────────────────────────────
 *
 * `/departments` is the tree as a RECORD: codes, colours, what to delete. This
 * is the same tree as a SHOP FLOOR — what a cashier sees, in the order they see
 * it, with the products on it. Same rows, two questions, and one screen trying
 * to answer both would be a table with a canvas bolted to it.
 *
 * The whole menu loads at once, deliberately. Arranging it means dragging
 * across levels, and a per-level fetch would stall every spring-open mid-drag.
 */
export default async function MenuDesignerPage() {
  // A hidden nav entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const menu = await loadMenu(siteId)

  return (
    <>
      <PageHeader
        title="Menu designer"
        subtitle="The till’s browse menu, arranged the way this shop sells"
      />

      <PageBody>
        <Callout tone="neutral" title="What a cashier sees">
          Drag a product onto a department to file it there, or onto the edge of another
          product to set the order. Drag a department onto another to nest it. Hold a drag
          over a folder and it opens, so a product can travel anywhere in one gesture.
        </Callout>

        {/* Always true by the time this renders — requireCapability above
            redirects anyone without it. The prop stays so the tiles have one
            switch to read, and so a future read-only route in can pass false
            rather than every tile learning about capabilities. */}
        <MenuDesigner initialMenu={menu} canEdit />
      </PageBody>
    </>
  )
}
