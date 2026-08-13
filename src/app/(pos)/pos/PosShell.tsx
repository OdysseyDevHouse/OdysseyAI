'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  useToast,
  Button,
  ConfirmModal,
  Icons,
  Modal,
  type PickableReason,
} from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { useOfflineShell } from '@/lib/posOffline/useOfflineShell'
import { useOfflineTill } from '@/lib/posOffline/useOfflineTill'
import { finaliseOffline, returnOffline, currentShiftId } from '@/lib/posOffline/finaliseOffline'
import {
  findByCode,
  searchOffline,
  browseOffline,
  storedQuickKeys,
  storedPendingPrices,
  storedInstructions,
} from '@/lib/posOffline/catalog'
import {
  parkOffline,
  recallOffline,
  discardParkedOffline,
  listParkedOffline,
} from '@/lib/posOffline/parkOffline'
import { cancelOfflineSale } from '@/lib/posOffline/cancelOffline'
import { offlineBlockedProduct, offlineBlockedTender } from '@/lib/offlineCapability'
import type { Special } from '@/lib/specialsEngine'
import {
  pendingPriceIndex,
  resolvedFromIndex,
  type PendingSchedule,
} from '@/lib/priceSchedules'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TillInstructionGroup } from '@/lib/site/instructions'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { Terminal } from '@/lib/site/terminals'
import type { BasketLine } from '@/lib/basket'
import {
  searchProductsAction,
  browseProductsAction,
  scanAction,
  finaliseSaleAction,
  createCreditNoteAction,
  saveSaleAction,
  saveForLaterAction,
  discardSaleAction,
  voidSaleAction,
} from '@/app/(app)/sales/actions'
import {
  listOpenTabsAction,
  recallSaleForTillAction,
  recordServiceChargeWaivedAction,
  type OpenTab,
} from './actions'
import { NewTableModal, type NewTableDetails } from './NewTableModal'
import { tillSignOutAction } from './pinActions'
import { tillStandingAction, type TillStanding } from '@/app/(app)/loyalty/actions'
import { TillStatusBar } from './TillStatusBar'
import { SalePane } from './SalePane'
import { DeptRail } from './DeptRail'
import { CatalogPane } from './CatalogPane'
import { TenderPad } from './TenderPad'
import { CustomerModal } from './CustomerModal'
import { SavedSalesModal, type SavedEntry } from './SavedSalesModal'
import { OutboxModal } from './OutboxModal'
import { LineEditModal } from './LineEditModal'
import InstructionsModal from './InstructionsModal'
import { ReceiptModal } from './ReceiptModal'
import { VoidModal } from './VoidModal'
import { useSaleState } from './useSaleState'
import {
  specialsFor,
  totalsFor,
  salePayloadLines,
  returnPayloadLines,
  docDiscountShares,
  type DocDiscount,
} from './saleSelectors'
import DocDiscountModal from './DocDiscountModal'
import { serviceChargeFor, planTips, type ServiceTier } from '@/lib/tipMath'
import { RefundPad } from './RefundPad'
import { TableGate } from './TableGate'
import {
  listTablesAction,
  openTableAction,
  updateTableBillAction,
  askForBillAction,
  tablePaidAction,
  billForSplitAction,
  splitTableAction,
  transferTableAction,
} from './tableActions'
import type { PosTable } from '@/lib/site/posTables'
import type { VisitType } from '@/lib/site/visitTypes'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import { SplitBillModal, type SplitLine } from './SplitBillModal'
import TransferTableModal from './TransferTableModal'
import ShiftModal from './ShiftModal'
import { tillShiftStatusAction } from './shiftActions'
import OverrideModal from './OverrideModal'
import { kvPut, KV } from '@/lib/posOffline/db'
import type { Capability } from '@/lib/site/permissions'
import type { OfflineSale } from '@/lib/posOffline/types'
import { WeighModal } from './WeighModal'
import { QuickKeyPanel } from './QuickKeyPanel'
import { TileSizeModal } from './TileSizeModal'
import { TileSizeContext, useTileSize } from '@/lib/posOffline/useTileSize'
import { runQuickKey, quickKeyEnabled } from './quickKeyRunner'
import type { QuickKeyRow } from '@/lib/quickKeys'
import type { Department } from './types'

/**
 * The till.
 *
 * ── WHAT THIS FILE IS AND IS NOT ──────────────────────────────────────────
 *
 * It owns wiring: the reducer, the server round trips, and which pane gets which
 * callback. It owns no layout beyond the three columns and no business rule at
 * all. Every rule lives somewhere testable — basket.ts decides what merges,
 * saleSelectors decides what a line costs, specialsEngine decides what a
 * promotion does.
 *
 * That split is the point. The POS this is modelled on is a single 10,569-line
 * component, and the reason it got there is that each new feature had one obvious
 * place to go. Here the obvious place is a new file.
 *
 * ── THREE COLUMNS ─────────────────────────────────────────────────────────
 *
 *   basket 440px  |  departments 240px  |  catalogue (the rest)
 *
 * Fixed widths on the first two because a cashier finds them by position, not by
 * reading. The rail hides below `xl` — three columns need about 1280px, and a
 * cashier on a 1024 screen is better served by a wider catalogue than by a
 * squeezed everything.
 *
 * ── HOSPITALITY IS A FLAG READ IN THREE PLACES, AND ONLY THREE ─────────────
 *
 * `hospitality` decides:
 *
 *   1. whether the TABLE GATE stands in front of the till (below, at the top of the
 *      render — a waiter picks a table before there is a basket to put anything in);
 *   2. whether the SEND TO KITCHEN key is offered (passed to SalePane);
 *   3. whether the hospitality quick keys are enabled (passed to the runner).
 *
 * Everything else is mode-blind. `SaleLineCard`, `SaleTotals`, `DeptRail`, `CatalogPane`,
 * `TenderPad`, `ProductTile` and the whole offline path do not know and must not learn:
 * a restaurant basket is a basket, and a restaurant sale posts through exactly the same
 * `finaliseDocument` a counter sale does.
 *
 * The reference POS threaded `restaurantMode` through ten thousand lines, and that is
 * the trap this is written to avoid. **If a fourth `if (hospitality)` appears, that is
 * the signal to reconsider the design rather than to add it.**
 */
export default function PosShell({
  siteId,
  siteName,
  operatorName,
  operatorUserId,
  terminals,
  departments,
  priceStructureId: siteDefaultStructureId,
  tenders,
  voidReasons,
  returnReasons,
  cashRounding,
  canOverrideDiscount,
  canOverridePrice,
  canVoid,
  savedCount,
  specials,
  pendingPrices: pendingPricesProp,
  quickKeys,
  quickKeyProductNames,
  quickKeyDepartmentNames,
  hospitality,
  initialTables,
  floorRooms,
  floorFeatures,
  visitTypes = [],
  serviceTiers,
  tipsTablesOnly,
}: {
  /** Keys the till's own IndexedDB — one database per site, never one shared. */
  siteId: number
  siteName: string
  operatorName: string
  operatorUserId: number
  terminals: Terminal[]
  departments: Department[]
  priceStructureId: number | null
  tenders: TenderType[]
  /**
   * The two reason lists, active entries only.
   *
   * Shipped with the page for the same reason the quick keys are: a till that
   * reloads with no network still has to be able to void and take a return, and
   * fetching a lookup at the moment a cashier taps Void is the one moment the
   * line is least likely to be there.
   */
  voidReasons: PickableReason[]
  returnReasons: PickableReason[]
  cashRounding: number
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /** Whether the OPERATOR may void. Re-checked by voidSaleAction regardless. */
  canVoid: boolean
  /* Not read yet — saved-sales recall is still to come, and this is the count for
     its button's badge. Typed now so the server page's contract is settled. */
  savedCount: number
  specials: Special[]
  /**
   * Approved price changes that have not happened yet, moments unevaluated.
   *
   * Shipped with the page for the same reason the quick keys are — so a till
   * that reloads with no network still holds them — and applied against this
   * machine's own clock, so six o'clock means six o'clock here.
   */
  pendingPrices: PendingSchedule[]
  /** The shop's own till buttons. Shipped with the page so they survive the line dropping. */
  quickKeys: QuickKeyRow[]
  quickKeyProductNames: Record<number, string>
  quickKeyDepartmentNames: Record<number, string>
  /** Read in THREE places only — see the docblock above. */
  hospitality: boolean
  /** The floor. Empty in retail, where the gate never mounts. */
  initialTables: PosTable[]
  /** The DRAWN floor, if a manager built one. Empty means the gate uses the grid. */
  floorRooms: FloorRoom[]
  floorFeatures: FloorFeature[]
  /** Active visit types, for the gate's filter. Empty hides it. */
  visitTypes?: VisitType[]
  /**
   * Service-charge bands, shipped with the page.
   *
   * Sent rather than fetched so the pad can price a charge with no round trip — and so a
   * till that has lost the network still charges what it was last told, which is the same
   * reasoning the specials and the pending price changes already use.
   */
  serviceTiers: ServiceTier[]
  /** Whether a service charge applies only to a table's bill. Defaults on. */
  tipsTablesOnly: boolean
}) {
  const [state, dispatch] = useSaleState()

  /*
   * The EFFECTIVE price structure (135): the attached account's own — already
   * resolved customer → group server-side on the TillCustomer — else the site
   * default the page shipped. Named to shadow the old prop so every lookup
   * below (scan, search, browse, recall, finalise) prices through the account
   * with no further changes. Lines rung BEFORE the account was attached keep
   * their prices — attach first is the till discipline, and the server
   * re-checks pricing at finalise either way.
   */
  const priceStructureId = state.customer?.priceStructureId ?? siteDefaultStructureId

  const [pending, startTransition] = useTransition()
  const [results, setResults] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [browse, setBrowse] = useState<{ loading: boolean; products: TillProduct[] }>({
    loading: false,
    products: [],
  })
  const [confirmClear, setConfirmClear] = useState(false)
  const [tendering, setTendering] = useState(false)
  const [pickingCustomer, setPickingCustomer] = useState(false)
  const [showingSaved, setShowingSaved] = useState(false)
  const [showingOutbox, setShowingOutbox] = useState(false)
  const [sizingTiles, setSizingTiles] = useState(false)
  /** The refund pad is open. Distinct from `state.returning`, which is the MODE. */
  const [returning, setReturning] = useState(false)
  /* Per-machine, from localStorage, applied after mount — a counter screen's useful
     tile size is a property of that screen, not of the shop. See useTileSize. */
  const tileSize = useTileSize()
  /*
   * How many baskets are parked, for the badge.
   *
   * Seeded from the server render and then maintained here, because the badge and
   * the list must agree. The server counts SITE-WIDE at page load while the modal
   * narrows to this till, so the two disagreed the moment a sale was parked — the
   * badge said 2 and the list showed 1, which reads as a lost basket.
   *
   * The modal reports its own count on open, which is the authoritative one: it is
   * the same query the list is drawn from.
   */
  const [savedTally, setSavedTally] = useState(savedCount)
  const [editing, setEditing] = useState<BasketLine | null>(null)
  /** A scale item waiting for its weight — see the guard in add(). */
  const [weighing, setWeighing] = useState<TillProduct | null>(null)

  /**
   * The product being asked about, if any. Null closes the dialog.
   *
   * Same shape as `editing` above, and for the same reason: one nullable piece
   * of state is easier to reason about than an open flag beside a payload that
   * may or may not match it.
   */
  const [asking, setAsking] = useState<{
    product: TillProduct
    qty: number
    groups: number[]
  } | null>(null)

  /**
   * The questions this till can ask.
   *
   * Read from storage unconditionally, unlike the pending prices above: there is
   * no server prop to compare against, because the library arrives only in the
   * catalogue. An empty one is the ordinary state of a shop that asks nothing.
   */
  const [instructions, setInstructions] = useState<{
    byId: Map<number, TillInstructionGroup>
    byProduct: Record<number, number[]>
  }>({ byId: new Map(), byProduct: {} })

  useEffect(() => {
    let cancelled = false
    void storedInstructions(siteId).then((held) => {
      if (!cancelled) setInstructions({ byId: held.byId, byProduct: held.byProduct })
    })
    return () => {
      cancelled = true
    }
  }, [siteId])
  const [receipt, setReceipt] = useState<{
    number: string
    change: number
    documentId: number
    /** Kept so the void dialog can show what is being reversed. */
    total: number
  } | null>(null)
  const [voiding, setVoiding] = useState(false)

  const toast = useToast()
  const router = useRouter()

  /*
   * Which till this machine IS.
   *
   * Browser-only, so it resolves after mount: the server knows which machines
   * have claimed a terminal, but only the machine knows which one it is.
   *
   * When nothing matches, this is not a cosmetic gap. `terminalId` then goes to
   * the server as null, `numberSegmentsFor` correctly declines to give the sale a
   * store-and-till segment, and the invoice numbers from the SHARED sequence as
   * INV101196 rather than INV_01_01_000001. That is right — an unclaimed machine
   * is not a register — but it is invisible unless the till says so, and a shop
   * that traded a day before noticing has a day of invoices in the wrong run.
   */
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => setDevice(deviceId()), [])

  /* The offline shell. Registered from here rather than the layout so it starts
     only once a till session exists — a worker installed by somebody who never
     got past the PIN pad caches a shell for a machine that is not a till. */
  const shell = useOfflineShell()

  /* Connection, queue and catalog — one hook, because a header that reported
     "offline" beside a queue count from before the line dropped would be worse than
     either fact alone. */
  const till = useOfflineTill(siteId)

  /*
   * Baskets parked on THIS machine, with no server involved.
   *
   * Kept in state rather than read inside the modal so the badge and the list agree —
   * the same reason `savedTally` exists. Re-read after every park, recall and discard,
   * because IndexedDB has no change notification and a stale list offers a basket
   * that is not there.
   */
  const [localBaskets, setLocalBaskets] = useState<SavedEntry[]>([])

  const reloadLocalBaskets = useCallback(async () => {
    const rows = await listParkedOffline(siteId).catch(() => [])
    setLocalBaskets(
      rows.map((row) => ({
        key: `l:${row.uid}`,
        where: 'till' as const,
        documentId: null,
        uid: row.uid,
        customerName: row.customerName,
        totalIncl: row.totalIncl,
        lineCount: row.itemCount,
        at: row.parkedAt,
      })),
    )
  }, [siteId])

  useEffect(() => {
    void reloadLocalBaskets()
  }, [reloadLocalBaskets])

  const terminal = device ? terminals.find((t) => t.deviceId === device) : undefined
  // `device === null` only means "not resolved yet", so the warning waits for it
  // rather than flashing on every load.
  const unclaimed = device !== null && terminal === undefined

  /*
   * ── WHERE THE PENDING CHANGES COME FROM ──────────────────────────────
   *
   * The props on a render that had a network, and IndexedDB on one that did
   * not — the same fallback the quick keys use further down, for the same
   * reason: a till that reloads with the line down must still change its
   * prices at six.
   *
   * With ONE difference that matters. An empty `quickKeys` prop means the
   * render had no server; an empty `pendingPrices` is the ordinary case, since
   * most days a shop has nothing scheduled. So "props are empty, read storage"
   * cannot be the rule here, or a cancelled change would go on applying itself
   * forever. The quick keys are the tell instead: they arrive in the same
   * render, and a shop that has set any up never legitimately has none.
   */
  const [heldPrices, setHeldPrices] = useState<PendingSchedule[] | null>(null)
  useEffect(() => {
    if (quickKeys.length > 0) return
    let cancelled = false
    void storedPendingPrices(siteId).then((held) => {
      if (!cancelled) setHeldPrices(held)
    })
    return () => {
      cancelled = true
    }
  }, [siteId, quickKeys.length])

  const pendingPrices =
    quickKeys.length > 0 ? pendingPricesProp : (heldPrices ?? pendingPricesProp)

  /* ── Specials and scheduled prices, re-checked as the clock moves ──────
     A basket can sit open while a window opens or closes, so this ticks as well
     as recomputing on every change. A slip that kept a price the shop stopped
     offering ten minutes ago is a slip the till and the shelf edge disagree
     about.

     A scheduled price change is the same kind of event — something that becomes
     true while a till is simply sitting there — so it rides the same tick. */
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (specials.length === 0 && pendingPrices.length === 0) return
    const timer = setInterval(() => setClock(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [specials.length, pendingPrices.length])

  /*
   * What every product costs right now, after any scheduled change that is due.
   *
   * Built ONCE per tick rather than searched per line: a whole-catalogue change
   * carries thousands of entries and this recomputes on every keystroke.
   *
   * Thirty seconds of granularity means a six o'clock change can be up to
   * half a minute late on a till nobody is touching. On one being used, every
   * keypress rebuilds it — so in practice the first sale after six is already
   * at the new price.
   */
  const priceIndex = useMemo(
    () => pendingPriceIndex(pendingPrices, new Date(clock)),
    [pendingPrices, clock],
  )

  /** The price to charge for a product, scheduled change included. */
  const priceFor = useCallback(
    (product: TillProduct) => resolvedFromIndex(product, priceStructureId, priceIndex),
    [priceIndex, priceStructureId],
  )

  /*
   * SPECIALS DO NOT APPLY TO A RETURN.
   *
   * An empty list in return mode rather than filtering the result afterwards, because
   * the engine's job is "what promotion does this basket earn" and a basket of goods
   * coming BACK earns none. A "buy 2 get 1 free" that triggered here would credit a
   * customer for a promotion they are handing in — and a mix-and-match one would price
   * the return at the promotional rate rather than at what was actually paid.
   *
   * The honest limitation, stated: without a receipt the till credits the CURRENT shelf
   * price, which is not necessarily what the customer paid. That is inherent to a
   * no-receipt return rather than a consequence of this line — the alternative is
   * refusing returns with no receipt, which shops do not do.
   */
  const lineSpecials = useMemo(
    () => specialsFor(state.lines, state.returning ? [] : specials, new Date(clock)),
    [state.lines, specials, clock, state.returning],
  )

  /**
   * A discount on the whole sale, spread onto the lines (rule 3).
   *
   * Plain state BESIDE the reducer rather than in it — the reducer is a shared
   * file another session may be editing, and the discount's lifecycle is simple:
   * it dies whenever the basket does. FORCED NULL in return mode — a return
   * credits what was paid, and the price already carries any discount.
   */
  const [docDiscount, setDocDiscount] = useState<DocDiscount>(null)
  const [discountingDoc, setDiscountingDoc] = useState(false)
  const effectiveDocDiscount = state.returning ? null : docDiscount
  const docShares = useMemo(
    () => docDiscountShares(state.lines, lineSpecials, effectiveDocDiscount),
    [state.lines, lineSpecials, effectiveDocDiscount],
  )

  /* An emptied basket takes its discount with it — CLEAR, SET_RETURNING and a
     settled sale all land here, so a recalled or fresh basket cannot inherit
     the last customer's discount. */
  useEffect(() => {
    if (state.lines.length === 0 && docDiscount) setDocDiscount(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lines.length])

  const totals = useMemo(
    () => totalsFor(state.lines, lineSpecials, docShares),
    [state.lines, lineSpecials, docShares],
  )

  /**
   * The service charge a bill of this size would earn, ignoring whether a table is
   * attached.
   *
   * Split from the table test on purpose: `table` is declared several hundred lines below
   * this — moving either would mean reordering state in a file another session also edits —
   * so the AMOUNT is resolved here and the tables-only rule applied at the render site,
   * where `table` is in scope. `serviceChargeOn` below is the one the pad receives.
   *
   * Computed on the CLIENT from tiers the page shipped, using the same `serviceChargeFor`
   * the server runs at finalise, so the figure the customer is told and the tip the server
   * writes come from one implementation. The server recomputes it regardless.
   */
  const serviceChargeForTotal = useMemo(
    () => serviceChargeFor(totals.doc.totalIncl, serviceTiers),
    [totals.doc.totalIncl, serviceTiers],
  )

  /* ── Search ───────────────────────────────────────────────────────────
     Debounced at 180ms: a scanner types a whole barcode in milliseconds, and
     querying per character would fire a dozen useless round trips.

     Typing also SWITCHES THE PANE to results. Requiring Enter or a Search tap
     first was the earlier behaviour and it is wrong: a cashier who types three
     letters and sees the quick keys unchanged concludes the search is broken and
     types harder. Two characters is the threshold because one letter matches
     most of the shop. */
  useEffect(() => {
    const term = state.query.trim()
    /*
     * An emptied box does NOT clear the results.
     *
     * ADD empties the box so the next scan starts clean, and a scanner appends —
     * a barcode landing after "milk" resolves to nothing. But the tiles the
     * cashier just used must stay put, so a short query only stops searching
     * rather than tearing down what is on screen. Leaving the search pane is a
     * deliberate tap on Back.
     */
    if (term.length < 2) return
    const timer = setTimeout(() => {
      setSearching(true)
      dispatch({ type: 'SHOW_SEARCH', term })
      /* Offline: search what is stored. Falling back on a THROW as well as on the
         known-offline flag, because a search that dies mid-keystroke must show the
         stored catalog rather than an empty pane that reads as "no such product". */
      const lookup = till.online
        ? searchProductsAction(term, priceStructureId).catch(() => searchOffline(siteId, term))
        : searchOffline(siteId, term)
      lookup
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [state.query, priceStructureId, dispatch, till.online, siteId])

  /* ── Department browse ────────────────────────────────────────────────
     Products directly in the open department. Fetched rather than shipped with
     the page: a store with 20,000 products cannot send its whole catalogue on
     every till load, and phase 4 replaces this with the offline catalogue. */
  const openDepartment =
    state.catalog.kind === 'departments'
      ? state.catalog.path[state.catalog.path.length - 1]
      : null

  useEffect(() => {
    if (openDepartment == null) {
      setBrowse({ loading: false, products: [] })
      return
    }
    let cancelled = false
    setBrowse({ loading: true, products: [] })
    /* departmentId, not a list: the action expands one id into its whole subtree
       server-side, which is what makes drilling into "Groceries" show everything
       beneath it rather than only what is filed directly there.

       ⚠ The offline fallback CANNOT do that expansion — Dexie indexes a product's
       own department and knows nothing of the tree — so drilling offline shows what
       is filed directly in the department that was opened. A visible difference, and
       the honest one: inventing a subtree walk here would be a second definition of
       "what is in this department" that could disagree with the server's. */
    const lookup = till.online
      ? browseProductsAction({ departmentId: openDepartment, priceStructureId, limit: 200 }).catch(
          () => browseOffline(siteId, openDepartment),
        )
      : browseOffline(siteId, openDepartment)
    lookup
      .then((products) => {
        if (!cancelled) setBrowse({ loading: false, products })
      })
      .catch(() => {
        if (!cancelled) setBrowse({ loading: false, products: [] })
      })
    return () => {
      cancelled = true
    }
  }, [openDepartment, priceStructureId, till.online, siteId])

  /* ── Actions ──────────────────────────────────────────────────────────── */

  function add(product: TillProduct, qty = 1) {
    /*
     * Some products cannot be sold with the server gone, and it is kinder to refuse
     * at the tile than at the tender pad with a queue waiting. A serial-tracked item
     * needs the serial table to pick a unit and to mark it sold in the same
     * transaction as the movement; a recipe or a refer item needs a live resolve.
     * None of that has an offline equivalent, and posting a guess at it later would
     * corrupt stock the shop cannot reconcile.
     */
    if (!till.online) {
      const blocked = offlineBlockedProduct(product)
      if (blocked) {
        toast.error(blocked)
        return
      }
    }

    /*
     * A scale item with no weight yet gets weighed BEFORE anything else. A
     * scale barcode arrives with the weight embedded (scannedQty) and passes
     * straight through; a tile, a search or a typed code has none, and ringing
     * up "1" of something sold per kilogram is a silent overcharge. Checked
     * here because every way of adding a product converges on add() — the path
     * a narrower check would miss is the scanner, most of a shop's volume.
     */
    if (product.scaleItem && product.scannedQty == null) {
      setWeighing(product)
      return
    }

    /*
     * If this product has questions, ask them before the line exists.
     *
     * Every way of adding a product converges here — a tile, the department
     * rail, a quick key, a scanner — so this one check covers all of them. Put
     * anywhere else it would cover one path and quietly miss the others, and the
     * one it missed would be the scanner, which is most of a shop's volume.
     */
    const asks = product.id === null ? [] : (instructions.byProduct[product.id] ?? [])
    if (asks.length > 0) {
      setAsking({ product, qty, groups: asks })
      return
    }

    dispatch({ type: 'ADD', product, qty, resolvedIncl: priceFor(product) })
  }

  /**
   * A typed or scanned code.
   *
   * Resolved as a barcode FIRST and added straight to the basket, because that is
   * what a scanner sends and it must feel instant. Only when nothing matches
   * exactly does the same string become a search — so a cashier who typed part of
   * a name gets tiles rather than an error.
   */
  function submitCode(code: string) {
    startTransition(async () => {
      /* Offline, a scan resolves against the stored catalog. Same order — barcode
         then code — because that is what makes a scanner gun feel instant. */
      const product = till.online
        ? await scanAction(code, priceStructureId).catch(() => findByCode(siteId, code))
        : await findByCode(siteId, code)
      if (product) {
        add(product, product.scannedQty ?? 1)
        return
      }
      dispatch({ type: 'SHOW_SEARCH', term: code })
      if (results.length === 0 && !searching) {
        toast.info(`No barcode matched "${code}" — searching instead.`)
      }
    })
  }

  /**
   * Posting the sale.
   *
   * Goes through `finaliseSaleAction` — the same action the desk till uses, which
   * saves the draft and finalises in one round trip so there is never a window
   * where a sale exists as a draft nobody meant to keep. The server recomputes
   * every total from the stored lines and re-checks the pricing, so what is sent
   * here is what was CHARGED rather than a claim about what is owed.
   */
  /**
   * Completing the sale on the till itself, because the server cannot be reached.
   *
   * Not a lesser path — it is the reason this whole feature exists. The basket's
   * figures were computed by documentMath and specialsEngine, the same modules the
   * server recomputes with at sync, so the slip this prints and the invoice that
   * eventually posts agree by construction rather than by luck.
   *
   * Refuses only when the till genuinely cannot RECORD the sale (no local numbering,
   * or IndexedDB unavailable). A sale it cannot record is a sale it must not take —
   * that refusal happens before any slip prints, with the goods still on the counter.
   */
  async function finaliseLocally(
    paid: { tenderTypeId: number; amount: number; reference?: string | null }[],
    /**
     * Tips, from the pad.
     *
     * Defaulted, so the offline RETRY path and any other caller behave as before.
     */
    tipInfo: { declared: Record<number, number>; serviceChargeWaived: boolean } = {
      declared: {},
      serviceChargeWaived: false,
    },
  ) {
    const tendered = paid.reduce((sum, p) => sum + p.amount, 0)
    const charge = tipInfo.serviceChargeWaived ? 0 : serviceCharge

    /*
     * ── THE OFFLINE SLIP MUST NOT PROMISE THE TIP BACK AS CHANGE ────────────
     *
     * This used to report `tendered - totalIncl` as change, which offline is the WHOLE
     * excess. So a customer leaving a R150 tip on a card was told the till owed them R150 —
     * and at sync the server planned no tip either, so the money silently became change on
     * the books. Both halves wrong, in the same direction, with nothing to notice it.
     *
     * `planTips` is the same function the online pad and the server both run, so the figure
     * printed here is the figure that eventually posts.
     */
    const plan = planTips({
      totalExcess: Math.max(0, tendered - totals.doc.totalIncl),
      tenders: paid.flatMap((p) => {
        const type = tenders.find((t) => t.id === p.tenderTypeId)
        return type
          ? [
              {
                tenderTypeId: type.id,
                amount: p.amount,
                allowsChange: type.allowsChange,
                tipOnOverTender: type.tipOnOverTender,
                tenderName: type.name,
              },
            ]
          : []
      }),
      declared: tipInfo.declared,
      serviceCharge:
        charge > 0.005 && paid[0] ? { tenderTypeId: paid[0].tenderTypeId, amount: charge } : null,
    })
    const result = await finaliseOffline({
      siteId,
      terminal: terminal ? { id: terminal.id, code: terminal.code } : null,
      operator: { userId: operatorUserId, name: operatorName },
      shiftId: await currentShiftId(siteId),
      customer: {
        id: state.customer?.id ?? null,
        // `||` not `??` — an untyped name trims to '', which is not nullish.
        name: state.customer?.name || state.customerName.trim() || 'Walk-in',
        vatNumber: state.customer?.vatNumber ?? null,
        phone: state.customer?.phone ?? null,
      },
      priceStructureId,
      lines: salePayloadLines(state.lines, lineSpecials, docShares),
      tenders: paid.map((p) => ({
        tenderTypeId: p.tenderTypeId,
        tenderCode: tenders.find((t) => t.id === p.tenderTypeId)?.code ?? '',
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      totalIncl: totals.doc.totalIncl,
      tenderedTotal: tendered,
      /* AFTER tips — see the plan above. A refused plan falls back to the raw excess, which
         is the pre-tip behaviour and never promises less than is owed. */
      change: plan.ok ? plan.changeRemaining : Math.max(0, tendered - totals.doc.totalIncl),
      declaredTips: tipInfo.declared,
      serviceCharge: charge,
      // Supervisor approvals given at this counter — the sync re-derives them.
      overrides: offlineOverridesRef.current.length > 0 ? [...offlineOverridesRef.current] : undefined,
    })

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    offlineOverridesRef.current = []

    setTendering(false)
    setEditing(null)
    setConfirmClear(false)
    setPickingCustomer(false)
    setReceipt({
      number: result.documentNumber,
      change: result.change,
      /* No document id — nothing has posted, so there is nothing to open or void
         through the back office. The receipt hides both buttons on a zero id, and
         cancelling an unsynced sale is the outbox screen's job. */
      documentId: 0,
      total: totals.doc.totalIncl,
    })
    dispatch({ type: 'CLEAR' })
    // The badge must move immediately: this sale is now the till's responsibility
    // and the cashier has to be able to see that it is waiting.
    await till.recount()
    toast.success(`${result.documentNumber} saved on this till — it will send itself.`)
  }

  function finalise(
    paid: { tenderTypeId: number; amount: number; reference?: string | null }[],
    voucherCodes: string[] = [],
    /**
     * Tips, from the pad.
     *
     * Defaulted so every other caller — the quick-key runner, the offline retry — is
     * unchanged: no declared tips and no waiver is exactly the behaviour before tips
     * existed.
     */
    tipInfo: { declared: Record<number, number>; serviceChargeWaived: boolean } = {
      declared: {},
      serviceChargeWaived: false,
    },
  ) {
    /*
     * A waived service charge is recorded BEFORE the sale posts, not after.
     *
     * The removal is the fact worth keeping even if the sale then fails — a manager who
     * took a charge off a bill that was never completed still took it off, and a shop
     * looking at who removes them wants that visible. It is also fire-and-forget: a
     * failure to write the audit row must never stop a customer paying.
     */
    if (tipInfo.serviceChargeWaived && serviceCharge > 0.005) {
      void recordServiceChargeWaivedAction(state.documentId, serviceCharge).catch(() => {})
    }

    /* Known to be offline: go straight to the local path rather than spending four
       seconds on a doomed request with a customer waiting. */
    if (!till.online) {
      startTransition(() => finaliseLocally(paid, tipInfo))
      return
    }

    startTransition(async () => {
      /*
       * THE CASE THAT MATTERS MOST: the line drops between opening the tender pad
       * and confirming it.
       *
       * `navigator.onLine` is still true, the request goes out, and it dies. A
       * server action that throws would surface as an unhandled rejection and the
       * cashier would be left holding a tendered basket with no slip and no
       * explanation — the exact moment this whole feature is supposed to cover, and
       * the one where failing would be least forgivable.
       *
       * So a TRANSPORT failure falls through to the local path. A refusal from the
       * server does not: that is a real answer about this sale (an over-limit
       * account, a locked period) and queueing it offline would smuggle past a rule
       * the server had just correctly applied.
       */
      let result: Awaited<ReturnType<typeof finaliseSaleAction>>
      try {
        result = await finaliseSaleAction(
          state.documentId,
          {
            // The id is what makes it an ACCOUNT sale; a name alone is a walk-in
            // snapshot on the document and creates no debtor record.
            customerId: state.customer?.id ?? null,
            /* `||`, NOT `??`, for the walk-in fallback.
               An untyped name trims to '' — which is not nullish, so `??` let it
               through and the document ended up with the literal string "null" as
               its customer name. Verified against real rows before this was fixed. */
            customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
            customerVatNo: state.customer?.vatNumber ?? null,
            customerPhone: state.customer?.phone ?? null,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            lines: salePayloadLines(state.lines, lineSpecials, docShares),
          },
          paid,
          voucherCodes,
          {
            declaredTips: tipInfo.declared,
            /* Zero when a manager waived it, so the server writes no service tip. The
               waiver itself was recorded above — the charge does not silently disappear,
               it disappears with a name against it. */
            serviceCharge: tipInfo.serviceChargeWaived ? 0 : serviceCharge,
          },
          // A supervisor's approval, if one was given for this basket.
          spendOverrideToken(),
        )
      } catch {
        await finaliseLocally(paid, tipInfo)
        // Re-check the connection so the header stops claiming to be online.
        void till.refresh()
        return
      }

      if (!result.ok) {
        // The draft is left behind deliberately when a post is refused — there is
        // a customer standing there, and losing the basket is worse than showing
        // the reason and letting them fix it.
        toast.error(result.error)
        return
      }

      // EVERY dialog closes, not just the tender pad. A line editor left open
      // behind the receipt would still be there when the next customer's basket
      // starts, pointed at a line that no longer exists.
      setTendering(false)
      setEditing(null)
      setConfirmClear(false)
      setPickingCustomer(false)
      setReceipt({
        number: result.documentNumber,
        change: result.change,
        documentId: result.documentId,
        /* Read from `totals` here, BEFORE the CLEAR below empties the basket.
           Reading it in the void dialog instead would show R0.00, because by then
           the basket it was computed from is gone. */
        total: totals.doc.totalIncl,
      })
      dispatch({ type: 'CLEAR' })

      /*
       * The table is released by the ACT of paying, not by the screen remembering to.
       *
       * Keyed off the DOCUMENT rather than off `table`, so it also frees a bill somebody
       * settled from a different till — and so a crash between finalising and this leaves
       * a stuck table visible on the gate rather than money unaccounted for.
       *
       * NOT a third `if (hospitality)`: in retail no table holds the document, so this is
       * a no-op that costs one indexed UPDATE. Guarding it would be the fourth read the
       * docblock warns about.
       */
      if (table) {
        const freed = await tablePaidAction(result.documentId).catch(() => null)
        if (freed?.ok) setTables(freed.tables)
        setTable(null)
        // Back to the floor: the next thing a waiter does is serve a different table.
        setChoosingTable(true)
      }

      // The saved-sale count and any stock figures on screen are now stale.
      router.refresh()
    })
  }

  /**
   * Takes a return.
   *
   * The same shape as `finalise`, and deliberately so — online first, falling through to
   * the local queue on a TRANSPORT failure but never on a refusal. A server that refuses
   * a credit note has said something true about it (a locked VAT period, a tender that
   * cannot be refunded here), and queueing it offline would smuggle past a rule the
   * server had just correctly applied.
   *
   * ── NO RECEIPT, EVEN ONLINE ──────────────────────────────────────────────
   *
   * `invoiceId: null` on both paths. The till has no way to ask "which invoice was this?"
   * — it has no receipt scanner and no invoice search — so every return taken here is a
   * no-receipt return, and the over-credit guard has nothing to guard. A RECEIPTED return
   * stays a back-office job, where `creditableLines` can show what is left to credit
   * against the actual sale. Making that work here needs the invoice on screen first, and
   * pretending otherwise would credit the same invoice twice.
   */
  async function confirmReturn(
    given: { tenderTypeId: number; amount: number; reference?: string | null }[],
    reason: { reasonId: number; note: string | null },
  ) {
    const lines = returnPayloadLines(state.lines)
    const total = totals.doc.totalIncl

    if (!till.online) {
      startTransition(() => returnLocally(given, reason, lines, total))
      return
    }

    startTransition(async () => {
      let result: Awaited<ReturnType<typeof createCreditNoteAction>>
      try {
        result = await createCreditNoteAction({
          invoiceId: null,
          customerId: state.customer?.id ?? null,
          customerName: state.customer?.name || state.customerName.trim() || null,
          reasonId: reason.reasonId,
          note: reason.note,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          lines: lines.map((l) => ({
            sourceLineId: null,
            productId: l.productId,
            productCode: l.productCode,
            description: l.description,
            productType: l.productType,
            departmentId: l.departmentId,
            qty: l.qty,
            unitPriceIncl: l.unitPriceIncl,
            vatRatePct: l.vatRatePct,
            unitCostExcl: l.unitCostExcl,
          })),
          refunds: given,
        })
      } catch {
        // The line dropped mid-refund. Queue it locally rather than losing the record.
        await returnLocally(given, reason, lines, total)
        void till.refresh()
        return
      }

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      setReturning(false)
      setEditing(null)
      setPickingCustomer(false)
      setReceipt({
        number: result.documentNumber,
        /* No change on a refund — the cashier hands back a stated amount, there is
           nothing to give back on top of it. */
        change: 0,
        documentId: result.documentId,
        total,
      })
      dispatch({ type: 'CLEAR' })
      router.refresh()
    })
  }

  /** The offline half of the above. */
  async function returnLocally(
    given: { tenderTypeId: number; amount: number; reference?: string | null }[],
    reason: { reasonId: number; note: string | null },
    lines: ReturnType<typeof returnPayloadLines>,
    total: number,
  ) {
    const result = await returnOffline({
      siteId,
      terminal: terminal ? { id: terminal.id, code: terminal.code } : null,
      operator: { userId: operatorUserId, name: operatorName },
      /* Null: the operator is the authoriser on this path. A supervisor override would
         set this, and the server re-derives whoever it names rather than trusting it. */
      authorisedBy: null,
      shiftId: await currentShiftId(siteId),
      customer: state.customer
        ? { id: state.customer.id, name: state.customer.name }
        : state.customerName.trim()
          ? { id: null, name: state.customerName.trim() }
          : null,
      reasonId: reason.reasonId,
      note: reason.note,
      lines,
      refunds: given.map((g) => ({
        tenderTypeId: g.tenderTypeId,
        tenderCode: tenders.find((t) => t.id === g.tenderTypeId)?.code ?? '',
        amount: g.amount,
        reference: g.reference ?? null,
      })),
      totalIncl: total,
      refundTotal: given.reduce((sum, g) => sum + g.amount, 0),
    })

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    setReturning(false)
    setEditing(null)
    setPickingCustomer(false)
    setReceipt({
      number: result.documentNumber,
      change: 0,
      /* Zero — nothing has posted, so there is nothing to open or void through the back
         office. The receipt hides both buttons on a zero id. */
      documentId: 0,
      total,
    })
    dispatch({ type: 'CLEAR' })
  }

  /**
   * Parking the basket so the next customer can be served.
   *
   * Two calls, in this order, and the order matters: `saveSaleAction` writes the
   * lines (creating the draft if there is not one yet), then `saveForLaterAction`
   * flips it to `saved`. Flipping first would park an empty basket.
   */
  /**
   * Parking locally, because there is no server to park against.
   *
   * A parked basket is NOT a sale — nobody has paid and no number has been issued —
   * so it does not go in the outbox, which is reserved for money that has already
   * changed hands. See parkOffline.
   */
  async function parkLocally() {
    try {
      await parkOffline(siteId, {
        customerId: state.customer?.id ?? null,
        customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
        customerVatNo: state.customer?.vatNumber ?? null,
        customerPhone: state.customer?.phone ?? null,
        priceStructureId,
        lines: salePayloadLines(state.lines, lineSpecials, docShares),
        totalIncl: totals.doc.totalIncl,
      })
    } catch {
      // Nothing was stored, so the basket must STAY on screen. Clearing it here
      // would throw away a basket the cashier believes is safe.
      toast.error('This basket could not be set aside on the till. It is still here.')
      return
    }
    toast.success('Sale saved on this till.')
    dispatch({ type: 'CLEAR' })
    setSavedTally((n) => n + 1)
  }

  /**
   * Park the basket.
   *
   * `label` overrides what the sale is currently called — the Close flow passes
   * the name straight from the dialog rather than setting state and hoping the
   * re-render lands before this runs, which it would not.
   */
  function park(label?: string, details?: { people: number | null; visitTypeId: number | null }) {
    if (!till.online) {
      startTransition(parkLocally)
      return
    }
    const reference = (label ?? tabLabel ?? '').trim() || null
    const people = details ? details.people : tabPeople
    const visitTypeId = details ? details.visitTypeId : tabVisitTypeId
    startTransition(async () => {
      /* Same fallback as finalise: a transport failure mid-park must not leave the
         cashier with a basket they think is saved and is not. A REFUSAL still stands
         — that is a real answer about this basket. */
      let saved: Awaited<ReturnType<typeof saveSaleAction>>
      try {
        saved = await saveSaleAction(state.documentId, {
          customerId: state.customer?.id ?? null,
          customerName:
            state.customer?.name ||
            state.customerName.trim() ||
            tabCustomer.trim() ||
            'Walk-in',
          customerVatNo: state.customer?.vatNumber ?? null,
          customerPhone: state.customer?.phone ?? null,
          /* What the floor will CALL this bill. Without it the tab lists under
             the customer's name, or "N/A" — findable, but not what the waiter
             typed. */
          reference,
          personCount: people,
          visitTypeId,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          priceStructureId,
          lines: salePayloadLines(state.lines, lineSpecials, docShares),
        },
        /* PEEKED, not spent: the same approval must still cover the finalise —
           the token verifies statelessly, so parking does not use it up. */
        overrideTokenRef.current ?? undefined)
      } catch {
        await parkLocally()
        void till.refresh()
        return
      }
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      let parked: Awaited<ReturnType<typeof saveForLaterAction>>
      try {
        parked = await saveForLaterAction(saved.documentId)
      } catch {
        /*
         * The draft IS written — the first call succeeded — it just never flipped to
         * `saved`. Parking a second copy locally would duplicate the basket, so the
         * honest answer is to say where it is: a draft on this terminal, which the
         * saved-sales list picks up as soon as the connection returns.
         */
        toast.info('The connection dropped. This basket is on the server as a draft — it will show in Saved sales.')
        dispatch({ type: 'CLEAR' })
        void till.refresh()
        return
      }
      if (!parked.ok) {
        toast.error(parked.error)
        return
      }
      toast.success(reference ? `${reference} saved.` : 'Sale saved.')
      dispatch({ type: 'CLEAR' })
      // Counted optimistically rather than waiting for the server: the badge is
      // a hint, and the modal corrects it from the real query the moment it opens.
      setSavedTally((n) => n + 1)

      /* Back to the floor, with the tab's identity dropped so the next sale does
         not inherit this one's name. In hospitality the gate IS where a waiter
         goes next; in retail there is no gate and the till simply empties. */
      clearTabIdentity()
      if (hospitality) {
        setTable(null)
        setChoosingTable(true)
        refreshTables()
      }
      router.refresh()
    })
  }

  /** Forget what this basket was called. Always paired with a CLEAR. */
  function clearTabIdentity() {
    setTabLabel(null)
    setTabCustomer('')
    setTabPeople(null)
    setTabVisitTypeId(null)
  }

  /**
   * The Close key.
   *
   * ── CLOSE IS HOW A TAB IS PARKED ──────────────────────────────────────────
   *
   * In a restaurant a waiter rings up drinks and walks away; the bill stays open
   * for an hour. There is no separate "save" step in that motion, and a Close
   * that threw the basket away would lose a real order every time somebody hit
   * the wrong key. So Close SAVES whatever it can identify:
   *
   *   empty basket        → nothing to save; just leave.
   *   already has a name  → park it silently and go back to the floor.
   *   no name yet         → ask: save it (naming it), void it, or carry on.
   *
   * The third case is the only one that interrupts, and it interrupts precisely
   * because there is no way to answer it on the waiter's behalf: an unnamed
   * basket cannot be found again once it leaves the screen.
   */
  function closeSale() {
    if (state.lines.length === 0) {
      // Nothing to lose. Leaving is the whole intent of the key.
      clearTabIdentity()
      dispatch({ type: 'CLEAR' })
      if (hospitality) {
        setTable(null)
        setChoosingTable(true)
      }
      return
    }

    /* A seated table is already named by its own code, and its bill is already on
       the server via the debounce — so Close is just "go back to the floor". */
    if (table) {
      clearTabIdentity()
      dispatch({ type: 'CLEAR' })
      setTable(null)
      setChoosingTable(true)
      refreshTables()
      toast.success(`${table.code} saved.`)
      return
    }

    if (tabLabel) {
      park()
      return
    }

    setClosePrompt(true)
  }

  /** The dialog came back with a name. Open a tab on it, or park onto it. */
  function nameTab(details: NewTableDetails, closing: boolean) {
    const label = details.tableNumber || details.customerName
    setTabLabel(label)
    setTabCustomer(details.customerName)
    setTabPeople(details.personCount || null)
    setTabVisitTypeId(details.visitTypeId)
    setNaming(null)

    if (closing) {
      /* Passed through rather than read back off state: this runs in the same
         tick as the setState calls above, so `tabLabel` is still the old value
         when park() reads it. */
      park(label, {
        people: details.personCount || null,
        visitTypeId: details.visitTypeId,
      })
      return
    }

    /* Opening a new table: drop into an empty till on it. Nothing is written
       until the first line lands — same reasoning as a seated table. */
    dispatch({ type: 'CLEAR' })
    setTable(null)
    setChoosingTable(false)
  }

  /** Put an open tab back on screen. */
  function resumeTab(tab: OpenTab) {
    startTransition(async () => {
      const result = await recallSaleForTillAction(tab.documentId, priceStructureId)
      if (!result.ok) {
        toast.error(result.error)
        // Another till took it while this waiter was looking. Re-read rather
        // than leaving a tile they will only tap again.
        refreshTables()
        return
      }
      /* The tab keeps its identity, so closing it again re-parks under the same
         label rather than prompting for a new one. */
      setTabLabel(tab.label)
      setTabCustomer(tab.customerName ?? '')
      setTabPeople(tab.personCount)
      setTabVisitTypeId(tab.visitTypeId)
      setTable(null)
      setChoosingTable(false)
      setDocDiscount(null) // a recalled basket must not inherit the last one's discount
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        customer: null,
        customerName: result.customerName ?? '',
      })
    })
  }

  /** Putting a basket parked on THIS till back on screen. */
  async function recallLocally(uid: string) {
    const row = await recallOffline(siteId, uid)
    if (!row) {
      // Already taken — the only way is a double tap, since a local basket is not
      // visible from anywhere else.
      toast.error('That basket is no longer here.')
      setShowingSaved(false)
      return
    }
    setDocDiscount(null) // a recalled basket must not inherit the last one's discount
    dispatch({
      type: 'LOAD',
      documentId: null,
      lines: row.lines as BasketLine[],
      /* Not restored as an ACCOUNT, for the same reason the online recall does not:
         offering credit against a balance parked yesterday is what the tender pad's
         headroom check exists to prevent — and offline there is no balance to read at
         all. The NAME comes back so the basket is not anonymous. */
      customer: null,
      customerName: row.customerName ?? '',
    })
    setShowingSaved(false)
    setSavedTally((n) => Math.max(0, n - 1))
    toast.success('Sale recalled.')
  }

  /** Putting a parked basket back on screen. */
  function recall(documentId: number) {
    startTransition(async () => {
      const result = await recallSaleForTillAction(documentId, priceStructureId)
      if (!result.ok) {
        toast.error(result.error)
        // The list is now stale — another till took it — so close and let the
        // cashier re-open onto a fresh one.
        setShowingSaved(false)
        return
      }
      setSavedTally((n) => Math.max(0, n - 1))
      setDocDiscount(null) // a recalled basket must not inherit the last one's discount
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        /* Not restored as an ACCOUNT. The document carries a customer id, but
           re-attaching would need the live credit position, and offering credit
           against a balance parked yesterday is what the tender pad's headroom
           check exists to prevent. The NAME comes back so the basket is not
           anonymous; the cashier re-attaches, which re-reads the balance. */
        customer: null,
        customerName: result.customerName ?? '',
      })
      if (result.customerId) {
        toast.info(`${result.customerName ?? 'That account'} needs re-attaching to pay on account.`)
      }
      setShowingSaved(false)
      toast.success('Sale recalled.')
    })
  }

  /**
   * Reversing the sale just taken.
   *
   * Stock goes back, the payment is reversed, and the document keeps its number as
   * `cancelled` — which is what makes the gap in the invoice run explainable
   * rather than missing. All of that is `voidDocument`'s work; this only asks.
   */
  function voidSale(reason: { reasonId: number; note: string | null }) {
    if (!receipt) return
    startTransition(async () => {
      const result = await voidSaleAction(receipt.documentId, reason, spendOverrideToken())
      if (!result.ok) {
        // Left open with the reason still chosen: the likely refusals are a locked
        // VAT period or a payment already allocated against the sale, and both
        // need somebody to read the message rather than start again.
        toast.error(result.error)
        return
      }
      toast.success(`${receipt.number} voided.`)
      setVoiding(false)
      setReceipt(null)
      // Stock and the saved-sale count have both moved.
      router.refresh()
    })
  }

  /* ── What the attached member is holding ─────────────────────────────────
     Re-read whenever the customer changes AND whenever the tender pad opens: a balance
     can move at another till while a basket sits on screen, and the figure a cashier is
     about to quote should be the current one.

     Failures collapse to null — loyalty must never be able to block a sale, and a till
     that refused to take cash because a points lookup timed out would be worse than one
     with no loyalty at all. */
  const [loyalty, setLoyalty] = useState<TillStanding | null>(null)

  useEffect(() => {
    const customerId = state.customer?.id
    if (!customerId || !till.online) {
      setLoyalty(null)
      return
    }
    let cancelled = false
    void tillStandingAction(customerId)
      .then((standing) => {
        if (!cancelled) setLoyalty(standing)
      })
      .catch(() => {
        if (!cancelled) setLoyalty(null)
      })
    return () => {
      cancelled = true
    }
    /* `tendering` is a dependency on purpose: opening the pad re-reads the balance, which
       is the moment it matters most. */
  }, [state.customer?.id, tendering, till.online])

  /* ── The floor ──────────────────────────────────────────────────────────
     Only in hospitality. In retail `tables` is empty, the gate never mounts, and this
     costs one unused state slot rather than a branch through the rest of the file. */
  const [tables, setTables] = useState<PosTable[]>(initialTables)
  /** The table this basket belongs to, or null for a walk-in. */
  const [table, setTable] = useState<PosTable | null>(null)

  /* ── Open tabs ────────────────────────────────────────────────────────────
     Every bill running in the SHOP, which is what the gate lists. Distinct from
     `tables` above: that is the shop's furniture (and the drawn floor plan),
     this is the trade. A tab is a `sales_documents` row parked with a label a
     waiter typed — see `listOpenTabsAction`. */
  const [tabs, setTabs] = useState<OpenTab[]>([])

  /**
   * What this basket is CALLED, and who is on it.
   *
   * Held here rather than derived from the basket because the label is decided
   * BEFORE anything is rung up — a waiter names the tab, then starts adding to
   * it — and because Close has to know whether the sale already has a name to
   * park under, or needs to ask for one.
   *
   * Null label means an unnamed sale: a quick sale, or a walk-in that has not
   * been given a table. That is precisely the case Close prompts about.
   */
  const [tabLabel, setTabLabel] = useState<string | null>(null)
  const [tabCustomer, setTabCustomer] = useState('')
  const [tabPeople, setTabPeople] = useState<number | null>(null)
  const [tabVisitTypeId, setTabVisitTypeId] = useState<number | null>(null)

  /** The Create-new-table dialog. `closing` means Close asked for the name. */
  const [naming, setNaming] = useState<null | { closing: boolean }>(null)
  /** Close was tapped on an unnamed sale: save it, void it, or carry on. */
  const [closePrompt, setClosePrompt] = useState(false)

  /**
   * The service charge actually applying to THIS bill.
   *
   * `tips_tables_only` defaults on, and on a retail till `table` is always null — so the
   * charge is zero and the pad never mentions it, which is what keeps the feature invisible
   * to a shop that does not serve tables.
   */
  const serviceCharge = tipsTablesOnly && !table ? 0 : serviceChargeForTotal
  /** True while the waiter is choosing — the gate stands in front of the till. */
  const [choosingTable, setChoosingTable] = useState(hospitality)
  /** The gate's split mode is armed — the next table tap opens the split screen. */
  const [armedForSplit, setArmedForSplit] = useState(false)
  /** The table being split, and its lines. Null when the split screen is closed. */
  const [splitting, setSplitting] = useState<{
    table: PosTable
    lines: SplitLine[]
  } | null>(null)

  /**
   * Opens the split screen for a table.
   *
   * The lines are fetched rather than taken from `table`, which carries only a count and
   * a total — a split needs each line's id, quantity and price, and those live on the
   * document. Disarms the mode either way: a fetch that failed and left the gate armed
   * would have the next tap open a screen the waiter had stopped expecting.
   */
  async function openSplit(table: PosTable) {
    setArmedForSplit(false)
    const bill = await billForSplitAction(table.id).catch(() => null)
    if (!bill || bill.lines.length === 0) {
      toast.error('That bill has nothing on it to split.')
      return
    }
    setSplitting({ table, lines: bill.lines })
  }

  /** Writes the split, then re-reads the floor so both halves show. */
  function confirmSplit(toTableId: number, moves: { lineId: number; qty: number }[]) {
    const from = splitting?.table
    if (!from) return
    startTransition(async () => {
      const result = await splitTableAction({ fromTableId: from.id, toTableId, moves })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTables(result.tables)
      setSplitting(null)
      const to = result.tables.find((t) => t.id === toTableId)
      toast.success(`Moved to ${to?.code ?? 'the other table'}.`)
    })
  }

  /**
   * Prints the pro-forma bill for the open tab.
   *
   * The tab is opened SYNCHRONOUSLY (a browser only allows window.open while it
   * can attribute the call to the tap — same trick the store builder uses), then
   * the current basket is pushed to the server so the paper matches the screen,
   * then the blank tab navigates to the print route. Asking for the bill also
   * marks the table amber on the floor — that is what "bill asked" is for.
   */
  function printBill() {
    const documentId = state.documentId
    if (!documentId) return
    if (!till.online) {
      toast.error('Printing a bill needs the connection — the tab lives on the server.')
      return
    }
    const tab = window.open('', '_blank')
    startTransition(async () => {
      try {
        if (table && state.lines.length > 0) {
          const saved = await updateTableBillAction(documentId, {
            customerName: table.code,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            lines: salePayloadLines(state.lines, lineSpecials, docShares),
          })
          if (!saved.ok) {
            tab?.close()
            toast.error(saved.error)
            return
          }
          setTables(saved.tables)
        }
        if (table) {
          const asked = await askForBillAction(table.id)
          if (asked.ok) setTables(asked.tables)
        }
        if (tab) tab.location.href = `/sales/${documentId}/bill`
      } catch {
        tab?.close()
        toast.error('The bill could not be prepared. Try again.')
      }
    })
  }

  /*
   * ── SUPERVISOR OVERRIDES ──────────────────────────────────────────────────
   * One pad, launched from wherever a refusal happened. On approval:
   * online, the minted token rides the NEXT save/finalise/void call and is
   * consumed there; offline, the authorisation is queued and rides the sale's
   * payload, where the sync re-derives the manager's right. Both refs clear
   * when the basket does — an approval must not outlive the sale it was for.
   */
  const [override, setOverride] = useState<{
    capability: Capability
    actionLabel: string
    amount?: number
    documentId?: number | null
    onAuthorised: (auth: { userId: number; name: string; token: string }) => void
  } | null>(null)
  const overrideTokenRef = useRef<string | null>(null)
  const offlineOverridesRef = useRef<NonNullable<OfflineSale['overrides']>>([])

  /** Takes (and clears) the pending token — an approval covers ONE action. */
  function spendOverrideToken(): string | undefined {
    const token = overrideTokenRef.current ?? undefined
    overrideTokenRef.current = null
    return token
  }

  /** The shift modal — float, payouts, and the blind cash-up count. */
  const [managingShift, setManagingShift] = useState(false)
  /** "Shift open · Ruth" for the header chip, or null when none is open. */
  const [shiftLabel, setShiftLabel] = useState<string | null>(null)

  /**
   * Stashes the open shift for the OFFLINE path and redraws the chip.
   *
   * KV.shift is what `currentShiftId` reads when an offline sale banks — it was
   * declared from day one and never written, so every offline sale banked into
   * no shift. Writing it here (on load and on every open/close) is what makes
   * an offline sale land in the right drawer's reconciliation.
   */
  const noteShift = useCallback(
    (shiftId: number | null, userName?: string) => {
      setShiftLabel(shiftId ? `Shift · ${userName ?? 'open'}` : null)
      void kvPut(siteId, KV.shift, shiftId ? { id: shiftId } : null).catch(() => {})
    },
    [siteId],
  )

  /* Seed the chip and KV.shift once the till is up — a shift somebody opened
     from the back office must still catch this till's offline sales. */
  useEffect(() => {
    if (!till.online) return
    void tillShiftStatusAction(terminal?.id ?? null)
      .then((result) => {
        if (!('ok' in result)) noteShift(result.shift?.id ?? null, result.shift?.userName)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [till.online, terminal?.id])

  /** The gate's move mode is armed — the next table tap picks the tab to move. */
  const [armedForTransfer, setArmedForTransfer] = useState(false)
  /** The table whose whole tab is moving. Null when the picker is closed. */
  const [transferring, setTransferring] = useState<PosTable | null>(null)

  /** Arms the destination picker for a seated table. Disarms the mode either way. */
  function openTransfer(fromTable: PosTable) {
    setArmedForTransfer(false)
    if (fromTable.documentId === null || fromTable.state === 'free') {
      toast.error('That table has no open bill to move.')
      return
    }
    setTransferring(fromTable)
  }

  /** Moves the whole tab — the document keeps its identity, only the table changes. */
  function confirmTransfer(toTableId: number) {
    const from = transferring
    if (!from) return
    startTransition(async () => {
      const result = await transferTableAction({ fromTableId: from.id, toTableId })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTables(result.tables)
      setTransferring(null)
      const to = result.tables.find((t) => t.id === toTableId)
      toast.success(`${from.code} moved to ${to?.code ?? 'the other table'}.`)
    })
  }

  /* Re-read after anything that could have changed the floor, and on a slow tick so a
     waiter sees another waiter's table go from open to bill-asked without reloading. A
     restaurant floor is a SHARED screen; a retail till is not, which is why nothing
     equivalent polls in retail. */
  /* Hoisted out of the effect so the gate's Refresh button runs the SAME read the
     timer does. Two paths to "re-read the floor" is two places for it to drift. */
  const refreshTables = useCallback(() => {
    void listTablesAction()
      .then((r) => {
        if (r.ok) setTables(r.tables)
      })
      .catch(() => {})
    /* The tabs come with it: the gate shows both, and two Refresh buttons — or a
       Refresh that updated half the screen — is worse than one read that costs a
       second query. A failure leaves the last good list on screen rather than
       blanking a floor mid-service. */
    void listOpenTabsAction()
      .then(setTabs)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!hospitality) return
    refreshTables()
    const timer = setInterval(refreshTables, 20_000)
    return () => clearInterval(timer)
  }, [hospitality, refreshTables])

  /**
   * Writes the basket to the table's bill.
   *
   * ── WHY A TABLE'S BASKET IS SAVED AND A COUNTER'S IS NOT ──────────────────
   *
   * At a counter the basket lives in this component until it is paid, seconds later. A
   * table's lives for an hour, on a screen a waiter walks away from — and the next
   * person to look at that table may be at a different till. So it has to be on the
   * server, or "table 6" means nothing to anybody but this browser.
   *
   * Called on a DEBOUNCE rather than per tap: a waiter ringing up eight items would
   * otherwise be eight round trips, and the basket on screen is already correct — this
   * is about making it survivable, not about making it visible.
   */
  const [tableSaving, setTableSaving] = useState(false)
  const tableLines = salePayloadLines(state.lines, lineSpecials, docShares)

  useEffect(() => {
    if (!table) return
    if (state.lines.length === 0) return

    const timer = setTimeout(() => {
      void (async () => {
        setTableSaving(true)
        try {
          if (state.documentId) {
            const updated = await updateTableBillAction(state.documentId, {
              customerName: table.code,
              terminalId: terminal?.id ?? null,
              terminalCode: terminal?.code ?? null,
              priceStructureId,
              lines: tableLines,
            })
            if (!updated.ok) {
              toast.error(updated.error)
              return
            }
            setTables(updated.tables)
            return
          }

          /* No document yet — this is the FIRST item on a free table, which is the moment
             the table actually becomes occupied. See openTableAction on why not at the
             tap. */
          const opened = await openTableAction(table.id, {
            customerName: table.code,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            lines: tableLines,
          })
          if (!opened.ok) {
            toast.error(opened.error)
            /* Somebody took the table. Back to the floor rather than leaving a waiter
               adding to a bill that will refuse every save from here on. */
            setTable(null)
            setChoosingTable(true)
            return
          }
          /* The reducer is told the document id so every later save UPDATES rather than
             creating a second bill for the same table. */
          dispatch({ type: 'ATTACH_DOCUMENT', documentId: opened.documentId })
          setTables(opened.tables)
        } finally {
          setTableSaving(false)
        }
      })()
    }, 900)

    return () => clearTimeout(timer)
    /* Deliberately keyed on the LINES, not on `tableLines` — that array is rebuilt every
       render, so depending on it would fire this on every keystroke elsewhere. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.id, state.documentId, state.lines])

  /** Puts a table's existing bill on screen. */
  function resumeTable(picked: PosTable) {
    if (picked.documentId == null) {
      // Free: start an empty basket against it. Nothing is written until the first
      // item — see openTableAction on why.
      setTable(picked)
      setChoosingTable(false)
      dispatch({ type: 'CLEAR' })
      return
    }
    startTransition(async () => {
      const result = await recallSaleForTillAction(picked.documentId!, priceStructureId)
      if (!result.ok) {
        toast.error(result.error)
        /* The floor is stale — somebody settled it while this waiter was looking. Re-read
           rather than leaving a tile they will tap again. */
        const fresh = await listTablesAction().catch(() => null)
        if (fresh?.ok) setTables(fresh.tables)
        return
      }
      setTable(picked)
      setChoosingTable(false)
      setDocDiscount(null) // a recalled basket must not inherit the last one's discount
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        customer: null,
        customerName: result.customerName ?? '',
      })
    })
  }

  /* ── Quick keys ─────────────────────────────────────────────────────────
     What the shop put on its own buttons.

     The page's props are the source when it renders — one round trip already made, and
     the grid is needed for the first paint. But a RELOAD with no network gets no props,
     and the key grid is the default pane: the till would open on an empty screen at
     exactly the moment a cashier can least afford to hunt by department. So the stored
     copy takes over whenever the props arrive empty. */
  const [heldKeys, setHeldKeys] = useState<{
    keys: QuickKeyRow[]
    productNames: Record<number, string>
    departmentNames: Record<number, string>
  } | null>(null)

  useEffect(() => {
    if (quickKeys.length > 0) return
    let cancelled = false
    void storedQuickKeys(siteId).then((held) => {
      if (!cancelled && held.keys.length > 0) {
        setHeldKeys({
          keys: held.keys as QuickKeyRow[],
          productNames: held.productNames,
          departmentNames: held.departmentNames,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [siteId, quickKeys.length])

  const keysToShow = quickKeys.length > 0 ? quickKeys : (heldKeys?.keys ?? [])
  const keyProductNames = quickKeys.length > 0 ? quickKeyProductNames : (heldKeys?.productNames ?? {})
  const keyDepartmentNames =
    quickKeys.length > 0 ? quickKeyDepartmentNames : (heldKeys?.departmentNames ?? {})

  const quickKeyContext = useMemo(
    () => ({
      handlers: {
        pay: () => setTendering(true),
        clear: () => setConfirmClear(true),
        park,
        showSaved: () => setShowingSaved(true),
        undo: () => {
          const last = state.lines[state.lines.length - 1]
          if (last) dispatch({ type: 'REMOVE', key: last.key })
        },
        pickCustomer: () => setPickingCustomer(true),
        editLine: () => {
          const line = state.lines.find((l) => l.key === state.selectedKey)
          if (line) setEditing(line)
        },
        openDepartment: (departmentId: number) => dispatch({ type: 'DRILL', departmentId }),
        addProduct: (productId: number) => {
          /* Resolved against the till's OWN catalogue, so a product key works offline —
             which is the point of storing an id rather than a whole product on the key. */
          const held = results.find((p) => p.id === productId) ?? browse.products.find((p) => p.id === productId)
          if (held) {
            add(held)
            return
          }
          startTransition(async () => {
            const found = till.online
              ? await scanAction(String(productId), priceStructureId).catch(() => null)
              : null
            const offline = found ?? (await findByCode(siteId, String(productId)))
            if (offline) add(offline)
            else toast.error('That product is not on this till right now.')
          })
        },
        showOutbox: () => setShowingOutbox(true),
        showShift: () => setManagingShift(true),
        docDiscount: () => setDiscountingDoc(true),
        startReturn: () => dispatch({ type: 'SET_RETURNING', returning: true }),
        navigate: (href: string) => router.push(href),
        say: (message: string, tone: 'info' | 'error') =>
          tone === 'error' ? toast.error(message) : toast.info(message),
      },
      /* The OPERATOR's rights, from the same booleans the screen already uses. Every
         action behind a key re-checks server-side, so this decides what is offered. */
      can: (capability: string) =>
        capability === 'sales.till' ||
        (capability === 'sales.discount_override' && canOverrideDiscount) ||
        (capability === 'sales.price_override' && canOverridePrice) ||
        (capability === 'sales.void' && canVoid) ||
        /* Everything else is a back-office right this screen was not told about. Allowed
           through to the action, which knows — refusing here would grey out keys a
           cashier legitimately holds, and a greyed key nobody can explain is worse than
           one that says why when pressed. */
        !['sales.discount_override', 'sales.price_override', 'sales.void'].includes(capability),
      hospitality: false,
      online: till.online,
      hasSelection: state.selectedKey !== null,
      hasLines: state.lines.length > 0,
      hasCustomer: state.customer !== null,
      returning: state.returning,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.lines, state.selectedKey, state.customer, till.online, results, browse.products, canOverrideDiscount, canOverridePrice, canVoid],
  )

  const customerLabel = state.customer?.name ?? (state.customerName.trim() || null)

  /*
   * Which payment methods this till can actually honour right now.
   *
   * Filtered HERE rather than inside TenderPad, so the pad stays ignorant of whether
   * there is a network — it renders what it is given. Account and loyalty both
   * depend on a balance only the server knows: a credit check against a stale
   * balance is how a shop extends credit to somebody who has already exhausted it,
   * and `redeemPointsForSale` THROWS rather than refuses, precisely so an
   * unaffordable redemption rolls the whole sale back. There is no offline
   * equivalent of that rollback.
   *
   * Cash, card and everything else work normally, which is the overwhelming majority
   * of what a shop takes.
   */
  const availableTenders = useMemo(
    () => (till.online ? tenders : tenders.filter((t) => offlineBlockedTender(t) === null)),
    [tenders, till.online],
  )

  return (
    <TileSizeContext.Provider value={tileSize.size}>
      <TillStatusBar
        /* The bar names the SCREEN under it — except on the gate, where the card
           below already says "Tables" and the slot carries the brand instead.
           No basket there either, so no item pill. */
        screenTitle={choosingTable ? null : 'Current Sale'}
        operatorName={operatorName}
        terminalLabel={
          terminal
            ? `${terminal.code}${terminal.tillNumber ? ` · till ${terminal.tillNumber}` : ''}`
            : null
        }
        unclaimed={unclaimed}
        /* Only once the device has resolved AND the shell has had its say — before
           that, "offline unavailable" would flash on every load and mean nothing. */
        offlineReason={device !== null && !shell.ready ? shell.reason : null}
        online={till.online}
        pendingSales={till.pending}
        failedSales={till.failed}
        catalogAgeHours={till.catalogAgeHours}
        itemCount={choosingTable ? null : state.lines.length}
        onShowOutbox={() => setShowingOutbox(true)}
        shiftLabel={shiftLabel}
        onShift={() => setManagingShift(true)}
        /*
         * WHICH BILL IS ON SCREEN — and nothing at all when that question has no
         * answer yet. A waiter needs to know which bill they are adding to before
         * they add to it, and the header is the one place never covered by a
         * dialog; but on the gate there is no basket, so a chip there would be
         * labelling a sale that does not exist.
         *
         * A seated table shows its code, a named tab shows what the waiter typed,
         * and a quick sale shows nothing — "Walk-in" was a word standing in for
         * "no table", which is already what an empty slot says.
         */
        tableLabel={choosingTable ? null : table ? table.code : tabLabel}
        /* Undefined ON the gate: a "back to the floor" button on the floor is a
           control that can only ever do nothing. */
        onChangeTable={
          hospitality && !choosingTable ? () => setChoosingTable(true) : undefined
        }
        /* Hand the screen back to the PIN pad, not to the back office: this is
           where a waiter ends their shift, and the next one signs in here.
           Clearing the till cookie is what makes PosEntry fall back to the gate;
           the refresh is what makes it happen now rather than on next load. */
        onExit={() => {
          startTransition(async () => {
            await tillSignOutAction()
            router.refresh()
          })
        }}
      />

      {/*
        ── HOSPITALITY READ 1 OF 3: the gate stands in FRONT of the till ──────
        Instead of the three columns, not beside them. A waiter picks the table before
        there is a basket to put anything in, so nothing below this needs to know
        whether one was picked.
      */}
      {choosingTable ? (
        <TableGate
          tabs={tabs}
          tables={tables}
          rooms={floorRooms}
          visitTypes={visitTypes}
          onRefresh={refreshTables}
          features={floorFeatures}
          busy={pending}
          onWalkIn={() => {
            clearTabIdentity()
            setTable(null)
            setChoosingTable(false)
            dispatch({ type: 'CLEAR' })
          }}
          onNewTable={() => setNaming({ closing: false })}
          splitting={armedForSplit}
          onToggleSplitting={setArmedForSplit}
          onSplitTable={openSplit}
          transferring={armedForTransfer}
          onToggleTransferring={setArmedForTransfer}
          onTransferTable={openTransfer}
          onPickTab={resumeTab}
          onPickTable={resumeTable}
        />
      ) : (
      /* THREE FLOATING CARDS on a padded canvas, rather than three panes flush
         against each other. The gap is what separates the basket from the
         catalogue visually — without it the till reads as one undifferentiated
         sheet, and a cashier's eye has nothing to anchor on. */
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <SalePane
          lines={state.lines}
          totals={totals}
          lineSpecials={lineSpecials}
          selectedKey={state.selectedKey}
          customerLabel={customerLabel}
          onSelect={(key) => dispatch({ type: 'SELECT', key })}
          onStep={(key, delta) => dispatch({ type: 'STEP', key, delta })}
          onEdit={setEditing}
          onRemove={(key) => dispatch({ type: 'REMOVE', key })}
          onCustomer={() => setPickingCustomer(true)}
          /* Close SAVES in hospitality rather than clearing — see closeSale. In
             retail there is no floor to park onto, so it keeps its old meaning
             and asks before throwing the basket away. */
          onClear={hospitality ? closeSale : () => setConfirmClear(true)}
          /* One button, two destinations. A separate "Refund" button beside Pay would sit
             unused all day next to the one key a cashier presses hundreds of times, and
             the mode is already stated on the pane — so the primary action follows the
             mode rather than competing with it. */
          onPay={() => (state.returning ? setReturning(true) : setTendering(true))}
          returning={state.returning}
          onToggleReturning={(next) => dispatch({ type: 'SET_RETURNING', returning: next })}
          /* Hospitality parks through Close, so the two park keys are retail-only —
             see SalePane's `showParkKeys`. */
          showParkKeys={!hospitality}
          onPark={park}
          onShowSaved={() => setShowingSaved(true)}
          savedCount={savedTally}
          /* Only a parked tab has a document to print — a counter basket lives
             in this component until it is paid, and has no bill to show. */
          onBill={hospitality && state.documentId ? printBill : undefined}
          onDocDiscount={() => setDiscountingDoc(true)}
          busy={pending}
        />

        <DeptRail
          departments={departments}
          activeId={state.catalog.kind === 'departments' ? state.catalog.path[0] ?? null : null}
          onPick={(id) => dispatch({ type: 'DRILL', departmentId: id })}
        />

        <CatalogPane
          view={state.catalog}
          query={state.query}
          departments={departments}
          results={results}
          searching={searching}
          browse={browse}
          onQuery={(query) => dispatch({ type: 'SET_QUERY', query })}
          onScan={submitCode}
          onDrill={(departmentId) => dispatch({ type: 'DRILL', departmentId })}
          onDrillTo={(path) => dispatch({ type: 'DRILL_TO', path })}
          onShowKeys={() => {
            // Leaving the pane is the one place results are thrown away, so a
            // returning cashier does not see somebody else's last search.
            setResults([])
            dispatch({ type: 'SHOW_KEYS' })
          }}
          onPick={add}
          onSizeTiles={() => setSizingTiles(true)}
          priceFor={priceFor}
          quickKeys={
            <QuickKeyPanel
              keys={keysToShow}
              productNames={keyProductNames}
              departmentNames={keyDepartmentNames}
              isEnabled={(key) => quickKeyEnabled(key, quickKeyContext)}
              onPress={(key) => runQuickKey(key, quickKeyContext)}
            />
          }
        />
      </div>
      )}

      {/* Confirmed rather than immediate. Close is a 72px key beside Pay, and an
          accidental brush of it must not silently bin a basket somebody has spent
          two minutes building in front of a customer. */}
      <ConfirmModal
        open={confirmClear}
        title="Clear this sale?"
        confirmLabel="Clear it"
        tone="danger"
        message={`${state.lines.length} line${
          state.lines.length === 1 ? '' : 's'
        } will be removed. Nothing has been posted, so nothing is reversed.`}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          dispatch({ type: 'CLEAR' })
          setConfirmClear(false)
        }}
      />

      {/* Naming a tab — opening a new one, or giving a name to a sale being
          closed. One dialog for both, because they ask the same question. */}
      <NewTableModal
        open={naming !== null}
        visitTypes={visitTypes}
        waiterName={operatorName}
        busy={pending}
        onClose={() => setNaming(null)}
        onSave={(details) => nameTab(details, naming?.closing ?? false)}
      />

      {/*
        ── CLOSING A SALE THAT HAS NO NAME ──────────────────────────────────
        Three answers, because there are genuinely three things a waiter might
        mean by Close here and no way to guess which:

          Save   — it is a real order; name it so it can be found again.
          Void   — it was a mistake; bin it.
          Cancel — mis-tap; carry on ringing up.

        Not a ConfirmModal: that offers two answers, and collapsing "save" and
        "void" into one button is how an hour of orders gets thrown away.
      */}
      <Modal
        open={closePrompt}
        onClose={() => setClosePrompt(false)}
        title="Close this sale?"
        description={`${state.lines.length} item${
          state.lines.length === 1 ? '' : 's'
        } on this sale. It has no table or name yet.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="touch" onClick={() => setClosePrompt(false)}>
              Continue the sale
            </Button>
            <Button
              variant="danger"
              size="touch"
              onClick={() => {
                setClosePrompt(false)
                clearTabIdentity()
                dispatch({ type: 'CLEAR' })
                setTable(null)
                setChoosingTable(true)
              }}
            >
              <Icons.Trash size={18} />
              Void it
            </Button>
            <Button
              variant="primary"
              size="touch"
              onClick={() => {
                setClosePrompt(false)
                setNaming({ closing: true })
              }}
            >
              <Icons.Save size={18} />
              Save it
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Saving asks for a table number or a customer name, so the tab can be picked up
          again from the floor. Voiding throws it away — nothing has been posted, so
          nothing is reversed.
        </p>
      </Modal>

      <TenderPad
        open={tendering}
        onClose={() => setTendering(false)}
        tenders={availableTenders}
        totalIncl={totals.doc.totalIncl}
        cashRounding={cashRounding}
        customer={state.customer}
        /* What the member is holding, so the pad can OFFER the reward. Null offline —
           redeeming against a stale balance is what offlineBlockedTender prevents. */
        loyalty={loyalty}
        pending={pending}
        serviceCharge={serviceCharge}
        /* `sales.discount_override` — the same right that lets somebody override a price.
           A waiter cannot take a forced charge off; somebody who can override money can. */
        canRemoveServiceCharge={canOverrideDiscount}
        onFinalise={finalise}
      />

      {/* Dividing a bill. Nothing is written until Confirm, and the server writes both
          halves in one transaction — see posSplit.ts. */}
      <SplitBillModal
        open={splitting !== null}
        onClose={() => setSplitting(null)}
        fromTable={splitting?.table ?? null}
        lines={splitting?.lines ?? []}
        tables={tables}
        busy={pending}
        onConfirm={confirmSplit}
      />

      {/* The drawer: open a shift, move money, cash up blind. Online only —
          the modal itself says so when the line is down. */}
      <ShiftModal
        open={managingShift}
        online={till.online}
        terminalId={terminal?.id ?? null}
        pendingSales={till.pending}
        onClose={() => setManagingShift(false)}
        onShiftChanged={(shiftId) => noteShift(shiftId, operatorName)}
      />

      {/* Moving a whole tab. The document keeps its identity — only the table's
          pointer moves, in one server transaction. See posSplit.ts. */}
      <TransferTableModal
        open={transferring !== null}
        onClose={() => setTransferring(null)}
        fromTable={transferring}
        tables={tables}
        busy={pending}
        onPick={confirmTransfer}
      />

      {/* Paying a customer back. Its own pad rather than the tender pad with a flag —
          a refund has no change, no vouchers, no loyalty and no cash rounding, which is
          most of what makes that component hard. See RefundPad's docblock. */}
      <RefundPad
        open={returning}
        onClose={() => setReturning(false)}
        /* The FULL tender list, not `availableTenders`: that one withholds account and
           loyalty tenders offline, which is right for taking money in. Paying money out
           is filtered by `allowsRefund` instead, which the pad does itself. */
        tenders={tenders}
        totalIncl={totals.doc.totalIncl}
        hasCustomer={state.customer !== null}
        reasons={returnReasons}
        pending={pending}
        onConfirm={confirmReturn}
      />

      <OutboxModal
        open={showingOutbox}
        siteId={siteId}
        busy={pending}
        /* `sales.void` — the nearest existing right, and making a sale disappear is
           exactly what it is for. The audit row records who did it either way, so this
           decides what is offered rather than what is possible. */
        canCancel={canVoid}
        onClose={() => setShowingOutbox(false)}
        onCancelSale={async (saleUid, reason) => {
          const result = await cancelOfflineSale(siteId, saleUid, reason, {
            userId: operatorUserId,
            name: operatorName,
          })
          if (!result) {
            toast.error('That sale can no longer be cancelled here.')
            return
          }
          await till.recount()
          /* Says which of the two happened, because they mean different things to
             whoever reads the invoice register: a burnt number leaves an explainable
             gap, a rewound one leaves the run intact. */
          toast.success(
            result.rewound
              ? `${result.documentNumber} cancelled. The number goes back.`
              : `${result.documentNumber} cancelled. That number is used up — the gap is on the record.`,
          )
        }}
      />

      <SavedSalesModal
        open={showingSaved}
        /* Narrowed to this till when the machine has claimed one — a cashier
           looking for the basket they parked should not read past every other
           till's. An unclaimed machine has no basis to narrow, so it sees all. */
        terminalId={terminal?.id ?? null}
        busy={pending}
        online={till.online}
        localBaskets={localBaskets}
        onClose={() => setShowingSaved(false)}
        onCount={setSavedTally}
        onRecall={(entry) => {
          startTransition(async () => {
            if (entry.where === 'till' && entry.uid) {
              await recallLocally(entry.uid)
              return
            }
            if (entry.documentId != null) recall(entry.documentId)
          })
        }}
        onDiscard={(entry) => {
          startTransition(async () => {
            if (entry.where === 'till' && entry.uid) {
              await discardParkedOffline(siteId, entry.uid)
              toast.success('Saved sale discarded.')
              setSavedTally((n) => Math.max(0, n - 1))
              setShowingSaved(false)
              return
            }
            if (entry.documentId == null) return
            const result = await discardSaleAction(entry.documentId)
            if (!result.ok) {
              toast.error(result.error)
              return
            }
            toast.success('Saved sale discarded.')
            setSavedTally((n) => Math.max(0, n - 1))
            // Closed rather than refreshed in place: the list is read on open, so
            // re-opening is what shows the shortened one.
            setShowingSaved(false)
            router.refresh()
          })
        }}
      />

      <CustomerModal
        open={pickingCustomer}
        customer={state.customer}
        walkInName={state.customerName}
        onClose={() => setPickingCustomer(false)}
        onAttach={(customer) => dispatch({ type: 'SET_CUSTOMER', customer })}
        onClear={() => dispatch({ type: 'SET_CUSTOMER', customer: null })}
        onWalkInName={(name) => dispatch({ type: 'SET_CUSTOMER_NAME', name })}
      />

      <LineEditModal
        line={editing}
        canOverrideDiscount={canOverrideDiscount}
        canOverridePrice={canOverridePrice}
        onClose={() => setEditing(null)}
        onSave={(changes) => {
          if (editing) dispatch({ type: 'UPDATE', key: editing.key, changes })
          setEditing(null)
        }}
        /* The refusal's remedy: a manager's PIN lifts it for THIS change. On
           approval the change lands on the line, the token (or the queued
           offline claim) rides the next save/finalise, and the audit row is
           already written under the manager's name. */
        onSupervisor={(request) => {
          const line = editing
          setOverride({
            capability: request.capability,
            actionLabel: request.actionLabel,
            amount: request.amount,
            documentId: state.documentId,
            onAuthorised: (auth) => {
              if (auth.token) {
                overrideTokenRef.current = auth.token
              } else {
                offlineOverridesRef.current.push({
                  capability: request.capability,
                  userId: auth.userId,
                  name: auth.name,
                  action: request.actionLabel,
                  amount: request.amount,
                })
              }
              if (line) dispatch({ type: 'UPDATE', key: line.key, changes: request.changes })
              setEditing(null)
              toast.success(`Approved by ${auth.name}.`)
            },
          })
        }}
      />

      {/* A discount on the whole sale — spread onto the lines, previewed, and
          routed through the supervisor pad when it breaches a line's ceiling. */}
      <DocDiscountModal
        open={discountingDoc}
        lines={state.lines}
        lineSpecials={lineSpecials}
        current={docDiscount}
        canOverrideDiscount={canOverrideDiscount}
        onApply={setDocDiscount}
        onSupervisor={({ discount, actionLabel, amount }) => {
          setDiscountingDoc(false)
          setOverride({
            capability: 'sales.discount_override',
            actionLabel,
            amount,
            documentId: state.documentId,
            onAuthorised: (auth) => {
              if (auth.token) {
                overrideTokenRef.current = auth.token
              } else {
                offlineOverridesRef.current.push({
                  capability: 'sales.discount_override',
                  userId: auth.userId,
                  name: auth.name,
                  action: actionLabel,
                  amount,
                })
              }
              setDocDiscount(discount)
              toast.success(`Approved by ${auth.name}.`)
            },
          })
        }}
        onClose={() => setDiscountingDoc(false)}
      />

      {/* The supervisor pad — one pad for every refusal that a manager's PIN
          can lift. See the override block near the top of the component. */}
      {override && (
        <OverrideModal
          open
          siteId={siteId}
          online={till.online}
          capability={override.capability}
          actionLabel={override.actionLabel}
          amount={override.amount}
          documentId={override.documentId}
          terminalCode={terminal?.code ?? null}
          cashierName={operatorName}
          onClose={() => setOverride(null)}
          onAuthorised={(auth) => {
            override.onAuthorised(auth)
            setOverride(null)
          }}
        />
      )}

      {/* Only mounted while a product is being asked about, so its state starts
          fresh each time — a modal kept alive would carry the last burger's
          answers onto the next one. */}
      {weighing && (
        <WeighModal
          product={weighing}
          onCancel={() => setWeighing(null)}
          onConfirm={(w) => {
            const product = weighing
            setWeighing(null)
            // scannedQty carries the confirmed weight back through add(), so
            // the guard passes and the product's questions still get asked.
            add({ ...product, scannedQty: w }, w)
          }}
        />
      )}

      {asking && (
        <InstructionsModal
          product={asking.product}
          qty={asking.qty}
          groups={asking.groups}
          byId={instructions.byId}
          basePriceIncl={priceFor(asking.product)}
          onCancel={() => setAsking(null)}
          onConfirm={(chosen, note) => {
            dispatch({
              type: 'ADD_WITH_INSTRUCTIONS',
              product: asking.product,
              qty: asking.qty,
              resolvedIncl: priceFor(asking.product),
              instructions: chosen,
              note,
            })
            setAsking(null)
          }}
        />
      )}

      <ReceiptModal
        open={receipt !== null && !voiding}
        documentNumber={receipt?.number ?? ''}
        change={receipt?.change ?? 0}
        /* Always offered on a POSTED sale: a cashier without the right gets the
           supervisor pad instead of a missing button they cannot explain. */
        canVoid={true}
        posted={(receipt?.documentId ?? 0) > 0}
        onVoid={() => {
          if (canVoid) {
            setVoiding(true)
            return
          }
          setOverride({
            capability: 'sales.void',
            actionLabel: `Void ${receipt?.number ?? 'this sale'}`,
            amount: receipt?.total,
            documentId: receipt?.documentId ?? null,
            onAuthorised: (auth) => {
              // Online only — an unposted offline sale hides the button anyway.
              overrideTokenRef.current = auth.token || null
              setVoiding(true)
            },
          })
        }}
        onClose={() => setReceipt(null)}
        /*
         * The document, in a new tab — NOT `/sales/print/{number}`.
         *
         * The desk till's own Print button opens that path and it 404s: no such
         * route exists anywhere in the app. Copying it here would have shipped a
         * second broken button. `/sales/[id]` is the real screen and is what the
         * finalise result's documentId is for.
         *
         * A new tab rather than window.print(), because printing the till itself
         * would send three panes of chrome to a receipt printer. Proper
         * thermal/ESC-POS printing is its own piece of work — see the open
         * questions on the plan.
         */
        onPrint={() => {
          if (receipt) window.open(`/sales/${receipt.documentId}`, '_blank')
        }}
      />

      {/* Replaces the receipt rather than stacking on it — two dialogs deep, on a
          screen where the one underneath holds the change figure, is how a cashier
          loses track of which sale they are reversing. */}
      <VoidModal
        open={voiding && receipt !== null}
        documentNumber={receipt?.number ?? ''}
        total={receipt?.total ?? 0}
        reasons={voidReasons}
        busy={pending}
        onClose={() => setVoiding(false)}
        onVoid={voidSale}
      />

      {/* Tile sizing. A dialog rather than sliders on the surface: it is set once
          when a till is commissioned and then never again, and two permanent
          sliders would cost basket width on every sale to serve that one moment. */}
      <TileSizeModal
        open={sizingTiles}
        size={tileSize.size}
        onChange={tileSize.setSize}
        onReset={tileSize.reset}
        onClose={() => setSizingTiles(false)}
      />
    </TileSizeContext.Provider>
  )
}
