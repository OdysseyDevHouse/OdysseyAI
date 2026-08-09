'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useToast, ConfirmModal } from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { useOfflineShell } from '@/lib/posOffline/useOfflineShell'
import { useOfflineTill } from '@/lib/posOffline/useOfflineTill'
import { finaliseOffline, currentShiftId } from '@/lib/posOffline/finaliseOffline'
import { findByCode, searchOffline, browseOffline } from '@/lib/posOffline/catalog'
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
import { SavedSalesModal } from './SavedSalesModal'
import { LineEditModal } from './LineEditModal'
import { ReceiptModal } from './ReceiptModal'
import { VoidModal } from './VoidModal'
import { useSaleState } from './useSaleState'
import { specialsFor, totalsFor, salePayloadLines } from './saleSelectors'
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
  function park() {
    startTransition(async () => {
      const saved = await saveSaleAction(state.documentId, {
        customerId: state.customer?.id ?? null,
        customerName: state.customer?.name || state.customerName.trim() || 'Walk-in',
        customerVatNo: state.customer?.vatNumber ?? null,
        customerPhone: state.customer?.phone ?? null,
        terminalId: terminal?.id ?? null,
        terminalCode: terminal?.code ?? null,
        priceStructureId,
        lines: salePayloadLines(state.lines, lineSpecials),
      })
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      const parked = await saveForLaterAction(saved.documentId)
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
        onExit={() => router.push('/dashboard')}
      />

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
        />
      </div>

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

      <SavedSalesModal
        open={showingSaved}
        /* Narrowed to this till when the machine has claimed one — a cashier
           looking for the basket they parked should not read past every other
           till's. An unclaimed machine has no basis to narrow, so it sees all. */
        terminalId={terminal?.id ?? null}
        busy={pending}
        onClose={() => setShowingSaved(false)}
        onRecall={recall}
        onCount={setSavedTally}
        onDiscard={(documentId) => {
          startTransition(async () => {
            const result = await discardSaleAction(documentId)
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
