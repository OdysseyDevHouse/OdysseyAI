import { requireCapability } from '@/lib/auth'
import { areasFor } from '@/lib/menuAreas'
import { hiddenAreas } from '@/lib/site/menuVisibility'
import { PageHeader, PageBody } from '@/components/ui'
import MenuAreasClient from './MenuAreasClient'

export const dynamic = 'force-dynamic'

/**
 * Which parts of the system appear in this shop's menu.
 *
 * ── WHY A SHOP WANTS THIS ───────────────────────────────────────────────────
 *
 * A plan is bought once, for what a business might do; a menu is read fifty
 * times a day by somebody who does exactly one thing. A workshop that bundles
 * Job Cards but takes no bookings, a retailer with no web shop, a two-person
 * shop that pays cash and keeps no roster — each carries a section its staff
 * will never open, and every one of those rows is a door to try. Switching it
 * off is not about money, it is about how long it takes to find Invoicing.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * Not billing: hiding an area changes nothing that is charged, and Setup → Plan
 * & billing is where the plan itself is bought and dropped. Not permissions
 * either: this applies to the whole shop, the same for everybody, while Roles
 * decides what each PERSON may open. Both of those are said on the screen.
 *
 * Areas sold as a module are only offered to a shop that HOLDS that module —
 * offering a switch for something never bought would read as a way to turn it
 * on. Base-package areas like Staff are always offered.
 */
export default async function MenuAreasPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, modules } = await requireCapability('setup.edit')

  const hidden = await hiddenAreas(siteId)
  /* MENU_AREAS order, which `areasFor` preserves. `held` is built from a
     database read, so its own order is whatever the rows came back in — and a
     settings screen whose switches move between visits looks broken. */
  const offered = areasFor(modules.held as ReadonlySet<string>)

  return (
    <>
      <PageHeader
        title="Menu & modules"
        subtitle="Switch off the parts of the system this shop does not use, so they stop appearing in the menu"
      />
      <PageBody>
        <MenuAreasClient
          offered={offered}
          initialShown={offered.filter((area) => !hidden.has(area))}
          degraded={modules.degraded}
        />
      </PageBody>
    </>
  )
}
