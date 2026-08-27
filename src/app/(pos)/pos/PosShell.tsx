'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  useToast,
  usePrintDocument,
  Button,
  ConfirmModal,
  EmptyState,
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
  storedPosMenus,
  storedInstructions,
  storedSettings,
} from '@/lib/posOffline/catalog'
import {
  activeMenu,
  departmentsOnMenu,
  productsOnMenu,
  type PosMenu,
} from '@/lib/posMenuEngine'
import {
  parkOffline,
  recallOffline,
  discardParkedOffline,
  listParkedOffline,
} from '@/lib/posOffline/parkOffline'
import { cancelOfflineSale } from '@/lib/posOffline/cancelOffline'
import { stockShortfalls, stockWarning } from '@/lib/stockWarning'
import { type PosMode } from '@/lib/posMode'
import { salePaperRoute } from '@/lib/salePaper'
import TradeEntryPane from './TradeEntryPane'
import ModuleMenu, {
  MODULE_DOC_TYPES,
  MODULE_PHRASES,
  MODULE_LIST_NAMES,
  LIST_ONLY_MODULES,
  moduleForDocType,
  type TillModule,
} from './ModuleMenu'
import {
  saveDraft as saveLocalDraft,
  readDraft as readLocalDraft,
  clearDraft as clearLocalDraft,
  draftDocType,
  DRAFT_DOC_LABELS,
  type DraftDocType,
} from '@/lib/posOffline/draftOffline'
import type { LocalDraft } from '@/lib/posOffline/db'
import { offlineBlockedProduct, offlineBlockedTender } from '@/lib/offlineCapability'
import type { Special, RewardProduct } from '@/lib/specialsEngine'
import { toProductType } from '@/lib/productTypes'
import {
  pendingPriceIndex,
  resolvedFromIndex,
  type PendingSchedule,
} from '@/lib/priceSchedules'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TillInstructionGroup } from '@/lib/site/instructions'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { Terminal } from '@/lib/site/terminals'
import type { PriceStructure } from '@/lib/site/lookups'
import type { BasketLine } from '@/lib/basket'
import {
  searchProductsAction,
  browseProductsAction,
  scanAction,
  lotsForProductAction,
  serialsForProductAction,
  finaliseSaleAction,
  createCreditNoteAction,
  saveSaleAction,
  saveAsOrderAction,
  saveForLaterAction,
  discardSaleAction,
  recordPrintAction,
} from '@/app/(app)/sales/actions'
import {
  listOpenTabsAction,
  recallSaleForTillAction,
  recordServiceChargeWaivedAction,
  recordUndoAction,
  recordVoidAction,
  productForTillAction,
  type OpenTab,
  type VoidEventPayload,
} from './actions'
import { NewTableModal, type NewTableDetails } from './NewTableModal'
import { tillSignOutAction } from './pinActions'
import {
  tillStandingAction,
  memberForCustomerAction,
  type TillStanding,
} from '@/app/(app)/loyalty/actions'
import { TillStatusBar } from './TillStatusBar'
import { SalePane } from './SalePane'
import { DeptRail } from './DeptRail'
import { CatalogPane } from './CatalogPane'
import { TenderPad } from './TenderPad'
import { CustomerModal } from './CustomerModal'
import { SavedSalesModal, type SavedEntry } from './SavedSalesModal'
import { OutboxModal } from './OutboxModal'
import { LineEditModal } from './LineEditModal'
import { LineOptionsModal, type LineOption } from './LineOptionsModal'
import { PriceTypeModal } from './PriceTypeModal'
import { PriceCheckModal } from './PriceCheckModal'
import { AccountPaymentModal } from './AccountPaymentModal'
import { DepositModal } from './DepositModal'
import { depositSummaryAction } from './depositActions'
import { ReprintModal } from './ReprintModal'
import { BillModal } from './BillModal'
import type { BillData } from '@/lib/billData'
import { OnlineOrdersModal } from './OnlineOrdersModal'
import { ClockModal } from './ClockModal'
import { collectOnlineOrderAction, type CollectableOrder } from './onlineOrderActions'
import { QuotesModal } from './QuotesModal'
import { recallQuoteForTillAction, type TillQuote } from './quoteActions'
import { OrdersModal } from './OrdersModal'
import { collectOrderForTillAction, type TillOrder } from './orderActions'
import { LaybysModal } from './LaybysModal'
import { StartLaybyModal } from './StartLaybyModal'
import {
  takeLaybyPaymentAction,
  collectLaybyAction,
  startLaybyAction,
  type TillLayby,
} from './laybyActions'
import InstructionsModal from './InstructionsModal'
import { ReceiptModal } from './ReceiptModal'
import { VoidReasonModal } from './VoidReasonModal'
import type { VoidType } from '@/lib/site/posVoids'
import { useSaleState } from './useSaleState'
import {
  specialsFor,
  rewardsFor,
  totalsFor,
  salePayloadLines,
  returnPayloadLines,
  docDiscountShares,
  departmentTallies,
  type DocDiscount,
} from './saleSelectors'
import DocDiscountModal from './DocDiscountModal'
import ReceiptReturnModal, { type ReceiptReturnPick } from './ReceiptReturnModal'
import { EmailInvoiceDialog } from '@/app/(app)/sales/EmailInvoiceDialog'
import { receiptDataFromBasket, type ReceiptData } from '@/lib/receiptData'
import {
  kickDrawer,
  printSlipViaBridge,
  printBillViaBridge,
  hasBridgeSlipPrinter,
  printKitchenViaBridge,
} from './printing'
import {
  kitchenTicketAction,
  markKitchenSentAction,
  kitchenSendOptionsAction,
  kitchenAutoPrintEnabledAction,
  kitchenCancelTicketAction,
  markKitchenCancelledAction,
  type KitchenScope,
  type KitchenSendOption,
} from './kitchenActions'
import SendToKitchenModal from './SendToKitchenModal'
import { tillCreditNoteAction, tillExchangeAction } from './returnActions'
import { validateTillCodeAction } from './discountCodeActions'
import { formatMoney, round } from '@/lib/decimals'
import { serviceChargeFor, planTips, type ServiceTier } from '@/lib/tipMath'
import { RefundPad } from './RefundPad'
import { TableGate } from './TableGate'
import {
  listTablesAction,
  openTableAction,
  updateTableBillAction,
  reparkTableBillAction,
  tillBookingsAction,
  seatBookingAction,
  type TillBooking,
  voidTableBillAction,
  askForBillAction,
  billDataAction,
  tablePaidAction,
  billForSplitAction,
  billForSplitByDocumentAction,
  destinationBillAction,
  splitTableAction,
  splitBillAction,
  transferTableAction,
} from './tableActions'
import type { PosTable } from '@/lib/site/posTables'
import type { VisitType } from '@/lib/site/visitTypes'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import { SplitBillModal, type SplitLine, type SplitDestination } from './SplitBillModal'
import TransferTableModal from './TransferTableModal'
import ShiftModal from './ShiftModal'
import DrawerMovementModal, { type MovementType } from './DrawerMovementModal'
import DeclarationModal from './DeclarationModal'
import OpenTillGate from './OpenTillGate'
import ClockInGate from './ClockInGate'
import { tillShiftStatusAction } from './shiftActions'
import OverrideModal from './OverrideModal'
import { kvPut, KV } from '@/lib/posOffline/db'
import type { Capability } from '@/lib/site/permissions'
import type { OfflineSale } from '@/lib/posOffline/types'
import { WeighModal } from './WeighModal'
import { LotModal } from './LotModal'
import { SerialModal } from './SerialModal'
import type { TillLot } from '@/lib/site/batches'
import { lotCaptureFor, type LotCapture } from '@/lib/gs1'
import { GiftCardModal, GiftCardBalanceModal } from './GiftCardModal'
import { lookupGiftCardAction } from './giftCardActions'
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
  siteVatNumber = null,
  operatorName,
  operatorUserId,
  terminals,
  departments,
  departmentCounts = {},
  priceStructureId: siteDefaultStructureId,
  priceStructures,
  tenders,
  voidReasons,
  returnReasons,
  cashRounding,
  depositMinPct,
  depositAllowWalkin,
  canOverrideDiscount,
  canOverridePrice,
  canVoid,
  specials,
  pendingPrices: pendingPricesProp,
  posMenus: posMenusProp = [],
  quickKeys,
  quickKeyProductNames,
  quickKeyDepartmentNames,
  hospitality,
  modeName,
  invoicing,
  posMode,
  startAs,
  initialTables,
  floorRooms,
  floorFeatures,
  visitTypes = [],
  serviceTiers,
  tipsTablesOnly,
  warnOutOfStock,
  offlineAccountSales = false,
  laybyDueDate = null,
  undoLimit,
}: {
  /** Keys the till's own IndexedDB — one database per site, never one shared. */
  siteId: number
  siteName: string
  /** For the till-printed slip's header — a tax invoice names the vendor. */
  siteVatNumber?: string | null
  operatorName: string
  operatorUserId: number
  terminals: Terminal[]
  departments: Department[]
  /**
   * How many sellable products sit DIRECTLY in each department, keyed by id.
   *
   * Rolled up into the subtree totals the tiles show by `departmentTallies` —
   * the till holds the whole tree, so counting a branch costs a walk over a
   * few dozen rows rather than a query per tile.
   *
   * Defaulted to empty rather than required: a department with no entry has
   * nothing of its own, which is both the honest reading of a missing key and
   * the common case for every branch. A caller that passes none gets tiles
   * with no count rather than tiles claiming zero.
   */
  departmentCounts?: Record<number, number>
  priceStructureId: number | null
  /**
   * Every active price type, for the price-change key to offer.
   *
   * The whole list rather than an id, because this key's job is to let a cashier
   * SWITCH — "what could this sale be priced at" has no answer without the names.
   * Shipped with the page: a shop has a handful and they change about never.
   */
  priceStructures: PriceStructure[]
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
  /** The smallest deposit this store takes, as a percentage. 0 means any. */
  depositMinPct: number
  /** Whether a deposit may be taken with no customer named. */
  depositAllowWalkin: boolean
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /**
   * Whether the OPERATOR holds `sales.void`.
   *
   * NOT about reversing a finalised sale — the till no longer offers that at
   * all, and it is the back office's job. What this still gates is the two
   * places the right applies before the money is banked: voiding an item, a
   * line or the whole basket in progress, and cancelling an unsynced sale from
   * the outbox. Both re-check server-side.
   */
  canVoid: boolean
  specials: Special[]
  /**
   * Approved price changes that have not happened yet, moments unevaluated.
   *
   * Shipped with the page for the same reason the quick keys are — so a till
   * that reloads with no network still holds them — and applied against this
   * machine's own clock, so six o'clock means six o'clock here.
   */
  pendingPrices: PendingSchedule[]
  /**
   * The shop's rotating menus (231), day masks and hour bands unevaluated.
   *
   * Shipped and applied exactly as the pending prices above are: this machine
   * picks the live menu on its OWN clock, so breakfast gives way to lunch at
   * eleven on every till at once — and on one that has been offline since
   * yesterday.
   *
   * Empty is the ordinary case and means "show the whole grid".
   */
  posMenus?: PosMenu[]
  /** The shop's own till buttons. Shipped with the page so they survive the line dropping. */
  quickKeys: QuickKeyRow[]
  quickKeyProductNames: Record<number, string>
  quickKeyDepartmentNames: Record<number, string>
  /** Read in THREE places only — see the docblock above. */
  hospitality: boolean
  /**
   * The lockup's second word, already resolved.
   *
   * A STRING rather than the mode itself, deliberately: the shell reads no
   * fourth branch off it, it only hands it to the bar. See the docblock above
   * on what a mode flag does once it starts spreading.
   */
  modeName: string
  /**
   * True on a TRADE COUNTER — a hardware or paint shop typing long documents.
   *
   * Changes the right-hand half of the screen and nothing else: the basket, the
   * money, the actions and the offline layer are the same ones every till uses.
   * See lib/posMode for why this picks a layout rather than adding branches.
   */
  invoicing: boolean
  /**
   * The mode itself, for the one question that is genuinely about all three
   * rather than about this screen's shape: which paper a finished sale prints
   * on. See lib/salePaper.
   *
   * Not a licence to branch on it — `hospitality` and `invoicing` above stay
   * the way this component asks about its own layout, for the reason the
   * docblock at the top gives. This is handed straight to salePaperRoute and
   * read nowhere else, so a fourth mode answers that question once, in one
   * file, instead of falling through a chain of booleans here.
   */
  posMode: PosMode
  /**
   * What this till should OPEN as, when somebody arrived meaning to make one.
   *
   * The back office links in with ?new=sales_order, so "New order" lands on a
   * till already writing an order. Applied once, after sign-in — see the effect
   * below for why it cannot simply be the reducer's initial state.
   */
  startAs: DraftDocType
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
  /**
   * Whether the tender pad warns when the basket outruns the shelf.
   *
   * Off for a shop that does not track stock, which is many of them — see
   * pos_warn_out_of_stock in settings.ts for why that is the default.
   */
  warnOutOfStock: boolean
  /**
   * Whether a disconnected till may still sell ON ACCOUNT.
   *
   * The shop's own decision — see pos_offline_account_sales for why this is a
   * setting rather than a rule. Defaults false so an existing store behaves
   * exactly as it did: account sales refused when the line is down.
   */
  offlineAccountSales?: boolean
  /**
   * What the lay-by dialog's "collected by" field opens with — today plus the
   * shop's `layby_default_days`, computed on the SERVER.
   *
   * A till's own clock can be wrong, and a due date is a promise to a customer
   * about when their goods stop being held. Null means the shop sets no term.
   */
  laybyDueDate?: string | null
  /**
   * How many undos one basket may spend. 0 means no limit.
   *
   * Resolved to a number by the page — a missing or unreadable setting arrives here
   * as 0, because a till that cannot read its limit must not start refusing
   * corrections. The RECORD of each undo is independent of this and is written
   * either way; see recordUndoAction.
   */
  undoLimit: number
}) {
  const [state, dispatch] = useSaleState()

  /**
   * The price type this sale is being rung at, chosen at the till.
   *
   * Null means "whatever the account or the site says" — the ordinary case, and
   * the state every sale starts and ends in. Set by the price-change key, and
   * cleared the moment the basket goes (see resetPricing), because a till left on
   * Wholesale after the trade customer walked out is how the next walk-in gets
   * trade prices and nobody notices until the month-end margin report.
   */
  const [pricingOverride, setPricingOverride] = useState<number | null>(null)
  /** The price-type list is open. */
  const [pickingPriceType, setPickingPriceType] = useState(false)
  /**
   * The price-check dialog is open.
   *
   * Independent of the basket, and deliberately so: the commonest price check is
   * the one asked before anything has been scanned at all.
   */
  const [checkingPrice, setCheckingPrice] = useState(false)
  /** The account-payment dialog is open. Independent of the basket. */
  const [takingPayment, setTakingPayment] = useState(false)
  /**
   * The deposit dialog is open, and what is already held against this basket.
   *
   * Held separately from the basket state rather than inside the reducer: a
   * deposit is a fact recorded on the SERVER about this document, not part of
   * what the basket is, and putting it in the reducer would give CLEAR and LOAD
   * a money figure to forget. Re-read from the server whenever the dialog opens.
   */
  const [takingDeposit, setTakingDeposit] = useState(false)
  const [depositHeld, setDepositHeld] = useState(0)
  /** The past-sales list is open, to reprint one. */
  const [showingReprints, setShowingReprints] = useState(false)
  /* The pro-forma bill, shown on the till rather than in the back office.
     `bill` is null while it is being fetched, which is what the dialog's
     skeleton reads. */
  const [billOpen, setBillOpen] = useState(false)
  const [bill, setBill] = useState<BillData | null>(null)
  const [billLoading, setBillLoading] = useState(false)
  const [billPrinting, setBillPrinting] = useState(false)
  /** The web-order list is open, to collect one. */
  const [showingOrders, setShowingOrders] = useState(false)
  /** The clock pad is open. Whoever taps a PIN into it, not the operator. */
  const [showingClock, setShowingClock] = useState(false)

  /*
   * The EFFECTIVE price structure (135): the till's own override first, then the
   * attached account's — already resolved customer → group server-side on the
   * TillCustomer — else the site default the page shipped. Named to shadow the old
   * prop so every lookup below (scan, search, browse, recall, finalise) prices
   * through it with no further changes. Lines rung BEFORE a change keep their
   * prices — switch first is the till discipline, and the server re-checks pricing
   * at finalise either way.
   *
   * The override wins over the ACCOUNT deliberately. A cashier who has just been
   * told to put this one through at wholesale has more information than the
   * customer record does, and a switch that silently lost to a price list on the
   * account would be a key that did nothing on exactly the customers it is for.
   */
  const priceStructureId =
    pricingOverride ?? state.customer?.priceStructureId ?? siteDefaultStructureId

  /*
   * ── RECEIPTED RETURNS AND EXCHANGE ─────────────────────────────────────────
   * The modal finds the invoice and picks quantities; the server re-reads every
   * price from it. A refund posts the credit note immediately; an exchange
   * HOLDS the credit while the cashier rings the replacement, then one action
   * posts both documents netted through the EXCHANGE tender.
   */
  const [receiptReturn, setReceiptReturn] = useState(false)
  const [exchangeCredit, setExchangeCredit] = useState<ReceiptReturnPick | null>(null)

  /**
   * A basket left behind by a session that ended badly.
   *
   * Null means nothing to recover, which is the ordinary case — a till that was
   * closed properly cleared its draft on the way out. A row here means the last
   * session did NOT end properly: a power cut, a crash, a machine switched off
   * at the wall. Offered back rather than restored silently, because the cashier
   * standing there may be a different person on a different day, and a basket
   * that appeared by itself would be rung up without anybody deciding to.
   */
  const [recoverable, setRecoverable] = useState<LocalDraft | null>(null)
  /** True once the recovery read has answered — see the writer effect. */
  /**
   * True once the recovery read has answered.
   *
   * STATE and not a ref, and the difference is load-bearing. Two effects wait on
   * this, and a ref mutating inside a promise re-renders nothing — so the one
   * that applies `startAs` checked it on mount, found it false, and never ran
   * again. A "New order" link opened an ordinary invoice till and nothing said
   * why. The writer below survived that only because its own dependencies change
   * constantly.
   *
   * The ref beside it is what the WRITER reads synchronously in its timeout,
   * where a stale closure would be the same bug in the other direction.
   */
  const [draftCheckDone, setDraftCheckDone] = useState(false)
  const draftChecked = useRef(false)
  const markDraftChecked = () => {
    draftChecked.current = true
    setDraftCheckDone(true)
  }

  /* The shop's own buttons, from IndexedDB, when the page's props arrive empty —
     a reload with no network gets no props, and the key grid is the default pane.
     The effect that fills this sits with the rest of the quick-key code. */
  const [heldKeys, setHeldKeys] = useState<{
    keys: QuickKeyRow[]
    productNames: Record<number, string>
    departmentNames: Record<number, string>
  } | null>(null)

  /* The attached account's loyalty standing — points, tier, what a voucher is worth.
     Re-read whenever the customer changes AND whenever the tender pad opens; failures
     collapse to null so a points lookup can never block a sale. The effect that reads
     it sits with the rest of the loyalty code. */
  const [loyalty, setLoyalty] = useState<TillStanding | null>(null)

  /* Tonight's bookings, shown on the gate so the floor can see who is coming.
     Empty on a retail till and on a shop that does not take bookings, which
     hides the strip entirely. */
  const [bookings, setBookings] = useState<TillBooking[]>([])

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

  /** True while the waiter is choosing — the gate stands in front of the till. */
  const [choosingTable, setChoosingTable] = useState(hospitality)
  /**
   * The floor has been read from the server at least once.
   *
   * Only the armed modes care, and they care a great deal. `tabs` and `tables`
   * both start empty, and the poll that fills them runs ONLY while the gate is
   * up (see the `choosingTable` effect) — so at the instant the Move key mounts
   * the gate, the floor it hands over is empty. "No bill can take this" is then
   * a statement about a list that has never been fetched rather than about the
   * shop: the gate refused, disarmed and toasted on the first paint, a beat
   * before the read it had itself just started came back carrying the waiter's
   * own table. The bill was on screen the whole time.
   *
   * Split escaped this by never going through the gate when a table is already
   * open (see `openSplitForCurrentTable`). Move cannot take that route, because
   * choosing a destination IS the gesture — so the gate has to learn to tell
   * "nothing is open" apart from "nothing has loaded yet".
   *
   * Set once and never cleared: a floor that has been read stays read, so a
   * later failed refresh leaves the last good list standing rather than
   * re-opening the race mid-service.
   */
  const [floorLoaded, setFloorLoaded] = useState(false)
  /** The gate's split mode is armed — the next table tap opens the split screen. */
  const [armedForSplit, setArmedForSplit] = useState(false)
  /** The gate's move mode is armed — the next table tap picks the tab to move. */
  const [armedForTransfer, setArmedForTransfer] = useState(false)
  /** The table whose whole tab is moving. Null when the picker is closed. */
  const [transferring, setTransferring] = useState<PosTable | null>(null)
  /**
   * The course picker for send-to-kitchen. Null when closed.
   *
   * Carries the document id with it rather than reading `state.documentId` at
   * send time: the waiter may have moved on by the time they choose, and firing
   * a course at whatever tab happens to be open would send one table's starters
   * against another's bill.
   */
  const [kitchenPicker, setKitchenPicker] = useState<{
    documentId: number
    options: KitchenSendOption[]
  } | null>(null)
  /** True while the hospitality autosave is writing this tab to the server. */
  const [tableSaving, setTableSaving] = useState(false)
  /**
   * Bumped when a table's autosave failed, to make it try again.
   *
   * The autosave is keyed on the LINES, so without this a waiter who added a
   * round while the box was unreachable and then stopped would never retry: the
   * basket would sit on screen, unsaved, until they happened to touch it again.
   * A counter is the smallest thing that re-runs an effect whose real inputs
   * have not changed.
   */
  const [tableSaveAttempt, setTableSaveAttempt] = useState(0)

  /**
   * The bill being split. Null when the split screen is closed.
   *
   * Keyed on the DOCUMENT, not the table: a split's source may be a free-text tab with
   * no table row at all, and the destination is now a document too (see posSplit.ts).
   * `label` is only what the screen calls it — a table code, or the tab's name.
   */
  const [splitting, setSplitting] = useState<{
    documentId: number
    label: string
    lines: SplitLine[]
  } | null>(null)

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

  /* ── THE SHIFT ────────────────────────────────────────────────────────────
     What a cash-up counts against, and the gate that refuses to trade without
     one. Declared here with the rest of the shell's state; the effect that
     seeds it and the gate derived from it stay beside the code they serve. */

  /** The shift modal — the opening float, and the blind cash-up count. */
  const [managingShift, setManagingShift] = useState(false)
  /**
   * Which drawer movement is being recorded, or null for none.
   *
   * The kind IS the open flag: one dialog wears three faces, and a separate
   * boolean beside it would be a second source of truth for "is this showing",
   * free to disagree with the face it is showing. See DrawerMovementModal.
   */
  const [drawerMovement, setDrawerMovement] = useState<MovementType | null>(null)
  /**
   * The detailed cash-up — denominations, every tender, banking.
   *
   * Separate state from `managingShift` because they are different acts: that
   * one starts and ends a shift, this is the count a supervisor signs. The
   * cashup quick key opens THIS; the shift dialog still reaches it via its own
   * button, so neither hides the other.
   */
  const [declaringCashup, setDeclaringCashup] = useState(false)
  /** "Shift open · Ruth" for the header chip, or null when none is open. */
  const [shiftLabel, setShiftLabel] = useState<string | null>(null)
  /** The open shift's id — what the declaration counts against. */
  const [shiftId, setShiftId] = useState<number | null>(null)

  /**
   * Whether this till is OPEN FOR BUSINESS — and the gate that says so.
   *
   * ── WHY THE SHELL OWNS THIS ───────────────────────────────────────────────
   *
   * A sale rung up with no shift is a real invoice in a real drawer that no
   * cash-up will ever account for. The chip in the header warned about that and
   * was ignorable by design; this makes it structural instead — no shift, no
   * sale screen. See OpenTillGate for the argument in full.
   *
   * `null` means "not established yet", which is NOT the same as "closed": the
   * status read is a round trip, and gating on a not-yet-known answer would
   * flash the closed screen on every load of a perfectly open till. So the gate
   * renders only once the server has actually said there is no shift.
   */
  const [shiftStatus, setShiftStatus] = useState<{
    mode: 'terminal' | 'user'
    canCashup: boolean
    open: boolean
    /* Whether THIS operator still has to clock on. Null-safe by construction:
       the server answers `required: false` when the shop has the rule off, so
       a site that never turns it on behaves exactly as before. */
    clock: { required: boolean; clockedIn: boolean; operatorName: string }
  } | null>(null)

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
  /**
   * The module menu is open.
   *
   * Only its OPENNESS is state. Which module the till is on is not — that is
   * `state.docType`, which the basket has carried all along. A second variable
   * saying the same thing is a second variable to get out of step with the
   * first, and the one that would be wrong is the one nothing renders from.
   */
  const [showingModules, setShowingModules] = useState(false)
  /**
   * A module switch waiting on "your basket will be cleared" — see pickModule.
   *
   * Holds the MODULE rather than the doc type it maps to, so the question names
   * the thing the cashier actually pressed. Storing the doc type had the dialog
   * ask about "an invoice" when the row said "Point of sale".
   */
  const [switchingTo, setSwitchingTo] = useState<TillModule | null>(null)
  /**
   * The shop's quotes, to find the one a customer is holding.
   *
   * Opened from the quote module's own screen rather than from the module menu:
   * the menu says WHICH KIND of document this basket is, and finding an
   * existing one is a different question from starting a new one.
   */
  const [showingQuotes, setShowingQuotes] = useState(false)
  /** Orders waiting to be collected. Opened from the order module's own key. */
  const [showingTillOrders, setShowingTillOrders] = useState(false)
  /**
   * The shop's lay-bys.
   *
   * Opened straight from the MODULE MENU, unlike quotes and orders which live
   * on the recall key. Those two are "find an existing one of what I am
   * writing"; a lay-by is not something the basket can be, so there is no
   * module to be in and no key of its own to put it on.
   */
  const [showingLaybys, setShowingLaybys] = useState(false)
  /** Turning the basket on screen into a new lay-by. */
  const [startingLayby, setStartingLayby] = useState(false)
  const [sizingTiles, setSizingTiles] = useState(false)
  /** The floor's quick-key dialog. The gate has no pane to draw them in. */
  const [showingTableKeys, setShowingTableKeys] = useState(false)
  /** The refund pad is open. Distinct from `state.returning`, which is the MODE. */
  const [returning, setReturning] = useState(false)
  /* Per-machine, from localStorage, applied after mount — a counter screen's useful
     tile size is a property of that screen, not of the shop. See useTileSize. */
  const tileSize = useTileSize()
  /* `savedTally` was here — a count of parked baskets, seeded by the server page
     and nudged up and down at five call sites, purely to feed a badge on the
     basket's Saved key. The key is a quick key now and carries no badge, so the
     counter had no reader; the server query that seeded it went with it. The
     list is still read fresh, per till, each time the modal opens. */
  const [editing, setEditing] = useState<BasketLine | null>(null)
  /**
   * Which field the line pad opens on.
   *
   * Set by the Line options menu, which names Line Discount, Price Override and
   * Set new quantity as three separate entries and so has to land on the field
   * each one promised. Everything else that opens the pad leaves it at quantity.
   */
  const [editingField, setEditingField] = useState<'qty' | 'price' | 'discount'>('qty')
  /** The line whose options menu is open — the "More" key on a line card. */
  const [lineOptions, setLineOptions] = useState<BasketLine | null>(null)
  /** A scale item waiting for its weight — see the guard in add(). */
  const [weighing, setWeighing] = useState<TillProduct | null>(null)
  /** A gift-card product waiting for its card and amount (147). */
  const [giftSelling, setGiftSelling] = useState<TillProduct | null>(null)
  /** The balance-enquiry prompt, behind its quick key. */
  const [giftBalanceOpen, setGiftBalanceOpen] = useState(false)

  /**
   * A batch-tracked product waiting for its lot (234).
   *
   * Carries the qty like `asking` does, rather than only the product like
   * `weighing`: the modal does not change the quantity, so it has to hand back
   * the one it was opened with or a "3" typed before the scan becomes a 1.
   *
   * `lots` is what the picker lists. Empty with `loading` false means the till
   * could not read them — offline, or a product with none on file — and the
   * modal falls back to a typed number.
   */
  const [lotting, setLotting] = useState<{
    product: TillProduct
    qty: number
    /**
     * The Refund key was armed when this was asked (236).
     *
     * Captured HERE rather than read at confirm time, because arming is spent
     * by the ADD that the modal's own confirm performs — by then the state says
     * false, and a return would be worded and defaulted as a sale.
     */
    returning: boolean
  } | null>(null)
  const [lotOptions, setLotOptions] = useState<TillLot[]>([])
  const [lotsLoading, setLotsLoading] = useState(false)

  /**
   * A serial-tracked product waiting for its unit (235).
   *
   * No qty carried, unlike `lotting`: one unit is one line, so the modal always
   * confirms a quantity of exactly one. Adding three laptops is three trips
   * through here, which is the point — each names its own machine.
   */
  const [serialling, setSerialling] = useState<TillProduct | null>(null)
  const [serialOptions, setSerialOptions] = useState<{ id: number; serial: string }[]>([])
  const [serialsLoading, setSerialsLoading] = useState(false)

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
    /**
     * What was kept as a tip, declared plus service charge.
     *
     * Shown beside the change because the two DIVIDE one over-tender: a
     * customer who hands over R500 on a R430 bill and leaves R20 is owed R50,
     * and a cashier looking only at "R50" has no way to tell that from a R70
     * change they short-changed. Absent (or 0) on every path that cannot carry
     * a tip — refunds, exchanges — where the row simply does not render.
     */
    tip?: number
    /** The attached account's address at finalise, for the Email button. */
    email?: string | null
  } | null>(null)
  /** The email-receipt dialog, over the receipt. */
  const [emailingReceipt, setEmailingReceipt] = useState(false)

  /**
   * The slip the LAST sale would print, built from the basket BEFORE it
   * cleared — the bridge's Print consumes this, so an offline till still puts
   * paper in a customer's hand. Online sales prefer the server slip route
   * (loyalty footer, COPY numbering); the snapshot is the bridge/offline path.
   */
  const slipRef = useRef<ReceiptData | null>(null)

  /** Builds the snapshot for the sale being finalised. Called pre-CLEAR. */
  function snapshotSlip(
    documentNumber: string,
    paid: { tenderTypeId: number; amount: number; reference?: string | null }[],
    change: number,
    roundingAdj: number,
  ) {
    try {
      slipRef.current = receiptDataFromBasket({
        siteName,
        vatNumber: siteVatNumber,
        documentNumber,
        // LOCAL date, matching how the sale is stamped.
        documentDate: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`,
        printedAt: new Date().toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }),
        cashierName: operatorName,
        terminalCode: terminal?.code ?? null,
        customerName: state.customer?.name || state.customerName.trim() || null,
        /* The payload lines, plus the promotion's NAME on each — the one thing
           a slip wants and the server does not. `salePayloadLines` is a
           whitelist of what may reach the server (see its comment), so the name
           is grafted on here rather than smuggled through it. Index-aligned by
           construction: both arrays are maps of `state.lines`. */
        lines: salePayloadLines(state.lines, lineSpecials, docShares).map((line, index) => ({
          ...line,
          /* A REWARD line has no entry in `lineSpecials` — it was not discounted,
             it was handed over, and the promotion that granted it lives in
             `rewardSpecialId`. Reading only lineSpecials here would leave the one
             line the promotion actually gave away as an unexplained R0.00 on the
             offline slip. Same fallback SalePane draws the on-screen badge with. */
          specialName:
            lineSpecials[index]?.name ??
            (state.lines[index]?.rewardSpecialId !== undefined
              ? (specialNames.get(state.lines[index].rewardSpecialId!) ?? null)
              : null),
        })),
        tenders: paid.map((p) => ({
          name: tenders.find((t) => t.id === p.tenderTypeId)?.name ?? 'Tender',
          amount: p.amount,
          changeGiven: 0,
          reference: p.reference ?? null,
        })),
        changeGiven: change,
        roundingAdj,
      })
    } catch {
      slipRef.current = null
    }
  }
  /* The last POSTED sale on this machine, surviving a reload — what the
     reprint-last-slip quick key reprints. Offline sales (documentId 0) are
     not recorded: their slip lives only in the moment, until the bridge can
     reprint a stored snapshot. One effect covers every path that sets a
     receipt, which is what keeps the four finalise sites out of this. */
  useEffect(() => {
    if (!receipt || receipt.documentId <= 0) return
    try {
      window.localStorage.setItem(
        `pos-last-sale-${siteId}`,
        JSON.stringify({ documentId: receipt.documentId, number: receipt.number }),
      )
    } catch {
      // Storage blocked — the key just says nothing to reprint.
    }
  }, [receipt, siteId])

  const toast = useToast()
  /* Named printPaper: this file's `openSalePaper` and `printBillPaper` both
     route through it, and `printDocument` would read as a third one. */
  const printPaper = usePrintDocument()
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
  /*
   * `undefined` is NOT READ YET; `null` is read, and this machine has no id.
   *
   * They were one value before, and the conflation is what put the closed-till
   * gate on screen for a blink after every sign-in — see the shift-status
   * effect. Two different facts sharing one `null` meant nothing downstream
   * could tell "ask me again in a tick" from "the answer is nothing".
   *
   * `null` is a real, permanent answer: `deviceId()` returns it when
   * localStorage is blocked (private browsing, locked-down kiosk), and the till
   * is deliberately allowed to trade on. So a reader must not simply wait for a
   * non-null id — it would wait forever on exactly those machines.
   */
  const [device, setDevice] = useState<string | null | undefined>(undefined)
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
   * ── THE HELD DEPOSIT FOLLOWS THE DOCUMENT ─────────────────────────────────
   *
   * Read from the DOCUMENT ON SCREEN rather than written by each of the two
   * dozen places that swap the basket. `depositHeld` used to be set only when
   * the deposit dialog opened, which was sound while it was that dialog's own
   * number — but the basket now shows the figure and the Pay key nets it off, so
   * a stale one is no longer a cosmetic slip. It is money.
   *
   * Both directions were wrong, and they failed opposite ways:
   *
   *   · RECALLING a parked sale that had a deposit taken against it read zero,
   *     so the till asked for the full amount and took the deposit twice.
   *   · CLEARING after a deposit sale left the figure behind, so the NEXT
   *     customer's basket came up already credited with a stranger's money.
   *
   * Keying it on `state.documentId` fixes both at once: LOAD brings a new id and
   * this re-reads, CLEAR nulls it and this zeroes. Every future path that puts a
   * basket on screen inherits the guarantee without knowing this exists — which
   * is the point, since remembering to call a setter in twenty-four places is
   * not a guarantee at all.
   *
   * Placed AFTER `till` deliberately: it reads `till.online`, and a hook above
   * that line would touch the const in its temporal dead zone and take the whole
   * till down on first render.
   *
   * `ignore` because the read is async and a cashier can recall, clear and
   * recall again faster than a round trip — without it a slow reply for a basket
   * that has since left the screen would land on the one now showing.
   */
  useEffect(() => {
    const documentId = state.documentId
    /* Offline reads nothing and holds nothing. A deposit needs the server (see
       DepositModal), so there is no figure to trust here and zero is the honest
       answer rather than a cached one from before the line dropped. */
    if (!documentId || !till.online) {
      setDepositHeld(0)
      return
    }
    let ignore = false
    void depositSummaryAction(documentId)
      .then((summary) => {
        if (ignore) return
        setDepositHeld(summary && !('ok' in summary) ? summary.held : 0)
      })
      /* A failed read must not invent a credit. Zero is the safe direction: it
         asks for the full amount, which a cashier can see is wrong and put
         right — where a phantom deposit sends a customer home underpaid. */
      .catch(() => {
        if (!ignore) setDepositHeld(0)
      })
    return () => {
      ignore = true
    }
  }, [state.documentId, till.online])

  /*
   * Baskets parked on THIS machine, with no server involved.
   *
   * Kept in state rather than read inside the modal so the shell can re-read them
   * after every park, recall and discard — IndexedDB has no change notification,
   * and a stale list offers a basket that is not there.
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
  /* Waits for the read rather than flashing the warning on every load — but only
     for the READ, not for an id. `undefined` is unread; `null` is a machine that
     has no id and never will, and that one IS unclaimed and should say so. */
  const unclaimed = device !== undefined && terminal === undefined

  /**
   * What to CALL this machine — "TILL001 • till 01".
   *
   * One value because two screens show it: the status bar along the top while
   * the till is trading, and the module menu's foot, which covers the bar while
   * it is open. It was written out twice for a few minutes and the two copies
   * had already picked different separators, which is the whole argument.
   */
  const terminalLabel = terminal
    ? `${terminal.code}${terminal.tillNumber ? ` • till ${terminal.tillNumber}` : ''}`
    : null

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

  /**
   * Whether this shop captures the lot on a batch sale, and how (234).
   *
   * Read from STORAGE rather than taken as a prop, for the reason the held
   * prices above are: a till that reloads with no network still has to behave
   * the way its shop configured it. A pharmacy that reloads at the counter must
   * not silently start booking lots by earliest expiry.
   *
   * Defaults to 'fefo' until the read lands, which is the behaviour every site
   * had before this shipped — so the wrong answer for those few milliseconds is
   * the old one rather than a wrong new one.
   */
  const [lotCapture, setLotCapture] = useState<LotCapture>({ mode: 'fefo', strict: false })
  useEffect(() => {
    let cancelled = false
    void storedSettings(siteId).then((stored) => {
      if (!cancelled) setLotCapture(lotCaptureFor(stored))
    })
    return () => {
      cancelled = true
    }
  }, [siteId])

  /*
   * The rotating menus, read the same way and with the same tell.
   *
   * An empty `posMenus` prop is ambiguous for exactly the reason the pending
   * prices are: most shops have no menus at all, so "props are empty, read
   * storage" cannot be the rule. The quick keys arrive in the same render and
   * a shop that has set any up never legitimately has none, so they stand in
   * for "did this render have a server".
   */
  const [heldMenus, setHeldMenus] = useState<PosMenu[] | null>(null)
  useEffect(() => {
    if (quickKeys.length > 0) return
    let cancelled = false
    void storedPosMenus(siteId).then((held) => {
      if (!cancelled) setHeldMenus(held)
    })
    return () => {
      cancelled = true
    }
  }, [siteId, quickKeys.length])

  const posMenus = quickKeys.length > 0 ? posMenusProp : (heldMenus ?? posMenusProp)

  /* ── Specials and scheduled prices, re-checked as the clock moves ──────
     A basket can sit open while a window opens or closes, so this ticks as well
     as recomputing on every change. A slip that kept a price the shop stopped
     offering ten minutes ago is a slip the till and the shelf edge disagree
     about.

     A scheduled price change is the same kind of event — something that becomes
     true while a till is simply sitting there — so it rides the same tick. */
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    /* Menus ride this tick too (231). Without them in the guard, a till in a
       shop that runs menus but no promotions would never re-render on the
       clock — and the grid would sit on breakfast until somebody touched it,
       which is precisely the hour nobody is touching it. */
    if (specials.length === 0 && pendingPrices.length === 0 && posMenus.length === 0) return
    const timer = setInterval(() => setClock(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [specials.length, pendingPrices.length, posMenus.length])

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
   * ── THE OVERRIDE DIES WITH THE BASKET ───────────────────────────────────
   *
   * Watched rather than cleared at each exit. A sale ends in fifteen places in
   * this file — finalised, parked, voided, closed onto a table, switched to a
   * return, recalled over — and a reset bolted onto each of them is a reset that
   * will be missing from the sixteenth. What every one of those has in common is
   * that the basket ends up empty, so that is the condition worth watching.
   *
   * The failure this prevents is quiet and expensive: a till left on Wholesale
   * after the trade customer leaves prices the next walk-in at trade, and nothing
   * on the screen is wrong — the sale simply rings up cheap. Nobody catches that
   * at the counter. It surfaces as a margin question weeks later.
   *
   * An empty basket the cashier is still setting up is unaffected: switching the
   * price type before scanning is the ordinary way to use this, and the effect
   * only fires on the TRANSITION to empty, not on staying empty.
   */
  const hadLines = useRef(false)
  useEffect(() => {
    const has = state.lines.length > 0
    if (hadLines.current && !has) setPricingOverride(null)
    hadLines.current = has
  }, [state.lines.length])

  /**
   * Puts the till back on the price type a recalled sale was rung at.
   *
   * The choice is a property of the SALE — it is written to the document when
   * the basket is parked — but it used to live only in the state above, so a
   * wholesale sale recalled onto a fresh basket read "@Retail" on every line
   * and wore a "Price changed" badge on each one. The prices were right; the
   * basis they were being described and compared against was not.
   *
   * Called on every recall path, ahead of the LOAD. Ordering matters only in
   * that it must not run after the basket empties — it never does, because a
   * recall goes empty → lines and the effect above fires the other way.
   *
   * Set unconditionally, including to null. A sale parked on the site default
   * must CLEAR an override the till is sitting on, or a basket recalled while
   * the screen happens to be on Wholesale would silently adopt it.
   */
  function restorePricing(structureId: number | null) {
    setPricingOverride(structureId)
  }

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
  /**
   * Who is being served, so a targeted promotion knows whether to fire.
   *
   * The customer and the member are already in this component's state — the
   * cashier attached them — and passing them is all targeting needs at the
   * till. Absent means a walk-in, which is exactly what a basket with nobody
   * attached is, and a special aimed at account customers correctly does not
   * apply to one.
   */
  const pricingContext = useMemo(
    () => ({
      accountType: state.customer?.accountType ?? null,
      groupId: state.customer?.groupId ?? null,
      isMember: state.member !== null,
      channel: 'in_store' as const,
    }),
    [state.customer, state.member],
  )

  const lineSpecials = useMemo(
    () => specialsFor(state.lines, state.returning ? [] : specials, new Date(clock), pricingContext),
    [state.lines, specials, clock, state.returning, pricingContext],
  )

  /** Special id to name, so a granted line's badge can say which deal gave it. */
  const specialNames = useMemo(
    () => new Map(specials.map((s) => [s.id, s.name])),
    [specials],
  )

  /**
   * The products this basket has EARNED, put on it.
   *
   * ── WHY THIS IS AN EFFECT AND NOT PART OF THE MEMO ABOVE ─────────────────
   *
   * A reward changes the basket. `lineSpecials` only reads it. Computing a
   * discount during a render is fine; adding a line during one is a render that
   * writes state, so it happens here — after the render that noticed.
   *
   * The loop this obviously risks is closed in two places: `specialsFor` feeds
   * reward lines to the engine at quantity zero, so a granted bread never helps
   * earn another; and `withRewards` returns the same array when nothing has
   * changed, so the reducer returns the same state and this effect settles after
   * exactly one pass.
   *
   * ── AND WHY IT IS SILENT ON A RETURN ─────────────────────────────────────
   *
   * Same list as the discounts above: goods coming back earn nothing, so a
   * return never grows a free item.
   */
  useEffect(() => {
    const rewards = state.returning
      ? []
      : rewardsFor(state.lines, specials, new Date(clock), pricingContext)
    // Nothing earned and nothing previously granted: the overwhelmingly common
    // case, and not worth a dispatch that the reducer would only no-op on.
    if (rewards.length === 0 && !state.lines.some((l) => l.rewardSpecialId !== undefined)) return

    /*
     * What a reward product IS comes from the special itself, not from a
     * lookup. The till has never searched for the free garlic bread — nobody
     * asked for it — so it is not in `results` or `browse`, and offline there
     * is nothing to ask. `liveSpecials` resolves it server-side and it rides in
     * the same catalogue payload the till already caches.
     */
    const described = new Map<number, RewardProduct>()
    for (const special of specials) {
      for (const product of special.rewardProducts ?? []) described.set(product.productId, product)
    }

    dispatch({
      type: 'SYNC_REWARDS',
      rewards,
      describe: (productId) => {
        const product = described.get(productId)
        // A reward naming a product this till cannot describe is not granted.
        // Better a deal that quietly does not pay than a blank line on a slip.
        if (!product) return null
        return {
          key: '',
          productId: product.productId,
          productCode: product.code,
          description: product.description,
          // Narrowed here rather than in the engine, which is pure and must not
          // know the product-type table. An unrecognised value falls back to
          // 'normal' — the same rule every other read of this column follows.
          productType: toProductType(product.productType),
          departmentId: product.departmentId,
          qty: 1,
          unitPriceIncl: 0,
          discountPct: 0,
          vatRatePct: product.vatRatePct,
          // Costed even though it is free: the giveaway has to show up against
          // the promotion in the margin, or the deal looks like it cost nothing.
          unitCostExcl: product.costExcl,
          maxDiscountPct: 0,
          shelfPriceIncl: 0,
          allowFractions: false,
          instructions: [],
          note: '',
          orderedAt: Date.now(),
        }
      },
    })
  }, [state.lines, state.returning, specials, clock, pricingContext])

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

  /**
   * A promo code on the sale. EXCLUSIVE with the manual doc discount — one
   * `docDiscount` slot, and the code wins while it is applied. Its reduction
   * rides the same apportionment, masked to the lines the code covers.
   */
  const [appliedCode, setAppliedCode] = useState<{
    codeId: number
    code: string
    discountIncl: number
    eligibleKeys: string[] | null
  } | null>(null)
  const [codeBusy, setCodeBusy] = useState(false)

  const effectiveDocDiscount: DocDiscount = state.returning
    ? null
    : appliedCode
      ? { kind: 'amount', value: appliedCode.discountIncl }
      : docDiscount
  const docShares = useMemo(
    () =>
      docDiscountShares(
        state.lines,
        lineSpecials,
        effectiveDocDiscount,
        appliedCode?.eligibleKeys ? new Set(appliedCode.eligibleKeys) : undefined,
      ),
    [state.lines, lineSpecials, effectiveDocDiscount, appliedCode],
  )

  /* An emptied basket takes its discount with it — CLEAR, SET_RETURNING and a
     settled sale all land here, so a recalled or fresh basket cannot inherit
     the last customer's discount. */
  useEffect(() => {
    if (state.lines.length === 0 && docDiscount) setDocDiscount(null)
    if (state.lines.length === 0 && appliedCode) setAppliedCode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lines.length])

  /* A CODE was priced against a specific basket — any line change invalidates
     the eligibility and the minimum, so it drops with a word rather than
     riding stale. One round trip to re-apply is cheaper than a wrong price. */
  const basketSignature = useMemo(
    () => state.lines.map((l) => `${l.key}:${l.qty}:${l.unitPriceIncl}`).join('|'),
    [state.lines],
  )
  useEffect(() => {
    if (!appliedCode || state.lines.length === 0) return
    setAppliedCode(null)
    toast.info(`Basket changed — enter ${appliedCode.code} again to re-check it.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketSignature])

  /** Validates a typed code against THIS basket and applies it. */
  function applyCode(raw: string) {
    setCodeBusy(true)
    void validateTillCodeAction(raw, {
      lines: state.lines.map((line, index) => ({
        key: line.key,
        productId: line.productId,
        qty: line.qty,
        unitPriceIncl: line.unitPriceIncl,
        onSpecial: lineSpecials[index] != null,
        departmentId: line.departmentId,
      })),
      customerId: state.customer?.id ?? null,
    })
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setDocDiscount(null) // the code takes the slot
        setAppliedCode({
          codeId: result.codeId,
          code: result.code,
          discountIncl: result.discountIncl,
          eligibleKeys: result.eligibleKeys,
        })
        setDiscountingDoc(false)
        toast.success(`${result.code} — ${result.reason}`)
      })
      .finally(() => setCodeBusy(false))
  }

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

  /**
   * The service charge actually applying to THIS bill.
   *
   * `tips_tables_only` defaults on, and on a retail till `table` is always null — so the
   * charge is zero and the pad never mentions it, which is what keeps the feature invisible
   * to a shop that does not serve tables.
   *
   * Derived, so it sits with the totals chain it reads rather than up in the state
   * block: `table` is state and hoisted, but `serviceChargeForTotal` is a memo over
   * the basket and cannot move above it.
   */
  const serviceCharge = tipsTablesOnly && !table ? 0 : serviceChargeForTotal

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
        ? searchProductsAction(term, priceStructureId, terminal?.id ?? null).catch(() =>
            searchOffline(siteId, term),
          )
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
      ? browseProductsAction({
          departmentId: openDepartment,
          priceStructureId,
          limit: 200,
          terminalId: terminal?.id ?? null,
        }).catch(() => browseOffline(siteId, openDepartment))
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

  /* ── The menu in force, and the grid it leaves ────────────────────────
     Recomputed on the `clock` tick above, so the changeover happens on this
     machine's own clock rather than whenever the catalogue next syncs.

     ⚠ BROWSE ONLY. Search results are deliberately NOT filtered: an off-menu
     product stays sellable by scan or by search, which is the promise 231
     makes and the reason a kitchen can still make you eggs at 11:05. Filtering
     search as well would turn a hospitality decision into a refusal. */
  /*
   * ⚠ `terminal?.id ?? null` — and the `null` is deliberate, not a fallback.
   *
   * `activeMenu` treats undefined as "do not narrow" (what the back office's
   * preview wants) and null as "a machine that matches no till", which gets
   * the shop-wide menus only. Passing undefined here would put a menu pinned
   * to the bar on an unclaimed machine, which is the bug this parameter
   * exists to prevent. See 232.
   */
  const liveMenu = useMemo(
    () => activeMenu(posMenus, new Date(clock), terminal?.id ?? null),
    [posMenus, clock, terminal?.id],
  )

  /* The department path lookup the engine needs, built once per department
     list rather than per product — a 400-tile grid would otherwise climb the
     tree 400 times to answer the same handful of questions. */
  const departmentPath = useMemo(() => {
    const byId = new Map(departments.map((d) => [d.id, d]))
    const cache = new Map<number, number[]>()
    return (departmentId: number | null): number[] => {
      if (departmentId === null) return []
      const hit = cache.get(departmentId)
      if (hit) return hit
      const path: number[] = []
      const seen = new Set<number>()
      let current = byId.get(departmentId)
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        path.push(current.id)
        current = current.parentId === null ? undefined : byId.get(current.parentId)
      }
      cache.set(departmentId, path)
      return path
    }
  }, [departments])

  const browseProducts = useMemo(
    () => productsOnMenu(browse.products, liveMenu, departmentPath),
    [browse.products, liveMenu, departmentPath],
  )

  /*
   * The rail and the drill tiles, filtered to match.
   *
   * Without this the till draws every department it has ever had, and at
   * breakfast most of them open onto nothing — a cashier presses "Burgers"
   * and gets an empty pane with no explanation, which reads as a broken till.
   *
   * ⚠ Judged from the MENU'S SCOPE, not from the products on screen. The till
   * only ever holds the open department's products, so "does this department
   * still have anything" cannot be answered by looking at the grid — every
   * unopened department would look empty and the rail would collapse to one
   * button.
   *
   * A department counts as on the menu when the menu includes it or an
   * ancestor of it, and does not exclude it — the same rule `menuAllows`
   * applies to a product, minus the per-product rows.
   */
  const menuDepartments = useMemo(
    () =>
      departmentsOnMenu(departments, liveMenu, (departmentId) => {
        if (!liveMenu) return true
        const path = new Set(departmentPath(departmentId))
        let included = false
        for (const item of liveMenu.items) {
          if (item.departmentId === null) continue
          if (!path.has(item.departmentId)) continue
          if (item.effect === 'exclude') return false
          included = true
        }
        return included
      }),
    [departments, liveMenu, departmentPath],
  )

  /*
   * What each department tile says beneath its name.
   *
   * Rolled up over MENU-FILTERED departments rather than the whole tree, and
   * that is the load-bearing part: at breakfast the menu hides most of a
   * restaurant's departments, and counting the raw tree would have a visible
   * 'Drinks' tile promise the sections and products of a 'Cocktails' that is
   * not on the menu and cannot be opened. The number a tile shows has to be
   * the number of things behind it right now.
   *
   * The per-department PRODUCT counts are still the shop's whole file — a menu
   * can hide a department but products are excluded per row, and the till only
   * holds the open department's products, so a menu that excludes individual
   * items will read very slightly high on its parent's tile. That is the
   * deliberate trade: the alternative is shipping the whole product file's
   * department ids to count them, and a count that is off by the handful of
   * items a menu suppresses is worth far less than the round trip.
   */
  const tallies = useMemo(
    () => departmentTallies(menuDepartments, departmentCounts),
    [menuDepartments, departmentCounts],
  )

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
     * A gift card needs its card number and amount before the line exists —
     * the WeighModal pattern, for the same reason: every add path converges
     * here, and the one a narrower check missed would be the scanner. A line
     * arriving with the code already on it (the modal's own confirm) passes.
     */
    if (product.productType === 'gift_card' && !product.giftCardCode) {
      setGiftSelling(product)
      return
    }

    /*
     * A serial-tracked item needs to say WHICH unit before the line exists (235).
     *
     * Until this existed, nothing at a till could name one — so the sale was
     * refused at the tender pad, with the customer's card already out. The
     * offline path never reaches here: serial items are blocked at the tile
     * above, because picking a unit needs the serial table.
     *
     * One unit per line, so the modal always adds a quantity of ONE regardless
     * of what was asked for. Three laptops means three trips through here.
     */
    if (product.productType === 'serial' && !product.pickedSerialId) {
      setSerialling(product)
      setSerialOptions([])
      setSerialsLoading(true)
      if (product.id !== null) {
        void serialsForProductAction(product.id, terminal?.id ?? null)
          .then((rows) => setSerialOptions(rows))
          .catch(() => setSerialOptions([]))
          .finally(() => setSerialsLoading(false))
      } else {
        setSerialsLoading(false)
      }
      return
    }

    /*
     * A batch item whose lot nobody has named yet (234).
     *
     * Only under 'prompt' — under 'barcode' the scan either carried a lot or it
     * did not, and stopping the queue to ask would defeat the point of reading
     * it off the pack. `scannedBatchNo` already set is the modal's own confirm
     * coming back through, and passes.
     *
     * Here for the reason the three checks above are: every add path converges
     * on add(), and the one a narrower check would miss is the scanner.
     */
    if (
      lotCapture.mode === 'prompt' &&
      product.productType === 'batch' &&
      !product.scannedBatchNo
    ) {
      setLotting({ product, qty, returning: state.refundArmed })
      setLotOptions([])
      /*
       * Offline there is no list to fetch — the catalog feed ships products,
       * not lots — so the modal opens straight into its typed field rather
       * than showing a spinner for something that will never arrive.
       */
      if (till.online && product.id !== null) {
        setLotsLoading(true)
        void lotsForProductAction(product.id, terminal?.id ?? null)
          .then((rows) => setLotOptions(rows))
          .catch(() => setLotOptions([]))
          .finally(() => setLotsLoading(false))
      }
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
        ? await scanAction(code, priceStructureId, terminal?.id ?? null).catch(() =>
            findByCode(siteId, code),
          )
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
      /* Off the SAME plan the change came from, so the two figures on the
         receipt always add up to the excess the customer handed over. Reading
         `tipInfo.declared` instead would miss the service charge and would
         report a tip the plan had refused. */
      tip: plan.ok ? round(plan.tips.reduce((sum, t) => sum + t.amount, 0), 2) : 0,
      /* No document id — nothing has posted, so there is nothing to open or void
         through the back office. The receipt hides both buttons on a zero id, and
         cancelling an unsynced sale is the outbox screen's job. */
      documentId: 0,
      total: totals.doc.totalIncl,
    })
    /* The offline slip and the drawer. The bridge is LOCAL, which is the whole
       point: paper still comes out with the server gone. */
    snapshotSlip(result.documentNumber, paid, result.change, 0)
    if (paid.some((p) => tenders.find((t) => t.id === p.tenderTypeId)?.opensCashDrawer)) {
      void kickDrawer()
    }
    dispatch({ type: 'CLEAR' })
    // The badge must move immediately: this sale is now the till's responsibility
    // and the cashier has to be able to see that it is waiting.
    await till.recount()
    toast.success(`${result.documentNumber} saved on this till — it will send itself.`)
  }

  /**
   * What this payment keeps as a tip — for the RECEIPT, not for posting.
   *
   * The server plans its own tips from the same inputs with the same `planTips`,
   * and its result reports only `change` back. Rather than widen the action's
   * return to carry a figure the client can already derive, this re-runs the
   * shared arithmetic — the same call `finaliseLocally` makes for the offline
   * slip, so both paths show one number computed one way.
   *
   * A refused plan reports 0: the server refuses the sale outright in that case,
   * so no receipt is shown, and guessing a tip here would be inventing one.
   */
  function tipTotalFor(
    paid: { tenderTypeId: number; amount: number; reference?: string | null }[],
    tipInfo: { declared: Record<number, number>; serviceChargeWaived: boolean },
  ) {
    const tendered = paid.reduce((sum, p) => sum + p.amount, 0)
    const charge = tipInfo.serviceChargeWaived ? 0 : serviceCharge
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
    return plan.ok ? round(plan.tips.reduce((sum, t) => sum + t.amount, 0), 2) : 0
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

    /*
     * ── AN EXCHANGE IN FLIGHT TAKES ITS OWN PATH ───────────────────────────
     * The held credit and the replacement basket post as ONE server call: the
     * credit note refunds into the EXCHANGE tender, the sale pays out of it,
     * and the pad's `paid` covers only the real-money balance. Online only —
     * the over-credit guard needs every credit note on the invoice.
     */
    if (exchangeCredit && !state.returning) {
      if (!till.online) {
        toast.error('An exchange needs the connection. Take a no-receipt return instead, or wait for the line.')
        return
      }
      const held = exchangeCredit
      startTransition(async () => {
        const result = await tillExchangeAction(
          { invoiceId: held.invoiceId, reasonId: held.reasonId, note: held.note, lines: held.lines },
          {
            customerId: state.customer?.id ?? null,
            customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            lines: salePayloadLines(state.lines, lineSpecials, docShares),
          },
          paid,
          spendOverrideToken(),
        )
        if (!result.ok) {
          if (result.creditNotePosted) {
            /* The return HAS posted — the credit is real. Drop exchange mode so
               the retry pays with the Exchange tender by hand, and say so. */
            setExchangeCredit(null)
          }
          toast.error(result.error)
          return
        }
        setTendering(false)
        setEditing(null)
        setExchangeCredit(null)
        setReceipt({
          number: result.sale.documentNumber,
          change: round(result.sale.change + result.cashBack, 2),
          documentId: result.sale.documentId,
          total: totals.doc.totalIncl,
        })
        dispatch({ type: 'CLEAR' })
        toast.success(
          `${result.creditNote.documentNumber} credited ${formatMoney(result.creditNote.total)}` +
            (result.cashBack > 0 ? ` — hand back ${formatMoney(result.cashBack)}.` : '.'),
        )
        router.refresh()
      })
      return
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
            /* Who earns and spends the loyalty. Sent separately because a
               walk-in member has no customerId to carry it, and because the
               server must not have to guess which of the two a caller meant. */
            memberId: state.member?.id ?? null,
            /* `||`, NOT `??`, for the walk-in fallback.
               An untyped name trims to '' — which is not nullish, so `??` let it
               through and the document ended up with the literal string "null" as
               its customer name. Verified against real rows before this was fixed. */
            customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
            customerVatNo: state.customer?.vatNumber ?? null,
            customerPhone: state.customer?.phone ?? null,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            /* Which machine is ringing this up. The server re-checks its licence
               rather than trusting the screen that already did — see
               requireLicensedDevice. */
            /* `?? null`: unread and no-id both travel as null. A sale cannot be
               rung up before the effect that reads it has run, so in practice
               this is the no-id case. */
            deviceSerial: device ?? null,
            priceStructureId,
            lines: salePayloadLines(
              state.lines,
              lineSpecials,
              docShares,
              appliedCode?.codeId ?? null,
            ),
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
          /* The promo code, spent transactionally at finalise — the lines
             above already carry its money as discountIncl. */
          appliedCode
            ? {
                codeId: appliedCode.codeId,
                code: appliedCode.code,
                amountIncl: appliedCode.discountIncl,
              }
            : null,
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
        /* Same arithmetic the server just ran, off the same inputs — see
           `tipTotalFor`. Computed BEFORE the CLEAR, like `total` below. */
        tip: tipTotalFor(paid, tipInfo),
        documentId: result.documentId,
        /* Read from `totals` here, BEFORE the CLEAR below empties the basket.
           Reading it in the void dialog instead would show R0.00, because by then
           the basket it was computed from is gone. */
        total: totals.doc.totalIncl,
        /* TillCustomer carries no email (deliberately lean); the dialog's empty
           To field says to type one. */
        email: null,
      })
      /* The slip snapshot and the drawer — BEFORE the CLEAR empties the basket
         they are built from. The kick fires now (a cashier owed change cannot
         wait); paper prints on the modal's Print tap. */
      snapshotSlip(result.documentNumber, paid, result.change, result.roundingAdj ?? 0)
      if (paid.some((p) => tenders.find((t) => t.id === p.tenderTypeId)?.opensCashDrawer)) {
        void kickDrawer()
      }
      /* Anything the kitchen has not seen, fired as the sale FINALISES — the
         third of the three commit points, beside saving and closing a tab. A
         quick counter sale is the case this catches: rung and paid in one
         gesture, with no save in between that could have sent it.

         Read `result.documentId` rather than `state.documentId`, and read it
         before the CLEAR below: a walk-in sale had no document until this call
         returned one. */
      void autoSendToKitchen(result.documentId)
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
  /** Runs a receipted-return action, chaining to the supervisor pad on refusal. */
  function runReceiptedRefund(pick: ReceiptReturnPick, refundTenderTypeId: number, token?: string) {
    startTransition(async () => {
      const result = await tillCreditNoteAction(
        {
          invoiceId: pick.invoiceId,
          reasonId: pick.reasonId,
          note: pick.note,
          lines: pick.lines,
          refunds: [{ tenderTypeId: refundTenderTypeId, amount: pick.total }],
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
        },
        token,
      )
      if (!result.ok) {
        if (!token && result.error.includes('supervisor')) {
          setOverride({
            capability: 'sales.credit_note',
            actionLabel: `Return against ${pick.invoiceNumber}`,
            amount: pick.total,
            documentId: pick.invoiceId,
            onAuthorised: (auth) =>
              runReceiptedRefund(pick, refundTenderTypeId, auth.token || undefined),
          })
          return
        }
        toast.error(result.error)
        return
      }
      setReceiptReturn(false)
      setReceipt({
        number: result.documentNumber,
        change: pick.total,
        documentId: result.documentId,
        total: -result.total,
      })
      toast.success(`${result.documentNumber} — hand back ${formatMoney(pick.total)}.`)
      router.refresh()
    })
  }

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
      /* SET_RETURNING rather than CLEAR, and the difference matters: CLEAR keeps the
         mode on purpose, so that a cashier who clears a mis-keyed return carries on
         returning. But this credit note is FINISHED — there is no Sale/Return switch to
         put the till back, so the posting is what ends the mode. Without this the next
         customer's goods are credited instead of sold. */
      dispatch({ type: 'SET_RETURNING', returning: false })
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
    /* Ends the mode as well as the basket — see the online path above. */
    dispatch({ type: 'SET_RETURNING', returning: false })
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
  }

  /**
   * Park the basket.
   *
   * `label` overrides what the sale is currently called — the Close flow passes
   * the name straight from the dialog rather than setting state and hoping the
   * re-render lands before this runs, which it would not.
   */
  /**
   * Open the deposit dialog, saving the basket first if it has never been saved.
   *
   * A deposit is held against a DOCUMENT, so there has to be one. An unsaved
   * basket has no id — `saveDraft` treats a null documentId as "create" — so this
   * saves exactly as `park` does and then opens the dialog against the id that
   * comes back.
   *
   * Offline it opens anyway and the dialog explains why it cannot take anything.
   * Refusing to open at all would leave a cashier tapping a dead key with no
   * idea why, which is the failure mode `NOT_WIRED` exists to prevent.
   */
  async function openDeposit() {
    if (!till.online) {
      setDepositHeld(0)
      setTakingDeposit(true)
      return
    }

    if (state.lines.length === 0) {
      toast.info('Ring the sale up first, then take a deposit against it.')
      return
    }

    startTransition(async () => {
      let saved: Awaited<ReturnType<typeof saveSaleAction>>
      try {
        saved = await saveSaleAction(
          state.documentId,
          {
            customerId: state.customer?.id ?? null,
            customerName:
              state.customer?.name || state.customerName.trim() || tabCustomer.trim() || 'Walk-in',
            customerVatNo: state.customer?.vatNumber ?? null,
            customerPhone: state.customer?.phone ?? null,
            reference: (tabLabel ?? '').trim() || null,
            personCount: tabPeople,
            visitTypeId: tabVisitTypeId,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            /* What this basket IS. Without it a deposit taken against a quote
               silently rewrote the document as an invoice — see park() below,
               which had the same omission. */
            docType: state.docType,
            lines: salePayloadLines(state.lines, lineSpecials, docShares),
          },
          /* Peeked, not spent — the same approval must still cover the finalise. */
          overrideTokenRef.current ?? undefined,
        )
      } catch {
        toast.error('The sale could not be saved, so no deposit was taken. Try again.')
        return
      }
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }

      /* Attach the id so the dialog, and everything after it, works against the
         document that now exists. */
      if (state.documentId !== saved.documentId) {
        dispatch({ type: 'ATTACH_DOCUMENT', documentId: saved.documentId })
      }

      /* Read fresh rather than trusting a cached figure: another till may have
         taken a deposit against this same document since it was last seen. */
      const summary = await depositSummaryAction(saved.documentId).catch(() => null)
      setDepositHeld(summary && !('ok' in summary) ? summary.held : 0)
      setTakingDeposit(true)
    })
  }

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
          /*
           * WHAT THIS BASKET IS.
           *
           * The basket has carried a doc type since the till learned to write
           * more than invoices, and this call never sent it — so a quote parked
           * at the till was written as an INVOICE, landed in Saved sales, and
           * never appeared in the quote register at all. The action has always
           * accepted the field; nothing passed it.
           */
          docType: state.docType,
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
      /* The second of the three commit points. `saved.documentId` rather than
         `state.documentId`: a basket saved for the first time only acquired an
         id on the call above, and that is exactly the case with the most to
         send. */
      void autoSendToKitchen(saved.documentId)
      /*
       * HAND THE CLAIM BACK.
       *
       * Harmless on an invoice, which is why nothing needed it before: a parked
       * sale lands in `saved` and the saved-sales list reclaims one freely. It
       * matters on a QUOTE. A terminal claim never expires by design, so a quote
       * finished here would stay locked to this till forever and no other
       * counter could ever open it again without a supervisor.
       *
       * Keyed on `saved.documentId` rather than through releaseHeldBill: that
       * one reads `state.documentId`, which is null for a basket that has just
       * been written for the first time — it would release nothing on exactly
       * the case that creates the document.
       *
       * Not awaited, like every other release: the claim is invisible to the
       * cashier and holding the screen on it would make saving feel slow.
       */
      void reparkTableBillAction(saved.documentId).catch(() => {})
      dispatch({ type: 'CLEAR' })

      /* Back to the floor, with the tab's identity dropped so the next sale does
         not inherit this one's name. In hospitality the gate IS where a waiter
         goes next; in retail there is no gate and the till simply empties.

         NOT ON A QUOTE. Somebody writing quotes is working through a queue of
         them at a counter, and being thrown out to the table plan after each one
         means walking back in through the gate and the module menu to write the
         next. The till stays where it is, empty and ready for the next quote. */
      clearTabIdentity()
      if (hospitality && state.docType !== 'quote') {
        setTable(null)
        setChoosingTable(true)
        refreshTables()
      }
      router.refresh()
    })
  }

  /**
   * Take the last line back off — the Undo key.
   *
   * ── TWO SEPARATE QUESTIONS, ASKED IN THIS ORDER ───────────────────────────
   *
   * May they, and did it happen. The limit answers the first and refuses BEFORE
   * anything is removed, because a till that took the line off and then complained
   * would have already done the thing it was refusing. The record answers the
   * second and is written for every undo that goes through, limit or no limit —
   * see recordUndoAction for why those are not the same switch.
   *
   * The line is read here rather than inside the reducer's UNDO because the record
   * needs to name what was removed, and by the time the reducer has run it is gone.
   * The reducer picks the last line by the same rule, so the two cannot disagree
   * about which one that is.
   *
   * The audit call is deliberately NOT awaited and its failure is deliberately not
   * surfaced. An undo is a correction the cashier is watching for, and holding the
   * screen on a log write — or worse, telling them it failed — would make the trail
   * the cashier's problem. `logActivity` already swallows its own errors; this
   * catch is for the transport.
   */
  /**
   * The void the cashier has asked for and not yet given a reason for.
   *
   * Voiding is two steps — ask, then do — and nothing is removed until the
   * reason comes back. Holding the intent here rather than removing optimistically
   * is what makes "Keep it" mean keep it: a cashier who opens the prompt and
   * changes their mind must get the line back exactly as it was, and a line put
   * back after removal would have lost its position in the basket.
   *
   * `lines` carries what will be recorded, captured NOW, because the reducer
   * destroys it. For an item void that is the single unit coming off, not the
   * line it comes off — see buildItemVoid.
   */
  const [pendingVoid, setPendingVoid] = useState<{
    voidType: VoidType
    /** What the modal shows. */
    description: string
    qty: number
    valueIncl: number
    /** What gets written, one row each. */
    events: VoidEventPayload[]
    /** Applied once a reason is given. */
    apply: () => void
  } | null>(null)

  /** The line's worth, VAT in and before discount — the undo trail's basis. */
  function lineValue(line: BasketLine, qty: number): number {
    return round(qty * line.unitPriceIncl, 2)
  }

  /**
   * Asks why, then does it.
   *
   * Every void goes through here, so the prompt cannot be skipped on one path
   * and enforced on another — which is the failure mode that makes a void report
   * quietly wrong rather than visibly empty.
   */
  function askVoid(intent: NonNullable<typeof pendingVoid>) {
    setPendingVoid(intent)
  }

  /**
   * One unit off a line, via the − key.
   *
   * Recorded as an `item` void even when it empties the line, because item is
   * what the cashier DID. `stepQty` removes a line that reaches zero, so on a
   * single-unit line this looks identical to a line void from the outside —
   * filing it as one would inflate line voids on every shop that sells singles.
   */
  /**
   * A reward line belongs to the promotion, not to the cashier.
   *
   * Its quantity, its price and its presence are all decided by the deal that
   * granted it, and re-priced from scratch on the next keystroke — so an edit
   * here would be silently undone a moment later, which is worse than being
   * told no. The way to remove a free item is to remove the goods that earned
   * it, and the message says so rather than just refusing.
   *
   * Returns true when it has handled the gesture, so callers read as a guard.
   */
  function refuseRewardEdit(line: BasketLine): boolean {
    if (line.rewardSpecialId === undefined) return false
    toast.info(`“${line.description}” is free with this deal — remove what earned it to take it off.`)
    return true
  }

  function stepLine(key: string, delta: number) {
    const line = state.lines.find((l) => l.key === key)
    if (!line) return
    if (refuseRewardEdit(line)) return

    // Adding is not a void. Only the − key asks a question.
    if (delta > 0) {
      dispatch({ type: 'STEP', key, delta })
      return
    }

    const step = line.allowFractions ? Math.abs(delta) : Math.max(1, Math.round(Math.abs(delta)))
    const coming = Math.min(step, line.qty)

    askVoid({
      voidType: 'item',
      description: line.description,
      qty: coming,
      valueIncl: lineValue(line, coming),
      events: [
        {
          voidType: 'item',
          productId: line.productId ?? null,
          productCode: line.productCode ?? null,
          description: line.description,
          qty: coming,
          valueIncl: lineValue(line, coming),
        },
      ],
      apply: () => dispatch({ type: 'STEP', key, delta }),
    })
  }

  /** A whole line off, via the Void key on the line card. */
  function voidLine(key: string) {
    const line = state.lines.find((l) => l.key === key)
    if (!line) return
    if (refuseRewardEdit(line)) return

    askVoid({
      voidType: 'line',
      description: line.description,
      qty: line.qty,
      valueIncl: lineValue(line, line.qty),
      events: [
        {
          voidType: 'line',
          productId: line.productId ?? null,
          productCode: line.productCode ?? null,
          description: line.description,
          qty: line.qty,
          valueIncl: lineValue(line, line.qty),
        },
      ],
      apply: () => dispatch({ type: 'REMOVE', key }),
    })
  }

  /**
   * The whole basket, abandoned.
   *
   * Writes a `sale` rollup AND one `line` row per line, sharing a group_id.
   * Without the line rows a product-level report cannot see the goods that went
   * out with the basket, which is where the value is; without the rollup nobody
   * can tell four separate mistakes from one abandoned sale. Anything summing
   * value must therefore filter on void_type — see the migration.
   */
  function voidSaleDraft(then?: () => void) {
    const lines = state.lines
    if (lines.length === 0) {
      then?.()
      return
    }

    const total = lines.reduce((sum, l) => sum + lineValue(l, l.qty), 0)

    askVoid({
      voidType: 'sale',
      description: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
      qty: lines.length,
      valueIncl: round(total, 2),
      events: [
        {
          voidType: 'sale',
          productId: null,
          productCode: null,
          description: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
          qty: lines.length,
          valueIncl: round(total, 2),
        },
        ...lines.map((l) => ({
          voidType: 'line' as const,
          productId: l.productId ?? null,
          productCode: l.productCode ?? null,
          description: l.description,
          qty: l.qty,
          valueIncl: lineValue(l, l.qty),
        })),
      ],
      apply: () => {
        /*
         * ── THE BILL GOES TOO, NOT JUST THE LINES ─────────────────────────
         *
         * This used to be a bare CLEAR, which is the whole job for a retail
         * basket — that one lives in this component until it is paid, so
         * emptying it IS voiding it. A hospitality basket is already parked on
         * the server, and a CLEAR alone left the voided order sitting on the
         * floor for the next waiter to pick up: the screen said the sale was
         * gone, the table said it was still there, and the table was right.
         *
         * Read BEFORE the dispatch. CLEAR wipes `state.documentId`, so a
         * version of this that read it afterwards would cancel nothing — the
         * same ordering trap `releaseHeldBill` documents.
         */
        const parked = state.documentId
        dispatch({ type: 'CLEAR' })
        if (parked) void voidTableBillAction(parked).catch(() => {})

        /*
         * Hospitality has somewhere to go back TO. The sale that was on screen
         * no longer exists, and a till sitting on a blank basket still labelled
         * with the table it just voided invites the waiter to ring the next
         * order onto a bill that is gone. Retail has no floor, so it stays put
         * on an empty basket — which is exactly where a cleared retail sale has
         * always left it.
         *
         * Skipped when the caller passed its own `then`: the unnamed-close
         * prompt already walks to the gate itself, and doing it twice would
         * fight over `choosingTable`.
         */
        if (then) {
          then()
          return
        }
        if (hospitality) {
          clearTabIdentity()
          setTable(null)
          setChoosingTable(true)
          refreshTables()
        }
      },
    })
  }

  /**
   * The reason came back: record it, then do the thing.
   *
   * The removal is applied FIRST and the write is fire-and-forget behind it. A
   * cashier waiting on a database round trip to see a line leave the screen
   * would be waiting on the audit trail, and an offline till would never let go
   * of the line at all. `recordVoidEvents` swallows its own errors; this catch
   * is for the transport.
   */
  function confirmVoid(reason: { reasonId: number; note: string | null; reasonName?: string }) {
    const intent = pendingVoid
    if (!intent) return

    setPendingVoid(null)

    /*
     * READ BEFORE `apply()`. The document id and the voided products are both
     * destroyed by the removal — a `sale` void dispatches CLEAR, which wipes
     * `state.documentId` — so a version of this that read them afterwards would
     * cancel nothing. The same ordering trap `releaseHeldBill` documents.
     *
     * The `sale` ROLLUP row is skipped: it carries no product and exists to
     * count baskets, while the `line` rows written beside it are the actual
     * goods. Including it would try to cancel a product id of null.
     */
    const cancelDocumentId = state.documentId
    const cancelItems = intent.events
      .filter((e) => e.voidType !== 'sale' && e.productId)
      .map((e) => ({
        productId: e.productId as number,
        description: e.description,
        qty: e.qty,
      }))

    intent.apply()

    // Told to the kitchen, so the shop's own word beats a code: a chef reads
    // "Customer left", not "CUSTLEFT".
    const cancelReason = [reason.reasonName, reason.note].filter(Boolean).join(' — ')
    void cancelAtKitchen(cancelDocumentId, cancelItems, cancelReason)

    const groupId = intent.voidType === 'sale' ? crypto.randomUUID() : null

    void (async () => {
      try {
        await recordVoidAction({
          reasonId: reason.reasonId,
          note: reason.note,
          documentId: state.documentId,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          shiftId: await currentShiftId(siteId),
          groupId,
          events: intent.events,
        })
      } catch {
        /* Offline, or the write failed. The void itself stands — it is local and
           the cashier has watched it happen. Nothing useful to say to them about
           a trail they did not ask for, and refusing the void because the audit
           row would not write is the one behaviour nobody wants: it would hold a
           customer at the counter over logging.

           KNOWN GAP: a void taken while the line is down is LOST, not queued.
           The outbox carries finalised sales, which are money owed and must
           arrive; a void has no such claim on it, and putting one in the queue
           would mean an abandoned basket could not be cleared until it drained.
           The honest consequence is that void totals under-report an offline
           spell rather than over-report it — which is the safer direction for a
           number an accusation might rest on, but it is still a gap. Closing it
           means its own IndexedDB store replayed on reconnect, the same shape
           `parkOffline` uses, and that is a piece of work rather than a line. */
      }
    })()
  }

  /**
   * A choice from the line's "More" menu.
   *
   * The menu is a list of verbs and this is the one place that says what each
   * verb DOES, so a reader can see the whole set at once rather than chasing
   * seven handlers. Three of them are the three fields of the line pad and open
   * it on their own field; one is the note, which the pad also holds.
   *
   * ── THE THREE THAT ARE NOT BUILT YET ──────────────────────────────────────
   *
   * Wastage, Generic Extras and Move to person are named here and refuse
   * politely, because each needs real work that has not been specced:
   *
   *   · WASTAGE has to take the stock OUT without selling it. The write-off
   *     document and its reason list already exist (100_stock_adjustments), and
   *     `recordMovement` is the one gate every quantity change goes through —
   *     but there is no movement type for it and no line-level reason column, so
   *     wiring it up is a decision about what a till may write off unsupervised,
   *     not a screen.
   *   · GENERIC EXTRAS needs an ad-hoc priced extra. Every `ChosenOption` today
   *     is minted from a configured library option, and `pruneUnasked` strips
   *     any answer whose group was not asked — so a free-typed extra would be
   *     silently deleted on the next save rather than merely unsupported.
   *   · MOVE TO PERSON has no model behind it. posSplit.ts records that a
   *     per-seat column on a line was considered and REJECTED, on the grounds
   *     that every screen summing a document would have to learn to group by it.
   *     Today the unit of person-ness is a table, and "move to person" either
   *     means a new concept or means the existing split.
   *
   * A named row that says "not yet" beats a missing row: a cashier who was
   * promised these can see the till knows about them, and nobody files a bug
   * for a button that is honest about itself.
   */
  function chooseLineOption(option: LineOption) {
    const line = lineOptions
    if (!line) return
    setLineOptions(null)

    switch (option) {
      /* The three fields of one pad, each landing on its own. */
      case 'discount':
        setEditingField('discount')
        setEditing(line)
        return
      case 'price':
        setEditingField('price')
        setEditing(line)
        return
      case 'quantity':
        setEditingField('qty')
        setEditing(line)
        return
      /* The note lives on the same pad, under the keys. Opened on quantity
         because the note box is always visible there — it is not a tab. */
      case 'message':
        setEditingField('qty')
        setEditing(line)
        return
      case 'wastage':
        toast.info('Wastage is not set up on the till yet — write it off under Adjustments.')
        return
      case 'extras':
        toast.info('Generic extras are not available yet.')
        return
      case 'move':
        /* Pointed at the thing that DOES exist rather than a flat refusal: a
           waiter moving one person's food onto their own bill is served today
           by splitting the table, and hospitality is the only mode where the
           gesture means anything. */
        toast.info(
          hospitality
            ? 'Moving one line to a person is not available yet — use Split bill.'
            : 'Moving a line to another bill is not available on a counter till.',
        )
        return
    }
  }

  function undoLastLine() {
    const last = state.lines[state.lines.length - 1]
    if (!last) {
      toast.info('Nothing to undo.')
      return
    }

    if (undoLimit > 0 && state.undoCount >= undoLimit) {
      toast.error(
        undoLimit === 1
          ? 'One undo per sale on this till. Tap the line to edit it, or void the sale.'
          : `${undoLimit} undos per sale on this till. Tap the line to edit it, or void the sale.`,
      )
      return
    }

    const undoNumber = state.undoCount + 1
    dispatch({ type: 'UNDO' })

    void recordUndoAction({
      documentId: state.documentId,
      productId: last.productId ?? null,
      description: last.description,
      qty: last.qty,
      /* Gross, before any line discount — the same shape documentMath starts from.
         What the customer would have been asked for is the figure that makes a
         pattern of undos worth reading. */
      lineTotalIncl: round(last.qty * last.unitPriceIncl, 2),
      undoNumber,
      terminalCode: terminal?.code ?? null,
    }).catch(() => {
      /* Offline, or the write failed. The undo itself stands — it is local, and the
         cashier has seen it happen. Nothing useful to say to them about a trail they
         did not ask for, so this is silent by design rather than by omission. */
    })

    /* Said out loud on the LAST one, while the sale is still open. A cashier who
       discovers the limit by being refused has already lost the correction they
       were making; one who is told they have none left can tap the line instead. */
    if (undoLimit > 0 && undoNumber === undoLimit) {
      toast.info('That was the last undo on this sale.')
    }
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
  /**
   * The Save key — the same act as Close, minus the ambiguity.
   *
   * Close has to ask "save, void, or carry on" when a basket has no name, because
   * a waiter pressing Close might mean any of the three. Somebody who pressed SAVE
   * has already answered that question, so this skips straight to naming: putting
   * a "void it" button in front of a cashier who asked to save is offering them a
   * way to lose the sale they were trying to keep.
   *
   * Everything else is the same path, deliberately — a named tab or a seated table
   * saves silently, an empty basket does nothing.
   */
  function saveSale() {
    if (state.lines.length === 0) {
      toast.info('Add something before saving the sale.')
      return
    }
    /*
     * A QUOTE IS NOT A TABLE'S BILL, so it never asks for a table.
     *
     * The naming dialog below is the hospitality path: an unnamed basket at a
     * restaurant till belongs to a table or a tab, and Save asks which. A quote
     * belongs to a CUSTOMER — it may be printed and carried out of the building
     * — and putting "Create new table · pick a table number" in front of
     * somebody saving one asks a question with no sensible answer. Which is
     * exactly what it did: found by driving the screen, where the save key on a
     * quote opened the table pad.
     *
     * Parked directly instead. The quote already carries the customer name it
     * was recalled or rung up with, which is the identity that matters here.
     */
    if (state.docType === 'quote') {
      park()
      return
    }
    if (table || tabLabel) {
      closeSale()
      return
    }
    setNaming({ closing: true })
  }

  /**
   * Opens the tender pad, after saying anything worth saying about stock.
   *
   * ── WHY THE CHECK IS HERE AND NOT AT THE LINE ─────────────────────────────
   *
   * Stock moves between somebody starting a sale and paying for it — another
   * till sells the last one, a delivery lands, a return comes back. Checking as
   * lines are added answers the question at its least useful moment. This is the
   * last point before money changes hands, so it is the honest one.
   *
   * ── IT WARNS, IT DOES NOT REFUSE ──────────────────────────────────────────
   *
   * A shop selling something it cannot hand over right now usually knows: the
   * customer collects tomorrow, the delivery is in the yard, the count is out
   * and everyone knows it. Blocking the sale would have the till argue with a
   * cashier who has more information than it does. So the pad opens either way
   * and the warning rides above it.
   *
   * ── SKIPPED OFFLINE, DELIBERATELY ─────────────────────────────────────────
   *
   * A disconnected till cannot know what other tills have sold. A warning from a
   * cached figure is a guess dressed as a fact, and the honest thing is silence.
   * The stock movement still posts when the sale syncs.
   */
  function openTender() {
    if (state.returning) {
      setReturning(true)
      return
    }

    /*
     * A QUOTE OR AN ORDER IS FINISHED BY SAVING IT, not by taking money.
     *
     * The same button does both jobs — see SalePane, where it reads "Save"
     * rather than "Pay" on these — because a till has one finish key and which
     * act that IS depends on what is being written. Opening a tender pad for a
     * document nobody can tender against would ask a counterhand to take payment
     * for goods that have not been handed over.
     *
     * Orders go through saveAsOrder, which reserves the stock. Quotes have no
     * such step yet, so they park like any other basket and the register picks
     * them up — the honest interim while the quote path is built.
     */
    if (state.docType === 'sales_order') {
      saveAsOrder()
      return
    }
    if (state.docType !== 'invoice') {
      saveSale()
      return
    }

    /*
     * ── A SALE THAT OWES THE CUSTOMER MONEY IS NOT A SALE ─────────────────
     *
     * A mixed basket may carry refund lines (see `refundArmed` in useSaleState),
     * and while the goods bought outweigh the goods returned this is an ordinary
     * invoice that nets to what is owed. When they do NOT, the till is being
     * asked to hand money OVER, and the tender pad has no way to do that: it
     * clamps what is payable at zero, so the pad would open showing nothing owed,
     * refuse every amount keyed into it, and never reach a settled state. A
     * cashier stuck in a pad that will not close, in front of a customer, with no
     * message saying why.
     *
     * Refused here with the way through, rather than built out. Paying money back
     * is a different act with different obligations — a reason, a refund tender,
     * a supervisor's name against it — and the till already does it properly on
     * the return path. A second half-built payout route beside that one would be
     * the one that goes wrong.
     *
     * Zero is allowed through: a basket that nets exactly nothing is a straight
     * swap, which posts cleanly with a zero tender and is a real thing shops do.
     */
    if (totals.doc.totalIncl < 0) {
      toast.info(
        'This slip pays money back. Take the returned goods on their own — use Credit sale for a receipted return, or the Return toggle without one.',
      )
      return
    }

    if (warnOutOfStock && till.online) {
      /*
       * On-hand comes from the CATALOGUE, not the basket line, because a line
       * records what was charged rather than what is on the shelf. Lines whose
       * product is not in the till's current results resolve to null, which the
       * rule reads as "unknown" and stays quiet about — the right answer for a
       * product nobody has looked up this session.
       */
      const held = new Map<number, TillProduct>()
      for (const p of [...results, ...browse.products]) held.set(p.id, p)

      const shortfalls = stockShortfalls(
        state.lines.map((l) => {
          const product = l.productId === null ? undefined : held.get(l.productId)
          return {
            productId: l.productId,
            description: l.description,
            qty: l.qty,
            onHand: product ? product.availableQty : null,
            /* Only these two have a shelf to run out of. A service, a gift card
               or a buyout has no stock to be short of, and warning about one
               would be noise a cashier learns to dismiss. */
            tracked: l.productType === 'normal' || l.productType === 'returnable',
          }
        }),
      )
      const warning = stockWarning(shortfalls)
      if (warning) toast.info(warning)
    }

    setTendering(true)
  }

  /**
   * Writes the basket as a SALES ORDER instead of ringing it up.
   *
   * The same lines at the same prices for the same customer — an order is an
   * invoice at an earlier moment in its life, so nothing about the basket has to
   * change. What differs is what happens to it: nothing posts, no number is
   * issued, no money is taken, and the stock is RESERVED rather than moved,
   * which is what stops the next person through the door buying it.
   *
   * The customer is checked here rather than only in the action, because the
   * useful thing to do about a missing one is open the picker — a cashier told
   * "attach a customer" still has to find the button. The action re-checks: it is
   * a public endpoint and this screen is not a boundary.
   */
  function saveAsOrder() {
    if (state.lines.length === 0) {
      toast.info('Add something before saving it as an order.')
      return
    }
    if (!state.customer) {
      toast.info('An order is a promise to someone — attach the customer first.')
      setPickingCustomer(true)
      return
    }

    startTransition(async () => {
      let saved: Awaited<ReturnType<typeof saveAsOrderAction>>
      try {
        saved = await saveAsOrderAction(state.documentId, {
          customerId: state.customer?.id ?? null,
          customerName: state.customer?.name ?? null,
          customerVatNo: state.customer?.vatNumber ?? null,
          customerPhone: state.customer?.phone ?? null,
          reference: (tabLabel ?? '').trim() || null,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          priceStructureId,
          lines: salePayloadLines(state.lines, lineSpecials, docShares),
        })
      } catch {
        /* No local fallback, unlike park. An order RESERVES stock, and a till that
           cannot see what anybody else has reserved cannot make that promise — so
           the honest answer is that it did not happen. The quick key refuses
           offline for the same reason; this catches the line dropping mid-save. */
        toast.error('The order was not saved — it needs the connection to reserve stock.')
        return
      }
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }

      toast.success(`Order saved for ${state.customer?.name ?? 'the customer'}.`)
      dispatch({ type: 'CLEAR' })
      router.refresh()
    })
  }

  /**
   * Hands this till's bill back, so the floor stops reading it as taken.
   *
   * Fire-and-forget, and deliberately not awaited: every caller is a waiter LEAVING,
   * and holding the screen on a round trip to release a lock they cannot see would make
   * going back to the floor feel broken. The claim expires on its own if this never
   * lands (171), so the worst case is already handled.
   *
   * Reads `state.documentId` at CALL time — callers dispatch CLEAR immediately after,
   * which wipes it, so a version that read it later would release nothing.
   */
  function releaseHeldBill() {
    const documentId = state.documentId
    if (!documentId) return
    void reparkTableBillAction(documentId).catch(() => {})
  }

  function closeSale() {
    if (state.lines.length === 0) {
      // Nothing to lose. Leaving is the whole intent of the key.
      releaseHeldBill()
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
      const documentId = state.documentId
      const closingTable = table
      const lines = salePayloadLines(state.lines, lineSpecials, docShares)
      releaseHeldBill()
      clearTabIdentity()
      dispatch({ type: 'CLEAR' })
      setTable(null)
      setChoosingTable(true)
      refreshTables()
      toast.success(`${closingTable.code} saved.`)

      /*
       * The first of the three commit points — closing a table IS saving it.
       *
       * The bill is PUSHED first rather than trusted to the debounce. That
       * autosave runs on a 900ms timer, so a waiter who adds a round and
       * immediately taps Close would otherwise fire a docket missing the last
       * thing they rang up — which is precisely the order that gets forgotten.
       *
       * Everything above has already run, so the waiter is back on the floor
       * while this finishes. That is the right order: the send must never hold
       * the screen, and a docket that prints half a second after somebody walks
       * away is still on time.
       */
      if (documentId) {
        startTransition(async () => {
          const pushed = await updateTableBillAction(documentId, {
            customerName: closingTable.code,
            terminalId: terminal?.id ?? null,
            terminalCode: terminal?.code ?? null,
            priceStructureId,
            lines,
          }).catch(() => null)
          if (pushed?.ok) await autoSendToKitchen(documentId)
        })
      }
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
      const result = await recallSaleForTillAction(tab.documentId, priceStructureId, terminal?.id ?? null)
      if (!result.ok) {
        toast.error(result.error)
        // Another till took it while this waiter was looking. Re-read rather
        // than leaving a tile they will only tap again.
        refreshTables()
        return
      }
      /* Back onto the price type the tab was opened at — see restorePricing. A
         trade tab resumed on a till sitting on retail otherwise re-reads every
         line as an override. */
      restorePricing(result.priceStructureId)
      /* The tab keeps its identity, so closing it again re-parks under the same
         label rather than prompting for a new one. */
      setTabLabel(tab.label)
      setTabCustomer(tab.customerName ?? '')
      setTabPeople(tab.personCount)
      setTabVisitTypeId(tab.visitTypeId)
      /*
       * A tab and a table are not alternatives — most of the tabs on a hospitality
       * floor ARE tables, listed by their bill rather than by their position. So the
       * table this bill sits on is carried onto the till when there is one.
       *
       * Nulling it unconditionally (which is what this did) left the till holding a
       * bill it did not know was on a table: every gesture that acts on the table —
       * split, the table's own label in the header, service charge — behaved as though
       * the waiter were at a counter. Split was the visible one: pressing the key while
       * sat in a table sent the waiter back to the floor to choose a table, and then
       * told them no bill was on one.
       *
       * Matched against a FRESH read rather than the `tables` already on screen, which
       * is re-read on mount and every twenty seconds — a table seated in between would
       * otherwise not be found, which is the same staleness that made this bug look
       * intermittent.
       */
      const floor = await listTablesAction().catch(() => null)
      if (floor?.ok) setTables(floor.tables)
      const onTable = (floor?.ok ? floor.tables : tables).find(
        (t) => t.documentId === tab.documentId,
      )
      setTable(onTable ?? null)
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
    /* The parked row carries the price type it was rung at, same as the online
       document does — see restorePricing. Offline it matters slightly more: the
       lines come back at their PARKED prices with no re-read, so a basket
       described as retail while holding wholesale figures has nothing at all to
       correct it. */
    restorePricing(row.priceStructureId ?? null)
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
    toast.success('Sale recalled.')
  }

  /** Putting a parked basket back on screen. */
  function recall(documentId: number) {
    startTransition(async () => {
      const result = await recallSaleForTillAction(documentId, priceStructureId, terminal?.id ?? null)
      if (!result.ok) {
        toast.error(result.error)
        // The list is now stale — another till took it — so close and let the
        // cashier re-open onto a fresh one.
        setShowingSaved(false)
        return
      }
      setDocDiscount(null) // a recalled basket must not inherit the last one's discount
      /* Back onto the price type this sale was parked at — see restorePricing.
         Unlike the customer below, this IS safe to restore: it is a pricing
         basis read off the document, not a credit position that may have moved. */
      restorePricing(result.priceStructureId)
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
   * Bringing a web order onto the till, to be collected and paid for.
   *
   * ── WHY IT REFUSES OVER A BASKET RATHER THAN MERGING ──────────────────────
   *
   * Two orders' lines in one basket is one invoice for two customers, and the
   * second one to walk in pays the first one's bill. A half-scanned basket for
   * somebody else has the same problem in a quieter form. So the till says what is
   * in the way rather than silently combining — the cashier finishes or parks what
   * they have and taps again.
   *
   * The COKE case is the opposite and is the whole point: extras are added AFTER
   * the order lands, onto the same basket, and go out on the same invoice. That
   * needs no special handling at all, which is why the order becomes an ordinary
   * basket rather than something the pad has to know about.
   */
  function collectOrder(order: CollectableOrder) {
    if (state.lines.length > 0) {
      toast.error('Finish or save the sale on screen first, then bring the order up.')
      return
    }
    startTransition(async () => {
      const result = await collectOnlineOrderAction(order.id, priceStructureId)
      if (!result.ok) {
        toast.error(result.error)
        /* Closed rather than left open: every refusal here means the list is out
           of date — already invoiced, cancelled, taken at the other till — and
           re-opening re-reads it. */
        setShowingOrders(false)
        return
      }
      setDocDiscount(null)
      /* The price type the STORE took the order on — see restorePricing. */
      restorePricing(result.priceStructureId)
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        /* Same rule as a recalled sale: the NAME comes back, the account does not.
           Credit needs a live balance, and an order placed on Tuesday is not it. */
        customer: null,
        customerName: result.customerName ?? '',
      })
      setShowingOrders(false)
      toast.success(`${order.orderNumber} is on the till. Add anything else, then take payment.`)
    })
  }

  /**
   * Bringing an existing quote onto the till.
   *
   * ── WHY IT REFUSES OVER A BASKET ──────────────────────────────────────────
   *
   * Same rule as a web order, for the same reason: two documents' lines in one
   * basket is one sale for two customers. The till says what is in the way and
   * the cashier finishes or saves first.
   *
   * ── WHAT IT DOES *NOT* DO ─────────────────────────────────────────────────
   *
   * It does not convert the quote. The basket comes back with the quote's
   * document id and the till stays in the quote module, so saving writes back
   * to the SAME quote. Turning it into an invoice is a decision somebody makes
   * — `convertToInvoice` in the back office, or switching this basket to Point
   * of sale — not a side effect of looking at one.
   */
  /**
   * Opens the shop's quotes, or says why it cannot.
   *
   * A function rather than an inline setter because there are two ways in — the
   * pane's recall key and a quick key — and a guard written at one of them is a
   * guard the other does not have. Same for the order list below.
   */
  function openQuoteList() {
    if (!till.online) {
      toast.info('Quotes need the connection — they live on the server.')
      return
    }
    setShowingQuotes(true)
  }

  function openOrderList() {
    if (!till.online) {
      toast.info('Sales orders need the connection — they live on the server.')
      return
    }
    setShowingTillOrders(true)
  }

  /**
   * The lay-by list, guarded the same way.
   *
   * It used to be opened inline from `pickModule` with its own copy of the
   * offline check — fine while the module menu was the only door. It is not any
   * more: there is a quick key now, and a guard written at one door is a guard
   * the other does not have. Same shape as the two above for that reason.
   */
  function openLaybyList() {
    if (!till.online) {
      toast.info('Lay-bys need the connection — they live on the server.')
      return
    }
    setShowingLaybys(true)
  }

  function recallQuote(quote: TillQuote) {
    /* Quotes live on the server and are claimed there, so an offline till can
       neither read one nor stop another till opening the same one. Said in the
       house phrasing every other server-bound key uses. */
    if (!till.online) {
      toast.info('Quotes need the connection — they live on the server.')
      return
    }
    if (state.lines.length > 0) {
      toast.error('Finish or save the sale on screen first, then bring the quote up.')
      return
    }
    startTransition(async () => {
      const result = await recallQuoteForTillAction(quote.id, priceStructureId, terminal?.id ?? null)
      if (!result.ok) {
        toast.error(result.error)
        /* Closed rather than left open: every refusal here means the list is out
           of date — accepted elsewhere, cancelled, open on another till — and
           re-opening re-reads it. */
        setShowingQuotes(false)
        return
      }
      setDocDiscount(null)
      /* The basis the quote was written on — see restorePricing. A quote is a
         promise of a figure, so it must come back described as what was quoted. */
      restorePricing(result.priceStructureId)
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        /*
         * SAYS IT IS A QUOTE, and this line is the whole of it.
         *
         * LOAD defaults an absent docType to `invoice` — right for a parked
         * basket, and it silently overwrote the till's quote mode here: the
         * lines landed and the header flipped to "Current Sale". Saving would
         * then have written a SECOND document and left the customer's quote
         * untouched, with both screens looking correct.
         *
         * Dispatching SET_DOC_TYPE first does NOT fix it — that action clears
         * the basket, and LOAD runs after and re-imposes the default anyway. The
         * type has to travel WITH the lines.
         */
        docType: 'quote',
        /* The NAME comes back, the account does not — same rule as a recalled
           sale. Credit needs a live balance, and a quote written last week is
           not it; re-attaching is a deliberate act on the customer key. */
        customer: null,
        customerName: result.customerName ?? '',
      })
      setShowingQuotes(false)
      toast.success(
        `${quote.documentNumber ?? 'That quote'} is on the till. Take payment to invoice it.`,
      )
    })
  }

  /**
   * Handing an order over at the counter.
   *
   * ── THIS IS THE ONE LIST TAP THAT MOVES STOCK ─────────────────────────────
   *
   * A recalled quote puts a price on screen and nothing has happened. This
   * DELIVERS: the goods are recorded as gone, the order's outstanding
   * quantities drop, and a linked invoice comes back to be paid for. None of
   * that is undone by clearing the basket — the delivery is its own event, and
   * reversing it is a credit note in the back office.
   *
   * Which is why the basket guard matters more here than anywhere else: firing
   * this with somebody else's half-rung sale on screen would deliver an order
   * AND lose the basket it could not merge into.
   */
  function collectTillOrder(order: TillOrder) {
    /* Handing an order over MOVES STOCK and raises an invoice. A till that
       cannot see what other tills have delivered could hand over goods already
       collected somewhere else — the same reasoning that keeps saveAsOrder
       online-only, and the reason this refuses rather than queues. */
    if (!till.online) {
      toast.info('Handing an order over needs the connection — the goods move on the server.')
      return
    }
    if (state.lines.length > 0) {
      toast.error('Finish or save the sale on screen first, then hand the order over.')
      return
    }
    startTransition(async () => {
      const result = await collectOrderForTillAction(
        order.id,
        priceStructureId,
        terminal?.id ?? null,
        terminal?.code ?? null,
      )
      if (!result.ok) {
        toast.error(result.error)
        /* Closed rather than left open: every refusal means the list is stale —
           collected at the other till, cancelled, nothing outstanding — and
           re-opening re-reads it. */
        setShowingTillOrders(false)
        return
      }
      setDocDiscount(null)
      /* The order's own price type — see restorePricing. The lines are the
         order's snapshot, so describing them on the till's structure would name
         a basis the customer was never quoted. */
      restorePricing(result.priceStructureId)
      dispatch({
        type: 'LOAD',
        documentId: result.documentId,
        lines: result.lines,
        /*
         * AN INVOICE, and deliberately so — the one place the basket's type
         * changes on the way in.
         *
         * What came back is the DELIVERY invoice, not the order. The order is
         * still an order and its fulfilment status has already moved; what is
         * on the till is a sale to be tendered, and calling it anything else
         * would put a Save key where Pay belongs and leave the goods handed
         * over with nothing collected for them.
         */
        docType: 'invoice',
        customer: null,
        customerName: result.customerName ?? '',
      })
      setShowingTillOrders(false)
      toast.success(
        `${order.documentNumber ?? 'That order'} is on the till. Take payment to finish it.`,
      )
    })
  }

  /**
   * Taking an instalment against a lay-by.
   *
   * ── NO BASKET GUARD, AND THAT IS THE POINT ────────────────────────────────
   *
   * Every other list on this till refuses over a basket, because pulling a
   * document onto the screen would collide with what is already there. This one
   * touches no basket at all: the money goes to `layby_payments` and the drawer,
   * and the half-rung sale behind the dialog is still exactly as it was. A
   * cashier interrupted mid-sale by somebody paying off their lay-by is an
   * ordinary counter moment, not a conflict.
   *
   * ── AND IT DOES NOT COMPLETE ──────────────────────────────────────────────
   *
   * Even when the last instalment clears the balance. Paying up and collecting
   * are days apart as often as not, and invoicing goods still on the shelf is
   * the one mistake this flow could make that a customer would notice.
   */
  function payLayby(
    layby: TillLayby,
    input: { amount: number; tenderTypeId: number; reference: string | null },
  ) {
    /*
     * Online only, and not merely because the row lives on the server.
     *
     * A lay-by balance is shared: the customer may have paid R200 off at the
     * other till an hour ago. An offline payment would be taken against a
     * balance this machine last saw, and `paymentRefusal` — which stops
     * somebody overpaying — would be judging a stale figure. Queuing it would
     * mean money accepted now and refused later, with the customer gone.
     */
    if (!till.online) {
      toast.info('A lay-by payment needs the connection — the balance is kept on the server.')
      return
    }
    startTransition(async () => {
      const result = await takeLaybyPaymentAction(layby.id, {
        ...input,
        terminalId: terminal?.id ?? null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setShowingLaybys(false)
      toast.success(
        result.settled
          ? `${result.laybyNumber ?? 'That lay-by'} is paid up. Hand the goods over when they collect.`
          : `${formatMoney(result.outstanding)} still to pay on ${result.laybyNumber ?? 'that lay-by'}.`,
      )
      /* The drawer has moved, and the till's own chrome reads from the shift —
         see the cash-up work on why lay-by money is part of the expected cash. */
      router.refresh()
    })
  }

  /**
   * Opens the "put this aside" dialog against the basket on screen.
   *
   * The refusals are here rather than in the dialog because they are about
   * whether the question can be ASKED at all — an empty basket has nothing to
   * put aside, and a return is money going the other way. The dialog itself
   * handles the missing customer, because that one is fixable without closing
   * it and losing the basket.
   */
  function openStartLayby() {
    /*
     * Refused BEFORE the dialog opens, not inside it.
     *
     * A lay-by takes a LAY number from the shared sequence the moment it is
     * created, and the customer walks out holding a document that refers to it
     * — a till inventing one offline would hand out a number another machine
     * may already have used. The quick key says the same thing; this is the
     * other route in, and letting somebody fill the dialog in first only to be
     * refused at the end would waste their time in front of a customer.
     */
    if (!till.online) {
      toast.info('A lay-by needs the connection — it takes a number from the server.')
      return
    }
    if (state.lines.length === 0) {
      toast.info('Ring the goods up first, then put them aside.')
      return
    }
    if (state.returning) {
      toast.info('A return cannot become a lay-by — finish the refund first.')
      return
    }
    setStartingLayby(true)
  }

  /**
   * Turns the basket into a lay-by.
   *
   * ── THE BASKET IS CLEARED, NOT SAVED ──────────────────────────────────────
   *
   * A lay-by is not a sales document and never becomes the one on screen: the
   * goods are recorded in `laybys` with their own number, and the till goes
   * back to empty ready for the next customer. Leaving the lines up would
   * invite somebody to take payment for goods that are now on a shelf with a
   * name on them.
   *
   * ── AND THE DEPOSIT IS THE SAME MONEY AS AN INSTALMENT ────────────────────
   *
   * It writes a `layby_payments` row, banks into this till's shift, and is
   * counted by the cash-up — so opening one with R500 down leaves the drawer
   * expecting R500 more. That is only true since the cash-up learned to count
   * off-ledger money; before it, this key would have made the drawer read over.
   */
  function startLayby(input: {
    deposit: { amount: number; tenderTypeId: number } | null
    dueDate: string | null
  }) {
    const customerId = state.customer?.id
    if (!customerId) {
      toast.error('Attach the customer first — a lay-by is held for a named person.')
      return
    }

    startTransition(async () => {
      const result = await startLaybyAction({
        customerId,
        lines: salePayloadLines(state.lines, lineSpecials, docShares),
        deposit: input.deposit,
        dueDate: input.dueDate,
        terminalId: terminal?.id ?? null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setStartingLayby(false)
      setDocDiscount(null)
      dispatch({ type: 'CLEAR' })
      toast.success(
        `${result.laybyNumber} opened for ${state.customer?.name ?? 'the customer'}. ${formatMoney(
          result.outstanding,
        )} still to pay.`,
      )
      /* The drawer has moved if a deposit was taken, and the lay-by list the
         module menu opens is now one longer. */
      router.refresh()
    })
  }

  /**
   * Handing lay-by goods over — the moment it becomes a sale.
   *
   * The invoice is raised, the VAT is declared and the stock moves, all through
   * the ordinary finalise path. Nothing lands on the basket: the sale is
   * complete when this returns, so putting it on screen would invite a cashier
   * to take payment for something already paid for.
   */
  function collectLayby(layby: TillLayby) {
    /* This is a finalise: an invoice is numbered, VAT is declared and stock
       moves. None of that can happen on a machine that cannot reach the
       sequence — see the same rule on the quick key. */
    if (!till.online) {
      toast.info('Handing the goods over needs the connection — it raises an invoice.')
      return
    }
    startTransition(async () => {
      const result = await collectLaybyAction(layby.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setShowingLaybys(false)
      toast.success(`${result.documentNumber} raised. The goods are the customer's.`)
      router.refresh()
    })
  }

  /* Which customer is attached RIGHT NOW, readable from inside a promise that
     started before the latest change. A ref rather than state because nothing
     renders from it — it exists only so a late membership lookup can tell
     whether its customer is still the one on screen. */
  const latestCustomerRef = useRef<number | null>(null)
  useEffect(() => {
    latestCustomerRef.current = state.customer?.id ?? null
  }, [state.customer?.id])

  /* ── What the attached member is holding ─────────────────────────────────
     Re-read whenever the MEMBER changes AND whenever the tender pad opens: a balance
     can move at another till while a basket sits on screen, and the figure a cashier is
     about to quote should be the current one.

     Failures collapse to null — loyalty must never be able to block a sale, and a till
     that refused to take cash because a points lookup timed out would be worse than one
     with no loyalty at all. The state itself is declared with the rest of the shell's. */
  useEffect(() => {
    const memberId = state.member?.id
    if (!memberId || !till.online) {
      setLoyalty(null)
      return
    }
    let cancelled = false
    void tillStandingAction(memberId)
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
  }, [state.member?.id, tendering, till.online])

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
    setSplitting({ documentId: bill.documentId, label: table.code, lines: bill.lines })
  }

  /**
   * Splitting the table the till is ALREADY IN.
   *
   * ── WHY THIS IS NOT "ARM AND GO BACK TO THE FLOOR" ────────────────────────
   *
   * Arming asks a waiter standing inside table six's bill to walk out to the floor and
   * tap table six — re-choosing the thing they are already looking at. It was also
   * unreliable in a way that read as the feature being broken: the gate counts armable
   * bills from the OPEN TABS list, which is re-read on mount and every twenty seconds,
   * so a table seated in between showed a floor with nothing to split on it. "No open
   * bill is on a table" while the waiter is sat in one.
   *
   * So when a table is open, the key opens the split screen on THAT table and never
   * touches the gate. Arming survives for the other case — no table open, pick one — and
   * that path still works exactly as it did.
   *
   * ── THE BASKET IS PUSHED FIRST, AND THAT IS THE WHOLE SUBTLETY ────────────
   *
   * The split reads the bill from the SERVER, because moving lines between documents is
   * done by line id and only the server knows them. But the till holds the basket in
   * memory and writes it on a 900ms debounce — so anything rung up in the last second is
   * on screen and not yet on the document. Splitting straight away would divide a bill
   * that is missing the last round of drinks, silently.
   *
   * Pushing first costs one round trip on a screen that is about to do several, and it
   * is what makes "what I can see is what I can split" true.
   */
  function openSplitForCurrentTable() {
    /* A tab is splittable too, now that a destination is a document rather than a table
       row — "Walk-in" divides exactly like table six does. What cannot be split is a
       basket that has never been saved, because a split moves lines between two SERVER
       documents and an unsaved basket is not one yet. */
    const label = table?.code ?? tabLabel ?? ''
    if (!state.documentId) {
      if (!table && !tabLabel) {
        // A counter basket with no identity. Send them to the floor to pick a bill.
        setArmedForTransfer(false)
        setArmedForSplit(true)
        setChoosingTable(true)
        return
      }
      toast.error('Save this sale before splitting it.')
      return
    }
    if (state.lines.length === 0) {
      toast.error('There is nothing on this bill to split.')
      return
    }
    if (!till.online) {
      /* The split writes two documents in one server transaction. Offline there is no
         way to do that, and no way to tell the waiter afterwards which half survived. */
      toast.error('Splitting a bill needs the connection.')
      return
    }

    startTransition(async () => {
      const documentId = state.documentId!
      /* The basket on screen is pushed FIRST, or the split divides a bill missing
         whatever was rung up in the last second — the table autosave runs on a 900ms
         debounce. Only a seated table has that autosave; a tab is parked by its own
         path, so this is the one that needs forcing. */
      const pushed = await updateTableBillAction(documentId, {
        customerName: label || 'Table',
        terminalId: terminal?.id ?? null,
        terminalCode: terminal?.code ?? null,
        priceStructureId,
        lines: salePayloadLines(state.lines, lineSpecials, docShares),
      }).catch(() => null)
      if (!pushed?.ok) {
        toast.error(pushed?.error ?? "Couldn't save this bill, so it cannot be split yet.")
        return
      }
      setTables(pushed.tables)

      const bill = await billForSplitByDocumentAction(documentId).catch(() => null)
      if (!bill || bill.lines.length === 0) {
        toast.error('That bill has nothing on it to split.')
        return
      }
      setArmedForSplit(false)
      setSplitting({ documentId, label: label || 'this sale', lines: bill.lines })
    })
  }

  /**
   * Every OTHER open sale, as the split screen's picker offers them.
   *
   * Built from the open-TABS list rather than the floor, because that is the list of
   * open bills — most of which are not seated on the floor plan. Where a bill does sit
   * on a table, the table's code is carried along as context: two tabs can both be
   * called "Walk-in", and where they are sitting is what tells them apart.
   */
  const splitDestinations = useMemo<SplitDestination[]>(() => {
    const tableByDoc = new Map(
      tables.filter((t) => t.documentId !== null).map((t) => [t.documentId!, t.code]),
    )
    return tabs
      .filter((t) => t.documentId !== splitting?.documentId)
      .map((t) => ({
        documentId: t.documentId,
        label: tableByDoc.get(t.documentId) ?? t.label ?? t.customerName ?? 'Walk-in',
        tableCode: tableByDoc.get(t.documentId) ?? null,
        lineCount: t.lineCount,
        totalIncl: t.totalIncl,
      }))
  }, [tabs, tables, splitting?.documentId])

  /** Writes the split, then re-reads the floor so both halves show. */
  function confirmSplit(
    toDocumentId: number | null,
    moves: { lineId: number; qty: number }[],
    newSaleName: string | null,
  ) {
    const from = splitting
    if (!from) return
    /* Read BEFORE the write: afterwards the destination always has a bill on it, and the
       distinction the toast draws is between joining one that already existed and
       starting a fresh one. */
    const where =
      toDocumentId === null
        ? newSaleName?.trim() || 'a new sale'
        : (splitDestinations.find((d) => d.documentId === toDocumentId)?.label ?? 'the other sale')
    const joinedExisting = toDocumentId !== null
    /* Was this split started from INSIDE the sale, rather than armed from the floor?
       That decides whether there is a stale basket on screen that has to be reloaded —
       left alone it would overwrite the split on the next autosave. */
    const keptDocumentId = state.documentId === from.documentId ? from.documentId : null
    startTransition(async () => {
      const result = await splitBillAction({
        fromDocumentId: from.documentId,
        toDocumentId,
        newSaleName,
        moves,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTables(result.tables)
      setSplitting(null)
      refreshTables()

      /*
       * The till is still holding the WHOLE bill, including the lines that just moved
       * off it. Left alone, the 900ms autosave would write that basket straight back
       * over the document and silently undo the split — the waiter would watch the
       * items reappear. So the kept half is re-read from the server, which is now the
       * only place that knows which lines survived.
       *
       * The waiter STAYS on the sale. They were serving it when they pressed the key,
       * the kept half is still theirs, and being thrown out to the floor mid-service is
       * how a bill gets abandoned half-finished.
       */
      if (keptDocumentId) {
        const kept = await recallSaleForTillAction(keptDocumentId, priceStructureId, terminal?.id ?? null).catch(
          () => null,
        )
        if (kept?.ok) {
          /* The half that stayed keeps the bill's price type — see restorePricing.
             A split must not re-base what the customer was already being charged on. */
          restorePricing(kept.priceStructureId)
          dispatch({
            type: 'LOAD',
            documentId: kept.documentId,
            lines: kept.lines,
            customer: null,
            customerName: kept.customerName ?? '',
          })
        } else {
          /* The kept half could not be re-read — rather than leave a basket on screen
             that would overwrite the split, hand the bill back and send the waiter to
             the floor, where tapping it reloads cleanly. */
          releaseHeldBill()
          dispatch({ type: 'CLEAR' })
          setTable(null)
          setChoosingTable(true)
        }
      }

      /* Says which of the two happened: added ONTO an existing bill is the one a waiter
         may want to check, since those lines are now mixed in with somebody else's. */
      toast.success(joinedExisting ? `Added to ${where}'s bill.` : `Moved to ${where}.`)
    })
  }

  /**
   * Shows the pro-forma bill for the open tab, in a dialog on the till.
   *
   * The current basket is pushed to the server first so the bill matches the
   * screen, then asking for it marks the table amber on the floor — that is what
   * "bill asked" is for — and then the slip is fetched as data and shown.
   *
   * It used to open /sales/[id]/bill in a new tab, which is a BACK-OFFICE route:
   * a waiter mid-service got the office chrome and left the till behind a second
   * tab with a half-scanned basket in it. See `BillModal` for the rest of the
   * argument; printing itself still leaves this screen alone, going to the
   * thermal bridge or, failing that, to the print route in a tab.
   */
  function printBill() {
    const documentId = state.documentId
    if (!documentId) {
      /* Said rather than ignored: the bill is a quick key now, so it can be
         pressed on a basket that was never parked against a table. */
      toast.info('Open the table first — the bill comes off the parked tab.')
      return
    }
    if (!till.online) {
      toast.error('Printing a bill needs the connection — the tab lives on the server.')
      return
    }

    /* Opened before the round trip, showing its skeleton, rather than after —
       a dialog that appears a second after the tap reads as a double press. */
    setBill(null)
    setBillLoading(true)
    setBillOpen(true)

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
            setBillOpen(false)
            setBillLoading(false)
            toast.error(saved.error)
            return
          }
          setTables(saved.tables)
        }
        if (table) {
          const asked = await askForBillAction(table.id)
          if (asked.ok) setTables(asked.tables)
        }

        const result = await billDataAction(documentId)
        if (!result.ok) {
          setBillOpen(false)
          setBillLoading(false)
          toast.error(result.error)
          return
        }
        setBill(result.bill)
        setBillLoading(false)
      } catch {
        setBillOpen(false)
        setBillLoading(false)
        toast.error('The bill could not be prepared. Try again.')
      }
    })
  }

  /**
   * The paper THIS till hands a customer for a posted sale, opened to print.
   *
   * WHICH paper is `salePaperRoute`'s call — see lib/salePaper for why a trade
   * counter owes A4 where a retail or hospitality till owes the slip.
   *
   * Every place that puts a finished sale on paper goes through here — Print on
   * the sale-complete dialog, the reprint-last quick key, and the reprint list —
   * so a counter cannot get an invoice from one and a slip from the next.
   *
   * Both routes count their own print server-side for a finalised invoice, so
   * no caller adds `recordPrintAction` on top of this.
   */
  function openSalePaper(documentId: number) {
    /* A hidden frame rather than a tab. On a till that matters more than
       anywhere else: a second tab takes the screen away from the basket the
       next customer is already being rung up on, and leaves the operator to
       find their way back. */
    printPaper(`/sales/${documentId}/${salePaperRoute(posMode)}`)
  }

  /**
   * Puts the bill on paper.
   *
   * The bridge first, and the print route as the fallback — never
   * `window.print()`, which would print the till: this dialog is a native
   * `<dialog>` in the top layer and the `(pos)` layout carries no print
   * stylesheet. The fallback route lives in the bare `(print)` group, which is
   * the only place laid out for paper, and `auto=1` prints it on arrival the way
   * the slip reprint does.
   *
   * Through a hidden frame rather than a tab: a till that opens a second tab
   * has taken itself off the screen it exists to be, which is the same reason
   * BillModal refuses window.print(). The bill route only moved INTO the
   * (print) group with this change — it was rendering inside the back office
   * layout, so the "bare group" this comment describes was aspirational.
   */
  function printBillPaper(data: BillData) {
    const documentId = state.documentId
    setBillPrinting(true)
    startTransition(async () => {
      try {
        if (hasBridgeSlipPrinter()) {
          const printed = await printBillViaBridge(data)
          if (printed.ok) {
            toast.success('Bill printed.')
            setBillOpen(false)
            return
          }
          toast.error(printed.error)
        }
        if (documentId) printPaper(`/sales/${documentId}/bill`)
      } finally {
        setBillPrinting(false)
      }
    })
  }

  /** Takes (and clears) the pending token — an approval covers ONE action. */
  function spendOverrideToken(): string | undefined {
    const token = overrideTokenRef.current ?? undefined
    overrideTokenRef.current = null
    return token
  }

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
      setShiftId(shiftId)
      setShiftStatus((s) => (s ? { ...s, open: shiftId !== null } : s))
      /*
        NO SHIFT MEANS NOTHING TO MANAGE.

        The shift dialog is about a drawer, so once there is no drawer its
        `open` flag is stale — and leaving it set is what put a second "Open a
        shift" panel in front of the gate after a quick cash-up. Cleared HERE,
        at the one place that learns the shift is gone, rather than at each of
        the callers that might have caused it. The mount also refuses to render
        in front of a gate; that guard covers the frame between this and the
        gate appearing, and this covers the state afterwards.
      */
      if (shiftId === null) setManagingShift(false)
      void kvPut(siteId, KV.shift, shiftId ? { id: shiftId } : null).catch(() => {})
    },
    [siteId],
  )

  /* Seed the chip, the gate and KV.shift once the till is up — a shift somebody
     opened from the back office must still catch this till's offline sales.

     Re-run when the OPERATOR changes as well as the till: in user mode the
     shift belongs to the person, so the answer to "is a shift open" is a
     different question for each one who signs in at this machine. */
  useEffect(() => {
    if (!till.online) return
    /*
     * WAIT FOR THE DEVICE ID, exactly as `unclaimed` does above.
     *
     * `device` is browser-only and resolves an effect-tick after mount, so on
     * the first pass `terminal` is undefined for EVERY machine — the claimed
     * ones included. Asking then sent `terminalId: null`, and in terminal mode
     * `tillShiftStatusAction` reads a null till as "no shift" (it cannot look
     * one up without knowing which drawer to look in). That answer is not
     * wrong, it is premature: it set `shiftStatus.open` false, `closedGate`
     * went true, and the till showed OpenTillGate — "This till is closed",
     * float pad and all — to a cashier whose till was open all along. A tick
     * later `device` resolved, this re-ran with the real id, found the shift
     * and tore the gate down again. That was the flicker, and the length of it
     * was however long that first doomed round trip took.
     *
     * It is worst on the screen that can least afford it: the first thing after
     * sign-in, at a counter, in front of a customer, telling the operator to
     * count a float they have already counted.
     *
     * Waits for the READ, not for an id. A machine with no id at all (blocked
     * localStorage) resolves to `null` and asks straight away — it is genuinely
     * unclaimed, and it still needs `mode` and `canCashup` for the gate's
     * unclaimed branch. Waiting for a non-null id would hang it forever.
     */
    if (device === undefined) return
    void tillShiftStatusAction(terminal?.id ?? null)
      .then((result) => {
        if ('ok' in result) return
        noteShift(result.shift?.id ?? null, result.shift?.userName)
        setShiftStatus({
          mode: result.mode,
          canCashup: result.canCashup,
          open: result.shift !== null,
          clock: result.clock,
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [till.online, device, terminal?.id, operatorUserId])

  /**
   * Does the closed-till gate stand in front of the sale right now?
   *
   * OFFLINE IS NOT GATED, deliberately. A till that lost the line mid-morning
   * cannot read or open a shift, and refusing to trade would turn a network
   * outage into a closed shop — the exact failure the whole offline path exists
   * to prevent. Those sales queue with whatever shift KV.shift last held, which
   * is the one the till was already trading on.
   */
  const closedGate =
    till.online && shiftStatus !== null && !shiftStatus.open ? shiftStatus : null

  /**
   * Does the clock-on gate stand in front of the sale right now?
   *
   * AFTER the shift gate, never instead of it. The drawer being open is a fact
   * about the till and the operator being on duty is a fact about the person —
   * both have to be true, and asking them in the other order would have the
   * first cashier of the day clock on to a till that is still shut.
   *
   * OFFLINE IS NOT GATED, for the same reason the shift gate is not: a time
   * entry is a server record, so a till that lost the line could not clear this
   * gate however long the cashier stood there. Turning a network outage into a
   * closed shop is the failure the offline path exists to prevent.
   */
  const clockGate =
    till.online &&
    shiftStatus !== null &&
    shiftStatus.open &&
    shiftStatus.clock.required &&
    !shiftStatus.clock.clockedIn
      ? shiftStatus.clock
      : null

  /**
   * Is it settled yet WHICH gate this is — and therefore safe to draw one?
   *
   * `closedGate` reads null both when the till is open and when the answer has
   * not come back, and those two are indistinguishable from the render below.
   * On a hospitality till `choosingTable` seeds true, so during that gap the
   * floor is the first branch that matches and the table gate paints in full —
   * then the status lands, the closed gate takes precedence, and the screen
   * swaps under the waiter. That is the flash somebody sees on every sign-in:
   * a fully drawn floor for one round trip, on a till that was never open.
   *
   * Re-ordering the branches could not fix it, because both were reading a
   * fact that did not exist yet. So the floor now waits for the same answer
   * the closed gate already waits for, and the one frame in between is the bar
   * on its own rather than the wrong screen.
   *
   * ONLINE ONLY, matching the gates themselves. An offline till never resolves
   * a status at all, and gating on it there would leave a waiter looking at an
   * empty screen for the whole outage — the exact failure the offline path
   * exists to prevent.
   */
  const gateUndecided = till.online && shiftStatus === null

  /** Re-reads the status, so clearing a gate takes the gate down. */
  const refreshShiftStatus = useCallback(() => {
    void tillShiftStatusAction(terminal?.id ?? null)
      .then((result) => {
        if ('ok' in result) return
        noteShift(result.shift?.id ?? null, result.shift?.userName)
        setShiftStatus({
          mode: result.mode,
          canCashup: result.canCashup,
          open: result.shift !== null,
          clock: result.clock,
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal?.id])

  /**
   * Send-to-kitchen: fetch the delta, PRINT, then mark — in that order, so a
   * failed print marks nothing (the retry reprints) and a failed mark risks
   * only a duplicate ticket. The tab is saved first so line ids exist and the
   * ticket matches the screen.
   */
  /**
   * Fires a tab's outstanding items at their printers — the one path every
   * caller uses.
   *
   * Three things reach it: the automatic send when a tab is committed, the
   * send-to-kitchen key, and that key's course picker. They differ only in
   * SCOPE and in how loudly they report, which is what the two options are for.
   * Anything else would be a second copy of the print-then-mark rule, and two
   * copies is how one of them ends up marking food that never printed.
   *
   * Each printer is its own ticket, printed and marked independently: a bar
   * printer out of paper leaves the bar's lines unmarked and the kitchen's
   * sent, so the retry re-fires the drinks and not the food.
   */
  async function fireKitchenTickets(
    documentId: number,
    options: { scope?: KitchenScope; source: 'auto' | 'manual'; quiet?: boolean },
  ): Promise<void> {
    const result = await kitchenTicketAction(documentId, terminal?.id ?? null, options.scope)
    if (!result.ok) {
      /* The automatic send is silent about having nothing to do — a waiter
         saving a table of drinks nobody routed does not need to be told so on
         every save. A deliberate press always gets an answer. */
      if (!options.quiet) toast.info(result.error)
      return
    }

    let sent = 0
    const failures: string[] = []

    for (const job of result.jobs) {
      const printed = await printKitchenViaBridge(job.bridgePrinter, job.ticket)
      if (!printed.ok) {
        failures.push(printed.error)
        continue
      }
      /* PRINT THEN MARK. A failed mark risks a duplicate docket, which a
         kitchen shrugs at; marking first would risk a lost one, which is a
         lost meal. */
      await markKitchenSentAction(
        documentId,
        job.printerId,
        job.lines,
        terminal?.id ?? null,
        options.source,
      ).catch(() => {})
      sent += job.lines.reduce((sum, l) => sum + l.qty, 0)
    }

    /* Failures are always spoken, even on the automatic send. "Nothing to
       send" is noise; "the grill did not print" is the one thing a waiter must
       hear before the food does not arrive. */
    if (failures.length > 0) toast.error(failures[0])
    if (sent > 0 && !(options.quiet && failures.length > 0)) {
      toast.success(`Sent ${sent} item${sent === 1 ? '' : 's'} to the kitchen.`)
    }
  }

  /**
   * Tells the kitchen to STOP, after a void.
   *
   * ── ONLY WHAT THEY ACTUALLY HAVE ─────────────────────────────────────────
   *
   * The server clamps every cancellation to what that printer was really sent,
   * so voiding a line the kitchen never saw prints nothing at all. That silence
   * is the correct outcome, not a failure: a docket reading "CANCEL: steak" for
   * food nobody is cooking sends a chef hunting an order that never existed.
   *
   * ── AND IT NEVER BLOCKS THE VOID ─────────────────────────────────────────
   *
   * The line has already left the cashier's screen by the time this runs. Every
   * failure is swallowed for the same reason `recordVoidAction` swallows its
   * own: holding a customer at the counter over a docket is worse than a docket
   * that did not print. A FAILED PRINT IS SPOKEN, though — unlike the audit
   * trail, somebody has to walk to the pass, and only the toast can tell them.
   */
  async function cancelAtKitchen(
    documentId: number | null,
    items: { productId: number; description: string; qty: number }[],
    reason: string,
  ): Promise<void> {
    /* No document means the kitchen was never told: a retail basket lives in
       this component until it is paid, so nothing was ever sent to cancel. */
    if (!documentId || items.length === 0) return
    try {
      const result = await kitchenCancelTicketAction(
        documentId,
        terminal?.id ?? null,
        items,
        reason,
      )
      if (!result.ok || result.jobs.length === 0) return

      for (const job of result.jobs) {
        const printed = await printKitchenViaBridge(job.bridgePrinter, job.ticket)
        if (!printed.ok) {
          /* Loud, and named. "The Grill did not print the cancellation" is a
             sentence somebody can act on by walking through the door; a silent
             failure leaves food being cooked that everyone believes is stopped. */
          toast.error(
            `${job.ticket.printerName || 'The kitchen'} did not print the cancellation — tell them.`,
          )
          continue
        }
        /* PRINT THEN MARK, inverted but for the same reason: marking without
           printing would leave the kitchen cooking food the system believes it
           has stopped. */
        await markKitchenCancelledAction(
          documentId,
          job.printerId,
          job.lines,
          terminal?.id ?? null,
        ).catch(() => {})
      }
      toast.info('The kitchen has been told to stop.')
    } catch {
      /* Offline, or the transport failed. The void itself stands — it is local
         and the cashier watched it happen. Same known gap as the void trail: a
         cancellation taken while the line is down is lost rather than queued. */
    }
  }

  /**
   * The automatic send, fired when a tab is SAVED, CLOSED or FINALISED.
   *
   * Quiet by design: it reports failures and successes but never "nothing to
   * send", because most saves in a retail shop have nothing routed anywhere
   * and a toast on each one would train people to ignore all of them.
   *
   * The setting is re-read per send rather than cached, so a shop switching it
   * off mid-service stops firing on the next save rather than at the next page
   * reload — a till holds a page open for a whole shift.
   */
  async function autoSendToKitchen(documentId: number | null): Promise<void> {
    if (!documentId) return
    try {
      if (!(await kitchenAutoPrintEnabledAction())) return
      await fireKitchenTickets(documentId, { source: 'auto', quiet: true })
    } catch {
      /* Never let the kitchen cost the sale. The tab is already saved by the
         time this runs; a failed docket is a walk to the pass, where a failed
         save is money. */
    }
  }

  /**
   * The send-to-kitchen key.
   *
   * Opens the course picker when the tab has more than one thing to fire, and
   * sends everything when it does not. A restaurant running three courses
   * chooses; a bar with one round should not have to tap twice to send it.
   */
  function sendToKitchen() {
    const documentId = state.documentId
    if (!documentId) {
      toast.info('Save the table first — the kitchen ticket comes off the parked tab.')
      return
    }
    startTransition(async () => {
      // Push any unsaved lines so the ticket matches the screen.
      if (table && state.lines.length > 0) {
        const saved = await updateTableBillAction(documentId, {
          customerName: table.code,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          priceStructureId,
          lines: salePayloadLines(state.lines, lineSpecials, docShares),
        })
        if (!saved.ok) {
          toast.error(saved.error)
          return
        }
      }

      const options = await kitchenSendOptionsAction(documentId)
      if (!options.ok) {
        toast.info(options.error)
        return
      }
      if (options.options.length === 0) {
        toast.info('Nothing new to send — the kitchen has it all.')
        return
      }
      /* One course with one item is not a choice worth making somebody make. */
      const single =
        options.options.length === 1 && options.options[0].lines.length === 1
      if (single) {
        await fireKitchenTickets(documentId, { source: 'manual' })
        return
      }
      setKitchenPicker({ documentId, options: options.options })
    })
  }

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
    /* BOTH reads, awaited together, because `floorLoaded` gates a judgement that
       joins them: the gate counts a bill as armable only when a configured table
       is carrying it (`tableByDoc`), so tabs-without-tables reads as an empty
       floor just as surely as no read at all. Flipping the flag on the first one
       home would hand the armed mode half a floor and re-open the exact race the
       flag exists to close. */
    void Promise.allSettled([
      listTablesAction()
        .then((r) => {
          if (r.ok) setTables(r.tables)
        })
        .catch(() => {}),
      /* The tabs come with it: the gate shows both, and two Refresh buttons — or a
         Refresh that updated half the screen — is worse than one read that costs a
         second query. A failure leaves the last good list on screen rather than
         blanking a floor mid-service. */
      listOpenTabsAction()
        .then(setTabs)
        .catch(() => {}),
    ]).then(() => setFloorLoaded(true))
  }, [])

  /**
   * Tonight's bookings, for the gate's strip.
   *
   * Its own call rather than riding with the tables, because it fails
   * differently: a shop with reservations switched off returns an empty list,
   * which is a normal answer and not a reason to leave the floor unrefreshed.
   * Failures are swallowed for the same reason the floor's are — a booking
   * strip that could not load must not stop a waiter seating anybody.
   */
  const refreshBookings = useCallback(() => {
    if (!hospitality) return
    void tillBookingsAction()
      .then(setBookings)
      .catch(() => {})
  }, [hospitality])

  /**
   * Keeping the floor live.
   *
   * ── WHY IT RUNS ONLY WHILE THE FLOOR IS ON SCREEN ─────────────────────────
   *
   * `choosingTable` is true exactly when the gate is showing, which is the only
   * time a stale floor is visible to anybody. A waiter deep in a basket cannot
   * see the floor, so refreshing behind it is work with no reader — and on a
   * hybrid site that work crosses the shop's LAN.
   *
   * It also seeds to `hospitality`, so a restaurant till opens on the gate and
   * this effect's leading read IS the first read. There is no separate mount
   * effect: one would fire alongside this on every start and read the floor
   * twice.
   *
   * Gating on `choosingTable` rather than `hospitality` is also what keeps this
   * out of the "fourth `if (hospitality)`" the header warns about: the question
   * being asked is "is the floor visible", not "is this a restaurant". The
   * `hospitality` term that remains is the existing one, narrowed.
   *
   * ── AND WHY THREE SECONDS ─────────────────────────────────────────────────
   *
   * Twenty was chosen when the floor lived in the cloud and every read crossed
   * the internet. On a hybrid site it is a query to a machine in the same
   * building, and the difference is measurable rather than assumed: 0.36ms per
   * read on a 40-table floor with 25 occupied, which for ten tills at three
   * seconds is 0.12% of one core.
   *
   * Three seconds is what makes ten waiters feel like they are looking at one
   * floor. At twenty, a round added at the bar is missing from the pass for
   * long enough that somebody walks over to ask.
   *
   * A cloud site pays for the same cadence over the internet, and gets the same
   * benefit — a shared floor is a shared floor. If that ever proves too chatty
   * for a shop on a poor line, the interval is the thing to change, not the
   * mechanism.
   *
   * WebSocket push was the plan and was reconsidered here: Next never exposes
   * the raw socket (see docs/local-backend.md — it is why replicaHost.mjs is a
   * separate process), so push would mean a second long-running process on
   * every restaurant box to install, supervise and restart — plus reconnect
   * logic and a poll fallback for when it drops. For 0.12% of a core, the
   * simpler thing wins. The trigger is the only part that would differ if that
   * changes, because everything already goes through `refreshTables`.
   */
  useEffect(() => {
    if (!hospitality || !choosingTable) return
    /*
     * Immediately on arrival, then every three seconds.
     *
     * The leading read is what makes the gate truthful the moment it appears.
     * Thirteen places set `choosingTable`, and only two of them refreshed —
     * from the other eleven a waiter backing out of a basket met a floor as old
     * as whenever they left it, for up to a full interval. Doing it here fixes
     * all thirteen and cannot be forgotten by a fourteenth.
     */
    refreshTables()
    const timer = setInterval(refreshTables, 3_000)
    return () => clearInterval(timer)
  }, [hospitality, choosingTable, refreshTables])

  /* Bookings change far more slowly than the floor does — a party arrives every
     few minutes at best, where a bill changes every time somebody rings up a
     drink. Two minutes rather than twenty seconds, so a quiet Tuesday is not
     asking the server for a list that has not moved. */
  useEffect(() => {
    if (!hospitality) return
    refreshBookings()
    const timer = setInterval(refreshBookings, 120_000)
    return () => clearInterval(timer)
  }, [hospitality, refreshBookings])

  /**
   * ── THE BASKET, KEPT WHERE A POWER CUT CANNOT REACH IT ────────────────────
   *
   * One effect over `state.lines`, rather than a call at each of the ten places
   * the basket changes. That is deliberate and it is the same discipline the
   * last-sale receipt uses a few hundred lines up: a rule enforced in one place
   * cannot be forgotten by the eleventh caller, and there WILL be an eleventh.
   *
   * Every CLEAR empties the lines, so the empty case — which deletes the row
   * rather than storing a basket with nothing in it — covers paid, parked,
   * cleared and voided without knowing which happened. The draft simply tracks
   * what is on screen.
   *
   * Debounced, because this fires per keystroke on a quantity edit and a write
   * per character is wasted work on a machine that may be slow. 400ms is well
   * inside the gap between a scan and the next one, so in practice a cashier
   * never outruns it — and if they do, the previous write already holds
   * everything but the last line.
   *
   * NOT the server, deliberately. This is the change that lets a trade counter
   * keep a long quotation safe without a round trip per line, and it works
   * identically with no network at all — which is the whole point.
   */
  /*
   * Is there a basket to hand back?
   *
   * Asked ONCE, on mount, and only about a basket that is not already on screen.
   * The empty check matters: this effect and the writer below both run on the
   * first render, and a till that recalled a saved sale before this resolved
   * would be offered the draft of the sale it is already holding.
   */
  useEffect(() => {
    if (state.lines.length > 0) {
      markDraftChecked()
      return
    }
    let cancelled = false
    void readLocalDraft(siteId)
      .then((draft) => {
        if (!cancelled && draft && draft.lines.length > 0) setRecoverable(draft)
      })
      .finally(() => {
        markDraftChecked()
      })
    return () => {
      cancelled = true
    }
    /* Mount only. Re-running when the basket empties would offer the draft back
       the instant a sale is finalised, which is the one moment it is certainly
       not wanted. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId])

  /*
   * ── AN OFFER THE WAITER HAS ALREADY OVERTAKEN ─────────────────────────────
   *
   * The read above answers on mount, but on a hospitality till the question
   * cannot be ASKED on mount: the floor gate is up, and the modal below rightly
   * waits for it. So the offer sits pending — and the thing that lifts the gate
   * is the waiter opening a table, a tab or a saved sale, which puts a real bill
   * on screen. The pending question then surfaced on top of that bill, and
   * answering "Restore it" LOADed the draft over it: lines and document id both
   * replaced, the table's order gone with no record that it had been.
   *
   * A basket arriving by any other route is that answer, given by doing. The
   * draft is dropped from the machine as well as from state, for the same reason
   * "Start fresh" clears it — otherwise the next load asks again about a basket
   * the till has visibly moved on from, and asks it at the end of the sale, when
   * the lines empty and the gate is long gone.
   *
   * Keyed on having lines rather than on the count, so this fires once when the
   * bill lands and not again per scan. It cannot race the mount read: that one
   * stands down entirely when lines are already present, and if it resolves
   * after a bill has loaded, this runs again and takes the offer straight back.
   */
  const basketHasLines = state.lines.length > 0
  useEffect(() => {
    if (recoverable === null || !basketHasLines) return
    setRecoverable(null)
    void clearLocalDraft(siteId)
  }, [siteId, recoverable, basketHasLines])

  /*
   * The till was opened to make something specific — start it as that.
   *
   * ── WHY AN EFFECT AND NOT THE REDUCER'S INITIAL STATE ─────────────────────
   *
   * Because it must not win over a recovered basket. Both this and the recovery
   * read fire on mount, and a till that had been switched off mid-quotation and
   * was then opened from the back office's "New order" would otherwise throw the
   * unfinished quote away before anybody was asked about it. So this waits for
   * the same `draftChecked` gate the writer uses, and stands down entirely if
   * there is a basket on screen or one waiting to be offered back.
   *
   * ── AND WHY IT RUNS ONCE ──────────────────────────────────────────────────
   *
   * The intent belongs to the ARRIVAL, not to the URL. A cashier who lands here
   * from "New order", finishes it, and carries on serving customers is at an
   * ordinary till — re-applying the type on every basket would have the URL
   * quietly deciding what the next twelve sales are, long after the person who
   * clicked that button has gone.
   */
  const startApplied = useRef(false)
  useEffect(() => {
    if (startApplied.current) return
    if (!draftCheckDone) return
    if (startAs === 'invoice') {
      startApplied.current = true
      return
    }
    // A basket in hand, or one about to be offered back, outranks a URL.
    if (state.lines.length > 0 || recoverable) return

    startApplied.current = true
    dispatch({ type: 'SET_DOC_TYPE', docType: startAs })
    /* Phrased by MODULE, which carries its own article — the old wording built
       "a " + the label and so announced "Starting a sales order." */
    toast.info(`Starting ${MODULE_PHRASES[moduleForDocType(startAs)]}.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAs, recoverable, state.lines.length, draftCheckDone])

  /**
   * Moves the till to another module.
   *
   * ── WHY THIS ASKS ─────────────────────────────────────────────────────────
   *
   * SET_DOC_TYPE clears the basket, and that is correct rather than incidental:
   * what has been rung up so far was rung up as one kind of document, and the
   * prices, discounts and promises attached to it are not automatically true of
   * another. See the reducer.
   *
   * But a menu that binned six lines the instant somebody tapped the wrong row
   * would make this the most dangerous control on the screen — and it sits at
   * the top-left, where a thumb rests. So a basket with anything in it earns a
   * question first. An EMPTY basket switches straight through: there is nothing
   * to lose and nothing to warn about, which is the overwhelming majority of
   * taps.
   */
  const pickModule = useCallback(
    (module: TillModule) => {
      /*
       * A LIST-ONLY MODULE CHANGES NOTHING. Lay-bys are not a kind of document
       * the basket can be — they live in their own table — so picking that row
       * opens the list and leaves whatever is on screen exactly where it is.
       * Routing it through SET_DOC_TYPE would clear a half-rung sale to show a
       * list and then hand back an identical empty till.
       */
      if (LIST_ONLY_MODULES.includes(module)) {
        /* Through the shared opener, which carries the offline refusal — an
           offline list would render its empty state, "No lay-bys on the go",
           which reads as a fact about the shop rather than about the line. */
        if (module === 'laybys') openLaybyList()
        return
      }

      const next = MODULE_DOC_TYPES[module]

      /*
       * ALREADY ON THIS MODULE, WITH AN EMPTY BASKET — nothing to do.
       *
       * This used to return for the whole same-module case, which was right while
       * a tap on the row meant "go to quotes": you were there. It is wrong now
       * that a button says "New quote" out loud. Somebody halfway through a quote
       * who presses that is asking to abandon it and start again, and a button
       * that silently did nothing would be pressed twice and then distrusted.
       *
       * So the empty case still returns (starting a fresh empty quote from an
       * empty quote is a no-op with a toast), and a basket with lines falls
       * through to the confirm below — which is the question that act deserves.
       */
      if (next === state.docType && state.lines.length === 0) return

      if (state.lines.length > 0) {
        setSwitchingTo(module)
        return
      }
      dispatch({ type: 'SET_DOC_TYPE', docType: next })
      toast.info(`Starting ${MODULE_PHRASES[module]}.`)
    },
    /* `till.online` is load-bearing here, not incidental: without it this
       callback closes over the value from mount — which is optimistically
       true — and the offline refusal below can never fire. Found by driving
       it: the quote guard worked (a plain function, re-created each render)
       while this one silently opened the list. */
    [state.docType, state.lines.length, toast, till.online],
  )

  /**
   * Opens a module's EXISTING documents, from the menu's second button.
   *
   * ── WHY THIS IS NOT `pickModule` ──────────────────────────────────────────
   *
   * They are opposites in the one way that matters to a cashier: picking a
   * module decides what the BASKET is and so may clear it, while this lays a
   * list over the top and touches nothing. A counterhand six lines into a sale
   * who wants to check last week's quote gets to keep their six lines.
   *
   * Each opener carries its own offline refusal, which is why this dispatches to
   * them rather than setting the modal flags directly — these documents live on
   * the server, and a list rendering its empty state offline would say "no
   * quotes" when the truth is "this till cannot see them".
   *
   * The MENU IS CLOSED ONLY ON THE WAY THROUGH. A refused open leaves it
   * standing, so the toast lands on the screen the cashier pressed from rather
   * than on a trading screen they did not ask to be returned to.
   */
  const openModuleList = useCallback(
    (module: TillModule) => {
      /*
       * SAVED SALES ARE THE EXCEPTION, and the only one: parked baskets live in
       * this machine's own IndexedDB as well as on the server, so that list has
       * something true to show with the line down. The other three are entirely
       * server-side.
       *
       * Refused HERE as well as inside each opener, because this is the branch
       * that decides whether the menu closes. Falling through would shut the menu
       * and then refuse, which reads as the tap having worked.
       */
      if (module !== 'sale' && !till.online) {
        toast.info(`${MODULE_LIST_NAMES[module]} need the connection — they live on the server.`)
        return
      }
      setShowingModules(false)
      if (module === 'sale') setShowingSaved(true)
      else if (module === 'quotes') openQuoteList()
      else if (module === 'orders') openOrderList()
      else if (module === 'laybys') openLaybyList()
    },
    /* Same reason `pickModule` lists it: without `till.online` this closes over
       the optimistic mount value and the refusal above can never fire. */
    [till.online, toast],
  )

  useEffect(() => {
    /*
     * Hold off until the read above has answered.
     *
     * Both effects run on mount, and this one's empty-basket case DELETES the
     * draft. Without this guard a till would wipe the very basket it was about
     * to offer back — the reader is async, the writer is on a timer, and which
     * of them lands first is not something to leave to chance.
     */
    if (!draftChecked.current) return
    const timer = setTimeout(() => {
      void saveLocalDraft(siteId, {
        documentId: state.documentId,
        docType: state.docType,
        customerId: state.customer?.id ?? null,
        customerName: state.customer?.name || state.customerName,
        customerVatNo: state.customer?.vatNumber ?? null,
        customerPhone: state.customer?.phone ?? null,
        priceStructureId,
        returning: state.returning,
        lines: state.lines,
        totalIncl: totals.doc.totalIncl,
      })
    }, 400)
    return () => clearTimeout(timer)
    /* Keyed on the LINES rather than on the payload, which is rebuilt every
       render — depending on that would fire this on every unrelated keystroke. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, state.lines, state.documentId, state.docType, state.customer, state.returning])

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
  const tableLines = salePayloadLines(state.lines, lineSpecials, docShares)

  useEffect(() => {
    if (!table) return
    if (state.lines.length === 0) return

    /* 900ms debounces a waiter's typing; a RETRY waits longer, because the thing
       it is waiting for is a machine coming back rather than a finger stopping.
       Retrying every 900ms would put ten tills on a dead box's doorstep for the
       whole outage, and the basket is safe on screen meanwhile.

       Not reset when the waiter leaves the table: at worst the first save on the
       next one waits five seconds and then resets itself, and a counter cleared
       in three places is a counter one of them will eventually forget. */
    const delay = tableSaveAttempt === 0 ? 900 : 5_000

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
            /* Back to the fast debounce. Left at a retry count, every later save
               on this table would wait five seconds for no reason. */
            setTableSaveAttempt(0)
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
          setTableSaveAttempt(0)
        } catch {
          /*
           * ── THE BILL COULD NOT BE WRITTEN ───────────────────────────────────
           *
           * On a hybrid site this is the shop's own box being unreachable — a
           * cable out, the machine off, a switch rebooted mid-service. On any
           * other site it is the cloud.
           *
           * Until now there was no catch here at all, only a `finally`. The
           * rejection escaped, nothing was said, and the basket sat on screen
           * looking exactly as it does when a save succeeded. A waiter would
           * carry on adding to it — and the round they were adding existed
           * nowhere but that browser.
           *
           * ── WHY IT DOES NOT FALL BACK TO A LOCAL PARK ──────────────────────
           *
           * The counter's Park button does, and that is right there: a parked
           * basket belongs to the till that parked it, and a cashier recalls it
           * where they left it.
           *
           * A TABLE is the opposite. Its whole purpose is that another waiter,
           * at another till, can pick it up — so a bill quietly written to this
           * browser would be a table nobody else can see, on a floor where the
           * table still reads free. Two waiters would then serve it, and only
           * one of the two bills exists anywhere. That is worse than the basket
           * simply not being saved yet, which is what this says.
           *
           * So it tells the truth, keeps the basket on screen, and schedules
           * another attempt. A box that comes back takes the whole basket with
           * it — nothing here is lost by waiting.
           */
          toast.error('The bill could not be saved. It is still on this screen — trying again.')
          /* Bumped, because the effect is keyed on the LINES: a waiter who added
             a round and then stopped would otherwise never retry, and the basket
             would sit unsaved until they happened to touch it again. */
          setTableSaveAttempt((n) => n + 1)
        } finally {
          setTableSaving(false)
        }
      })()
    }, delay)

    return () => clearTimeout(timer)
    /* Deliberately keyed on the LINES, not on `tableLines` — that array is rebuilt every
       render, so depending on it would fire this on every keystroke elsewhere. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.id, state.documentId, state.lines, tableSaveAttempt])

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
      const result = await recallSaleForTillAction(picked.documentId!, priceStructureId, terminal?.id ?? null)
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
      /* The bill's own price type, not the till's — see restorePricing. */
      restorePricing(result.priceStructureId)
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
     copy takes over whenever the props arrive empty. The state is declared with the
     rest of the shell's; this is the effect that fills it. */
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
        /* Through the same door as the Pay button, so the stock warning cannot
           be walked around by pressing a quick key instead. */
        pay: openTender,
        /*
         * The Void Sale key ASKS WHY, like every other void.
         *
         * It used to open the plain "Clear this sale?" confirm, which is how the
         * one void a cashier reaches most often was also the only one that wrote
         * no reason — the exact failure `askVoid` exists to prevent, and it made
         * a void report quietly wrong rather than visibly empty.
         *
         * A RETURN keeps the old confirm. There is no reason list for goods
         * coming back this way, and clearing one is a mode change rather than a
         * void — the same split `onClear` makes on the pane.
         */
        clear: () => {
          if (state.returning || state.lines.length === 0) setConfirmClear(true)
          else voidSaleDraft()
        },
        saveSale,
        saveAsOrder,
        undo: undoLastLine,
        pickCustomer: () => setPickingCustomer(true),
        editLine: () => {
          const line = state.lines.find((l) => l.key === state.selectedKey)
          if (line) setEditing(line)
        },
        pickPriceType: () => {
          /* A shop with one price type has nothing to choose between, and a dialog
             offering a single option that is already selected is a dead end. Say what
             is missing and where it is set up instead. */
          if (priceStructures.length < 2) {
            toast.info('This shop has one price type. Add more under Setup → Pricing.')
            return
          }
          setPickingPriceType(true)
        },
        /* Unconditional, unlike the key above it. A shop with one price type
           still has prices worth checking — the ladder is only part of what this
           answers, and "what does this cost and is there any" is the rest. */
        priceCheck: () => setCheckingPrice(true),
        takePayment: () => setTakingPayment(true),
        takeDeposit: () => void openDeposit(),
        showReprints: () => setShowingReprints(true),
        showOnlineOrders: () => setShowingOrders(true),
        startLayby: openStartLayby,
        showClock: () => setShowingClock(true),
        /* root: a quick key names the department to open outright — it is not a
           step down from wherever the pane happens to be sitting. */
        openDepartment: (departmentId: number) =>
          dispatch({ type: 'DRILL', departmentId, root: true }),
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
              ? await scanAction(String(productId), priceStructureId, terminal?.id ?? null).catch(
                  () => null,
                )
              : null
            const offline = found ?? (await findByCode(siteId, String(productId)))
            if (offline) add(offline)
            else toast.error('That product is not on this till right now.')
          })
        },
        showOutbox: () => setShowingOutbox(true),
        showShift: () => setManagingShift(true),
        showDrawerMovement: (type: MovementType) => setDrawerMovement(type),
        showDeclaration: () => setDeclaringCashup(true),
        docDiscount: () => setDiscountingDoc(true),
        sendToKitchen,
        printBill,
        reprintLastSlip: () => {
          try {
            const raw = window.localStorage.getItem(`pos-last-sale-${siteId}`)
            const last = raw ? (JSON.parse(raw) as { documentId: number; number: string }) : null
            if (last?.documentId) {
              openSalePaper(last.documentId)
            } else {
              toast.info('Nothing has been sold on this till yet.')
            }
          } catch {
            toast.info('Nothing has been sold on this till yet.')
          }
        },
        startReturn: () => dispatch({ type: 'SET_RETURNING', returning: true }),
        findReceipt: () => setReceiptReturn(true),
        /*
         * Arms the next item as a refund on the sale in progress.
         *
         * A bare dispatch: no dialog, no confirmation, nothing asked. The whole
         * value of this key is that it is one tap in the middle of serving
         * somebody, and a question here would cost more than the mistake it
         * prevents — the mistake being one line the cashier can see, on a slip
         * they have not tendered, next to a badge that says Refund.
         *
         * The toast is the second half of the signal, not decoration. The
         * banner (see SalePane) says the state; this says the state CHANGED,
         * which is what a cashier who pressed the wrong key needs to hear.
         */
        armRefund: (armed: boolean) => {
          dispatch({ type: 'ARM_REFUND', armed })
          toast.info(
            armed
              ? 'Refund armed — ring up the item coming back.'
              : 'Refund cancelled. The till is selling.',
          )
        },
        giftCardBalance: () => setGiftBalanceOpen(true),
        /*
         * The two gestures that act on a whole table, reached from a key — they were
         * once a pair of buttons on the gate's header.
         *
         * They differ in WHERE they start, because the two jobs differ. A split acts on
         * the bill the waiter is looking at, so it opens on the table already open and
         * only sends them to the floor to pick one when none is (see
         * `openSplitForCurrentTable`). A move is about a table other than this one by
         * definition — its whole purpose is choosing a destination — so it still arms
         * the floor.
         *
         * For the arming path the order matters and is the whole subtlety: the gate is
         * only mounted while `choosingTable`, so arming first and navigating second
         * would set state on a screen that is not there. Arming the mode and THEN
         * showing the gate means the banner is up on the first paint the waiter sees.
         *
         * Exclusive, like the buttons were: a tap on the floor can only mean one thing.
         */
        armSplit: openSplitForCurrentTable,
        armTransfer: () => {
          setArmedForSplit(false)
          setArmedForTransfer(true)
          setChoosingTable(true)
        },
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
      /* HOSPITALITY READ 3 OF 3 — the one the docblock at the top of this file names.
         It was pinned to `false`, which greyed every hospitality-only key (split the
         bill, move table, print the bill, send to kitchen) on EVERY till including a
         restaurant one, and made a configured feature look unbuilt. The prop is the
         only authority on which kind of till this is. */
      hospitality,
      online: till.online,
      hasSelection: state.selectedKey !== null,
      hasLines: state.lines.length > 0,
      hasCustomer: state.customer !== null,
      returning: state.returning,
      refundArmed: state.refundArmed,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    /* `state.undoCount` is in here for the undo handler's sake: it closes over the
       count to decide whether the allowance is spent, so a memo that did not rebuild
       when it changed would keep refusing against the figure from two undos ago. */
    /* `state.returning` earns its place now that the Void Sale key branches on it:
       without it the key would keep reading the mode from whenever the memo last
       rebuilt, and offer a reason picker for a return it thinks is still a sale. */
    /* `table` and `state.documentId` are here for the Split key, which acts on the
       table the till is IN. Without them the handler kept the `table` from whenever the
       memo last rebuilt — null, from before the waiter tapped a table — so pressing
       Split inside an open table read as "no table open", threw the waiter back to the
       floor and told them no bill was on one. The bill was on screen the whole time. */
    /* `state.refundArmed` is here because the Refund key TOGGLES on it: a memo that
       did not rebuild when it changed would keep re-arming an already-armed till, so
       the second press — the cashier's only way out — would do nothing. */
    [state.lines, state.selectedKey, state.customer, state.undoCount, state.returning, state.refundArmed, state.documentId, table, till.online, results, browse.products, canOverrideDiscount, canOverridePrice, canVoid, hospitality],
  )

  /*
   * Which quick key, if any, is holding a state right now.
   *
   * One predicate passed to every panel rather than a flag per bar, because the
   * shop decides where its keys live: Refund may sit on the counter bar, inside
   * a folder, or on the tables bar of a restaurant till, and a ring that only
   * appeared on one of them would be a cashier hunting for the armed key on a
   * screen that is not showing it.
   *
   * Only action keys can be armed — a product or a department tile is a thing,
   * not a mode — so everything else answers false without being asked.
   */
  const quickKeyActive = useCallback(
    (key: QuickKeyRow) =>
      key.kind === 'action' && key.actionSlug === 'refund' && state.refundArmed,
    [state.refundArmed],
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
    () =>
      till.online
        ? tenders
        : tenders.filter(
            (t) => offlineBlockedTender(t, { allowAccount: offlineAccountSales }) === null,
          ),
    /* `offlineAccountSales` is the shop's own answer to whether a disconnected
       till may still sell on account — see pos_offline_account_sales. Off by
       default, so this list is unchanged for a shop that has not chosen. */
    [tenders, till.online, offlineAccountSales],
  )

  return (
    <TileSizeContext.Provider value={tileSize.size}>
      <TillStatusBar
        modeName={modeName}
        /* The bar names the SCREEN under it — except on either gate, where the
           card below carries its own heading and the slot takes the brand
           instead. No basket there either, so no item pill. */
        /*
         * The heading NAMES what is being built, not just "a sale".
         *
         * A till writing a quote looks identical to one writing an invoice —
         * same basket, same prices, same Pay button — and the only thing that
         * differed was a toast that had faded by the time anybody looked. So
         * somebody could be three minutes into an order believing it was a sale,
         * and find out when it did not take money.
         *
         * Invoice stays "Current Sale": it is the ordinary case, that is what a
         * cashier calls it, and a till that announced "Invoice" all day would be
         * naming the paperwork instead of the job.
         */
        screenTitle={
          choosingTable || closedGate || clockGate
            ? null
            : state.docType === 'invoice'
              ? 'Current Sale'
              : DRAFT_DOC_LABELS[state.docType]
        }
        operatorName={operatorName}
        terminalLabel={terminalLabel}
        unclaimed={unclaimed}
        /* Only once the device has resolved AND the shell has had its say — before
           that, "offline unavailable" would flash on every load and mean nothing. */
        offlineReason={device !== undefined && !shell.ready ? shell.reason : null}
        online={till.online}
        /* ── THE OPENING SCREEN WEARS THE BRAND AND NOTHING ELSE ────────────
           Every chip on the right reports on a till that is TRADING, and this
           one is not open yet. The gate's own card already names the till, its
           code, the operator and the day — so the row above was repeating all
           of it in smaller type, beside the one figure on the screen that has
           to be typed carefully. It is stripped here rather than nulled prop by
           prop; see `bare` in TillStatusBar for why.

           Only the closed gate, not the clock gate: clocking on happens on an
           OPEN till, where the queue and the shift are live facts somebody may
           legitimately need mid-shift. */
        bare={closedGate !== null}
        pendingSales={till.pending}
        failedSales={till.failed}
        catalogAgeHours={till.catalogAgeHours}
        itemCount={choosingTable || closedGate || clockGate ? null : state.lines.length}
        onShowOutbox={() => setShowingOutbox(true)}
        shiftLabel={shiftLabel}
        /* No shift chip on either gate: the whole screen under it is already
           the answer, and a "No shift" warning beside a screen saying the till
           is closed is the same sentence twice. */
        onShift={closedGate || clockGate ? undefined : () => setManagingShift(true)}
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
        tableLabel={
          choosingTable || closedGate || clockGate ? null : table ? table.code : tabLabel
        }
        /* Undefined ON either gate: a "back to the floor" button on the floor is
           a control that can only ever do nothing, and one on a closed till
           would walk past the very thing that gate exists to insist on. */
        /* Not on either gate. The closed till is a screen whose whole purpose is
           to insist on a shift before anything else happens, and the floor is a
           choice of TABLE — a cashier who switched to quotes from there would
           land on a trading screen belonging to no bill. Both gates lead to the
           sale screen, where this is waiting. */
        /*
         * AND NOT ON A RESTAURANT TILL AT ALL.
         *
         * Every row behind this menu is a retail act. A quote, a sales order and
         * a lay-by are all promises about goods leaving the shop later — none of
         * which a kitchen does. Worse, two of them CHANGE THE DOC TYPE, which
         * clears the basket: a waiter with a table open who taps here to see what
         * it is loses the tab's lines to a document the restaurant will never
         * write. The one row that would survive — the floor — is already the
         * screen behind them, reached by Change table beside this.
         *
         * So it is hidden rather than filtered down to one row: a menu offering
         * only "Sale" on a screen already selling is a control that can do
         * nothing, and the space belongs to the table label instead.
         */
        onOpenModules={
          hospitality || choosingTable || closedGate || clockGate
            ? undefined
            : () => setShowingModules(true)
        }
        onChangeTable={
          hospitality && !choosingTable && !closedGate && !clockGate
            ? () => {
                /* Walking back to the floor with the bill still on screen. The basket
                   is already on the server via the debounce, so the only thing left to
                   do is hand the claim back — otherwise this table reads as taken until
                   the lease expires. */
                releaseHeldBill()
                setChoosingTable(true)
              }
            : undefined
        }
        /* Hand the screen back to the PIN pad, not to the back office: this is
           where a waiter ends their shift, and the next one signs in here.
           Clearing the till cookie is what makes PosEntry fall back to the gate;
           the refresh is what makes it happen now rather than on next load. */
        onExit={() => {
          startTransition(async () => {
            /* Awaited, unlike everywhere else: signing out ends the session that owns
               the claim, so a fire-and-forget release could be cut off by the redirect
               and leave the table taken for the whole lease — with the one person who
               could explain it already gone. */
            const held = state.documentId
            if (held) await reparkTableBillAction(held).catch(() => {})
            await tillSignOutAction()
            router.refresh()
          })
        }}
      />

      {/*
        ── THE TILL IS NOT OPEN ──────────────────────────────────────────────
        In front of EVERYTHING, including the table gate: a waiter seating a party
        onto a till with no shift is the same unreconciled sale as a cashier
        ringing one up, only slower to discover. Sits above the hospitality branch
        for that reason rather than inside it.
      */}
      {closedGate ? (
        <OpenTillGate
          mode={closedGate.mode}
          operatorName={operatorName}
          terminalId={terminal?.id ?? null}
          terminalLabel={terminal?.code ?? null}
          /* The code is the identity and goes first; the till number is what a
             shop actually calls the machine out loud ("till 2"), so it trails
             it. Deliberately not `terminalLabel` — that value bakes in its own
             bullet for the status bar, and the gate sets the two parts itself. */
          terminalName={terminal?.tillNumber ? `Till ${terminal.tillNumber}` : null}
          /* NOT `terminalId === null`, which the gate could work out for
             itself. `terminal` is also undefined for the tick before `device`
             resolves, so inferring it there would flash "not set up as a till"
             on every single load — the same reason this flag exists at all
             rather than the status bar testing `terminalLabel`. */
          unclaimed={unclaimed}
          canCashup={closedGate.canCashup}
          online={till.online}
          onOpened={(shiftId) => {
            noteShift(shiftId, operatorName)
            /* Straight to the floor in hospitality, straight to the basket in
               retail — the same place a sign-in lands, because opening the till
               is the step BEFORE that rather than a detour off it. */
            if (hospitality) setChoosingTable(true)
          }}
          onExit={() => {
            startTransition(async () => {
              await tillSignOutAction()
              router.refresh()
            })
          }}
        />
      ) : /*
        ── THIS PERSON IS NOT ON DUTY ────────────────────────────────────────
        After the till is open and before anything can be sold. The drawer is a
        fact about the machine; being clocked on is a fact about whoever is
        standing at it, and in terminal mode the shift gate stopped asking after
        the first cashier of the day. Only stands where the shop asked for it.
      */
      clockGate ? (
        <ClockInGate
          operatorName={clockGate.operatorName}
          terminalId={terminal?.id ?? null}
          online={till.online}
          onClockedIn={() => {
            refreshShiftStatus()
            /* Same landing as opening the till: the floor in hospitality, the
               basket in retail. Clocking on is the step before trading rather
               than a detour off it. */
            if (hospitality) setChoosingTable(true)
          }}
          onExit={() => {
            startTransition(async () => {
              await tillSignOutAction()
              router.refresh()
            })
          }}
        />
      ) : /*
        ── HOSPITALITY READ 1 OF 3: the gate stands in FRONT of the till ──────
        Instead of the three columns, not beside them. A waiter picks the table before
        there is a basket to put anything in, so nothing below this needs to know
        whether one was picked.
      */
      /*
        ── WHICH GATE IS THIS? NOT KNOWN YET ─────────────────────────────────
        Nothing, for the one round trip it takes to find out. `choosingTable`
        seeds true on a hospitality till, so without this the floor would paint
        first and be replaced the instant the shift status said the till was
        shut — see gateUndecided for why that read as a flash on every sign-in.

        Blank rather than a spinner, the same call PosEntry makes above: it
        resolves in milliseconds, and a spinner that appears on every single
        sign-in is more noticeable than the pause it is describing.
      */
      gateUndecided ? null : choosingTable ? (
        <TableGate
          bookings={bookings}
          /* Seating is a floor act, so the person on the floor does it. The
             booking is marked seated against whichever table it was pencilled
             against; the bill opens when they order, exactly as a walk-in's
             does. */
          onSeatBooking={(booking) => {
            startTransition(async () => {
              const result = await seatBookingAction(booking.id, booking.tableName || undefined)
              if (!result.ok) {
                toast.error(result.error)
                return
              }
              toast.success(`${booking.contactName} seated.`)
              void refreshBookings()
            })
          }}
          tabs={tabs}
          tables={tables}
          rooms={floorRooms}
          visitTypes={visitTypes}
          onRefresh={refreshTables}
          features={floorFeatures}
          busy={pending}
          /* Whether the floor below is the shop's or just an unfilled initial
             state. The armed modes refuse on an empty floor, and until this is
             true "empty" means "not read yet". */
          floorLoaded={floorLoaded}
          onWalkIn={() => {
            clearTabIdentity()
            setTable(null)
            setChoosingTable(false)
            dispatch({ type: 'CLEAR' })
          }}
          onNewTable={() => setNaming({ closing: false })}
          /*
           * ALWAYS offered on a hospitality till, even with an empty tables bar.
           *
           * It was gated on `hasTableKeys` at first, to avoid a button that opens an
           * empty dialog. That was wrong in practice: NOTHING has ever written to the
           * tables section — every call site passed 'main' until this change — so the
           * gate hid the button on every existing shop, and the feature could only be
           * discovered by a manager who had already found a designer tab nobody has
           * used. A control that appears only after you have done the setup it exists
           * to advertise is a control nobody finds.
           *
           * So the empty case is a teaching screen instead — see the dialog, which
           * names the bar and where to fill it. The keys are still the shop's own.
           */
          onShowQuickKeys={() => setShowingTableKeys(true)}
          splitting={armedForSplit}
          onToggleSplitting={setArmedForSplit}
          onSplitTable={openSplit}
          transferring={armedForTransfer}
          onToggleTransferring={setArmedForTransfer}
          onTransferTable={openTransfer}
          /* The key armed a mode over a floor with nothing it could act on. Said here
             rather than in the gate, which owns no toast — and said in terms of the
             remedy, because "no configured table" is not something a waiter can fix
             mid-service without being told where to go. */
          onEmptyArm={(mode) =>
            toast.info(
              mode === 'split'
                ? 'No open bill is on a table, so there is nothing to split. Seat it on one first.'
                : 'No open bill is on a table, so there is nothing to move. Seat it on one first.',
            )
          }
          onPickTab={resumeTab}
          onPickTable={resumeTable}
        />
      ) : (
      /* THREE FLOATING CARDS on a padded canvas, rather than three panes flush
         against each other. The gap is what separates the basket from the
         catalogue visually — without it the till reads as one undifferentiated
         sheet, and a cashier's eye has nothing to anchor on.

         `px-4 pb-4`, no top: TillStatusBar carries its own py-4, so the gap
         under the chips is already paid for. A p-4 here would stack on it. */
      <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4">
        <SalePane
          lines={state.lines}
          totals={totals}
          lineSpecials={lineSpecials}
          specialNameById={specialNames}
          selectedKey={state.selectedKey}
          customerLabel={customerLabel}
          /* What the basket looked like when it was recalled, so each line can
             say whether it has been touched this sitting. Null on a counter
             basket, which was recalled from nowhere. */
          baseline={state.baseline}
          /* The structure the basket is being priced on, named. The id is
             already resolved above (account → group → site default); this turns
             it into the words the line card prints. */
          priceStructureName={
            priceStructures.find((s) => s.id === priceStructureId)?.name ?? null
          }
          onSelect={(key) => dispatch({ type: 'SELECT', key })}
          /* − asks why before it takes anything off; ＋ goes straight through.
             See stepLine for why one unit off is an `item` void even when it
             empties the line. */
          onStep={stepLine}
          onEdit={(line) => {
            if (refuseRewardEdit(line)) return
            setEditingField('qty')
            setEditing(line)
          }}
          /* "More" opens the MENU, not the pad. The pad is one of the things the
             menu leads to — see LineOptionsModal for why the rare per-line verbs
             live a tap deeper than +, − and Void. */
          onLineMore={(line) => {
            if (refuseRewardEdit(line)) return
            setLineOptions(line)
          }}
          onRemove={voidLine}
          onCustomer={() => setPickingCustomer(true)}
          /* Close SAVES in hospitality rather than clearing — see closeSale. In
             retail there is no floor to park onto, so it keeps its old meaning
             and asks before throwing the basket away. */
          /* Abandoning a SALE with lines in it is a void and asks why. A return
             and an empty basket keep the plain confirm: there is no reason list
             for goods coming back this way, and nothing to account for when
             nothing was rung up. */
          onClear={
            hospitality
              ? closeSale
              : () => {
                  if (state.returning || state.lines.length === 0) setConfirmClear(true)
                  else voidSaleDraft()
                }
          }
          /* One button, two destinations. A separate "Refund" button beside Pay would sit
             unused all day next to the one key a cashier presses hundreds of times, and
             the mode is already stated on the pane — so the primary action follows the
             mode rather than competing with it. */
          onPay={openTender}
          returning={state.returning}
          refundArmed={state.refundArmed}
          onCancelRefund={() => dispatch({ type: 'ARM_REFUND', armed: false })}
          /* Decides whether the finish key says Pay or Save — a quote and an
             order take no money. See SalePane. */
          docType={state.docType}
          /* The Save/recall row this pane used to carry — and the six props that
             fed it — is gone. Saving is the `save-sale` quick key, and the three
             lists are quick keys of their own, so a shop places what it uses
             instead of every till carrying a strip it may never press. */
          onDocDiscount={() => setDiscountingDoc(true)}
          onFindReceipt={() => setReceiptReturn(true)}
          /* Money already down against this basket, so the pane can say so and
             the Pay key can carry the balance rather than the gross. Same figure
             the tender pad is given below — one number, read in both places. */
          depositHeld={depositHeld}
          exchange={
            exchangeCredit
              ? {
                  label: `Exchange · ${formatMoney(exchangeCredit.total)} credit from ${exchangeCredit.invoiceNumber}`,
                  onClear: () => setExchangeCredit(null),
                }
              : null
          }
          busy={pending}
        />

        {/*
          ── THE TRADE COUNTER'S WAY IN ─────────────────────────────────────
          A keyboard instead of a grid. Everything to the LEFT of this — the
          basket, its totals, Pay, Close — is the same component the touch till
          draws, wired to the same handlers, because a trade counter and a
          supermarket disagree about how a line is CHOSEN and about nothing
          else. Only the right-hand half changes.

          This is the shape phase 8 was for, and it is deliberately not a third
          `if (invoicing)` threaded through the file: it is one branch, at the
          one place the screen differs, over a shell that stays single.
        */}
        {invoicing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <TradeEntryPane
              online={till.online}
              busy={pending}
              onLookup={async (code) =>
                till.online
                  ? await scanAction(code, priceStructureId, terminal?.id ?? null).catch(() =>
                      findByCode(siteId, code),
                    )
                  : await findByCode(siteId, code)
              }
              onAdd={(product, qty) => add(product, qty)}
            />
            {/* The shop's own keys still work here — a trade counter wants Save
                as order and the supervisor keys as much as a till does, even
                though it has no use for a wall of product tiles. */}
            <div className="min-h-0 flex-1 overflow-auto rounded-card border border-border bg-surface p-4">
              <QuickKeyPanel
                keys={keysToShow}
                productNames={keyProductNames}
                departmentNames={keyDepartmentNames}
                isEnabled={(key) => quickKeyEnabled(key, quickKeyContext)}
                isActive={quickKeyActive}
                onPress={(key) => runQuickKey(key, quickKeyContext)}
                /* The default empty state says "pick a department on the left",
                   and on this screen there is no rail on the left — the code box
                   above IS how a line is added here. Pointing at furniture that
                   is not on the screen reads as a broken till. */
                emptyState={
                  <EmptyState
                    icon={<Icons.Sparkles size={28} />}
                    title="No quick keys yet"
                    hint="A manager can set these up in Setup → Quick keys. Until then, type a code above."
                  />
                }
              />
            </div>
          </div>
        ) : (
          <>
        <DeptRail
          /* The menu's departments, so no rail button opens onto nothing. */
          departments={menuDepartments}
          /* What is behind each button, so a cashier can see a department is
             worth opening before opening it. */
          tallies={tallies}
          activeId={state.catalog.kind === 'departments' ? state.catalog.path[0] ?? null : null}
          /* root: the rail only ever lists top-level departments, so picking one
             starts a fresh trail rather than adding to wherever the cashier
             happened to be. */
          onPick={(id) => dispatch({ type: 'DRILL', departmentId: id, root: true })}
        />

        <CatalogPane
          view={state.catalog}
          query={state.query}
          /* Same list as the rail: the drill tiles and the breadcrumb must
             agree with it, or drilling would offer a department the rail has
             already said is not on the menu. */
          departments={menuDepartments}
          /* The same tallies the rail shows, from the same memo — a tile and
             the row that opens it disagreeing on the count would read as a
             rendering fault. */
          tallies={tallies}
          results={results}
          searching={searching}
          /* The menu's grid, not the department's whole contents. `loading` is
             carried through untouched so a slow fetch still shows its skeleton. */
          browse={{ loading: browse.loading, products: browseProducts }}
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
              isActive={quickKeyActive}
              onPress={(key) => runQuickKey(key, quickKeyContext)}
            />
          }
        />
          </>
        )}
      </div>
      )}

      {/* The way between the till's modules. Lays OVER the trading screen rather
          than replacing it, so the basket and the catalogue stay mounted
          underneath — see ModuleMenu for why that matters. */}
      <ModuleMenu
        open={showingModules}
        current={moduleForDocType(state.docType)}
        /* Every module this build has. The list is filtered by what a shop has
           switched on the day there is a setting to switch; until then, showing
           all four is honest — all four work. */
        available={['sale', 'quotes', 'orders', 'laybys']}
        /* The same two values the status bar reads, from the same place — the
           panel covers most of the bar while it is open, and one source viewed
           twice is what stops the two disagreeing. */
        operatorName={operatorName}
        terminalLabel={terminalLabel}
        onPick={pickModule}
        onOpenList={openModuleList}
        onClose={() => setShowingModules(false)}
      />

      {/* The shop's quotes. Reached from the quote screen's own key rather than
          from the module menu: the menu answers "what kind of document is this
          basket", and finding an existing one is a different question. */}
      <QuotesModal
        open={showingQuotes}
        onClose={() => setShowingQuotes(false)}
        onRecall={recallQuote}
        busy={pending}
      />

      {/* Turning the basket into a NEW lay-by — the opposite direction from the
          list below, which finds an existing one to pay against. */}
      <StartLaybyModal
        open={startingLayby}
        onClose={() => setStartingLayby(false)}
        onStart={startLayby}
        customerName={state.customer?.name ?? null}
        totalIncl={totals.doc.totalIncl}
        lineCount={state.lines.length}
        defaultDueDate={laybyDueDate}
        busy={pending}
      />

      {/* The shop's lay-bys, from the module menu rather than a pane key —
          a lay-by is not something the basket can be. */}
      <LaybysModal
        open={showingLaybys}
        onClose={() => setShowingLaybys(false)}
        onPay={payLayby}
        onCollect={collectLayby}
        /* Closes the list on the way, so the two dialogs never stack. */
        onStartNew={() => {
          setShowingLaybys(false)
          openStartLayby()
        }}
        basketLines={state.lines.length}
        busy={pending}
      />

      {/* Orders waiting to go out. Tapping one DELIVERS it — see OrdersModal. */}
      <OrdersModal
        open={showingTillOrders}
        onClose={() => setShowingTillOrders(false)}
        onCollect={collectTillOrder}
        busy={pending}
      />

      {/* Only ever raised with a basket in hand — an empty one goes straight
          through. Worded as what will HAPPEN to the lines rather than as "are you
          sure", because the cost is the thing being decided.

          Raised by TWO acts now, and the wording covers both without changing:
          switching to another module, and the menu's "New quote" pressed while a
          quote is already half-written. "Start a quote? The 6 lines on screen
          will be cleared" is the right question either way — what the cashier is
          deciding is the fate of the lines, not the doc type. */}
      <ConfirmModal
        open={switchingTo !== null}
        title={switchingTo ? `Start ${MODULE_PHRASES[switchingTo]}?` : ''}
        confirmLabel={switchingTo ? `Yes, start ${MODULE_PHRASES[switchingTo]}` : ''}
        tone="danger"
        message={`The ${state.lines.length} line${
          state.lines.length === 1 ? '' : 's'
        } on screen will be cleared. Nothing has been posted, so nothing is reversed — but they will have to be rung up again.`}
        onClose={() => setSwitchingTo(null)}
        onConfirm={() => {
          if (switchingTo) {
            dispatch({ type: 'SET_DOC_TYPE', docType: MODULE_DOC_TYPES[switchingTo] })
            toast.info(`Starting ${MODULE_PHRASES[switchingTo]}.`)
          }
          setSwitchingTo(null)
        }}
      />

      {/* Confirmed rather than immediate. Close is a 72px key beside Pay, and an
          accidental brush of it must not silently bin a basket somebody has spent
          two minutes building in front of a customer. */}
      <ConfirmModal
        open={confirmClear}
        title={state.returning ? 'Clear this return?' : 'Clear this sale?'}
        confirmLabel="Clear it"
        tone="danger"
        message={`${state.lines.length} line${
          state.lines.length === 1 ? '' : 's'
        } will be removed. Nothing has been posted, so nothing is reversed.${
          state.returning ? ' The till goes back to selling.' : ''
        }`}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          /*
           * Clearing a RETURN also leaves return mode, which is the opposite of what
           * CLEAR does on its own — see the reducer, where the mode deliberately
           * survives so a mis-keyed return can be restarted.
           *
           * That reasoning assumed a Sale/Return switch on the pane. There is no longer
           * one: return mode is entered by the credit-sale quick key, and if Clear did
           * not end it there would be no way out short of finishing a credit note the
           * cashier never wanted. Abandoning the basket is the cashier saying they are
           * done returning, so it is the honest place to put the exit — and the message
           * says so rather than letting them find out at the next scan.
           */
          dispatch(
            state.returning ? { type: 'SET_RETURNING', returning: false } : { type: 'CLEAR' },
          )
          setConfirmClear(false)
        }}
      />

      {/*
        A basket the last session did not finish.
        Asked rather than restored: the person standing here may not be the one
        who built it, and a basket that appeared by itself would get rung up
        without anybody deciding to. Discarding is safe — nothing was posted.
      */}
      <ConfirmModal
        /*
         * Not while a gate is up.
         *
         * A recovered draft is a COUNTER basket, and both gates stand in front
         * of the sale screen for their own reasons — no shift open, or no table
         * chosen yet. Asking about a basket there interrupts a waiter picking a
         * table with a question about something else entirely, and worse, the
         * answer restores a basket onto a screen that is not showing. It waits
         * until there is a sale to restore it INTO.
         *
         * NOR over a basket that is already there. The gates lift by the waiter
         * OPENING something — a table, a tab, a saved sale — so the frame after
         * `choosingTable` goes false is the frame a real bill lands in. Asking
         * then is asking over somebody's order, and "Restore it" answers by
         * LOADing the draft, which replaces the lines AND the document id: the
         * table's bill is silently swapped for yesterday's counter basket. The
         * empty check is what keeps the offer to the screen it belongs on. The
         * effect below is the other half — this alone would only hide it.
         */
        open={
          recoverable !== null &&
          !closedGate &&
          !clockGate &&
          !choosingTable &&
          state.lines.length === 0
        }
        title="Pick up where the till left off?"
        confirmLabel="Restore it"
        cancelLabel="Start fresh"
        /* PRIMARY, not the default danger. Restoring is the safe action here —
           it is Start fresh that throws work away — and a red confirm button
           tells a cashier the opposite of what is true. */
        tone="primary"
        message={
          recoverable
            ? `This till was switched off with ${recoverable.itemCount} line${
                recoverable.itemCount === 1 ? '' : 's'
              } on screen, worth ${formatMoney(recoverable.totalIncl)}${
                recoverable.customerName ? ` for ${recoverable.customerName}` : ''
              }. Nothing was paid for and nothing was posted.`
            : ''
        }
        onClose={() => {
          /* Declined. The draft goes, or the next load would ask again about a
             basket somebody has already said they do not want. */
          setRecoverable(null)
          void clearLocalDraft(siteId)
        }}
        onConfirm={() => {
          const draft = recoverable
          if (!draft) return
          dispatch({
            type: 'LOAD',
            documentId: draft.documentId,
            lines: draft.lines as BasketLine[],
            customerName: draft.customerName,
            docType: draftDocType(draft.docType),
          })
          setRecoverable(null)
          /* The customer is NOT restored, only their name.
             A TillCustomer carries a credit limit and a balance, and the ones
             cached on a basket from yesterday are not today's. The name keeps
             the cashier oriented; re-attaching re-reads the account. */
          toast.info('Basket restored. Re-attach the customer if this is an account sale.')
        }}
      />

      {/* Why something is coming off a sale nobody has paid for. Holds the
          removal until the reason is given — see pendingVoid. */}
      <VoidReasonModal
        open={pendingVoid !== null}
        voidType={pendingVoid?.voidType ?? 'line'}
        description={pendingVoid?.description ?? ''}
        qty={pendingVoid?.qty ?? 0}
        valueIncl={pendingVoid?.valueIncl ?? 0}
        reasons={voidReasons}
        onClose={() => setPendingVoid(null)}
        onConfirm={confirmVoid}
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
                /* Asks why, then throws it away. voidSaleDraft does the CLEAR
                   itself once a reason is given, so the rest of the teardown
                   rides along behind it rather than running now — leaving the
                   floor before the cashier has answered would strand them on
                   the table gate with the prompt still open. */
                voidSaleDraft(() => {
                  clearTabIdentity()
                  setTable(null)
                  setChoosingTable(true)
                })
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
        /* An exchange's held credit — the pad shows the balance, the server
           adds the EXCHANGE tender when it posts the pair. */
        credit={
          exchangeCredit
            ? { amount: exchangeCredit.total, label: `Credit from ${exchangeCredit.invoiceNumber}` }
            : null
        }
        /* A deposit already taken against this basket — the pad asks for the
           balance, the server adds the DEPOSIT tender when it posts. Same
           arrangement as the exchange credit above it. */
        depositHeld={depositHeld}
        /* The card lookup for the redemption step (147). Online only — the
           balance lives on the server, and offlineBlockedTender already hides
           the key when the line is down. */
        onGiftCardLookup={async (code) => {
          const result = await lookupGiftCardAction(code, 'redeem')
          if (!result.ok) return result
          return {
            ok: true as const,
            code: result.code,
            display: result.display,
            balance: result.balance,
            expiresOn: result.expiresOn,
          }
        }}
        onFinalise={finalise}
      />

      {/* Dividing a bill. Nothing is written until Confirm, and the server writes both
          halves in one transaction — see posSplit.ts. */}
      <SplitBillModal
        open={splitting !== null}
        onClose={() => setSplitting(null)}
        fromLabel={splitting?.label ?? ''}
        lines={splitting?.lines ?? []}
        destinations={splitDestinations}
        busy={pending}
        /* What the chosen destination already has on it. Read when it is picked, not
           held for every open sale: a waiter opens one of them. */
        loadDestinationLines={async (documentId) => {
          const bill = await billForSplitByDocumentAction(documentId)
          return bill?.lines ?? []
        }}
        onConfirm={confirmSplit}
      />

      {/* The shift: open one, or cash up blind. Online only — the modal itself
          says so when the line is down. The three drawer movements used to live
          in here too; they are their own quick keys now, below. */}
      <ShiftModal
        /*
          NEVER IN FRONT OF THE GATE.

          `closedGate` IS a full-screen "Open your till" panel with its own
          float pad. This dialog's no-shift face is a second one, and stacking
          them showed a cashier two panels asking for the same float — the top
          one covering the real gate behind it.

          The status bar already refuses to open this while a gate stands (see
          `onShift` above). This is the same rule at the mount, because that
          only guards the ONE way in: cashing up from the quick count closes the
          shift while this dialog is already open, which raises the gate under a
          dialog nobody re-opened. The quick count now dismisses itself too, so
          this is the belt to that pair of braces — a guard on the STATE rather
          than on each route into it.
        */
        open={managingShift && !closedGate}
        online={till.online}
        terminalId={terminal?.id ?? null}
        pendingSales={till.pending}
        onClose={() => setManagingShift(false)}
        onShiftChanged={(shiftId) => noteShift(shiftId, operatorName)}
        onDeclare={() => {
          setManagingShift(false)
          setDeclaringCashup(true)
        }}
      />

      {/* Money in or out of the drawer that is not a sale — one dialog, three
          faces, reached by the payout / pay-in / drop quick keys. It resolves
          the open shift itself rather than trusting this shell's cached id;
          see the note in DrawerMovementModal for why that matters. */}
      <DrawerMovementModal
        open={drawerMovement !== null}
        type={drawerMovement}
        online={till.online}
        terminalId={terminal?.id ?? null}
        onClose={() => setDrawerMovement(null)}
        /* The status bar shows the shift's sale count and float; a movement
           changes what the drawer holds, so it is re-read rather than left
           showing the figure from before the payout. */
        onRecorded={() => noteShift(shiftId, operatorName)}
      />

      {/* The detailed cash-up the "Cash up" key opens: notes and coin counted
          by pile, every tender declared against a withheld expectation, and the
          banking. Reuses the back office's engine — see DeclarationModal. */}
      <DeclarationModal
        open={declaringCashup}
        shiftId={shiftId}
        /* Which till this machine is, for the owner picker. Null on an
           unclaimed machine, which the dialog shows rather than guesses. */
        terminalId={terminal?.id ?? null}
        pendingSales={till.pending}
        onClose={() => setDeclaringCashup(false)}
        onFinalized={() => noteShift(null)}
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

      {/* Mounted only while open, unlike the modals above. A closed dialog's
          children never unmount, and this one holds a tab's worth of state that
          must not survive into the next table's send. */}
      {kitchenPicker && (
        <SendToKitchenModal
          options={kitchenPicker.options}
          pending={pending}
          onClose={() => setKitchenPicker(null)}
          onSend={(scope) => {
            const target = kitchenPicker.documentId
            setKitchenPicker(null)
            startTransition(async () => {
              await fireKitchenTickets(target, { scope, source: 'manual' })
            })
          }}
        />
      )}

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
        onAttach={(customer) => {
          // Attach the account immediately — the cashier asked for it and must
          // not wait on a loyalty lookup to see it land.
          dispatch({ type: 'SET_CUSTOMER', customer })
          // Then find their membership and attach that too, if they have one.
          // Fire-and-forget on purpose: no membership, or a loyalty lookup that
          // fails, must never stop an account being attached. The sale simply
          // has no member, which is the same state as a customer who never
          // joined.
          void memberForCustomerAction(customer.id)
            .then((member) => {
              // Only if this is still the attached customer. Switching from one
              // account to another while the first lookup is in flight would
              // otherwise land the first customer's membership on the second.
              if (member && latestCustomerRef.current === customer.id) {
                dispatch({ type: 'SET_MEMBER', member })
              }
            })
            .catch(() => {})
        }}
        onClear={() => dispatch({ type: 'SET_CUSTOMER', customer: null })}
        onWalkInName={(name) => dispatch({ type: 'SET_CUSTOMER_NAME', name })}
      />

      {/* The "More" menu. Each entry either opens the pad on its own field, or
          leads to the flow that owns it — see chooseLineOption. */}
      <LineOptionsModal
        line={lineOptions}
        onClose={() => setLineOptions(null)}
        onChoose={chooseLineOption}
      />

      <LineEditModal
        line={editing}
        field={editingField}
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
          /* Captured before the dialog goes, because closing it clears `editing`
             and the approval still has to land on the line it was raised for. */
          const line = editing
          /* CLOSED BEFORE THE PAD OPENS, the same way the document discount closes
             itself. Both dialogs carry a NumPad, and a pad is not unmounted when its
             <dialog> closes — it is only hidden, which is the one state usePadKeys
             can see. Left open, this one sits behind the supervisor's PinPad with
             its own keys still live, and every digit of the manager's PIN is typed
             into the quantity or price field underneath it as well. */
          setEditing(null)
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
              toast.success(`Approved by ${auth.name}.`)
            },
          })
        }}
      />

      {/* Which of the shop's price lists the rest of this sale rings at. A mode on
          the sale, cleared when the basket goes — not a per-line override, which is
          still what tapping a line gives you. */}
      <PriceTypeModal
        open={pickingPriceType}
        structures={priceStructures}
        activeId={priceStructureId}
        /* What it falls back to with no override — the account's list when one is
           attached, else the shop's. Passed apart from `activeId` so the dialog can
           mark the row a cashier returns to by picking it again. */
        defaultId={state.customer?.priceStructureId ?? siteDefaultStructureId}
        fromCustomer={state.customer?.priceStructureId != null}
        hasLines={state.lines.length > 0}
        onClose={() => setPickingPriceType(false)}
        onPick={(structureId) => {
          setPricingOverride(structureId)
          setPickingPriceType(false)
          const picked = priceStructures.find((s) => s.id === (structureId ?? priceStructureId))
          /* Named out loud. The switch has no other visible consequence until the
             next item is scanned, and a key that appears to do nothing is one a
             cashier presses again. */
          toast.success(
            structureId === null
              ? 'Back to normal prices.'
              : `Now ringing up at ${picked?.name ?? 'the chosen price'}.`,
          )
        }}
      />

      {/* What something costs on every price type, without touching the sale.
          The counterpart to the dialog above: that one changes what the till
          rings at, this one changes nothing unless the cashier asks it to. */}
      <PriceCheckModal
        open={checkingPrice}
        priceStructureId={priceStructureId}
        terminalId={terminal?.id ?? null}
        onClose={() => setCheckingPrice(false)}
        onAdd={(productId, structureId) => {
          /*
           * Rung at the price type that was QUOTED, not the one the till is on.
           *
           * Re-read rather than taken from the dialog's own figure: `add()` wants
           * a whole TillProduct — its VAT rate, its discount ceiling, whether it
           * is a scale item — and the price is only one field of it. Fetching it
           * on the chosen structure gets all of them consistent with each other,
           * where patching a price onto a product read on a different structure
           * would leave a line whose price and shelf price disagree, which is
           * exactly the false "Price changed" this session set out to fix.
           *
           * Deliberately does NOT switch the till: one item quoted on trade is
           * one line, not a change of mode. See PriceTypeModal.
           *
           * By ID, not through `scanAction` — that resolves a BARCODE or a CODE,
           * and an id is neither. See productForTillAction.
           */
          startTransition(async () => {
            const found = await productForTillAction(
              productId,
              structureId,
              terminal?.id ?? null,
            ).catch(() => null)
            if (!found) {
              toast.error('That product could not be read. Try scanning it.')
              return
            }
            add(found)
          })
        }}
      />

      {/* Starting or ending a shift. The PIN says who — not the till session,
          because the person clocking on is usually not the one signed in. */}
      <ClockModal
        open={showingClock}
        terminalId={terminal?.id ?? null}
        onClose={() => setShowingClock(false)}
      />

      {/* Web orders waiting to be collected. Tapping one makes it the basket, so
          anything else picked up in the shop goes on the same invoice. */}
      <OnlineOrdersModal
        open={showingOrders}
        busy={pending}
        onClose={() => setShowingOrders(false)}
        onCollect={collectOrder}
      />

      {/* Past sales, to print one again. Opens on the till rather than sending the
          cashier to the invoicing list in the back office. */}
      <ReprintModal
        open={showingReprints}
        onClose={() => setShowingReprints(false)}
        onPrint={(sale) => {
          /*
           * Through the print ROUTE rather than the bridge, and that is deliberate.
           *
           * The bridge path prints from a snapshot built out of the live basket —
           * `slipRef` — and a past sale has no such snapshot on this machine; it may
           * have been rung up on the other till, or yesterday. The route loads the
           * document server-side, renders the same slip component, and calls
           * recordPrint so the copy number moves. Rebuilding a snapshot here would
           * be a second renderer for a document that already has one, and the two
           * would disagree the first time a slip's layout changed.
           *
           * Which paper — slip or A4 — is openSalePaper's call, so a reprint
           * matches what the counter handed over the first time.
           */
          openSalePaper(sale.id)
          setShowingReprints(false)
        }}
      />

      {/* The pro-forma bill for the open tab. On the till, for the same reason
          the reprint list is: asking for a bill must not send a waiter to the
          back office with a basket still on the screen behind them. */}
      <BillModal
        open={billOpen}
        bill={bill}
        loading={billLoading}
        printing={billPrinting}
        onClose={() => setBillOpen(false)}
        onPrint={printBillPaper}
      />

      {/* Money against an account, with no sale involved. Any customer, not the
          one attached to the basket — see the modal's own header. */}
      <AccountPaymentModal
        open={takingPayment}
        /* The ONLINE-filtered list. Account and loyalty are already stripped from
           it when the line is down, and this dialog is online-only anyway. */
        tenders={availableTenders}
        terminalId={terminal?.id ?? null}
        onClose={() => setTakingPayment(false)}
      />

      {/* Money held against THIS basket, unlike the dialog above. The sale stays
          open and posts later; the deposit becomes a tender when it does. */}
      <DepositModal
        open={takingDeposit}
        documentId={state.documentId}
        /* A basket on the till is always a draft — it becomes 'saved' only when
           parked, and a parked basket is not on screen. The server re-checks the
           real status either way; this is what the dialog shows. */
        status="draft"
        totalIncl={totals.doc.totalIncl}
        heldTotal={depositHeld}
        hasCustomer={state.customer !== null}
        minPct={depositMinPct}
        allowWalkin={depositAllowWalkin}
        tenders={availableTenders}
        terminalId={terminal?.id ?? null}
        online={till.online}
        onClose={() => setTakingDeposit(false)}
        onTaken={(held) => setDepositHeld(held)}
      />

      {/* A return WITH the slip: find the invoice, pick what is coming back,
          refund now or hold the credit for an exchange. */}
      <ReceiptReturnModal
        open={receiptReturn}
        online={till.online}
        reasons={returnReasons}
        tenders={tenders}
        busy={pending}
        onClose={() => setReceiptReturn(false)}
        onRefund={(pick, refundTenderTypeId) => runReceiptedRefund(pick, refundTenderTypeId)}
        onExchange={(pick) => {
          setExchangeCredit(pick)
          setReceiptReturn(false)
          toast.info(
            `${formatMoney(pick.total)} credit held from ${pick.invoiceNumber} — ring up the replacement, then Pay.`,
          )
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
        online={till.online}
        appliedCode={appliedCode}
        codeBusy={codeBusy}
        onCode={applyCode}
        onClearCode={() => setAppliedCode(null)}
        onApply={(discount) => {
          setAppliedCode(null) // the manual discount takes the slot back
          setDocDiscount(discount)
        }}
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

      {giftSelling && (
        <GiftCardModal
          product={giftSelling}
          onCancel={() => setGiftSelling(null)}
          onConfirm={(card) => {
            const product = giftSelling
            setGiftSelling(null)
            // giftCardCode + scannedPrice ride back through add() the way a
            // confirmed weight does: the guard passes, the amount becomes the
            // line's price, and the line never merges with another card.
            add(
              { ...product, giftCardCode: card.code, scannedPrice: card.amount },
              1,
            )
            toast.info(`Card ${card.display} on the slip — it activates when the sale completes.`)
          }}
        />
      )}

      {serialling && (
        <SerialModal
          product={serialling}
          units={serialOptions}
          loading={serialsLoading}
          onCancel={() => setSerialling(null)}
          onConfirm={(unit) => {
            const product = serialling
            setSerialling(null)
            // The unit rides back through add() the way a confirmed weight
            // does: the guard passes, the serial lands on the line, and that
            // line will not merge with another of the same product.
            add({ ...product, pickedSerialId: unit.id, pickedSerial: unit.serial }, 1)
          }}
        />
      )}

      {lotting && (
        <LotModal
          product={lotting.product}
          returning={lotting.returning}
          lots={lotOptions}
          loading={lotsLoading}
          offline={!till.online}
          strict={lotCapture.strict}
          onCancel={() => setLotting(null)}
          onConfirm={(batchNo) => {
            const { product, qty } = lotting
            setLotting(null)
            // scannedBatchNo rides back through add() the way a confirmed
            // weight does: the guard passes, the lot lands on the line, and
            // this line will not merge with another of the same product.
            add({ ...product, scannedBatchNo: batchNo }, qty)
          }}
        />
      )}

      {giftBalanceOpen && <GiftCardBalanceModal onClose={() => setGiftBalanceOpen(false)} />}

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
        open={receipt !== null}
        documentNumber={receipt?.number ?? ''}
        change={receipt?.change ?? 0}
        tip={receipt?.tip}
        posted={(receipt?.documentId ?? 0) > 0}
        onClose={() => setReceipt(null)}
        canPrint={
          (receipt?.documentId ?? 0) > 0 ||
          /* A basket snapshot only becomes paper on a THERMAL till. The trade
             counter's paper is the stored A4 document, so an unposted offline
             sale has nothing for it to print yet. */
          (!invoicing && slipRef.current !== null && hasBridgeSlipPrinter())
        }
        /* What the paper IS, per till, is openSalePaper's decision — see there.
           The bridge stays here because it is a thermal shortcut around that
           route rather than a third kind of paper: it is an ESC/POS path, and
           there is no such thing as an A4 page rendered through it, so a trade
           counter never takes it. Retail and hospitality keep exactly what they
           had — bridge first for silent thermal paper with no tab, falling back
           to the slip route, which is also the only path for a bridgeless
           machine. */
        onPrint={() => {
          const snapshot = slipRef.current
          if (!invoicing && snapshot && hasBridgeSlipPrinter()) {
            void printSlipViaBridge(snapshot).then((result) => {
              if (result.ok) {
                if (receipt && receipt.documentId > 0) {
                  void recordPrintAction(receipt.documentId).catch(() => {})
                }
                toast.success('Slip sent to the printer.')
              } else {
                toast.error(result.error)
                if (receipt && receipt.documentId > 0) {
                  openSalePaper(receipt.documentId)
                }
              }
            })
            return
          }
          if (receipt && receipt.documentId > 0) {
            openSalePaper(receipt.documentId)
          }
        }}
        /* A present, and therefore a till-slip idea: it is the 80mm slip with
           the prices struck out, and there is no A4 counterpart. A trade
           counter invoicing an account customer is not wrapping a gift, so it
           is not offered one — see ReceiptModal's `onGiftReceipt`. */
        onGiftReceipt={
          invoicing
            ? undefined
            : () => {
                if (receipt) printPaper(`/sales/${receipt.documentId}/slip?gift=1`)
              }
        }
        /* The back-office document — still the void/credit surface. */
        onOpen={() => {
          if (receipt) window.open(`/sales/${receipt.documentId}`, '_blank')
        }}
        onEmail={till.online ? () => setEmailingReceipt(true) : undefined}
      />

      {/* Emailing the slip — the same engine the back office uses, gated for
          the till, and a settled sale's email carries no pay link. */}
      {receipt && receipt.documentId > 0 && (
        <EmailInvoiceDialog
          open={emailingReceipt}
          onClose={() => setEmailingReceipt(false)}
          documentId={receipt.documentId}
          documentNumber={receipt.number}
          defaultTo={receipt.email ?? ''}
          lastEmailedNote={null}
        />
      )}

      {/*
        ── THE SHOP'S OWN KEYS, ON THE FLOOR ─────────────────────────────────
        A dialog here, where the catalogue pane holds the same grid inline. The
        gate is not a three-column till: it is one card that fills the screen, and
        carving a permanent key rail out of it would cost tables on every service
        to serve the handful of moments somebody needs a key.

        So it opens over the floor and dismisses back to it — and the floor stays
        visible around it, which is what stops a waiter losing their place.

        The `tables` section, not `main`. Which keys belong here is a question a
        manager already answered in the designer, and `noTables` keeps the
        till-level ones (cash up, clock in) off it — pressing "Cash up" with six
        tables open is precisely the mistake that flag exists to prevent.

        Closes on press, before the key runs. Every key either opens a dialog of
        its own — which would otherwise stack on this one — or acts on the floor
        underneath; in both cases this dialog has said all it has to say, and the
        one exception that says something back does it through a toast, which
        paints above either way.
      */}
      <Modal
        open={showingTableKeys}
        onClose={() => setShowingTableKeys(false)}
        title="Quick keys"
        /* Says what the bar IS rather than promising tiles: the dialog opens on
           every hospitality till, including one whose tables bar is still empty. */
        description="The keys for the floor — tap one to run it."
        size="lg"
      >
        <QuickKeyPanel
          keys={keysToShow}
          section="tables"
          /* The dialog's own title already says "Quick keys" — see showEyebrow. */
          showEyebrow={false}
          /* The panel's default message names the catalogue pane's remedy ("pick a
             department on the left"), which is not on screen here. This one names the
             bar that is actually empty and who fills it — the floor's keys are set up
             on their own tab, and a waiter sent to the main bar's list would be told
             to look at keys that are not the ones missing. */
          emptyState={
            <EmptyState
              icon={<Icons.Sparkles size={28} />}
              title="No keys on the floor yet"
              hint="A manager sets these up in Setup → Quick keys, under “Open tables” — the keys for a bill in progress, like printing it or sending it to the kitchen."
            />
          }
          productNames={keyProductNames}
          departmentNames={keyDepartmentNames}
          isEnabled={(key) => quickKeyEnabled(key, quickKeyContext)}
          isActive={quickKeyActive}
          onPress={(key) => {
            /* Only ever a key that RUNS — a folder is opened in place by the panel
               itself and never reaches here, which is what keeps a drill-down from
               dismissing the dialog the waiter just opened. */
            setShowingTableKeys(false)
            runQuickKey(key, quickKeyContext)
          }}
        />
      </Modal>

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
