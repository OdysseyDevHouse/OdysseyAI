import { redirect } from 'next/navigation'

import { requireSiteUser } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listFieldDefs } from '@/lib/site/customFields'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { toDocType } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { getNumericSetting, getSetting, getSettings } from '@/lib/site/settings'
import { taxLabel } from '@/lib/site/taxIdentity'
import { can, capabilitiesForRole } from '@/lib/site/permissions'
import { getUser } from '@/lib/site/users'
import { getTillSession } from '@/lib/tillSession'
import { liveSpecials } from '@/lib/site/specials'
import { pendingSchedulesForTill } from '@/lib/site/priceSchedules'
import { livePosMenus } from '@/lib/site/posMenus'
import { listDepartments } from '@/lib/site/departments'
import { tillProductCounts } from '@/lib/site/tillSearch'
import { backdropUrl, stockBackdropUrl } from '@/lib/site/posSignInArt'
import { logoFileName, LOGO_URL } from '@/lib/site/documentLogo'
import { signInSpecials } from '@/lib/site/posSignInSpecials'
import type { PosSignInSpecial } from '@/components/ui'
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
export default async function PosPage({
  searchParams,
}: {
  /**
   * What the till should START as, when somebody arrived here meaning to make
   * something specific.
   *
   * The back office links in with `?new=sales_order` from Orders and
   * `?new=quote` from Quotes, so "New order" opens a till already writing one
   * rather than dropping somebody at a counter screen with no clue what to
   * press. Absent is the ordinary case — a cashier opening the till to trade —
   * and means an invoice, which is what every till wrote before this existed.
   */
  searchParams: Promise<{ new?: string }>
}) {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'sales.till')) redirect('/not-allowed')

  const params = await searchParams
  /* Validated here rather than trusted: this is a URL anybody can type, and an
     unrecognised value must open an ordinary till rather than a broken one. */
  const startAs = toDocType(params.new) ?? 'invoice'

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
    structures,
    cashRounding,
    specials,
    pendingPrices,
    posMenus,
    departments,
    departmentCounts,
    signInArt,
    quickKeys,
    tables,
    floorRooms,
    floorFeatures,
    visitTypes,
    serviceTiers,
    tipsTablesOnlySetting,
    undoLimitSetting,
    warnOutOfStockSetting,
    offlineAccountSetting,
    laybyDefaultDays,
  ] = await Promise.all([
      listTerminals(site.id, false),
      listTenderTypes(site.id),
      /* Active only: this is the list a cashier picks FROM, and a retired reason
         is one nobody may choose again. The retired ones stay readable on the
         documents that used them, and visible on the setup screen that brings
         one back. */
      listSalesReasons(site.id, 'void'),
      listSalesReasons(site.id, 'return'),
      /* `listSaved(site.id)` was here, site-wide, on every till load — a first
         paint for the badge on the basket's Saved key. That key is a quick key
         now and carries no badge, so this was a query nothing read. The list
         itself still loads on demand, per till, when the modal opens. */
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
      /* The rotating menus (231), windows unevaluated — shipped with the page
         for exactly the reason above: a till freshly reloaded at five to eleven
         must still switch to lunch at eleven, and it can only do that if it is
         already holding the menus when the minute arrives. */
      livePosMenus(site.id),
      // The department rail. Flat, with parent ids — the tree is assembled on the
      // client because drilling into one must not cost a round trip.
      listDepartments(site.id, true),
      /* How many sellable products sit in each department, for the count on
         its tile. Counted here rather than read off listDepartments' own
         `productCount`: that one counts every row, archived products and
         variant parents included, so a tile would promise more than the grid
         behind it opens on. tillProductCounts owns the rule, and its WHERE
         clause is browseForTill's. */
      tillProductCounts(site.id),
      /* What the SIGN-IN screen shows before anybody has signed in: the shop's
         backdrop, its logo, and the promotions worth putting on a board. All
         three degrade to nothing on their own, so this never keeps a cashier
         off a till — see posSignInArt and posSignInSpecials. */
      signInArtFor(site.id, site.siteTypeId),
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
      /* The floor. In retail the query returns nothing and the gate never mounts —
         one query rather than a branch, because the branch would have to be
         repeated for every consumer of the result.

         The MODE no longer comes from here: it is a property of the till, and
         only the browser knows which till this is. See PosEntry. */
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
      /* Whether a disconnected till may still sell on account. Shipped with the
         page for the same reason the others are: the tender pad has to know at
         the moment the line drops, which is the moment a fetch cannot help. */
      getSetting(site.id, 'pos_offline_account_sales'),
      /* How long the shop gives somebody to pay a lay-by off. Shipped rather
         than fetched when the dialog opens, for the same reason as the two
         above: it is a default in a field, and a round trip to fill one in is a
         round trip a cashier waits through with a customer in front of them. */
      getNumericSetting(site.id, 'layby_default_days'),
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
  const depositSettings = await getSettings(site.id, [
    'deposit_min_pct',
    'deposit_allow_walkin',
    /* The two sign-out rules, read alongside the deposit pair rather than in a
       query of their own. Both are consulted at a moment no fetch can help: one
       when a sale completes, the other on a timer that has to keep running with
       the line down. Shipped with the page, like every other till rule. */
    'pos_return_to_login',
    'pos_idle_logout_seconds',
    /* Whether a scan makes a noise. Shipped for the strongest version of the
       reason the others are: the sound has to fire in the same tick as the
       basket changes, and it has to keep working with the line down — a
       mis-scan is likelier offline, not less. */
    'pos_scan_sounds',
  ])
  const depositMinPct = Number(depositSettings.deposit_min_pct ?? '0') || 0
  const depositAllowWalkin = String(depositSettings.deposit_allow_walkin ?? '1') !== '0'
  const returnToLogin = String(depositSettings.pos_return_to_login ?? '0') === '1'
  /* Clamped to a non-negative integer here rather than trusted: this drives a
     setTimeout, and a NaN there would silently never fire — a security setting
     that reads as on and does nothing. Zero is never, which is also the answer
     a malformed value should give. */
  const idleLogoutSeconds = Math.max(
    0,
    Math.trunc(Number(depositSettings.pos_idle_logout_seconds ?? '0')) || 0,
  )
  const scanSounds = String(depositSettings.pos_scan_sounds ?? '0') === '1'

  /*
   * The questions a sale may be asked at the pad.
   *
   * Shipped with the page rather than fetched when the pad opens, like every
   * other till rule: the dialog stands between a cashier and a customer's
   * money, and a round trip there is one somebody waits through. Active only —
   * a retired field is one nobody may be asked any more.
   *
   * A shop with none gets an empty list, and the gate in PosShell then never
   * fires however the tender flags happen to be set.
   */
  const saleCommentFields = (await listFieldDefs(site.id, 'sale').catch(() => []))
    .filter((d) => d.isActive)
    .map((d) => ({
      fieldId: d.id,
      code: d.code,
      name: d.name,
      hint: d.hint,
      fieldType: d.fieldType,
      options: d.options,
      unit: d.unit,
      isRequired: d.isRequired,
    }))

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
      siteTaxLabel={await taxLabel(site.id)}
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
         a parent, a name, an order and the till picture. `color` and `code` stay
         behind — `color` is a stored hex, and a tile reading one would paint
         outside the tokens. Tile colour still comes from toneForId; the picture
         is an id the tile resolves to a URL, which is a different thing. */
      departments={departments
        .filter((d) => d.isActive)
        .map((d) => ({
          id: d.id,
          parentId: d.parentId,
          name: d.name,
          sortOrder: d.sortOrder,
          posImageId: d.posImageId,
        }))}
      /* Direct per-department counts, rolled into subtree totals on the client
         — see departmentTallies. Passed as the raw map rather than as finished
         captions so the rail and the grid can phrase them differently without
         this page having to know that they do. */
      departmentCounts={departmentCounts}
      priceStructureId={priceStructure?.id ?? null}
      /* The whole list, so the price-change key can offer them. Shipped with the
         page rather than fetched when the key is pressed: a shop has a handful of
         these and they change about never, so a round trip mid-sale would buy
         nothing and cost the one thing a till cannot spend. */
      priceStructures={structures}
      cashRounding={cashRounding}
      depositMinPct={depositMinPct}
      depositAllowWalkin={depositAllowWalkin}
      returnToLogin={returnToLogin}
      idleLogoutSeconds={idleLogoutSeconds}
      scanSounds={scanSounds}
      saleCommentFields={saleCommentFields}
      specials={specials}
      pendingPrices={pendingPrices}
      posMenus={posMenus}
      quickKeys={quickKeys}
      quickKeyProductNames={quickKeyProductNames}
      /* NO MODE PASSED DOWN, deliberately.
         The mode belongs to the TILL now, and this page cannot tell which till
         it is serving — the device id is browser-only. PosEntry matches the
         machine against `terminals` and resolves it there, before PosShell
         mounts and seeds its state from it. */
      /* What this till should open as, when the back office asked for something
         specific. Absent means invoice — see the page signature. */
      startAs={startAs}
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
      /* Absent means OFF — an existing shop keeps refusing account sales offline
         until an owner decides otherwise. See pos_offline_account_sales. */
      offlineAccountSales={String(offlineAccountSetting ?? '0') === '1'}
      /*
       * The date the lay-by dialog opens with, computed HERE rather than in the
       * browser.
       *
       * A till's own clock can be wrong — that is the whole reason documents are
       * dated by the server — and a due date is a promise to a customer about
       * when their goods stop being held. Zero or a missing setting means the
       * shop sets no term, which is a legitimate answer and arrives as null.
       */
      laybyDueDate={
        Number.isFinite(laybyDefaultDays) && (laybyDefaultDays ?? 0) > 0
          ? new Date(Date.now() + Number(laybyDefaultDays) * 86_400_000)
              .toISOString()
              .slice(0, 10)
          : null
      }
      /* 0 means no limit, and so does a missing or unreadable value — the till must
         fail OPEN here. A setting that could not be read is not a shop asking for a
         stricter till, and refusing corrections because a query returned nothing
         would be the wrong way round. */
      undoLimit={Number.isFinite(undoLimitSetting) && (undoLimitSetting ?? 0) > 0 ? Number(undoLimitSetting) : 0}
      quickKeyDepartmentNames={quickKeyDepartmentNames}
      /* The showcase half of the sign-in screen. Spread rather than passed as
         one object so PosEntry relays three ordinary props — it is a
         pass-through, and a bag of state it never reads into would be one more
         shape to keep in step. */
      backdropUrl={signInArt.backdropUrl}
      logoUrl={signInArt.logoUrl}
      signInSpecials={signInArt.specials}
    />
  )
}

/**
 * Everything the sign-in showcase needs, resolved together.
 *
 * One helper rather than three entries in the Promise.all above, because all
 * three belong to one screen and each is INDIVIDUALLY optional — a shop with a
 * logo and no backdrop, or promotions and neither, is ordinary. Grouping them
 * keeps that "any of these may be absent" in one place instead of spread
 * across three defaults at the call site.
 *
 * Every branch degrades to empty. This screen stands between a cashier and the
 * till at the start of a shift, so nothing decorative on it may ever be able to
 * stop somebody signing in.
 */
async function signInArtFor(
  siteId: number,
  siteTypeId: number | null,
): Promise<{
  backdropUrl: string
  logoUrl: string
  specials: PosSignInSpecial[]
}> {
  const [backdrop, logoFile, specials] = await Promise.all([
    backdropUrl(siteId).catch(() => ''),
    logoFileName(siteId).catch(() => ''),
    /* NOW, from the server's clock rather than the till's: this decides whether
       a happy hour is on the board, and a counter machine whose clock has
       drifted would advertise the five o'clock price at half past four. */
    signInSpecials(siteId, new Date()).catch(() => []),
  ])

  return {
    /* The shop's OWN photograph if it uploaded one, and the stock picture for
       its trade otherwise. Never neither: `stockBackdropUrl` always answers, so
       the brand gradient is now only what shows through while a picture loads or
       when its bytes have gone missing. */
    backdropUrl: backdrop || stockBackdropUrl(siteTypeId),
    /* Cache-busted on the stored NAME, matching what logoImgTag does for
       printed documents: the URL is constant per site, so without it a
       replaced logo would stay on screen until somebody hard-refreshed a
       machine that is never refreshed. */
    logoUrl: logoFile ? `${LOGO_URL}?v=${encodeURIComponent(logoFile)}` : '',
    /* Two row shapes, and only one of them has a picture to point at. The id
       becomes a URL HERE rather than in the panel, so the kit component stays a
       dumb renderer that knows no routes — the same reason TillProduct ships an
       image id rather than a path. */
    specials: specials.map((s) =>
      s.kind === 'price'
        ? {
            kind: 'price' as const,
            productId: s.productId,
            description: s.description,
            blurb: s.blurb,
            priceIncl: s.priceIncl,
            wasIncl: s.wasIncl,
            imageUrl:
              s.imageId === null
                ? undefined
                : `/api/pos/special-image?id=${s.imageId}&productId=${s.productId}`,
          }
        : {
            kind: 'offer' as const,
            specialId: s.specialId,
            description: s.description,
            blurb: s.blurb,
            appliesTo: s.appliesTo,
          },
    ),
  }
}
