'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ColumnPicker,
  Combobox,
  ConfirmModal,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
  PageHeader,
  Select,
  TableToolbar,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import ChargesEditor, { type ChargeRow } from './ChargesEditor'
import type { TillProduct } from '@/lib/site/tillSearch'
import { LineImportDialog } from '@/components/import/LineImportDialog'
import type { LineDraft as ImportedLine } from '@/lib/import/documentLines'
import {
  DocumentScanDialog,
  type ScannedDraft,
} from '@/components/import/DocumentScanDialog'
import type { ScannedHeader } from '@/lib/import/documentScan'
import PurchaseLineGrid, {
  PURCHASE_COLUMNS,
  PURCHASE_COLUMN_IDS,
  RECEIVE_DEFAULT_COLUMNS,
  type GridLine,
} from '../PurchaseLineGrid'
import { purchaseDocumentFigures } from '../purchaseLine'
import ProductSearchModal, {
  type ProductSearchPick,
} from '@/components/products/ProductSearchModal'
import { searchProductsForPurchasePickerAction } from '@/components/products/productSearchActions'
import {
  searchProductsForPurchaseAction,
  receiveGoodsAction,
  saveDraftReceiptAction,
  deleteDraftReceiptAction,
  loadOrderAction,
  productPositionsAction,
} from '../actions'

/**
 * How long a change sits still before it is saved.
 *
 * The same figure the order screen uses, and deliberately so: the two screens
 * are one flow worked by one person, and a delivery that saved on a different
 * rhythm from the order it came from would feel like a different product.
 */
const AUTOSAVE_MS = 800

/**
 * Receiving goods.
 *
 * The screen shows what each line will do to the product's average cost BEFORE
 * anything is posted. That is the point: a receipt at an unusual price quietly
 * moves the cost every future margin is measured against, and seeing it in
 * advance is the difference between catching a keying error and finding it in
 * next month's GP report.
 *
 * ── CHANGING THIS SCREEN? CHANGE ../OrderScreen.tsx WITH IT ───────────────
 *
 * Ordering and receiving are two documents but ONE flow, and the same person
 * works both in the same afternoon. They are separate files because a GRV
 * carries what an order cannot — their invoice number and total, freight and
 * charges, a stock location, serial numbers — not because they are allowed to
 * look like two different products.
 *
 * So a layout change here is only half a change:
 *
 *   • The LINE GRID is shared already — edit ../PurchaseLineGrid.tsx and it
 *     lands on both. Never patch grid behaviour inside this file.
 *   • Card order, headings, the search-plus-browse row, the totals panel, where
 *     the primary button sits, the explanatory footnote under it: mirror it in
 *     OrderScreen so the two screens still read as the same screen.
 *   • Something genuinely receiving-only (serials, charges, locations) is a
 *     card OrderScreen simply omits — that is fine. Moving a card both screens
 *     have, and moving it only here, is not.
 *
 * Supplier returns (../[id]/return/ReturnScreen.tsx) follow the same shape.
 */

type StockLocationOption = { id: number; code: string; name: string; isMain: boolean }

/**
 * A line on this delivery.
 *
 * GridLine carries everything the shared grid needs — quantities, costs,
 * discounts, the pricing figures. What is added here is what only receiving
 * cares about: the order line being fulfilled, and the serial numbers that
 * arrived with the goods.
 */
type ReceiveLine = GridLine & {
  orderLineId?: number | null
  departmentId: number | null
  /**
   * One serial per unit, for a serial-tracked product. Empty on every other
   * line and never sent for them.
   */
  serials: string[]
  /** Manufacturer expiry, applied to every serial captured on this line. */
  warrantyUntil: string
  /** The lot identity for a batch-tracked product (148). '' on other lines. */
  batchNo: string
  expiryDate: string
}

export default function ReceiveScreen({
  suppliers,
  openOrders,
  defaultVatRate,
  sellingVatRate,
  initialOrderId,
  costWarnPct = 0,
  draft,
  locations,
  scanConfigured = false,
}: {
  suppliers: { id: number; code: string; name: string; terms: number }[]
  openOrders: {
    id: number
    documentNumber: string | null
    supplierId: number
    supplierName: string | null
    documentDate: string
  }[]
  defaultVatRate: number
  /** Sales VAT, for the margin columns — a product can carry a different rate
      on the way out from the one it carries on the way in. */
  sellingVatRate: number
  /** An order to open against, from "Receive" on an issued order. */
  initialOrderId?: number | null
  /** Percentage a cost may move before a line says so. Zero switches it off. */
  costWarnPct?: number
  /** A draft being reopened. Everything below starts from it. */
  draft?: {
    id: number
    supplierId: number
    supplierInvoiceNo: string
    orderId: number | null
    reference: string
    notes: string
    discountPct: number
    discountExcl: number
    lines: ReceiveLine[]
    charges: ChargeRow[]
  } | null
  /** Active stock locations. Always at least one — the main location. */
  locations: StockLocationOption[]
  /**
   * Whether reading a PDF is set up at all. Decided on the server because the
   * key lives there — a client check would either leak it or lie.
   */
  scanConfigured?: boolean
}) {
  // Every new line starts here, so a single-location site never sees the
  // control and a multi-location one gets the sensible default rather than an
  // empty box it must fill in ten times.
  const mainLocationId = locations.find((l) => l.isMain)?.id ?? locations[0]?.id ?? null
  const multiLocation = locations.length > 1
  const [supplierId, setSupplierId] = useState(draft ? String(draft.supplierId) : '')
  const [orderId, setOrderId] = useState(draft?.orderId ? String(draft.orderId) : '')
  const [invoiceNo, setInvoiceNo] = useState(draft?.supplierInvoiceNo ?? '')
  /**
   * What their invoice says the whole delivery comes to, VAT included.
   *
   * Zero means "not given", and the check is skipped — receiving against a
   * delivery note with no prices on it is a real and common case.
   */
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [charges, setCharges] = useState<ChargeRow[]>(draft?.charges ?? [])
  const [docDiscountPct, setDocDiscountPct] = useState(draft?.discountPct ?? 0)
  const [docDiscountAmount, setDocDiscountAmount] = useState(draft?.discountExcl ?? 0)
  const [lines, setLines] = useState<ReceiveLine[]>(draft?.lines ?? [])
  /** Set once saved, so a second save updates rather than making another. */
  const [draftId, setDraftId] = useState<number | null>(draft?.id ?? null)
  /* The "discard this draft?" confirm. Nothing is destroyed until it is
     answered — the button only opens the question. */
  const [discarding, setDiscarding] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()

  /* The product search dialog — the shared one, the same grid ordering,
     recipes and invoicing use. Distinct from the Combobox above it, which
     answers keystrokes: this one answers "show me what is in Groceries" with no
     term at all, which is how a receiver works through a delivery note full of
     things they cannot spell. It holds its own search, filter, sort, paging and
     column state, so this screen keeps none of it. */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)

  const columns = useColumnPrefs(
    'odyssey.purchasing.receive.columns',
    RECEIVE_DEFAULT_COLUMNS,
    PURCHASE_COLUMN_IDS,
  )

  const toast = useToast()
  const router = useRouter()

  /** One line changed. The grid hands back only what moved. */
  function patchLine(key: string, patch: Partial<GridLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  const ordersForSupplier = openOrders.filter(
    (o) => !supplierId || o.supplierId === Number(supplierId),
  )

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsForPurchaseAction(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  /** Pulls an order's outstanding lines onto the receipt. */
  function loadOrder(id: string) {
    setOrderId(id)
    if (!id) return

    startTransition(async () => {
      const order = await loadOrderAction(Number(id))
      if (!order) return

      setSupplierId(String(order.supplierId))

      // Where these products stand NOW. The order snapshotted a cost when it
      // was raised — possibly weeks ago — and never knew the stock figure, so
      // without this the cost and margin previews would all read zero.
      const positions = await productPositionsAction(
        order.lines.map((l) => l.productId).filter((id): id is number => id !== null),
      )
      const positionFor = new Map(positions.map((p) => [p.productId, p]))

      setLines(
        order.lines
          .filter((l) => l.qtyOutstanding > 0)
          .map((l, index) => ({
            key: `order-${l.id}-${index}`,
            orderLineId: l.id,
            productId: l.productId,
            productCode: l.productCode,
            supplierCode: l.supplierCode ?? '',
            description: l.description,
            productType: l.productType,
            departmentId: l.departmentId,
            qtyOrdered: l.qtyOrdered,
            // Defaults to what is still outstanding — the common case is that
            // everything ordered has arrived.
            qty: l.qtyOutstanding,
            qtyBonus: 0,
            unitCostExcl: l.unitCostExcl,
            discountPct: l.discountPct,
            discountAmount: 0,
            vatRatePct: l.vatRatePct,
            // Where the ORDER said these goods should go, which is the buyer
            // saying it once at the point they knew — rather than the receiver
            // rebuilding the split from a delivery note that never carried it.
            // Still editable: intent in January is not a promise about where
            // the pallet actually goes in February. A line the order left blank
            // falls back to main, as it always did — and so does one naming a
            // location that has been CLOSED since the order went out, which
            // would otherwise sit in state as an id with no option behind it
            // and post goods into a room nobody uses.
            locationId: locations.some((loc) => loc.id === l.locationId)
              ? l.locationId
              : mainLocationId,
            serials: [],
            warrantyUntil: '',
            batchNo: '',
            expiryDate: '',
            currentAverage: positionFor.get(l.productId ?? -1)?.averageCost ?? 0,
            lastCost: positionFor.get(l.productId ?? -1)?.lastCost ?? 0,
            currentStock: positionFor.get(l.productId ?? -1)?.stockOnHand ?? 0,
            sellIncl: positionFor.get(l.productId ?? -1)?.sellIncl ?? 0,
          })),
      )
    })
  }

  // Opened from "Receive" on an issued order: pull its lines in straight away
  // rather than making the user pick the order they just came from. Runs once
  // — reloading the same order would discard quantities already corrected.
  useEffect(() => {
    if (initialOrderId) loadOrder(String(initialOrderId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId])

  /**
   * What `addProducts` needs to know about a thing being received.
   *
   * Its own shape because two different pickers feed it: the type-ahead
   * Combobox, which returns a full TillProduct, and the search dialog, which
   * returns a ProductSearchPick. Both narrow to this on the way in, so the
   * line-building below is written once.
   */
  type Addable = {
    id: number
    code: string
    description: string
    productType: string
    departmentId: number | null
    /** Excl. VAT. Null when the role may not read costs — the line opens at 0. */
    costExcl: number | null
    stockOnHand: number
    priceIncl: number | null
  }

  const fromTillProduct = (p: TillProduct): Addable => ({
    id: p.id,
    code: p.code,
    description: p.description,
    productType: p.productType,
    departmentId: p.departmentId,
    costExcl: p.costExcl,
    stockOnHand: p.stockOnHand,
    priceIncl: p.priceIncl,
  })

  const fromPick = (p: ProductSearchPick): Addable => ({
    id: p.id,
    code: p.code,
    description: p.description,
    productType: p.productType,
    departmentId: p.departmentId,
    costExcl: p.cost,
    stockOnHand: p.stockOnHand,
    priceIncl: p.priceIncl,
  })

  /**
   * Puts products on the delivery.
   *
   * Takes a LIST because the search dialog can send several: ticking a dozen
   * and adding them together is the gesture that replaced opening the picker a
   * dozen times. One product is a list of one, so there is a single path.
   */
  function addProducts(products: Addable[]) {
    if (products.length === 0) return
    const stamp = Date.now()

    setLines((current) => [
      ...current,
      ...products.map((product, index) => ({
        key: `${product.id}-${stamp}-${index}`,
        productId: product.id,
        productCode: product.code,
        supplierCode: '',
        description: product.description,
        productType: product.productType,
        departmentId: product.departmentId,
        qtyOrdered: 0,
        qty: 1,
        qtyBonus: 0,
        unitCostExcl: product.costExcl ?? 0,
        discountPct: 0,
        discountAmount: 0,
        vatRatePct: defaultVatRate,
        // Inherits whatever the previous line used, so allocating a whole
        // delivery to the warehouse is one choice rather than one per line.
        locationId: current[current.length - 1]?.locationId ?? mainLocationId,
        serials: [],
        warrantyUntil: '',
        batchNo: '',
        expiryDate: '',
        currentAverage: product.costExcl ?? 0,
        // The search path has no separate last cost; costExcl already follows
        // the site cost basis, so it is the same comparison a buyer makes.
        lastCost: product.costExcl ?? 0,
        currentStock: product.stockOnHand,
        // A variant PARENT prices per child and has no price of its own.
        sellIncl: product.priceIncl ?? 0,
      })),
    ])
    setQuery('')
    setOptions([])
  }

  /** One product, from the type-ahead beside the button. */
  function addProduct(product: TillProduct) {
    addProducts([fromTillProduct(product)])
  }

  /**
   * Lines from a supplier's delivery note or a spreadsheet.
   *
   * The same row shape `addProduct` builds. Two things the file can say that a
   * hand-added line cannot: which room each line lands in, and the serials on
   * it — both per line, because one delivery can be split across rooms and a
   * serial product is counted by its labels rather than by a typed quantity.
   *
   * A cost the file omitted falls back to zero here rather than to the
   * product's, deliberately: a GRV prices what the supplier actually charged,
   * and a silently inherited cost is the kind of figure that gets posted
   * without being read.
   */
  function addImportedLines(imported: ImportedLine[]) {
    const stamp = Date.now()
    setLines((current) => {
      const inherited = current[current.length - 1]?.locationId ?? mainLocationId
      return [
        ...current,
        ...imported.map((row, index) => ({
          key: `${row.productId}-${stamp}-${index}`,
          productId: row.productId,
          productCode: row.code,
          supplierCode: '',
          description: row.description,
          productType: row.productType,
          departmentId: null,
          qtyOrdered: 0,
          qty: row.qty,
          qtyBonus: 0,
          unitCostExcl: row.unitCostExcl ?? 0,
          discountPct: row.discountPct ?? 0,
          discountAmount: 0,
          vatRatePct: defaultVatRate,
          locationId: locationIdFor(row.locationCode) ?? inherited,
          serials: row.serials,
          warrantyUntil: '',
          batchNo: '',
          expiryDate: '',
          currentAverage: 0,
          lastCost: 0,
          currentStock: 0,
          sellIncl: 0,
        })),
      ]
    })
  }

  /**
   * Lines read off a supplier's PDF.
   *
   * The same rows addImportedLines builds, and it goes through that function
   * rather than repeating it — a scanned line and an imported line are the same
   * thing once resolved, and two copies of this mapping would drift the first
   * time the grid gained a column. What a scan cannot say is which room a line
   * lands in or what serials came with it; both fall back exactly as an import
   * with those columns missing does.
   */
  function addScannedLines(scanned: ScannedDraft[]) {
    addImportedLines(
      scanned.map((row, index) => ({
        line: index + 1,
        reference: row.code,
        productId: row.productId,
        code: row.code,
        description: row.description,
        productType: row.productType,
        qty: row.qty,
        unitCostExcl: row.unitCostExcl,
        discountPct: row.discountPct,
        locationCode: null,
        serials: [],
      })),
    )
  }

  /**
   * What the PDF said about the document itself.
   *
   * Only fills what is still EMPTY. A buyer who has already typed the invoice
   * number has typed it off the paper in their hand, and a scan quietly
   * replacing it — with a figure read from the same paper, but by a machine —
   * would be the one place this feature could overwrite a person's work.
   *
   * The supplier is deliberately not applied here even when it was matched:
   * changing it mid-capture would reprice every line already on the grid
   * against a different agreed price list.
   */
  function applyScannedHeader(header: ScannedHeader) {
    if (header.documentNumber && !invoiceNo) setInvoiceNo(header.documentNumber)
    if (header.totalIncl !== null && invoiceTotal <= 0) setInvoiceTotal(header.totalIncl)
  }

  /** A location named in the file, by code or by name. Null falls back. */
  function locationIdFor(code: string | null): number | null {
    if (!code) return null
    const wanted = code.trim().toLowerCase()
    const match = locations.find(
      (l) => l.code.toLowerCase() === wanted || l.name.toLowerCase() === wanted,
    )
    return match?.id ?? null
  }

  // Every figure on the delivery, from the one place that computes them. The
  // grid re-derives each line from the same function, so what a row shows and
  // what the summary adds up can never disagree.
  // Every charge lands in cost, whoever billed it — so the whole total is what
  // gets apportioned across the lines.
  const chargesTotal = useMemo(
    () => charges.reduce((sum, c) => round(sum + c.amountExcl, 2), 0),
    [charges],
  )

  const totals = useMemo(
    () =>
      purchaseDocumentFigures(lines, {
        chargesExcl: chargesTotal,
        discountPct: docDiscountPct,
        discountExcl: docDiscountAmount,
      }),
    [lines, chargesTotal, docDiscountPct, docDiscountAmount],
  )

  /**
   * What the GOODS supplier is owed — their charges only.
   *
   * A courier's invoice in this figure would be chased from the wrong account
   * and paid to the wrong company, so the summary must separate them even
   * though both are in landed cost.
   */
  const ownCharges = useMemo(
    () =>
      charges
        .filter((c) => !c.supplierId)
        .reduce((sum, c) => round(sum + c.amountExcl + c.amountExcl * (c.vatRatePct / 100), 2), 0),
    [charges],
  )

  const carrierCharges = useMemo(
    () =>
      charges
        .filter((c) => c.supplierId)
        .reduce((sum, c) => round(sum + c.amountExcl + c.amountExcl * (c.vatRatePct / 100), 2), 0),
    [charges],
  )

  /**
   * What the GOODS supplier is owed, which is what their invoice shows.
   *
   * A carrier's separate invoice is not on the page being checked, so it must
   * not be in the figure compared against it.
   */
  const ourTotal = round(totals.taxableExcl + totals.vatTotal + ownCharges, 2)
  const invoiceVariance = invoiceTotal > 0 ? round(ourTotal - invoiceTotal, 2) : 0

  /**
   * The payload, built once and used by both saving and posting.
   *
   * Shared deliberately: a draft that serialises differently from the receipt
   * it becomes would post something other than what was on screen when it was
   * saved, and the difference would only show up after the stock had moved.
   */
  function payload() {
    return {
      supplierId: Number(supplierId),
      orderId: orderId ? Number(orderId) : null,
      supplierInvoiceNo: invoiceNo || null,
      // Zero means not given: posting must stay possible without the invoice.
      supplierInvoiceTotal: invoiceTotal > 0 ? invoiceTotal : null,
      discountPct: docDiscountPct,
      discountExcl: docDiscountAmount,
      charges: charges
        // A blank row the user added and never filled in is not a charge.
        .filter((c) => c.description.trim() || c.amountExcl > 0)
        .map((c) => ({
          supplierId: c.supplierId,
          description: c.description.trim() || 'Delivery',
          amountExcl: c.amountExcl,
          vatRatePct: c.vatRatePct,
          theirInvoiceNo: c.theirInvoiceNo || null,
        })),
      lines: lines.map((l) => ({
        orderLineId: l.orderLineId,
        productId: l.productId,
        locationId: l.locationId,
        productCode: l.productCode,
        supplierCode: l.supplierCode || null,
        description: l.description,
        productType: l.productType,
        departmentId: l.departmentId,
        qtyOrdered: l.qtyOrdered || l.qty,
        qtyReceived: l.qty,
        qtyBonus: l.qtyBonus,
        unitCostExcl: l.unitCostExcl,
        discountPct: l.discountPct,
        discountAmount: l.discountAmount,
        vatRatePct: l.vatRatePct,
        // The shelf price, but ONLY where the buyer actually set one (193).
        //
        // Every line arrives carrying the product's current price so the
        // Markup % and GP % columns have something to read against. Sending
        // that back untouched would have a delivery nobody re-priced rewrite
        // the shelf with a figure it was merely shown — and overwrite any
        // price changed between the order going out and the goods arriving.
        // null is the instruction to leave it alone.
        sellingPriceIncl: l.sellTouched ? l.sellIncl : null,
        serials: l.productType === 'serial' ? l.serials : undefined,
        warrantyUntil: l.productType === 'serial' ? l.warrantyUntil || null : undefined,
        batchNo: l.productType === 'batch' ? l.batchNo || null : undefined,
        expiryDate: l.productType === 'batch' ? l.expiryDate || null : undefined,
      })),
    }
  }

  /* ── Autosave ────────────────────────────────────────────────────────────
   *
   * The GRV is written as the delivery is keyed: choosing a supplier creates
   * it, adding a product writes the line, editing a cost or a quantity writes
   * the change. A sixty-line delivery interrupted by the phone is no longer an
   * hour of work standing on somebody remembering to press Save.
   *
   * saveDraftReceipt() was built for exactly this and validates almost nothing
   * — a draft is by definition incomplete, and the full check runs at finalise
   * where it belongs. Nothing here moves stock, cost or ledger.
   *
   * ── WHY IT IS NOT IN startTransition ─────────────────────────────────────
   *
   * `pending` disables "Receive the goods". Firing an autosave through the same
   * transition would grey the primary action out every time somebody typed a
   * digit, which reads as the screen fighting them. The autosave carries its
   * own quiet flag; only the explicit button drives `pending`.
   */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  /* The last payload written, serialised — the comparison that decides whether
     there is anything to save. Without it every re-render would queue another
     identical write. */
  const savedJson = useRef<string | null>(null)
  /* The live id. State alone is not enough: two saves queued before the first
     returns would both read `draftId` as null and create two receipts. */
  const draftIdRef = useRef<number | null>(draft?.id ?? null)
  /* Only the newest save may report its result and set the id — a slow early
     save landing after a later one must not overwrite it. */
  const saveSeq = useRef(0)

  const draftBody = JSON.stringify({
    supplierId,
    orderId,
    invoiceNo,
    invoiceTotal,
    charges,
    docDiscountPct,
    docDiscountAmount,
    lines,
  })

  useEffect(() => {
    // Nothing to save until it is known who delivered: supplier_id is the one
    // column the row cannot exist without, and saveDraftReceipt refuses
    // without it. A receipt with a supplier and no lines IS saved — that is
    // the "choosing a supplier creates it" step, and it is what makes the id
    // exist for the first line to be written against.
    if (supplierId === '') return
    if (draftBody === savedJson.current) return

    const body = payload()
    const timer = setTimeout(() => {
      const seq = ++saveSeq.current
      setSaveState('saving')
      void (async () => {
        try {
          const result = await saveDraftReceiptAction(draftIdRef.current, body)
          if (seq !== saveSeq.current) return
          if (!result.ok) {
            setSaveState('error')
            toast.error(result.error)
            return
          }
          draftIdRef.current = result.id
          setDraftId(result.id)
          savedJson.current = draftBody
          setSaveState('saved')
        } catch {
          if (seq !== saveSeq.current) return
          // Deliberately quiet: a failed autosave is usually a dropped
          // connection, and a toast on every retry while a laptop wakes up is
          // noise. The indicator says "not saved", which is the honest state.
          setSaveState('error')
        }
      })()
    }, AUTOSAVE_MS)

    return () => clearTimeout(timer)
    // Keyed on the serialised body: `lines` and `charges` are new arrays every
    // render, so depending on them directly would re-arm the timer forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftBody])

  /** Posts it. Stock moves, cost moves, the supplier is credited. */
  function submit() {
    startTransition(async () => {
      // Retires any autosave still in flight: its result must not come back
      // after this and re-open a draft that posting has just finalised.
      saveSeq.current++

      const result = await receiveGoodsAction({
        ...payload(),
        // Finalises the draft IN PLACE when there is one, so its id survives
        // and anything already pointing at it still resolves. Read from the
        // ref, which is written the moment an autosave returns an id — the
        // state may still be a render behind.
        draftId: draftIdRef.current,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} received — stock and costs updated.`)
      router.push(`/purchasing/${result.documentId}`)
    })
  }

  /**
   * Lines whose serial count does not match what arrived.
   *
   * The posting path refuses these too — this only means the receiver is told
   * before pressing the button rather than after, while the delivery note is
   * still in their hand.
   */
  const serialGaps = lines.filter(
    (l) =>
      l.productType === 'serial' &&
      (l.serials.length !== l.qty + l.qtyBonus || !Number.isInteger(l.qty + l.qtyBonus)),
  )

  /* A batch line with neither lot number nor expiry cannot post — the posting
     path refuses it too; this tells the receiver while the note is in hand. */
  const batchGaps = lines.filter(
    (l) => l.productType === 'batch' && !l.batchNo.trim() && !l.expiryDate.trim(),
  )

  const ready =
    supplierId !== '' &&
    lines.length > 0 &&
    lines.every((l) => l.qty > 0) &&
    serialGaps.length === 0 &&
    batchGaps.length === 0

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: `${p.code} · ${formatQty(p.stockOnHand)} on hand`,
    trailing: formatMoney(p.costExcl),
    data: p,
  }))

  return (
    <>
      {/* Rendered here rather than by the page, because the two actions carry
          this component's state — pending, and everything `ready` checks. They
          sit in the header, anchored right, so the act this screen exists for
          is reachable without scrolling past a delivery of forty lines. */}
      <PageHeader
        title="Receive goods"
        /* The state as a chip, not only as prose. A receiver who opens a saved
           draft is looking at an editor full of lines that have not moved any
           stock, and a sentence in muted text beside the title is the first
           thing skimmed past — the badge is what survives a glance. */
        status={draftId ? <Badge tone="brand">Draft</Badge> : undefined}
        /* Says which of the two it is, now that a draft row in the list opens
           straight here: landing on an editor already full of lines, under a
           title that reads like a blank one, leaves the receiver wondering
           whose delivery they are looking at. */
        subtitle={
          draftId
            ? 'Picking up a saved draft — nothing has moved yet.'
            : 'Stock in, costs updated, supplier credited.'
        }
        backHref="/purchasing"
        backLabel="Purchasing"
        action={
          <>
            {/* No "Save for later" button any more: the delivery saves itself
                as it is keyed, and a button that repeats what already happened
                invites the belief that work is lost without it. What replaces
                it is a statement of where the draft actually stands. */}
            <span className="text-xs text-muted" aria-live="polite">
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'error'
                  ? 'Not saved — check your connection.'
                  : draftId
                    ? 'Saved automatically.'
                    : 'Choose a supplier and this saves itself.'}
            </span>
            {/* Only once there IS a draft to discard. The screen saves itself
                as soon as a supplier is chosen, so before that there is no row
                — and a discard button for nothing reads as broken.

                Here as well as on the document screen because THIS is where a
                draft receipt actually opens from the purchasing list (see
                hrefFor): a receiver abandoning a half-keyed delivery is looking
                at this screen, not at the read-only one. */}
            {draftId && (
              <Button
                variant="danger-ghost"
                disabled={pending}
                onClick={() => setDiscarding(true)}
              >
                <Icons.Trash size={15} />
                Discard
              </Button>
            )}
            <Button variant="primary" disabled={!ready || pending} onClick={submit}>
              <Icons.PackageOpen size={15} />
              {pending ? 'Receiving…' : 'Receive the goods'}
            </Button>
          </>
        }
      />
      <PageBody>
      {/* DELIVERY FIRST, FULL WIDTH, AND ITS FOUR FIELDS IN ONE ROW.

          They are one question asked four ways — who sent it, against what, on
          which invoice, for how much — and they are answered together off the
          top of the document in the receiver's hand. Stacking them down a third
          of the page made a four-line job read as a form, and pushed the
          invoice total, the screen's best guard, below the fold on a laptop.

          The LINE GRID still gets the full width below: it carries up to twenty
          columns — cost, markup, GP, selling price — and figures that only mean
          anything beside each other must not be scrolled to. */}
      <Card>
        <CardHeader title="Delivery" description="Who it came from, and what it came with." />
        <CardBody className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field
            label="Supplier"
            // Marked here, not in a footnote by the button — the fix is this box.
            error={
              lines.length > 0 && supplierId === ''
                ? 'Choose who this delivery came from.'
                : undefined
            }
          >
            <Select
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value)
                setOrderId('')
              }}
            >
              <option value="">— Choose —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Against an order"
            hint={
              ordersForSupplier.length === 0
                ? 'No open orders — receiving straight in is fine.'
                : 'Pulls the outstanding lines in.'
            }
          >
            <Select
              value={orderId}
              onChange={(e) => loadOrder(e.target.value)}
              disabled={ordersForSupplier.length === 0}
            >
              <option value="">— No order —</option>
              {ordersForSupplier.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.documentNumber} · {o.documentDate}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Their invoice number" hint="What the payment run will match against.">
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </Field>

          {/* The single best guard in the module. Typed from the bottom of
              the page in their hand; the receipt is refused if the lines do
              not tie to it. Left blank when receiving against a delivery
              note that carries no prices. */}
          <Field
            label="Their invoice total (incl.)"
            hint={
              invoiceTotal > 0
                ? undefined
                : 'Optional — but it catches a mis-keyed cost before it reaches the ledger.'
            }
            error={
              invoiceTotal > 0 && Math.abs(invoiceVariance) > 0.1
                ? `Out by ${formatMoney(Math.abs(invoiceVariance))} — the lines come to ${formatMoney(ourTotal)}.`
                : undefined
            }
          >
            <CurrencyInput
              value={invoiceTotal}
              onChange={(e) =>
                setInvoiceTotal(Number(String(e.target.value).replace(',', '.')) || 0)
              }
            />
          </Field>
        </CardBody>
      </Card>

      {/* The two things that move the whole invoice rather than one line, side
          by side under the delivery they adjust. They are a pair: charges add
          to what the goods cost, a discount takes off it, and both are read off
          the bottom of the same supplier invoice in one pass. `items-start` so
          the shorter card keeps its own height instead of stretching to match
          a charges list that grows a row at a time. */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Delivery and charges"
            description="Spread across the lines by value, so cost is landed cost — whoever billed it."
          />
          <CardBody>
            <ChargesEditor
              charges={charges}
              suppliers={suppliers}
              goodsSupplierName={
                supplierId
                  ? `On ${suppliers.find((s) => s.id === Number(supplierId))?.name ?? 'the'} invoice`
                  : ''
              }
              defaultVatRate={defaultVatRate}
              onChange={setCharges}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Discount on the invoice"
            description="Settlement terms or a rebate on the whole delivery, spread across the lines."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Percent off"
              hint={docDiscountAmount > 0 ? 'Ignored — an amount is set.' : 'Of the goods total.'}
            >
              <NumberInput
                value={docDiscountPct}
                precision={2}
                onChange={(e) =>
                  setDocDiscountPct(
                    Math.min(Math.max(Number(String(e.target.value).replace(',', '.')) || 0, 0), 100),
                  )
                }
              />
            </Field>
            <Field label="Or an amount" hint="Wins over the percentage — what the invoice says.">
              <CurrencyInput
                value={docDiscountAmount}
                onChange={(e) =>
                  setDocDiscountAmount(Number(String(e.target.value).replace(',', '.')) || 0)
                }
              />
            </Field>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="What arrived"
          description="Costs are exclusive of VAT — how a supplier invoice is written."
          action={
            <ColumnPicker
              columns={PURCHASE_COLUMNS}
              visible={columns.visible}
              onChange={columns.setVisible}
              onReset={columns.reset}
            />
          }
        />
        <CardBody className="flex flex-col gap-3">
          {/* Two ways in, because a delivery is checked two ways. The box is
              for something whose code you know; the button is for working down
              a note of things you do not. */}
          {/* The box is capped rather than filling the row: a search field is
              sized by what gets typed into it — a code or a few words — and one
              stretched across a wide screen leaves the button it belongs with
              stranded at the far edge. Capped, the two read as one control. */}
          <div className="flex items-start gap-2">
            <div className="w-full max-w-[400px]">
              <Combobox
                options={comboOptions}
                query={query}
                onQueryChange={setQuery}
                onSelect={(option) => option.data && addProduct(option.data)}
                placeholder="Search a product to add a line…"
                loading={searching}
                clearOnSelect
                emptyText={query.trim().length >= 2 ? 'No product matches.' : 'Keep typing…'}
              />
            </div>
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>
              <Icons.Plus size={16} />
              Add stock
            </Button>
            {/* Beside the two hands-on ways in, because it is a third answer to
                the same question — how do lines get onto this delivery. Hidden
                rather than disabled when there is no API key: a button that can
                only explain why it does not work is worse than no button. */}
            {scanConfigured && (
              <Button variant="ghost" onClick={() => setScanOpen(true)}>
                <Icons.Sparkles size={16} />
                Read a PDF
              </Button>
            )}
          </div>

          {/* Most deliveries go to one place. Setting each line separately is
              what the per-line control is for; this is the common case. */}
          {multiLocation && lines.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Send every line to</span>
              <Select
                value=""
                className="w-auto"
                onChange={(e) => {
                  const id = Number(e.target.value)
                  if (!id) return
                  setLines((c) => c.map((l) => ({ ...l, locationId: id })))
                }}
              >
                <option value="">— Choose —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} — {loc.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardBody>

        {lines.length === 0 ? (
          <EmptyState
            title="Nothing on this delivery yet"
            hint="Pick an order above, or search for a product."
            icon={<Icons.PackageOpen size={22} />}
          />
        ) : (
          <PurchaseLineGrid
            lines={lines}
            visible={columns.visible}
            mode="receive"
            locations={locations}
            documentDiscounts={totals.lines.map((l) => l.documentDiscountExcl)}
            charges={totals.lines.map((l) => l.chargeExcl)}
            sellingVatPct={sellingVatRate}
            costWarnPct={costWarnPct}
            onPatch={patchLine}
            onRemove={(key) => setLines((c) => c.filter((l) => l.key !== key))}
            /* Serial capture, for the lines that need it. Rendered inline
               rather than behind a dialog: the delivery note is in the
               receiver's hand now, and a modal per line would make a
               ten-line delivery ten interruptions. */
            renderAfterRow={(line) => {
              const l = lines.find((x) => x.key === line.key)
              if (!l) return null
              if (l.productType === 'serial') {
                return (
                  <SerialCapture
                    serials={l.serials}
                    warrantyUntil={l.warrantyUntil}
                    qtyReceived={l.qty + l.qtyBonus}
                    onChange={(patch) => patchLine(l.key, patch as Partial<GridLine>)}
                  />
                )
              }
              if (l.productType === 'batch') {
                return (
                  <BatchCapture
                    batchNo={l.batchNo}
                    expiryDate={l.expiryDate}
                    onChange={(patch) => patchLine(l.key, patch as Partial<GridLine>)}
                  />
                )
              }
              return null
            }}
          />
        )}
      </Card>

      {/* Under the grid: the state of the document on the left, what receiving
          will do in the middle, and the figure the invoice is checked against
          on the right. Three columns rather than one stacked third, so the
          explanation sits BESIDE the total it explains instead of pushing it
          down the page — on a laptop that difference is whether the invoice
          total is on screen at the moment the button is pressed. `items-start`
          so neither side stretches to the other's height. */}
      <div className="grid items-start gap-4 xl:grid-cols-3">
        {/* Status notes, centred in the space left of the totals. Kept out of
            the header deliberately: they explain a disabled button a long way
            up the page, and a hint that shouts from the title bar reads as an
            error the receiver has not made yet. */}
        <div className="flex flex-col items-center justify-center gap-2 self-center">
          {/* Everything else that blocks the button is marked at its source —
              the supplier field, a quantity box, a line's serial badge. An
              empty delivery is the one state with nowhere to point. */}
          {lines.length === 0 && (
            <p className="text-center text-xs text-muted">Add what arrived.</p>
          )}

          {draftId && (
            <p className="flex items-center gap-2 text-center text-xs text-muted">
              <Icons.StatusSuccess size={15} className="shrink-0 text-success" />
              Saved as a draft. Nothing has moved yet.
            </p>
          )}
        </div>

        {/* What the button is about to do, in the reading path between the
            lines and the total — an informational tint rather than a plain
            card, because it is a standing explanation and not a figure. */}
        <Card className="flex gap-3 border-brand-soft bg-brand-soft/40 p-4">
          <Icons.Info size={17} className="mt-0.5 shrink-0 text-brand" />
          <div className="flex flex-col gap-2 text-xs text-muted">
            <p>
              Receiving moves stock in, blends the landed cost into each product&apos;s average,
              and credits the supplier&apos;s account.
            </p>
            <p>It is the only thing in the system that changes average cost.</p>
            <p>
              Any selling price you change here moves the shelf price too — but only when
              you post. Lines you leave alone keep the price they already have.
            </p>
          </div>
        </Card>

        {/* The totals panel. A brand-tinted left edge so the one figure that
            gets checked against the paper invoice is findable without reading
            — it is the last thing looked at before posting. */}
        <Card className="border-l-2 border-l-brand p-4">
          <dl className="flex flex-col gap-1.5 text-sm">
            <Row label="Goods (excl.)" value={formatMoney(totals.subtotalExcl)} />
            {totals.discountExcl > 0 && (
              <Row label="Discount" value={`−${formatMoney(totals.discountExcl)}`} />
            )}
            {ownCharges > 0 && <Row label="Delivery" value={formatMoney(ownCharges)} />}
            <Row label="VAT" value={formatMoney(totals.vatTotal)} />
          </dl>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium text-ink">
              {carrierCharges > 0 ? 'Their invoice' : 'Invoice total'}
            </span>
            <span className="numeric text-xl font-semibold text-ink">
              {/* taxableExcl, not subtotalExcl: the document discount has
                  already come off it, and showing the pre-discount figure here
                  would disagree with the invoice being keyed from. */}
              {formatMoney(round(totals.taxableExcl + totals.vatTotal + ownCharges, 2))}
            </span>
          </div>

          {/* Billed separately, so it is NOT part of what this supplier is
              owed — but it IS in the cost of the goods. Showing it here rather
              than only on the charges table is what stops someone reading the
              invoice total as the whole cost of the delivery. */}
          {carrierCharges > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted">Carriers, billed separately</span>
                <span className="numeric text-ink-2">{formatMoney(carrierCharges)}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted">
                Posted to their own accounts. In the cost of the goods, not in what{' '}
                {suppliers.find((s) => s.id === Number(supplierId))?.name ?? 'this supplier'} is
                owed.
              </p>
            </div>
          )}
        </Card>
      </div>
      {/* The shared product search — the same grid ordering, recipes and
          invoicing use, not a lookup box of its own. What it adds over the old
          picker is the whole catalogue's worth of narrowing: any column the
          store has turned on, the advanced filter, sorting by cost or by what
          last arrived, and tick boxes for adding a dozen at once.

          Recipe products are absent by construction — see
          searchProductsForPurchasePickerAction. A made item is assembled here,
          never delivered, so it is not offered. */}
      <ProductSearchModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add stock"
        description="Search, filter and sort the catalogue. Click a name to add one, or tick several and add them together."
        confirmLabel="Add"
        search={searchProductsForPurchasePickerAction}
        onPick={(p) => addProducts([fromPick(p)])}
        /* Present, so the tick boxes appear: a delivery of thirty lines was
           thirty separate trips through the old dialog. */
        onPickMany={(picks) => addProducts(picks.map(fromPick))}
      />

      <LineImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onLines={addImportedLines}
        noun="delivery lines"
      />

      {/* Discarded rather than marked cancelled: a half-keyed delivery that was
          never posted is an unfinished form, not history. Nothing has moved, so
          nothing is reversed. */}
      <ConfirmModal
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={async () => {
          if (!draftId) return
          const result = await deleteDraftReceiptAction(draftId)
          if (!result.ok) {
            toast.error(result.error)
            return
          }
          toast.success('Draft discarded.')
          router.push('/purchasing')
        }}
        title="Discard this draft?"
        confirmLabel="Discard it"
        cancelLabel="Keep it"
        busy={pending}
        message={
          <p>
            Nothing has been posted, so nothing is reversed — the part-keyed lines are simply
            thrown away. This cannot be undone.
          </p>
        }
      />

      <DocumentScanDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onLines={addScannedLines}
        onHeader={applyScannedHeader}
        supplierId={supplierId ? Number(supplierId) : null}
        searchProducts={searchProductsForPurchaseAction}
        noun="delivery lines"
      />
      </PageBody>
    </>
  )
}

/**
 * The serial numbers arriving on one line.
 *
 * Built around scanning, because that is what actually happens at a delivery:
 * the box is in one hand and the scanner in the other, and a scanner ends its
 * read with Enter. So Enter takes the number and clears the field for the next
 * one, and the box keeps focus throughout.
 *
 * Pasting a whole list is the fallback for a delivery note that arrived as a
 * spreadsheet — splitting on commas, newlines, tabs and semicolons covers every
 * shape one of those turns up in.
 */
function SerialCapture({
  serials,
  warrantyUntil,
  qtyReceived,
  onChange,
}: {
  serials: string[]
  warrantyUntil: string
  qtyReceived: number
  onChange: (patch: { serials?: string[]; warrantyUntil?: string }) => void
}) {
  const [entry, setEntry] = useState('')

  /** Adds one or many, refusing what is already on this line. */
  function take(raw: string) {
    const incoming = raw
      .split(/[\n,;\t]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (incoming.length === 0) return

    const seen = new Set(serials)
    const fresh = incoming.filter((s) => !seen.has(s) && seen.add(s))
    if (fresh.length > 0) onChange({ serials: [...serials, ...fresh] })
    setEntry('')
  }

  const short = qtyReceived - serials.length
  const whole = Number.isInteger(qtyReceived)

  return (
    <div className="my-1.5 rounded-control border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <Icons.Barcode size={15} className="text-muted" />
        <span className="text-sm font-medium text-ink">Serial numbers</span>
        {!whole ? (
          <Badge tone="danger">whole units only</Badge>
        ) : short === 0 ? (
          <Badge tone="success">{serials.length} of {qtyReceived}</Badge>
        ) : (
          <Badge tone="warning">
            {serials.length} of {qtyReceived} — {short > 0 ? `${short} still to scan` : `${-short} too many`}
          </Badge>
        )}
      </div>

      {/*
        The two inputs sit together on one row, packed LEFT — the same shape
        BatchCapture below uses, and for the same reason.

        Warranty until used to be pushed to the far edge by a `justify-between`
        on the heading row, which put it a whole screen away from the serial box
        it belongs with and left it floating above nothing. On a wide grid that
        reads as a stray control rather than as part of this line's capture.

        `items-end` is what actually lines the two boxes up: the fields have
        labels of different lengths above them, so aligning the TOPS would leave
        the inputs themselves at different heights. Bottom-aligned, the two
        boxes share a baseline.
      */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Serial number" className="w-full max-w-md">
          <Input
            value={entry}
            placeholder="Scan or type a serial, then press Enter"
            onChange={(e) => {
              // A scanner that sends its whole payload at once, including the
              // separators, is handled here rather than waiting for Enter.
              if (/[\n,;\t]/.test(e.target.value)) take(e.target.value)
              else setEntry(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Swallowed so a scanner's trailing Enter takes the serial instead
              // of submitting the receipt half-captured.
              e.preventDefault()
              take(entry)
            }}
          />
        </Field>

        <Field label="Warranty until" className="w-44">
          <Input
            type="date"
            value={warrantyUntil}
            onChange={(e) => onChange({ warrantyUntil: e.target.value })}
          />
        </Field>
      </div>

      {serials.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {serials.map((serial, i) => (
            <li key={`${serial}-${i}`}>
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface px-2.5 py-1 text-xs">
                <span className="numeric text-ink-2">{serial}</span>
                <button
                  type="button"
                  aria-label={`Remove serial ${serial}`}
                  onClick={() => onChange({ serials: serials.filter((_, x) => x !== i) })}
                  /* A chip's own remove affordance — smaller than any kit
                     button variant, and inside a pill rather than beside it.
                     data-kit-ok */
                  data-kit-ok
                  className="text-faint transition hover:text-danger"
                >
                  <Icons.Close size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The lot capture for a batch-tracked line (148) — one number, one date,
 * inline under the row like SerialCapture and for the same reason: the
 * delivery note is in the receiver's hand NOW. At least one of the two is
 * required; expiry alone names the lot EXP-<date> server-side.
 */
function BatchCapture({
  batchNo,
  expiryDate,
  onChange,
}: {
  batchNo: string
  expiryDate: string
  onChange: (patch: { batchNo?: string; expiryDate?: string }) => void
}) {
  const filled = !!batchNo.trim() || !!expiryDate.trim()
  return (
    <div className="my-1.5 rounded-control border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2 self-center">
          <Icons.Barcode size={15} className="text-muted" />
          <span className="text-sm font-medium text-ink">Lot</span>
          {filled ? (
            <Badge tone="success">captured</Badge>
          ) : (
            <Badge tone="warning">batch number or expiry needed</Badge>
          )}
        </div>
        <Field label="Batch / lot number" className="w-52">
          <Input
            value={batchNo}
            placeholder="e.g. L2408A"
            onChange={(e) => onChange({ batchNo: e.target.value })}
          />
        </Field>
        <Field label="Expiry date" className="w-44">
          <Input
            type="date"
            value={expiryDate}
            onChange={(e) => onChange({ expiryDate: e.target.value })}
          />
        </Field>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="numeric text-ink-2">{value}</dd>
    </div>
  )
}
