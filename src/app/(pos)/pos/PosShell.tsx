'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useToast, ConfirmModal } from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { useOfflineShell } from '@/lib/posOffline/useOfflineShell'
import { useOfflineTill } from '@/lib/posOffline/useOfflineTill'
import { finaliseOffline, currentShiftId } from '@/lib/posOffline/finaliseOffline'
import {
  findByCode,
  searchOffline,
  browseOffline,
  storedQuickKeys,
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
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { Terminal } from '@/lib/site/terminals'
import type { BasketLine } from '@/lib/basket'
import {
  searchProductsAction,
  browseProductsAction,
  scanAction,
  finaliseSaleAction,
  saveSaleAction,
  saveForLaterAction,
  discardSaleAction,
  voidSaleAction,
} from '@/app/(app)/sales/actions'
import { recallSaleForTillAction } from './actions'
import { TillStatusBar } from './TillStatusBar'
import { SalePane } from './SalePane'
import { DeptRail } from './DeptRail'
import { CatalogPane } from './CatalogPane'
import { TenderPad } from './TenderPad'
import { CustomerModal } from './CustomerModal'
import { SavedSalesModal, type SavedEntry } from './SavedSalesModal'
import { OutboxModal } from './OutboxModal'
import { LineEditModal } from './LineEditModal'
import { ReceiptModal } from './ReceiptModal'
import { VoidModal } from './VoidModal'
import { useSaleState } from './useSaleState'
import { specialsFor, totalsFor, salePayloadLines } from './saleSelectors'
import { TableGate } from './TableGate'
import { listTablesAction, openTableAction, updateTableBillAction, askForBillAction, tablePaidAction } from './tableActions'
import type { PosTable } from '@/lib/site/posTables'
import { QuickKeyPanel } from './QuickKeyPanel'
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
  priceStructureId,
  tenders,
  cashRounding,
  canOverrideDiscount,
  canOverridePrice,
  canVoid,
  savedCount,
  specials,
  quickKeys,
  quickKeyProductNames,
  quickKeyDepartmentNames,
  hospitality,
  initialTables,
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
  cashRounding: number
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /** Whether the OPERATOR may void. Re-checked by voidSaleAction regardless. */
  canVoid: boolean
  /* Not read yet — saved-sales recall is still to come, and this is the count for
     its button's badge. Typed now so the server page's contract is settled. */
  savedCount: number
  specials: Special[]
  /** The shop's own till buttons. Shipped with the page so they survive the line dropping. */
  quickKeys: QuickKeyRow[]
  quickKeyProductNames: Record<number, string>
  quickKeyDepartmentNames: Record<number, string>
  /** Read in THREE places only — see the docblock above. */
  hospitality: boolean
  /** The floor. Empty in retail, where the gate never mounts. */
  initialTables: PosTable[]
}) {
  const [state, dispatch] = useSaleState()
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

  /* ── Specials, re-checked as the clock moves ───────────────────────────
     A basket can sit open while a window opens or closes, so this ticks as well
     as recomputing on every change. A slip that kept a price the shop stopped
     offering ten minutes ago is a slip the till and the shelf edge disagree
     about. */
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (specials.length === 0) return
    const timer = setInterval(() => setClock(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [specials.length])

  const lineSpecials = useMemo(
    () => specialsFor(state.lines, specials, new Date(clock)),
    [state.lines, specials, clock],
  )
  const totals = useMemo(() => totalsFor(state.lines, lineSpecials), [state.lines, lineSpecials])

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
    dispatch({ type: 'ADD', product, qty })
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
  ) {
    const tendered = paid.reduce((sum, p) => sum + p.amount, 0)
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
      lines: salePayloadLines(state.lines, lineSpecials),
      tenders: paid.map((p) => ({
        tenderTypeId: p.tenderTypeId,
        tenderCode: tenders.find((t) => t.id === p.tenderTypeId)?.code ?? '',
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      totalIncl: totals.doc.totalIncl,
      tenderedTotal: tendered,
      change: Math.max(0, tendered - totals.doc.totalIncl),
    })

    if (!result.ok) {
      toast.error(result.error)
      return
    }

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

  function finalise(paid: { tenderTypeId: number; amount: number; reference?: string | null }[]) {
    /* Known to be offline: go straight to the local path rather than spending four
       seconds on a doomed request with a customer waiting. */
    if (!till.online) {
      startTransition(() => finaliseLocally(paid))
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
            lines: salePayloadLines(state.lines, lineSpecials),
          },
          paid,
        )
      } catch {
        await finaliseLocally(paid)
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
        lines: salePayloadLines(state.lines, lineSpecials),
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

  function park() {
    if (!till.online) {
      startTransition(parkLocally)
      return
    }
    startTransition(async () => {
      /* Same fallback as finalise: a transport failure mid-park must not leave the
         cashier with a basket they think is saved and is not. A REFUSAL still stands
         — that is a real answer about this basket. */
      let saved: Awaited<ReturnType<typeof saveSaleAction>>
      try {
        saved = await saveSaleAction(state.documentId, {
          customerId: state.customer?.id ?? null,
          customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
          customerVatNo: state.customer?.vatNumber ?? null,
          customerPhone: state.customer?.phone ?? null,
          terminalId: terminal?.id ?? null,
          terminalCode: terminal?.code ?? null,
          priceStructureId,
          lines: salePayloadLines(state.lines, lineSpecials),
        })
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
      toast.success('Sale saved.')
      dispatch({ type: 'CLEAR' })
      // Counted optimistically rather than waiting for the server: the badge is
      // a hint, and the modal corrects it from the real query the moment it opens.
      setSavedTally((n) => n + 1)
      router.refresh()
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
  function voidSale(reason: string) {
    if (!receipt) return
    startTransition(async () => {
      const result = await voidSaleAction(receipt.documentId, reason)
      if (!result.ok) {
        // Left open with the reason still typed: the likely refusals are a locked
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

  /* ── The floor ──────────────────────────────────────────────────────────
     Only in hospitality. In retail `tables` is empty, the gate never mounts, and this
     costs one unused state slot rather than a branch through the rest of the file. */
  const [tables, setTables] = useState<PosTable[]>(initialTables)
  /** The table this basket belongs to, or null for a walk-in. */
  const [table, setTable] = useState<PosTable | null>(null)
  /** True while the waiter is choosing — the gate stands in front of the till. */
  const [choosingTable, setChoosingTable] = useState(hospitality)

  /* Re-read after anything that could have changed the floor, and on a slow tick so a
     waiter sees another waiter's table go from open to bill-asked without reloading. A
     restaurant floor is a SHARED screen; a retail till is not, which is why nothing
     equivalent polls in retail. */
  useEffect(() => {
    if (!hospitality) return
    const refresh = () => {
      void listTablesAction()
        .then((r) => {
          if (r.ok) setTables(r.tables)
        })
        .catch(() => {})
    }
    const timer = setInterval(refresh, 20_000)
    return () => clearInterval(timer)
  }, [hospitality])

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
  const tableLines = salePayloadLines(state.lines, lineSpecials)

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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.lines, state.selectedKey, till.online, results, browse.products, canOverrideDiscount, canOverridePrice, canVoid],
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
    <>
      <TillStatusBar
        siteName={siteName}
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
        itemCount={state.lines.length}
        onShowOutbox={() => setShowingOutbox(true)}
        /* The table, when there is one. A waiter needs to know which bill they are
           adding to before they add to it — and the header is the one place on this
           screen that is never covered by a dialog. */
        tableLabel={table ? table.code : hospitality ? 'Walk-in' : null}
        onChangeTable={hospitality ? () => setChoosingTable(true) : undefined}
        onExit={() => router.push('/dashboard')}
      />

      {/*
        ── HOSPITALITY READ 1 OF 3: the gate stands in FRONT of the till ──────
        Instead of the three columns, not beside them. A waiter picks the table before
        there is a basket to put anything in, so nothing below this needs to know
        whether one was picked.
      */}
      {choosingTable ? (
        <TableGate
          tables={tables}
          busy={pending}
          onWalkIn={() => {
            setTable(null)
            setChoosingTable(false)
            dispatch({ type: 'CLEAR' })
          }}
          onPickTable={resumeTable}
        />
      ) : (
      <div className="flex min-h-0 flex-1">
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
          onClear={() => setConfirmClear(true)}
          onPay={() => setTendering(true)}
          onPark={park}
          onShowSaved={() => setShowingSaved(true)}
          savedCount={savedTally}
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

      <TenderPad
        open={tendering}
        onClose={() => setTendering(false)}
        tenders={availableTenders}
        totalIncl={totals.doc.totalIncl}
        cashRounding={cashRounding}
        customer={state.customer}
        pending={pending}
        onFinalise={finalise}
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
      />

      <ReceiptModal
        open={receipt !== null && !voiding}
        documentNumber={receipt?.number ?? ''}
        change={receipt?.change ?? 0}
        canVoid={canVoid}
        posted={(receipt?.documentId ?? 0) > 0}
        onVoid={() => setVoiding(true)}
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
        busy={pending}
        onClose={() => setVoiding(false)}
        onVoid={voidSale}
      />
    </>
  )
}
