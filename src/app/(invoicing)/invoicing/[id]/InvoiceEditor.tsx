'use client'

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  PageBody,
  PageHeader,
  PickerResults,
  type PickableReason,
  ReasonPicker,
  Select,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  Textarea,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { deviceId } from '@/lib/deviceId'
import { documentTotals, lineTotals } from '@/lib/documentMath'
import {
  computeSpecials,
  effectiveDiscountPct,
  type Special,
  type RewardProduct,
} from '@/lib/specialsEngine'
import type { SalesDocument } from '@/lib/site/salesDocuments'
import type { PriceStructure, SalesRep } from '@/lib/site/lookups'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import { stockNote } from '@/lib/tillProductNotes'
import type { TillProduct } from '@/lib/site/tillSearch'
import {
  scanAction,
  searchProductsAction,
  browseProductsAction,
  listProductDepartmentsAction,
  voidSaleAction,
  creditWholeSaleAction,
  recordPrintAction,
} from '@/app/(app)/sales/actions'
import { EmailInvoiceDialog } from '@/app/(app)/sales/EmailInvoiceDialog'
import {
  finaliseInvoiceAction,
  getInvoiceCustomerAction,
  saleRecordAction,
  saveInvoiceAction,
  type InvoicePayload,
} from '../actions'
import { SaleRecord } from '@/app/(app)/sales/[id]/SaleRecord'
import type { SaleRecordSnapshot } from '@/lib/site/saleRecord'
import TenderPad from './TenderPad'
import { issueQuoteAction } from '@/app/(invoicing)/invoicing/quotes/actions'
import CustomerBar from './CustomerBar'

/**
 * The editable invoice grid.
 *
 * Every figure a user can change lives in component state and is recomputed
 * locally through documentMath, so the totals panel tracks typing without a
 * round trip. The server recomputes all of it on save — this is a preview of
 * the answer, never the source of it.
 */

type EditorLine = {
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: string
  departmentId: number | null
  salesRepUserId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  /**
   * The special that PUT this line here — a product given away rather than
   * discounted. See the same field on BasketLine for why a reward has to be a
   * line rather than a percentage.
   *
   * It also marks the line as the ENGINE's rather than the typist's, which is
   * what lets the reconciliation below add and remove rewards without ever
   * touching a line somebody entered by hand.
   */
  rewardSpecialId?: number
}

let keySeq = 0
const nextKey = () => `line-${++keySeq}`

/*
 * Local until sales/status.ts exists. Never print the raw enum: a "draft" is
 * unfinished typing, a "saved" invoice is waiting to be finalised — the words
 * and tones have to keep those apart.
 */
const STATUS_LABELS: Record<SalesDocument['status'], string> = {
  draft: 'Draft',
  saved: 'Saved',
  issued: 'Issued',
  finalised: 'Finalised',
  cancelled: 'Cancelled',
}
const STATUS_TONE: Record<SalesDocument['status'], BadgeTone> = {
  draft: 'neutral',
  saved: 'warning',
  issued: 'brand',
  finalised: 'success',
  cancelled: 'neutral',
}

/**
 * How many products the picker loads at once.
 *
 * Enough that a shop of ordinary size sees its whole catalogue without
 * filtering, and bounded so a chain with fifty thousand lines does not ship all
 * of them to the browser. Past this the dialog says so rather than pretending
 * the list is complete.
 */
const PICKER_LIMIT = 500

/**
 * One cell of the document's header strip — a glyph beside a field.
 *
 * The left hairline belongs to the CELL rather than to the strip. Tailwind's
 * `divide-x` puts a border on every child but the first, which the strip's own
 * `gap` then holds away from anything, so the rules were drawn floating in the
 * gutter instead of between the columns.
 *
 * Dropped below `lg`, where the cells stack into a single column and a
 * left-hand border would be drawing an edge that is no longer there.
 *
 * Exported so the quote screen's "Valid until" can be shaped identically —
 * a cell that came from another file has to match its neighbours exactly, and
 * a second copy of these classes is how that quietly stops being true.
 *
 * ── WHY BOTH A MIN AND A MAX ──────────────────────────────────────────────
 *
 * `flex-1` from `min-w-56` lets the cells share the row and wrap in step
 * rather than each demanding a fixed width and shoving one sibling onto a line
 * of its own — which is what the fifth cell did on a quote at 1280px.
 *
 * `max-w-72` is the other half of that. A cell that DOES wrap ends up alone on
 * its row, where `flex-1` would stretch it edge to edge and print a date box
 * the width of the page. Bounded, a wrapped cell keeps the same size it had
 * beside its siblings.
 */
export const HEADER_CELL =
  'flex min-w-56 max-w-72 flex-1 items-start gap-3 lg:border-l lg:border-border lg:pl-5 lg:ml-5'

export default function InvoiceEditor({
  document,
  structures,
  reps,
  defaultRepUserId = null,
  tenders,
  cashRounding,
  customer: initialCustomer,
  editable,
  canOverrideDiscount,
  canOverridePrice,
  showCost,
  specials,
  extraStatus = null,
  voidReasons = [],
  returnReasons = [],
  canVoid = false,
  canCredit = false,
  depositHeld = 0,
  detailsSlot = null,
  hasSectionsBelow = false,
}: {
  document: SalesDocument
  structures: PriceStructure[]
  reps: SalesRep[]
  /**
   * Whoever is capturing, pre-selected on every new line. Null when they are
   * not a selectable rep, in which case lines start unattributed as before.
   */
  defaultRepUserId?: number | null
  tenders: TenderType[]
  cashRounding: number
  /** The attached account's credit position, or null for a once-off. */
  customer: TillCustomer | null
  editable: boolean
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /** The shop's live promotions. See the note on lineSpecials below. */
  specials: Special[]
  /** Whether this person may see cost and margin. */
  showCost: boolean
  /**
   * An extra badge for the header row, from the screen that owns the document.
   *
   * An order has TWO states and they answer different questions: `Draft` is
   * "has this been saved", which the editor knows, and `Open` is "has any of it
   * been delivered", which only the order screen does. Both belong on the same
   * line as the title — a status floating on its own above a heading reads as
   * something that fell off.
   *
   * Rendered first, so the fulfilment state leads and the document state sits
   * beside the buttons that change it.
   */
  extraStatus?: ReactNode
  /**
   * The site's reason lists, for the dialog shown once this invoice posts.
   *
   * Empty by default so the back-office editor — which has a document viewer
   * one click away — is unchanged by this.
   */
  voidReasons?: PickableReason[]
  returnReasons?: PickableReason[]
  /** Whether this ROLE may cancel / credit. Both re-checked by the actions. */
  canVoid?: boolean
  canCredit?: boolean
  /**
   * Money already held against this document, so the tender pad asks for the
   * balance rather than the whole total. Zero for a document with no deposit,
   * which is the overwhelming majority. See TenderPad's `depositHeld`.
   */
  depositHeld?: number
  /**
   * Extra fields for the details card, from the screen that owns the document.
   *
   * A quote's "Valid until" is one of the things you set while capturing the
   * header — same breath as the date and the customer's reference — so it
   * belongs in the same card as those, not in a panel below the lines. The
   * editor cannot own it (an invoice has no validity), so the quote screen
   * hands the field down and the editor just gives it the last cell.
   */
  detailsSlot?: ReactNode
  /**
   * Whether the owning screen renders more sections below this editor.
   *
   * The editor's PageBody normally ends the page and so carries `pb-10`. On
   * the invoice, quote and order screens it does not — a deposit panel, an
   * outcome panel and proof of delivery follow it — and that trailing 40px
   * doubled the seam under the grid. Set it where those sections exist; the
   * screen that sets it owns the real bottom padding instead.
   */
  hasSectionsBelow?: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  /*
   * This machine, so a saved invoice records the till it was captured on.
   *
   * Read after mount because `deviceId()` returns null during SSR by design —
   * it reads the desktop shell's machine id or localStorage, neither of which
   * exists on the server. The value is sent as-is and the SERVER decides which
   * terminal it belongs to; nothing here picks a till, and there is no control
   * for one. Null until the effect runs, which only matters for a save fired in
   * the first frame — and that save would have carried no till before this
   * existed either.
   */
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => setDevice(deviceId()), [])

  const [customerId, setCustomerId] = useState(document.customerId)
  const [customerName, setCustomerName] = useState(document.customerName ?? '')
  const [priceStructureId, setPriceStructureId] = useState(document.priceStructureId)
  const [reference, setReference] = useState(document.reference ?? '')
  const [documentDate, setDocumentDate] = useState(document.documentDate)
  const [notes, setNotes] = useState(document.notes ?? '')

  const [lines, setLines] = useState<EditorLine[]>(() =>
    document.lines.map((l) => ({
      key: nextKey(),
      productId: l.productId,
      productCode: l.productCode,
      description: l.description,
      productType: l.productType,
      departmentId: l.departmentId,
      /* A line that already names someone keeps them — reopening a draft must
         not quietly re-attribute a colleague's work to whoever opened it. The
         default only fills a gap, and only while the document can still be
         changed: a finalised invoice is a record, not a form. */
      salesRepUserId: l.salesRepUserId ?? (editable ? defaultRepUserId : null),
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      vatRatePct: l.vatRatePct,
      unitCostExcl: l.unitCostExcl,
    })),
  )

  const [entry, setEntry] = useState('')
  const entryRef = useRef<HTMLInputElement>(null)

  /*
   * The product search dialog.
   *
   * The entry box below the grid only resolves an exact code or barcode, which
   * is the right tool with the product in your hand and the wrong one when the
   * customer says "the blue one, 20 mil". This is how you look without knowing
   * the code.
   *
   * Kept out of `pending`: that transition disables the whole invoice while a
   * save is in flight, and a search that greys out the grid behind it would
   * make the dialog feel like it was committing something.
   */
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchDept, setSearchDept] = useState<number | null>(null)
  const [searchResults, setSearchResults] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDepts, setSearchDepts] = useState<{ id: number; name: string; depth: number }[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [tendering, setTendering] = useState(false)
  const [receipt, setReceipt] = useState<{
    documentId: number
    number: string
    change: number
  } | null>(null)

  /*
   * The posted invoice as a RECORD, for the dialog to show.
   *
   * Read back from the server rather than assembled from what is on screen: the
   * capture form holds what was typed, and what matters now is what was STORED
   * — the numbers the posting engine settled on, the tenders it wrote, the
   * document number it allocated. Null while it loads, which is the one beat
   * between the dialog opening and the record arriving.
   */
  const [record, setRecord] = useState<SaleRecordSnapshot | null>(null)

  /*
   * The finalised dialog's two destructive paths.
   *
   * Kept as a 'which face is showing' value rather than nested modals: a
   * <dialog> inside an open <dialog> is a stacking problem, and the counter is
   * answering one question at a time — print it, or cancel it, or credit it.
   * `null` is the ordinary face with the four buttons.
   */
  const [finalisedFace, setFinalisedFace] = useState<'void' | 'credit' | null>(null)
  const [emailingPosted, setEmailingPosted] = useState(false)
  const [postedReasonId, setPostedReasonId] = useState<number | null>(null)
  const [postedNote, setPostedNote] = useState("")

  /**
   * Cancelling the invoice that was just posted, without leaving the counter.
   *
   * Same action the back-office viewer calls, so the same rules apply: it
   * re-resolves the operator, re-checks `sales.void`, and refuses anything that
   * is not same-day. A refusal is shown as a toast and the dialog stays open on
   * the reason face, because the counter still has a customer in front of them
   * and needs to know what happened.
   */
  function voidPosted() {
    if (!receipt || postedReasonId === null) return
    startTransition(async () => {
      const result = await voidSaleAction(receipt.documentId, {
        reasonId: postedReasonId,
        note: postedNote.trim() || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${receipt.number} cancelled. The stock has been returned.`)
      leaveFinalised()
    })
  }

  /** Crediting it in full — the after-today answer to the same mistake. */
  function creditPosted() {
    if (!receipt || postedReasonId === null) return
    startTransition(async () => {
      const result = await creditWholeSaleAction(receipt.documentId, {
        reasonId: postedReasonId,
        note: postedNote.trim() || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${receipt.number} credited in full.`)
      leaveFinalised()
    })
  }

  /** Closes the dialog and leaves the counter ready for the next customer. */
  function leaveFinalised() {
    setReceipt(null)
    setRecord(null)
    setFinalisedFace(null)
    setPostedReasonId(null)
    setPostedNote("")
    /* Back to the register rather than the back office: this window is where
       the next customer is served, and the list re-reads so the invoice just
       posted is on it. */
    router.push('/invoicing')
  }

  /*
   * The credit position of whoever is attached right now.
   *
   * Re-fetched when the customer changes rather than derived from the picker's
   * row, because the tender pad refuses the account tender on balance and limit
   * — and the balance moves while this invoice is being captured.
   */
  const [customer, setCustomer] = useState<TillCustomer | null>(initialCustomer)

  useEffect(() => {
    if (customerId === null) {
      setCustomer(null)
      return
    }
    if (customerId === customer?.id) return

    let cancelled = false
    getInvoiceCustomerAction(customerId).then((fresh) => {
      if (cancelled) return
      setCustomer(fresh)
      /*
       * The account's OWN structure (customer → group, resolved server-side)
       * takes over when one is set and the document may still change. The
       * dropdown stays as the manual override — this only moves the default
       * when a different account is attached. Lines already on the document
       * keep their prices: checkPricing re-reads the structure at save, so a
       * price that no longer matches is refused there with the reason, which
       * beats silently rewriting figures under the person's cursor.
       */
      if (fresh?.priceStructureId && editable && fresh.priceStructureId !== priceStructureId) {
        setPriceStructureId(fresh.priceStructureId)
        toast.info(`Pricing follows ${fresh.name}'s structure for new lines.`)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- priceStructureId
    // is read for the comparison only; reacting to it would loop the adopt.
  }, [customerId, customer?.id])

  /* ── Totals ──────────────────────────────────────────────────────────── */

  /*
   * ── What each line is entitled to ──────────────────────────────────────
   *
   * Recomputed when the lines change, and DELIBERATELY NOT on a timer — unlike
   * the till. A till is worked in seconds and a slip must match the shelf edge
   * right now; an invoice is edited over minutes, and re-pricing it under
   * someone's cursor while they type would be worse than a figure that is a
   * few minutes stale. It refreshes on the next edit or reload.
   */
  /**
   * The lines as the engine should see them.
   *
   * A reward the engine granted goes in at quantity zero: it keeps its slot so
   * the results stay index-aligned, but it must not count towards anything.
   * Feeding a granted line back in inflates the deal count, and since this
   * recomputes on every edit that inflation would compound.
   */
  const engineLines = useMemo(
    () =>
      lines.map((l) => ({
        productId: l.productId ?? -1,
        departmentId: l.departmentId ?? null,
        priceIncl: l.unitPriceIncl,
        // A credit line earns nothing — see the engine's note on refunds.
        qty: l.rewardSpecialId !== undefined ? 0 : Math.max(l.qty, 0),
      })),
    [lines],
  )

  const lineSpecials = useMemo(() => {
    if (specials.length === 0) return lines.map(() => undefined)
    return computeSpecials(engineLines, specials, new Date()).lineSpecials
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` only for
    // the empty-specials shortcut above; engineLines already tracks it.
  }, [engineLines, specials])

  /**
   * The products this invoice has EARNED, put on it.
   *
   * The same reconciliation the till does, and for the same reasons — see the
   * SYNC_REWARDS action and `withRewards`. An effect rather than part of the
   * memo above, because a reward CHANGES the lines and a render must not write
   * state. It settles in one pass: nothing earned and nothing granted returns
   * early, and an unchanged answer produces an identical array.
   */
  useEffect(() => {
    if (specials.length === 0) return
    const rewards = computeSpecials(engineLines, specials, new Date()).rewards
    if (rewards.length === 0 && !lines.some((l) => l.rewardSpecialId !== undefined)) return

    const described = new Map<number, RewardProduct>()
    for (const special of specials) {
      for (const product of special.rewardProducts ?? []) described.set(product.productId, product)
    }

    setLines((current) => {
      const own = current.filter((l) => l.rewardSpecialId === undefined)
      const existing = new Map(
        current
          .filter((l) => l.rewardSpecialId !== undefined)
          .map((l) => [`${l.rewardSpecialId}-${l.productId}`, l]),
      )

      const granted: EditorLine[] = []
      for (const reward of rewards) {
        if (reward.qty <= 0) continue
        const already = existing.get(`${reward.specialId}-${reward.productId}`)
        if (already) {
          granted.push(already.qty === reward.qty ? already : { ...already, qty: reward.qty })
          continue
        }
        const product = described.get(reward.productId)
        // A reward naming a product that cannot be described is not granted —
        // better a deal that quietly does not pay than a blank line.
        if (!product) continue
        granted.push({
          key: nextKey(),
          productId: product.productId,
          productCode: product.code,
          description: product.description,
          productType: product.productType,
          departmentId: product.departmentId,
          salesRepUserId: null,
          qty: reward.qty,
          // Free, not marked down: a discount is something a person chose to
          // give, while this is the promotion paying out as it was set up.
          unitPriceIncl: 0,
          discountPct: 0,
          vatRatePct: product.vatRatePct,
          // Costed even though free, so the giveaway shows against the margin.
          unitCostExcl: product.costExcl,
          rewardSpecialId: reward.specialId,
        })
      }

      /*
       * The SAME array back when nothing moved, so React bails out of the
       * re-render and this effect settles rather than looping.
       *
       * "Nothing moved" has to mean every granted line is the very object that
       * was already there, in the same order, with no line dropped — comparing
       * only the counts would loop forever the first time a reward's quantity
       * changed, since a new object with the same length looks identical.
       */
      const unchanged =
        own.length + granted.length === current.length &&
        granted.every((line, index) => current[own.length + index] === line)
      return unchanged ? current : [...own, ...granted]
    })
  }, [engineLines, specials, lines])

  const computed = useMemo(() => {
    const per = lines.map((l, i) =>
      lineTotals({
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        // The better of the special and any discount typed by hand. They never
        // compound — see effectiveDiscountPct.
        discountPct: effectiveDiscountPct(l.discountPct, lineSpecials[i]),
        vatRatePct: l.vatRatePct,
      }),
    )
    const totals = documentTotals(
      per.map((t, i) => ({ ...t, vatRatePct: lines[i].vatRatePct })),
    )

    // Cost is EXCLUSIVE, so margin must be measured against the exclusive
    // selling figure. Comparing cost to an inclusive total would report a
    // margin the VAT is paying for.
    const costTotal = round(
      lines.reduce((sum, l) => sum + l.unitCostExcl * l.qty, 0),
      2,
    )
    const gpValue = round(totals.subtotalExcl - costTotal, 2)
    const gpPct = totals.subtotalExcl === 0 ? 0 : round((gpValue / totals.subtotalExcl) * 100, 2)

    return { per, totals, costTotal, gpValue, gpPct }
  }, [lines])

  /* ── Line entry ──────────────────────────────────────────────────────── */

  /**
   * Puts a resolved product on the invoice.
   *
   * Separate from the lookup below because there are two ways to arrive here —
   * typing a code, and choosing from the search dialog — and only the first has
   * anything to resolve. The dialog already holds the product.
   */
  function appendLine(found: TillProduct) {
    setLines((current) => [
      ...current,
      {
        key: nextKey(),
        productId: found.id,
        productCode: found.code,
        description: found.description,
        productType: found.productType,
        departmentId: found.departmentId,
        // Inherits the line above, which is nearly always right when one
        // assistant is capturing a whole order; otherwise whoever is signed in.
        // Inheritance wins so that deliberately re-attributing one line carries
        // down the rest of the order rather than snapping back.
        salesRepUserId: current[current.length - 1]?.salesRepUserId ?? defaultRepUserId,
        qty: 1,
        unitPriceIncl: found.priceIncl,
        /*
         * The account's standing discount is the DEFAULT, capped at the
         * product's own ceiling: checkPricing refuses a line above
         * max_discount_pct for anyone without the override right, and a
         * back-office setting must never brick the capture. Still editable —
         * a default, not a mandate.
         */
        discountPct: customer
          ? Math.min(customer.discountPct, found.maxDiscountPct > 0 ? found.maxDiscountPct : 100)
          : 0,
        vatRatePct: found.vatRatePct,
        unitCostExcl: found.costExcl,
      },
    ])
  }

  /*
   * Loads the catalogue as the term and department settle.
   *
   * Runs with an EMPTY term too — the dialog opens showing the first 500
   * products, because a picker that shows nothing until you type hides the
   * catalogue from anyone who does not already know what is in it. Typing and
   * choosing a department both narrow the same list.
   *
   * Debounced because this would otherwise hit the database on every keystroke,
   * and the sequence guard matters more than the delay: a short term matches far
   * more rows than a long one, so a slow early request can land after a fast
   * later one and replace the right answer with a stale list. Only the newest
   * request is allowed to write.
   */
  useEffect(() => {
    if (!searchOpen) return

    let live = true
    setSearching(true)
    const timer = setTimeout(
      async () => {
        try {
          const found = await browseProductsAction({
            term: searchTerm.trim(),
            departmentId: searchDept,
            priceStructureId,
            limit: PICKER_LIMIT,
          })
          if (live) setSearchResults(found)
        } catch {
          if (live) setSearchResults([])
        } finally {
          if (live) setSearching(false)
        }
      },
      // No debounce on the very first load — the dialog would otherwise open
      // empty for a quarter second every time.
      searchTerm.trim() || searchDept !== null ? 250 : 0,
    )

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [searchOpen, searchTerm, searchDept, priceStructureId])

  /* The department list is the same for the life of the screen, so it is
     fetched once on first open rather than with every query. */
  useEffect(() => {
    if (!searchOpen || searchDepts.length > 0) return
    let live = true
    listProductDepartmentsAction()
      .then((d) => { if (live) setSearchDepts(d) })
      .catch(() => { if (live) setSearchDepts([]) })
    return () => { live = false }
  }, [searchOpen, searchDepts.length])

  function openSearch() {
    setSearchTerm('')
    setSearchDept(null)
    setSearchResults([])
    setSearchOpen(true)
  }

  /**
   * Adds the chosen product and stays open.
   *
   * Capturing an order is nearly always several products in a row, so closing
   * after each one would mean re-opening and re-typing.
   */
  function pickFromSearch(product: TillProduct) {
    appendLine(product)
    toast.success(`Added ${product.description}.`)
    // The term clears so the next one can be typed straight away; the
    // DEPARTMENT stays, because someone working through one aisle is usually
    // adding several things from it. Results are left alone — clearing them
    // would blank the list for the moment it takes to re-query.
    setSearchTerm('')
    searchInputRef.current?.focus()
  }

  function addProduct(code: string) {
    const term = code.trim()
    if (!term) return

    startTransition(async () => {
      const scanned = await scanAction(term, priceStructureId)
      const found = scanned ?? (await searchProductsAction(term, priceStructureId))[0] ?? null

      if (!found) {
        toast.error(`Nothing found for "${term}".`)
        return
      }

      appendLine(found)
      setEntry('')
      entryRef.current?.focus()
    })
  }

  function patch(key: string, changes: Partial<EditorLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)))
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key))
  }

  /* ── Saving ──────────────────────────────────────────────────────────── */

  function payload(): InvoicePayload {
    return {
      documentId: document.id,
      deviceId: device,
      customerId,
      customerName: customerName.trim() || null,
      priceStructureId,
      documentDate,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((l, i) => ({
        productId: l.productId,
        productCode: l.productCode,
        description: l.description,
        productType: l.productType,
        departmentId: l.departmentId,
        salesRepUserId: l.salesRepUserId,
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        // What the screen showed, so the saved invoice matches it.
        discountPct: effectiveDiscountPct(l.discountPct, lineSpecials[i]),
        /* A granted line records the special that PUT it here. It carries no
           discount of its own — it is free rather than reduced — so without
           this the one line the promotion actually gave away would be the one
           line with no trace of which promotion gave it. */
        specialId: l.rewardSpecialId ?? lineSpecials[i]?.specialId ?? null,
        vatRatePct: l.vatRatePct,
        unitCostExcl: l.unitCostExcl,
      })),
    }
  }

  function save() {
    startTransition(async () => {
      const result = await saveInvoiceAction(payload())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Invoice saved.')
      router.refresh()
    })
  }

  /**
   * Saves the document, then opens its printable copy in a new tab.
   *
   * ── SAVING FIRST IS THE WHOLE POINT ───────────────────────────────────
   *
   * The print route renders from the STORED document, because paper that
   * disagrees with the database is worse than no paper. Every figure in this
   * editor lives in component state until a save, so printing a pro forma with
   * an unsaved line on screen would hand a customer a document missing the
   * item they just asked for. Same reasoning as takePayment below.
   *
   * A FINALISED document has nothing to save — it is immutable, and
   * saveInvoiceAction would refuse — so that case opens the tab directly.
   *
   * The tab is opened BEFORE the await when there is a save to do: a popup
   * blocker allows `window.open` only inside the gesture that asked for it,
   * and opening it after an awaited action is what gets a print silently
   * swallowed. It is pointed at the route once the save succeeds, and closed
   * again if the save fails, so a refusal never leaves a blank tab behind.
   */
  function printDocument() {
    const href = `/sales/${document.id}/document`

    if (!editable) {
      window.open(href, '_blank')
      return
    }

    const tab = window.open('', '_blank')
    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        tab?.close()
        toast.error(saved.error)
        return
      }
      if (tab) tab.location.href = href
      else window.open(href, '_blank')
      router.refresh()
    })
  }

  /**
   * Saves the draft, then asks for payment.
   *
   * Saving first is not a nicety: the tender pad settles against a total, and
   * the total that matters is the one the server will recompute from the stored
   * lines. Opening the pad on an unsaved edit would take payment against a
   * figure the posting engine is about to disagree with.
   */
  function takePayment() {
    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      setTendering(true)
    })
  }

  function finalise(taken: { tenderTypeId: number; amount: number; reference?: string | null }[]) {
    startTransition(async () => {
      const result = await finaliseInvoiceAction(payload(), taken)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTendering(false)
      setReceipt({
        documentId: result.documentId,
        number: result.documentNumber,
        change: result.change,
      })
      /* Opened first, filled a moment later: the dialog must appear the instant
         the sale posts — the counter is waiting on it — so the record is read
         behind it rather than held up in front of it. */
      setRecord(null)
      void saleRecordAction(result.documentId).then(setRecord)
    })
  }

  /**
   * Issues a quote to the customer.
   *
   * Saves and stamps it issued — no tender pad, no stock, no ledger, because a
   * quote is an offer rather than a sale. It becomes a real document only when
   * the customer accepts it and it converts to an invoice.
   */
  function issueQuote() {
    startTransition(async () => {
      const saved = await saveInvoiceAction(payload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      const issued = await issueQuoteAction(document.id)
      if (!issued.ok) {
        toast.error(issued.error)
        return
      }
      toast.success(issued.message)
      router.refresh()
    })
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  /*
   * ── WHAT THIS DOCUMENT IS CALLED, AND HOW IT ENDS ─────────────────────
   *
   * Three kinds now share this editor, and only one of them takes money. A
   * quote is an offer, an order is a promise, an invoice is the sale — same
   * lines, same prices, same grid, three different last steps:
   *
   *   quote    → Issue quote      (sent to the customer)
   *   order    → Save order       (delivered later, from its own screen)
   *   invoice  → Finalise         (opens the tender pad)
   *
   * Written as a lookup rather than a chain of ternaries because there is now
   * a third, and a fourth would go the same way — DOC_TYPES already has
   * credit_sale in it.
   */
  const isQuote = document.docType === 'quote'
  const isOrder = document.docType === 'sales_order'
  const noun = isQuote ? 'Quote' : isOrder ? 'Order' : 'Invoice'
  const title = document.documentNumber ?? `${noun} #${document.id}`

  /*
   * ── STATE ON THE LEFT, ACTIONS ON THE RIGHT ───────────────────────────
   *
   * The two status badges used to sit in the same row as Save and Finalise,
   * which put what this document IS inside the group of things you can DO to
   * it — and left the buttons reading as a four-item row where only two were
   * pressable. PageHeader has a `status` slot between the title and subtitle
   * built for precisely this, so the state now sits against the name it
   * describes and the right-hand side is buttons only.
   *
   * The owning screen's own state first — see `extraStatus`. On an order that
   * is "Open" or "Part delivered", which is a different question from the
   * "Draft" beside it.
   */
  const status = (
    <>
      {extraStatus}
      <Badge tone={STATUS_TONE[document.status]}>{STATUS_LABELS[document.status]}</Badge>
    </>
  )

  /*
   * What the Print button will actually put on paper.
   *
   * Named rather than left as a bare "Print" because the four documents this
   * editor produces are not interchangeable: somebody handing a customer a
   * PRO FORMA needs to know that is what came out, and the difference between
   * that and a tax invoice is the whole reason the route decides the heading
   * from status. The button says the same word the paper does.
   *
   * Kept in step with printKindFor in lib/site/salesDocumentKind — that function is
   * the authority, this only labels the button that opens it.
   */
  const printLabel = isQuote
    ? 'Print quote'
    : isOrder
      ? 'Print order'
      : document.status === 'finalised'
        ? 'Print invoice'
        : 'Print pro forma'

  const actions = (
    <>
      {/* Outside the `editable` gate: a finalised invoice is exactly the one
          you most often need on paper, and it was the only state with no way
          to print an A4 copy at all. Nothing to print on an empty document,
          which is why the line count still gates it. */}
      <Button
        variant="ghost"
        onClick={printDocument}
        disabled={pending || lines.length === 0}
      >
        <Icons.Printer size={16} />
        {printLabel}
      </Button>

      {editable && (
        <>
          <Button variant="secondary" onClick={save} disabled={pending || lines.length === 0}>
            <Icons.Save size={16} />
            Save (draft)
          </Button>
          {/* A quote takes no payment — it is an offer, not a sale — and an
              order takes none either, because the goods have not gone anywhere
              yet. Only an invoice opens the tender pad. Everything above this
              point is identical for all three, which is the whole reason one
              editor serves them. */}
          {isQuote ? (
            <Button onClick={issueQuote} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Issue quote
            </Button>
          ) : isOrder ? (
            <Button onClick={save} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Save order
            </Button>
          ) : (
            <Button onClick={takePayment} disabled={pending || lines.length === 0}>
              <Icons.Check size={16} />
              Finalise
            </Button>
          )}
        </>
      )}
    </>
  )

  return (
    <>
      <PageHeader
        title={title}
        status={status}
        subtitle={`${customerName || 'No customer'} · ${documentDate}`}
        /* Back to the register this document belongs to. It always said
           "invoicing", which sent somebody editing a quote to the wrong list. */
        backHref={isQuote ? '/invoicing/quotes' : isOrder ? '/invoicing/orders' : '/invoicing'}
        backLabel={isQuote ? 'Back to quotes' : isOrder ? 'Back to orders' : 'Back to invoicing'}
        action={actions}
      />

      {/*
        `flush` when the owning screen has more to put below the editor.

        PageBody ends in `pb-10` because it is normally the last thing on a
        page — but on the invoice, quote and order screens it is not: a deposit
        panel, an outcome panel and proof of delivery all follow. That trailing
        40px then landed on top of the next section's own spacing, making the
        seam under the grid three times the `gap-5` between every other card,
        which is what made the screen look like it came apart there.

        The screens that follow the editor supply their own `pb-10` at the true
        bottom of the page, so nothing ends flush against the window.
      */}
      <PageBody flush={hasSectionsBelow}>
        {/*
          ── WHO, AND ON WHAT TERMS — ONE BAND ────────────────────────────

          The customer and the document's terms (price type, their reference,
          the date, a quote's validity) answer one question between them, and
          they were being read as two: a customer card, then a details card,
          then the grid. Three separate boxes for what is really one header.

          So they share a strip, divided rather than boxed. Each terms cell
          draws its OWN left hairline (see CELL below) rather than the strip
          using `divide-x`: Tailwind's divide utility puts the border on every
          child but the first, which a `gap` then holds away from anything —
          the rules were there and invisible, floating in the gutter. A border
          that belongs to the cell sits against the cell.

          Chrome, so it is roomy: this is touched once per document, unlike
          the grid below it which is scanned line by line.
        */}
        <Card>
          {/* items-START. One cell can carry a hint under its field ("Blank
              means it does not expire") and the others cannot, so centring
              floated the taller cell's glyph and label above its neighbours'.
              Aligned at the top, every glyph and every label sits on one line
              and the hint hangs below where it belongs.

              data-brand-rule marks the card's left edge the way CardHeader
              does — see globals.css. This strip IS the card's header, it just
              has no heading text, so it was the one card on the screen without
              the rule down its edge while Products, Comment and Summary all
              had one. The attribute is what the CSS looks for, not the
              component, so saying it directly is the whole fix. */}
          <div data-brand-rule className="flex flex-wrap items-start gap-y-4 px-5 py-4">
            <CustomerBar
              customerId={customerId}
              customerName={customerName}
              editable={editable}
              onPick={(picked) => {
                setCustomerId(picked?.id ?? null)
                setCustomerName(picked?.name ?? '')
              }}
            />

            {/* Each term is its own cell and owns the hairline on its left, so
                the rule sits against the content rather than floating in a
                gap. Dropped below `lg`, where the cells stack and a left-hand
                border would be drawing a column that is no longer there. */}
            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Tag size={18} />
              </span>
              <Field label="Price type" className="min-w-0 flex-1">
                <Select
                  value={priceStructureId ?? ''}
                  disabled={!editable}
                  onChange={(e) =>
                    setPriceStructureId(e.target.value ? Number(e.target.value) : null)
                  }
                >
                  {structures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* The CUSTOMER's own reference — their purchase-order number, their job
                number, whatever they quote back at you. "Invoice order number"
                read oddly on a quote, and templating the noun in produced
                "Order order number" on an order. It is one thing whatever the
                document is, so it is named for what it IS. */}
            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Contact size={18} />
              </span>
              <Field label="Customer reference" className="min-w-0 flex-1">
                <Input
                  value={reference}
                  disabled={!editable}
                  maxLength={64}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
            </div>

            <div className={HEADER_CELL}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
                <Icons.Calendar size={18} />
              </span>
              <Field label={`${noun} date`} className="min-w-0 flex-1">
                <Input
                  type="date"
                  value={documentDate}
                  disabled={!editable}
                  onChange={(e) => setDocumentDate(e.target.value)}
                />
              </Field>
            </div>

            {/* A quote's "Valid until", passed down by the quote screen. It
                brings its own glyph so the cell matches its neighbours. */}
            {detailsSlot}
          </div>
        </Card>

        <Card>
          {/* The grid says what it is. It was the one unlabelled card on the
              screen — a bare "Add product" button floating above a table —
              while every other section carried a heading. */}
          <CardHeader
            icon={<Icons.ShoppingCart size={18} />}
            title="Products & line items"
            action={
              /* Not the primary — Finalise is. Opens the search dialog, because
                 the dashed entry box below already covers the case where the
                 code is known; this is for when it is not. */
              <Button variant="secondary" onClick={openSearch} disabled={!editable || pending}>
                <Icons.Plus size={16} />
                Add product
              </Button>
            }
          />

          <div className="overflow-x-auto">
            <table className={TABLE}>
              {/* Fixed widths so every box in a column is the same size and the
                  numbers line up down the grid. Product takes what is left. */}
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-24" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-12" />
              </colgroup>
              {/* No column headings over an empty grid. Seven labels above
                  nothing describe a table that is not there, and they sat
                  between the code box and the "No lines yet" state that is
                  supposed to be the thing you read. */}
              <thead hidden={lines.length === 0}>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Product</th>
                  {/* "Salesperson", not "Clerk": this decides who earns
                      commission on the line, which is a different question from
                      who captured the document. */}
                  <th className={TABLE_TH}>Salesperson</th>
                  <th className={`${TABLE_TH} text-right`}>Qty</th>
                  <th className={`${TABLE_TH} text-right`}>Selling excl</th>
                  <th className={`${TABLE_TH} text-right`}>Selling incl</th>
                  <th className={`${TABLE_TH} text-right`}>Disc %</th>
                  <th className={`${TABLE_TH} text-right`}>Line total</th>
                  <th className={TABLE_TH} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const totals = computed.per[index]
                  const excl =
                    line.vatRatePct > 0
                      ? round(line.unitPriceIncl / (1 + line.vatRatePct / 100), 2)
                      : line.unitPriceIncl

                  return (
                    <tr key={line.key} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <div className="font-medium text-ink">{line.description}</div>
                        {line.productCode && (
                          <div className="text-xs text-muted">{line.productCode}</div>
                        )}
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        {/* Writes salesRepUserId, not salesRepId: commission is
                            paid to a user (047), and this picker deciding who
                            gets paid is the whole point of it being per line. */}
                        <Select
                          aria-label={`Salesperson for ${line.description}`}
                          value={line.salesRepUserId ?? ''}
                          disabled={!editable}
                          onChange={(e) =>
                            patch(line.key, {
                              salesRepUserId: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                        >
                          <option value="">—</option>
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        <NumberInput
                          aria-label={`Quantity for ${line.description}`}
                          value={line.qty}
                          precision={2}
                          disabled={!editable}
                          onChange={(e) =>
                            patch(line.key, { qty: Number(String(e.target.value).replace(',', '.')) || 0 })
                          }
                        />
                      </td>

                      {/* Editable, and it writes back through the VAT rate to the
                          inclusive price — which stays the stored figure. Someone
                          quoting a trade price ex-VAT types here; the shelf price
                          follows. */}
                      <td className={TABLE_TD_INPUT}>
                        <CurrencyInput
                          aria-label={`Selling price excluding VAT for ${line.description}`}
                          value={excl}
                          disabled={!editable || !canOverridePrice}
                          onChange={(e) => {
                            const typed = Number(String(e.target.value).replace(',', '.')) || 0
                            patch(line.key, {
                              unitPriceIncl: round(typed * (1 + line.vatRatePct / 100), 4),
                            })
                          }}
                        />
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        <CurrencyInput
                          aria-label={`Selling price including VAT for ${line.description}`}
                          value={line.unitPriceIncl}
                          disabled={!editable || !canOverridePrice}
                          onChange={(e) =>
                            patch(line.key, {
                              unitPriceIncl: Number(String(e.target.value).replace(',', '.')) || 0,
                            })
                          }
                        />
                      </td>

                      <td className={TABLE_TD_INPUT}>
                        <NumberInput
                          aria-label={`Discount for ${line.description}`}
                          value={line.discountPct}
                          precision={2}
                          disabled={!editable || !canOverrideDiscount}
                          icon={<span className="text-xs text-faint">%</span>}
                          onChange={(e) =>
                            patch(line.key, {
                              discountPct: Number(String(e.target.value).replace(',', '.')) || 0,
                            })
                          }
                        />
                      </td>

                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                        {formatMoney(totals.lineTotalIncl)}
                      </td>

                      <td className={`${TABLE_TD} text-right`}>
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${line.description}`}
                          disabled={!editable}
                          onClick={() => removeLine(line.key)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {editable && (
            <div className="px-4 py-3">
              <Input
                ref={entryRef}
                value={entry}
                placeholder="Type a product code or barcode, then Tab or Enter to add…"
                aria-label="Add a product by code or barcode"
                disabled={pending}
                className="border-dashed"
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    if (!entry.trim()) return
                    e.preventDefault()
                    addProduct(entry)
                  }
                }}
              />
            </div>
          )}

          {lines.length === 0 && (
            <EmptyState
              icon={<Icons.Barcode size={22} />}
              title="No lines yet"
              hint="Scan or search to add the first line."
            />
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              icon={<Icons.MessageSquare size={18} />}
              title="Comment"
              description="Printed on the invoice."
            />
            <CardBody>
              <Textarea
                rows={5}
                value={notes}
                disabled={!editable}
                maxLength={2000}
                aria-label="Comment printed on the invoice"
                onChange={(e) => setNotes(e.target.value)}
              />
            </CardBody>
          </Card>

          {/* The working figures stay quiet; the one number the panel exists to
              state is the inclusive total. GP goes danger when the sale would
              lose money. */}
          <Card>
            <CardHeader icon={<Icons.Calculator size={18} />} title="Summary" />
            <CardBody>
              <SummaryList>
                {/* What the shop paid and what it makes are a different
                    question from what the customer owes — a counter assistant
                    capturing an order has no business seeing either. */}
                {showCost && (
                  <>
                    <SummaryRow
                      label="Cost"
                      value={formatMoney(computed.costTotal)}
                      tone="muted"
                    />
                    <SummaryRow
                      label={`GP ${computed.gpPct.toFixed(2)}%`}
                      value={formatMoney(computed.gpValue)}
                      tone={computed.gpValue < 0 ? 'danger' : 'muted'}
                    />
                  </>
                )}
                <SummaryRow
                  label="Discount"
                  value={formatMoney(computed.totals.discountTotal)}
                  tone="muted"
                />
                <SummaryRow
                  label="Total exclusive"
                  value={formatMoney(computed.totals.subtotalExcl)}
                  tone="muted"
                />
                <SummaryRow
                  label="VAT"
                  value={formatMoney(computed.totals.vatTotal)}
                  tone="muted"
                />
                <SummaryTotal label="Total inclusive" value={formatMoney(computed.totals.totalIncl)} />
              </SummaryList>
            </CardBody>
          </Card>
        </div>

        {/* The till's own tender pad, not a copy of it. Same buttons, same
            split-payment rules, same credit refusals — an invoice paid by card
            must behave exactly as it would at the counter. */}
        <TenderPad
          open={tendering}
          onClose={() => setTendering(false)}
          tenders={tenders}
          totalIncl={computed.totals.totalIncl}
          cashRounding={cashRounding}
          customer={customer}
          /* What is already paid comes off what the pad asks for — the posting
             engine adds it back as a DEPOSIT tender of its own. See the prop's
             docblock in TenderPad. */
          depositHeld={depositHeld}
          pending={pending}
          onFinalise={finalise}
        />

        {/* closeOnBackdrop stays on: nothing here is half-typed work worth
            protecting — every pick is already on the invoice behind it. */}
        <Modal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          title="Add a product"
          description="Browse by department, or search by code, barcode or description. Each one you pick goes straight onto the invoice."
          size="lg"
          footer={
            <Button variant="secondary" onClick={() => setSearchOpen(false)}>
              Done
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Search" className="min-w-64 flex-1">
                <Input
                  ref={searchInputRef}
                  autoFocus
                  value={searchTerm}
                  placeholder="Code, barcode or description…"
                  aria-label="Search products by code, barcode or description"
                  icon={<Icons.Search size={15} />}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter takes the first match, so a search that has already
                    // narrowed to the right thing needs no reach for the mouse.
                    if (e.key === 'Enter' && searchResults[0]) {
                      e.preventDefault()
                      pickFromSearch(searchResults[0])
                    }
                  }}
                />
              </Field>

              <Field label="Department" className="w-60">
                <Select
                  value={searchDept ?? ''}
                  aria-label="Filter products by department"
                  onChange={(e) => setSearchDept(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">All departments</option>
                  {searchDepts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {/* Non-breaking spaces: a plain one is collapsed inside an
                          <option>, so a nested list would render flat. */}
                      {'  '.repeat(d.depth)}
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* A fixed height, so the dialog does not jump as results arrive and
                a pick never lands on a row that moved under the cursor. */}
            <div className="min-h-[18rem]">
              {searching && searchResults.length === 0 ? (
                <p className="px-1 py-3 text-sm text-muted">Loading products…</p>
              ) : searchResults.length === 0 ? (
                <p className="px-1 py-3 text-sm text-muted">
                  {searchTerm.trim()
                    ? `Nothing matches “${searchTerm.trim()}”${searchDept !== null ? ' in this department' : ''}.`
                    : 'No products in this department.'}{' '}
                  Only products visible at the till are listed here.
                </p>
              ) : (
                <PickerResults
                  results={searchResults.map((p) => ({
                    key: p.id,
                    label: p.description,
                    // The same stock note the till shows, from the same helper:
                    // billing for something the shop does not have is the
                    // mistake this dialog is most likely to cause.
                    meta: `${p.code}${stockNote(p)}`,
                    trailing: formatMoney(p.priceIncl),
                  }))}
                  onPick={(key) => {
                    const product = searchResults.find((p) => p.id === Number(key))
                    if (product) pickFromSearch(product)
                  }}
                />
              )}
            </div>

            {/* Say so when the list is cut short. A picker that silently shows
                the first 500 of 40,000 looks like a complete catalogue, and the
                product someone cannot find is the one they conclude the shop
                does not sell. */}
            {searchResults.length >= PICKER_LIMIT && (
              <p className="px-1 text-xs text-muted">
                Showing the first <span className="numeric">{PICKER_LIMIT}</span> products. Narrow
                by department or search to see the rest.
              </p>
            )}
          </div>
        </Modal>

        {/*
          WHAT NOW — answered HERE, not in the back office.

          This used to offer one button that navigated to /sales/[id], which
          left the invoicing window entirely: the counter lost its chrome, its
          offline shell and its place in the queue, to reach four buttons. The
          four buttons now come to it — and so does the record itself.

          The record is the point. "Finalised" as a line of text asks the
          operator to take the system's word for it; showing the SALE — what was
          rung, what it came to, how it was paid — lets them check it against
          the customer standing in front of them before anyone walks off. It is
          the same <SaleRecord> the /sales/[id] screen renders, so the two can
          never disagree about a sale.

          Everything destructive is still re-checked server-side — voidSaleAction
          and creditWholeSaleAction each resolve the operator and their role for
          themselves — so these buttons decide what is EASY, never what is
          permitted.
        */}
        <Modal
          open={receipt !== null}
          onClose={leaveFinalised}
          title={
            finalisedFace === 'void'
              ? 'Cancel this invoice'
              : finalisedFace === 'credit'
                ? 'Credit this invoice'
                : (receipt?.number ?? 'Invoice finalised')
          }
          description={
            finalisedFace !== null
              ? (receipt?.number ?? undefined)
              : record
                ? `${record.docLabel} · ${record.documentDate}`
                : 'Finalised'
          }
          /* The reason face is one question with a reason list; the record is a
             three-column layout. They are not the same dialog size. */
          size={finalisedFace === null ? 'xl' : 'sm'}
          footer={
            finalisedFace === null ? (
              /* The four buttons live in the FOOTER now, not in the body: the
                 body is a scrolling record, and an action row that scrolls out
                 of reach is an action row the counter cannot find. */
              <>
                {canVoid && (
                  <Button variant="danger-ghost" onClick={() => setFinalisedFace('void')}>
                    <Icons.Close size={15} />
                    Cancel sale
                  </Button>
                )}

                {canCredit && (
                  <Button variant="ghost" onClick={() => setFinalisedFace('credit')}>
                    <Icons.Reverse size={15} />
                    Credit sale
                  </Button>
                )}

                <Button variant="ghost" onClick={() => setEmailingPosted(true)}>
                  <Icons.Mail size={15} />
                  Email
                </Button>

                {/* Print leads: on a posted invoice it is what most of these
                    dialogs are for. Opened as the slip route in its own tab so
                    the printed page is the DOCUMENT — window.print() here would
                    print the capture screen behind the dialog. */}
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!receipt) return
                    void recordPrintAction(receipt.documentId)
                    window.open(`/sales/${receipt.documentId}/slip?auto=1`, '_blank')
                  }}
                >
                  <Icons.Printer size={15} />
                  Print
                </Button>

                <Button variant="primary" onClick={leaveFinalised}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setFinalisedFace(null)
                    setPostedReasonId(null)
                    setPostedNote('')
                  }}
                >
                  Back
                </Button>
                <Button
                  variant="danger"
                  disabled={pending || postedReasonId === null}
                  onClick={finalisedFace === 'void' ? voidPosted : creditPosted}
                >
                  {finalisedFace === 'void' ? 'Cancel the invoice' : 'Credit it in full'}
                </Button>
              </>
            )
          }
        >
          {finalisedFace === null ? (
            <div className="flex flex-col gap-4">
              {/* Change first and loudest: it is the one thing on this dialog
                  that is owed to a person rather than filed. */}
              {receipt !== null && receipt.change > 0 && (
                <p className="rounded-card bg-success-soft px-4 py-3 text-sm text-success-ink">
                  Change due{' '}
                  <span className="numeric font-semibold">{formatMoney(receipt.change)}</span>
                </p>
              )}

              {record ? (
                <SaleRecord sale={record} linkCredits={false} />
              ) : (
                /* The one beat before the record lands. It says what is known
                   for certain already — the sale posted — rather than an empty
                   panel that reads like something went wrong. */
                <p className="text-sm text-muted">
                  {formatMoney(computed.totals.totalIncl)} posted. Stock has moved and the payment
                  is recorded against this sale.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                {finalisedFace === 'void'
                  ? 'The invoice is reversed and the stock goes back. Same-day only — after today, credit it instead.'
                  : 'Every line is credited and the stock comes back. The invoice stays on file as issued.'}
              </p>
              <ReasonPicker
                reasons={finalisedFace === 'void' ? voidReasons : returnReasons}
                value={postedReasonId}
                onChange={setPostedReasonId}
                note={postedNote}
                onNoteChange={setPostedNote}
              />
            </div>
          )}
        </Modal>

        {/* The same dialog the back office and the register use. */}
        {receipt !== null && (
          <EmailInvoiceDialog
            open={emailingPosted}
            onClose={() => setEmailingPosted(false)}
            documentId={receipt.documentId}
            documentNumber={receipt.number}
            /* The till customer record carries CREDIT facts, not contact
               details, so there is no address to prefill here — the dialog asks
               for one, which is also what a walk-in needs. */
            defaultTo=""
            lastEmailedNote={null}
          />
        )}
      </PageBody>
    </>
  )
}
