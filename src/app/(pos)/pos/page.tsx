import { redirect } from 'next/navigation'
import { toPosMode } from '@/lib/posMode'
import { requireSiteUser } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { listSaved } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { getNumericSetting, getSetting, getSettings } from '@/lib/site/settings'
import { can, capabilitiesForRole } from '@/lib/site/permissions'
import { getUser } from '@/lib/site/users'
import { getTillSession } from '@/lib/tillSession'
import { liveSpecials } from '@/lib/site/specials'
import { pendingSchedulesForTill } from '@/lib/site/priceSchedules'
import { listDepartments } from '@/lib/site/departments'
import { listAllQuickKeys } from '@/lib/site/quickKeys'
import { listTables } from '@/lib/site/posTables'
import { listRooms, listFeatures } from '@/lib/site/posFloor'
import { listVisitTypes } from '@/lib/site/visitTypes'
import { listServiceTiers } from '@/lib/site/tips'
import { siteQuery } from '@/lib/siteDb'
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

  const [
    terminals,
    tenders,
    voidReasons,
    returnReasons,
    saved,
    structures,
    cashRounding,
    specials,
    pendingPrices,
    departments,
    quickKeys,
    posMode,
    tables,
    floorRooms,
    floorFeatures,
    visitTypes,
    serviceTiers,
    tipsTablesOnlySetting,
    undoLimitSetting,
    warnOutOfStockSetting,
  ] = await Promise.all([
      listTerminals(site.id, false),
      listTenderTypes(site.id),
      /* Active only: this is the list a cashier picks FROM, and a retired reason
         is one nobody may choose again. The retired ones stay readable on the
         documents that used them, and visible on the setup screen that brings
         one back. */
      listSalesReasons(site.id, 'void'),
      listSalesReasons(site.id, 'return'),
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
      /*
       * Scheduled price changes, sent the same way and for the same reason.
       *
       * Rendered here as well as shipped in the catalogue: a till that reloads
       * its PAGE while online takes its props from this render, and one that has
       * been offline takes them from IndexedDB. If only the catalogue carried
       * them, a fresh load at five to six would hold none and the change would
       * miss its moment on exactly the machine that had just been restarted.
       */
      pendingSchedulesForTill(site.id),
      // The department rail. Flat, with parent ids — the tree is assembled on the
      // client because drilling into one must not cost a round trip.
      listDepartments(site.id, true),
      /* The shop's own till buttons. Shipped with the page rather than fetched by the
         client: they are the DEFAULT pane, so a till that had to wait for them would
         open on an empty grid — and one that lost them when the line dropped would lose
         the fastest way it has to sell.

         BOTH BARS, not just `main`. The tables bar is what the floor's Quick keys button
         opens, and a manager who arranged one in the designer had it rendered nowhere
         until this loaded it. Each consumer picks its own section — `topLevelKeys` takes
         one — so the extra rows cost a shop with no tables bar nothing but the handful of
         rows it does not have. */
      listAllQuickKeys(site.id),
      /* The mode, and the floor. In retail the floor query returns nothing and the gate
         never mounts — one query rather than a branch, because the branch would have to
         be repeated for every consumer of the result. */
      getSetting(site.id, 'pos_mode'),
      listTables(site.id),
      /* The drawn plan, if a manager built one. Both come back empty on a shop that
         never opened the designer, and the gate then renders the sectioned grid — so
         these are fetched unconditionally rather than behind a mode check, for the same
         reason the tables are: one query beats a branch repeated per consumer. */
      listRooms(site.id),
      listFeatures(site.id),
      /* ACTIVE only: the gate offers one filter segment per type, and a retired one is
         a segment nobody can file a table under. The setup screen asks for all of them,
         because hiding a type is undone from there. */
      listVisitTypes(site.id, true),
      /* The service-charge bands and where they apply. Shipped with the page so the pad can
         price a charge with no round trip, and so a till that has lost the network still
         charges what it was last told — the same reasoning the specials already use. */
      listServiceTiers(site.id),
      getSetting(site.id, 'tips_tables_only'),
      /* How many undos one basket may spend. Shipped with the page rather than read
         when the key is pressed: the refusal has to land instantly and has to work
         with the line down, and a limit fetched at press time would do neither. */
      getNumericSetting(site.id, 'pos_undo_limit'),
      /* Whether the tender pad says anything about stock. Shipped with the page
         for the same reason as the undo limit: the warning has to appear at the
         moment Pay is pressed, and a setting fetched then would be one more
         round trip standing between a cashier and a customer's money. */
      getSetting(site.id, 'pos_warn_out_of_stock'),
    ])

  const priceStructure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  /* Names for the keys that point at something, so a key with no caption of its own can
     read the product's. Only the ones ACTUALLY on a key — the alternative is shipping the
     whole product file so the till can look one up, which the offline catalog already
     does at 0.9MB and has no business doing twice. */
  const keyProductIds = [
    ...new Set(quickKeys.map((k) => k.productId).filter((id): id is number => !!id)),
  ]
  const keyDepartmentIds = [
    ...new Set(quickKeys.map((k) => k.departmentId).filter((id): id is number => !!id)),
  ]
  /* The deposit rules (172), read as a pair. Both are plain strings with sane
     defaults, so a store that has never opened the setup screen takes deposits
     from anybody for any amount — which is what a shop that has not thought
     about it expects to happen. */
  const depositSettings = await getSettings(site.id, ['deposit_min_pct', 'deposit_allow_walkin'])
  const depositMinPct = Number(depositSettings.deposit_min_pct ?? '0') || 0
  const depositAllowWalkin = String(depositSettings.deposit_allow_walkin ?? '1') !== '0'

  const keyProducts = keyProductIds.length
    ? await siteQuery<{ id: number; description: string }>(
        site.id,
        `SELECT id, description FROM products WHERE id IN (${keyProductIds.map(() => '?').join(',')})`,
        keyProductIds,
      )
    : []
  const quickKeyProductNames = Object.fromEntries(keyProducts.map((p) => [p.id, p.description]))
  /* Departments come from the list already loaded above rather than a second query — the
     rail needs all of them anyway, so the names are in hand. */
  const quickKeyDepartmentNames = Object.fromEntries(
    departments.filter((d) => keyDepartmentIds.includes(d.id)).map((d) => [d.id, d.name]),
  )

  return (
    <PosEntry
      /* The till's own IndexedDB is keyed by this, so a machine that switches shops
         opens a different database rather than mixing two shops' outboxes. */
      siteId={site.id}
      siteName={site.displayName}
      /* For the till-printed slip's header — a tax invoice names the vendor. */
      siteVatNumber={site.vatNumber}
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
      voidReasons={voidReasons}
      returnReasons={returnReasons}
      /* Narrowed on the way out rather than passed whole: the till needs an id,
         a parent and a name, and shipping `color`/`posImageId`/`code` as well
         would invite a tile to read a stored hex — which the design system does
         not allow. Tile colour comes from toneForId. */
      departments={departments
        .filter((d) => d.isActive)
        .map((d) => ({ id: d.id, parentId: d.parentId, name: d.name, sortOrder: d.sortOrder }))}
      priceStructureId={priceStructure?.id ?? null}
      /* The whole list, so the price-change key can offer them. Shipped with the
         page rather than fetched when the key is pressed: a shop has a handful of
         these and they change about never, so a round trip mid-sale would buy
         nothing and cost the one thing a till cannot spend. */
      priceStructures={structures}
      savedCount={saved.length}
      cashRounding={cashRounding}
      depositMinPct={depositMinPct}
      depositAllowWalkin={depositAllowWalkin}
      specials={specials}
      pendingPrices={pendingPrices}
      quickKeys={quickKeys}
      quickKeyProductNames={quickKeyProductNames}
      /* The one place the mode is turned into flags. Three values, resolved
         once — see lib/posMode for why this picks a screen rather than
         threading a third boolean through the shell. */
      hospitality={toPosMode(posMode) === 'hospitality'}
      invoicing={toPosMode(posMode) === 'invoicing'}
      initialTables={tables}
      floorRooms={floorRooms}
      visitTypes={visitTypes}
      floorFeatures={floorFeatures}
      serviceTiers={serviceTiers}
      /* Absent means ON — the careful default. A percentage appearing on takeaways the
         moment a shop configures its first band is a charge nobody agreed to. */
      tipsTablesOnly={tipsTablesOnlySetting === null || tipsTablesOnlySetting === undefined ? true : String(tipsTablesOnlySetting) !== '0'}
      /* Absent means OFF, the opposite default to tips above and deliberately so:
         plenty of shops do not track stock, and a warning about figures nobody
         maintains teaches cashiers to dismiss warnings without reading them. */
      warnOutOfStock={String(warnOutOfStockSetting ?? '0') === '1'}
      /* 0 means no limit, and so does a missing or unreadable value — the till must
         fail OPEN here. A setting that could not be read is not a shop asking for a
         stricter till, and refusing corrections because a query returned nothing
         would be the wrong way round. */
      undoLimit={Number.isFinite(undoLimitSetting) && (undoLimitSetting ?? 0) > 0 ? Number(undoLimitSetting) : 0}
      quickKeyDepartmentNames={quickKeyDepartmentNames}
    />
  )
}
