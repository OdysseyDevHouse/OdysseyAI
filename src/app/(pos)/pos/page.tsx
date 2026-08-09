import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listSaved } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { getNumericSetting } from '@/lib/site/settings'
import { can, capabilitiesForRole } from '@/lib/site/permissions'
import { getUser } from '@/lib/site/users'
import { getTillSession } from '@/lib/tillSession'
import { liveSpecials } from '@/lib/site/specials'
import { listDepartments } from '@/lib/site/departments'
import PosEntry from './PosEntry'

export const dynamic = 'force-dynamic'

/**
 * The touch till.
 *
 * Gated here rather than in the layout, so the layout can also serve the public
 * unlock screen. Two identities are checked and they are different questions:
 * `requireSiteUser` says which company's data is open, `getTillSession` says which
 * PERSON is standing at the counter. A shop floor swaps the second several times
 * a day and never the first.
 */
export default async function PosPage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'sales.till')) redirect('/not-allowed')

  /*
   * Who is standing here, if the server can tell.
   *
   * No PIN, no basket — rendering the till first and asking afterwards is how a sale
   * gets rung up against whoever opened the browser that morning. But the ANSWER is
   * now handed to PosEntry rather than acted on here, because the till cookie lasts 8
   * hours against the browser session's 12: it lapses first, and when it does with no
   * network, only the client can say whether somebody signed in against this device's
   * own verifiers. See PosEntry.
   *
   * The shop-level data below is loaded either way. Loading it only for an
   * already-signed-in operator would mean an offline sign-in had nothing to render
   * and would need a round trip it cannot make.
   */
  const till = await getTillSession(site.id)

  // The OPERATOR's permissions, not the browser session's. A manager signed in to
  // the back office who hands the till to a junior must not leave their own
  // discount and price-override rights behind on the screen.
  const operator = till ? await getUser(site.id, till.userId) : null
  const operatorCapabilities = operator
    ? await capabilitiesForRole(site.id, operator.roleId)
    : capabilities

  const [terminals, tenders, saved, structures, cashRounding, specials, departments] =
    await Promise.all([
      listTerminals(site.id, false),
      listTenderTypes(site.id),
      /* Site-wide, and it cannot be otherwise here: which till this machine IS
         lives in its own localStorage, so the server has no way to narrow this at
         render time. The count is a first paint for the badge — PosShell replaces
         it with the per-till figure the moment the saved-sales list is opened. */
      listSaved(site.id),
      listPriceStructures(site.id),
      getNumericSetting(site.id, 'sales_cash_rounding'),
      /*
       * Sent WHOLE, with their windows unevaluated — the till re-checks them
       * against its own clock, so a happy hour starting at five begins on time
       * even though this page was loaded at ten to.
       */
      liveSpecials(site.id),
      // The department rail. Flat, with parent ids — the tree is assembled on the
      // client because drilling into one must not cost a round trip.
      listDepartments(site.id, true),
    ])

  const priceStructure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  return (
    <PosEntry
      /* The till's own IndexedDB is keyed by this, so a machine that switches shops
         opens a different database rather than mixing two shops' outboxes. */
      siteId={site.id}
      siteName={site.displayName}
      /* Null when the till cookie has lapsed. PosEntry then looks for an offline
         session before deciding to show the PIN gate. */
      serverOperator={
        till
          ? {
              /* Carried on every offline sale for attribution. The server re-derives
                 this person's CAPABILITIES from their role at sync and never trusts
                 the payload's word for them — see postOfflineSale. */
              userId: till.userId,
              name: till.name,
              canOverrideDiscount: can(operatorCapabilities, 'sales.discount_override'),
              canOverridePrice: can(operatorCapabilities, 'sales.price_override'),
              /* Whether the OPERATOR may void, not the browser session. This only
                 decides whether the button is offered — voidSaleAction re-checks,
                 because a server action is a public endpoint and hiding a button
                 changes what is easy rather than what is possible. */
              canVoid: can(operatorCapabilities, 'sales.void'),
            }
          : null
      }
      terminals={terminals}
      tenders={tenders}
      /* Narrowed on the way out rather than passed whole: the till needs an id,
         a parent and a name, and shipping `color`/`posImageId`/`code` as well
         would invite a tile to read a stored hex — which the design system does
         not allow. Tile colour comes from toneForId. */
      departments={departments
        .filter((d) => d.isActive)
        .map((d) => ({ id: d.id, parentId: d.parentId, name: d.name, sortOrder: d.sortOrder }))}
      priceStructureId={priceStructure?.id ?? null}
      savedCount={saved.length}
      cashRounding={cashRounding}
      specials={specials}
    />
  )
}
