'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ColumnPicker,
  Combobox,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  PageBody,
  PickerResults,
  Select,
  Textarea,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import type { TillProduct } from '@/lib/site/tillSearch'
import { LineImportDialog } from '@/components/import/LineImportDialog'
import type { LineDraft as ImportedLine } from '@/lib/import/documentLines'
import {
  DocumentScanDialog,
  type ScannedDraft,
} from '@/components/import/DocumentScanDialog'
import PurchaseLineGrid, {
  ORDER_DEFAULT_COLUMNS,
  PURCHASE_COLUMNS,
  PURCHASE_COLUMN_IDS,
  type GridLine,
  type StockLocationOption,
} from './PurchaseLineGrid'
import { purchaseDocumentFigures } from './purchaseLine'
import {
  searchProductsForPurchaseAction,
  browseProductsForPurchaseAction,
  purchaseDepartmentsAction,
  agreedPricesAction,
  saveOrderAction,
  issueOrderAction,
} from './actions'

/**
 * How many products the browse dialog will show at once.
 *
 * The same ceiling receiving uses, for the same reason: a buyer narrows by
 * department or types a few characters, and 500 rows is already more than
 * anyone scrolls. The dialog says when the list was cut short.
 */
const PICKER_LIMIT = 500

/**
 * Raising a purchase order.
 *
 * An order MOVES NOTHING — no stock, no cost, no ledger. It is a statement of
 * what was asked for, and it exists so that receiving can be checked against
 * it. That is why this screen is so much simpler than receiving: no serials, no
 * average-cost preview, nothing that needs a warning.
 *
 * What it does need is the cost and margin columns, because the decision being
 * made here is "should we buy this, at this price". The shared line grid
 * carries those; see PurchaseLineGrid.
 *
 * ── THE LOCATION COLUMN IS A DESTINATION, NOT A MOVEMENT ──────────────────
 *
 * A line can name where its goods are meant to land. That does not weaken the
 * paragraph above: nothing moves here either way, and receiveGoods() is still
 * the only thing that puts stock in a pile. What it records is the buyer's
 * intent — ten cases for the warehouse and two for the shop is known when the
 * order is raised, and rebuilding that split at the door from a delivery note
 * that never carried it is guesswork.
 *
 * Receiving INHERITS it and may override it line by line, because what was
 * intended in January is not a promise about where the pallet actually goes in
 * February. A line left blank means "wherever main is at the time", resolved at
 * receipt rather than pinned here.
 *
 * Save leaves it a draft. Issue claims the PO number — an order that was never
 * sent should not consume one, for the same reason a saved sale does not.
 *
 * ── CHANGING THIS SCREEN? CHANGE receive/ReceiveScreen.tsx WITH IT ────────
 *
 * Ordering and receiving are two documents but ONE flow, and the same person
 * works both in the same afternoon. They are separate files because a GRV
 * carries what an order cannot — their invoice number and total, freight and
 * charges, serial numbers — not because they are allowed to look like two
 * different products.
 *
 * So a layout change here is only half a change:
 *
 *   • The LINE GRID is shared already — edit ./PurchaseLineGrid.tsx and it
 *     lands on both. Never patch grid behaviour inside this file.
 *   • Card order, headings, the product search row, the totals panel, where the
 *     primary button sits, the explanatory footnote under it: mirror it in
 *     ReceiveScreen so the two screens still read as the same screen.
 *   • Something genuinely ordering-only (lead time, expected date, the minimum
 *     order warning) is a field ReceiveScreen simply omits — that is fine.
 *     Moving a card both screens have, and moving it only here, is not.
 *
 * Supplier returns ([id]/return/ReturnScreen.tsx) follow the same shape.
 */

export type OrderScreenLine = GridLine

export default function OrderScreen({
  suppliers,
  defaultVatRate,
  sellingVatRate,
  locations,
  existing,
  scanConfigured = false,
}: {
  suppliers: {
    id: number
    code: string
    name: string
    terms: number
    /** Typical days from order to delivery. Seeds the expected date. */
    leadTimeDays: number
    /** What they will not deliver below. Warned about, never enforced. */
    minimumOrder: number
  }[]
  defaultVatRate: number
  sellingVatRate: number
  /** Active stock locations. Always at least one — the main location. */
  locations: StockLocationOption[]
  /** Set when editing a draft. Absent when raising a new order. */
  existing?: {
    id: number
    supplierId: number
    documentDate: string
    expectedDate: string | null
    supplierOrderNo: string | null
    reference: string | null
    notes: string | null
    lines: OrderScreenLine[]
  }
  /**
   * Whether reading a PDF is set up at all. Decided on the server because the
   * key lives there — a client check would either leak it or lie.
   */
  scanConfigured?: boolean
}) {
  // Every new line starts here, so a single-location site never sees the
  // control and a multi-location one gets the sensible default rather than an
  // empty box it must fill in ten times. Receiving seeds itself the same way.
  const mainLocationId = locations.find((l) => l.isMain)?.id ?? locations[0]?.id ?? null
  const multiLocation = locations.length > 1
  const [supplierId, setSupplierId] = useState(existing ? String(existing.supplierId) : '')
  const [documentDate, setDocumentDate] = useState(existing?.documentDate ?? todayIso())
  const [expectedDate, setExpectedDate] = useState(existing?.expectedDate ?? '')
  const [supplierOrderNo, setSupplierOrderNo] = useState(existing?.supplierOrderNo ?? '')
  const [reference, setReference] = useState(existing?.reference ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [lines, setLines] = useState<OrderScreenLine[]>(existing?.lines ?? [])
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()

  /* The browse dialog, the same one receiving uses. Distinct from the Combobox
     above it, which answers keystrokes: this one answers "show me what is in
     Groceries" with no term at all, which is how a buyer works down a
     supplier's catalogue for things they cannot spell. */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [pickerTerm, setPickerTerm] = useState('')
  const [pickerDept, setPickerDept] = useState<number | null>(null)
  const [pickerResults, setPickerResults] = useState<TillProduct[]>([])
  const [pickerBusy, setPickerBusy] = useState(false)
  const [depts, setDepts] = useState<{ id: number; name: string; depth: number }[]>([])

  const columns = useColumnPrefs(
    'odyssey.purchasing.order.columns',
    ORDER_DEFAULT_COLUMNS,
    PURCHASE_COLUMN_IDS,
  )

  const toast = useToast()
  const router = useRouter()

  const supplier = suppliers.find((s) => s.id === Number(supplierId))

  // Their usual lead time, offered rather than imposed: the buyer can always
  // type a date the supplier has promised for this particular order.
  useEffect(() => {
    if (!supplier || supplier.leadTimeDays <= 0 || expectedDate) return
    const when = new Date(`${documentDate}T00:00:00`)
    when.setDate(when.getDate() + supplier.leadTimeDays)
    setExpectedDate(when.toISOString().slice(0, 10))
    // Only when the supplier changes — retyping the date must not be undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplier?.id])

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

  // The department filter, fetched once the dialog is first opened rather than
  // on page load: most orders are keyed from the search box and never open it.
  useEffect(() => {
    if (!pickerOpen || depts.length > 0) return
    purchaseDepartmentsAction().then(setDepts).catch(() => setDepts([]))
  }, [pickerOpen, depts.length])

  // Results follow the term and the department. Debounced like the Combobox,
  // and it runs with an EMPTY term too — that is the whole point of browsing.
  useEffect(() => {
    if (!pickerOpen) return
    setPickerBusy(true)
    const timer = setTimeout(() => {
      browseProductsForPurchaseAction({
        term: pickerTerm.trim() || undefined,
        departmentId: pickerDept,
        limit: PICKER_LIMIT,
      })
        .then(setPickerResults)
        .catch(() => setPickerResults([]))
        .finally(() => setPickerBusy(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [pickerOpen, pickerTerm, pickerDept])

  function patchLine(key: string, patch: Partial<GridLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  /**
   * Replaces line costs with what the supplier has AGREED to charge.
   *
   * Runs when a product is added and when the supplier changes: the same
   * product from two suppliers is two different prices, and an order that kept
   * the first supplier's would go out wrong. Falls back silently to whatever
   * the line already carries — a product they have never quoted still orders
   * at last cost, which is what ordering did before price lists existed.
   */
  function applyAgreedPrices(forSupplierId: number, candidates: OrderScreenLine[]) {
    const ids = candidates.map((l) => l.productId).filter((id): id is number => id !== null)
    if (!forSupplierId || ids.length === 0) return

    startTransition(async () => {
      const agreed = await agreedPricesAction(forSupplierId, ids)
      if (agreed.length === 0) return
      const byProduct = new Map(agreed.map((a) => [a.productId, a]))

      setLines((current) =>
        current.map((l) => {
          const price = l.productId === null ? undefined : byProduct.get(l.productId)
          return price ? { ...l, unitCostExcl: price.costExcl } : l
        }),
      )
    })
  }

  function addProduct(product: TillProduct) {
    setLines((current) => [
      ...current,
      {
        key: `${product.id}-${Date.now()}`,
        productId: product.id,
        productCode: product.code,
        supplierCode: '',
        description: product.description,
        productType: product.productType,
        qtyOrdered: 1,
        qty: 1,
        qtyBonus: 0,
        unitCostExcl: product.costExcl,
        discountPct: 0,
        discountAmount: 0,
        vatRatePct: defaultVatRate,
        // Inherits whatever the previous line used, so ordering a whole pallet
        // for the warehouse is one choice rather than one per line. The same
        // rule receiving follows.
        locationId: current[current.length - 1]?.locationId ?? mainLocationId,
        currentAverage: product.costExcl,
        lastCost: product.costExcl,
        currentStock: product.stockOnHand,
        sellIncl: product.priceIncl,
      },
    ])
    setQuery('')
    setOptions([])

    // Their agreed price beats the product's last cost, if they have quoted
    // one. Fetched after the line is on screen rather than before, so adding a
    // product is never gated on a round trip.
    if (supplierId) {
      applyAgreedPrices(Number(supplierId), [
        { productId: product.id } as OrderScreenLine,
      ])
    }
  }

  /**
   * Lines from a spreadsheet, in the same shape `addProduct` builds.
   *
   * A cost the file did not carry stays null there and falls back to the
   * product's last cost, exactly as if the line had been added by hand — the
   * import fills the grid in, it does not invent figures for it. Their agreed
   * prices are applied afterwards for the same reason they are on a hand-added
   * line: a quoted price beats a historic one.
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
          qtyOrdered: row.qty,
          qty: row.qty,
          qtyBonus: 0,
          unitCostExcl: row.unitCostExcl ?? 0,
          discountPct: row.discountPct ?? 0,
          discountAmount: 0,
          vatRatePct: defaultVatRate,
          // A file that names a room is honoured, exactly as on a delivery
          // note: one order split across two buildings is a spreadsheet
          // column, not ten dropdowns.
          locationId: locationIdFor(row.locationCode) ?? inherited,
          currentAverage: 0,
          lastCost: 0,
          currentStock: 0,
          sellIncl: 0,
        })),
      ]
    })

    if (supplierId) {
      applyAgreedPrices(
        Number(supplierId),
        imported.map((row) => ({ productId: row.productId }) as OrderScreenLine),
      )
    }
  }

  /**
   * Lines read off a supplier's quote.
   *
   * Routed through addImportedLines rather than repeating it: once resolved, a
   * scanned line and an imported one are the same thing, and two copies of the
   * mapping would drift the first time the grid gained a column. That also
   * means a scan gets the agreed-price pass for free, which matters more here
   * than on a delivery — a quote is a proposal, and what we have agreed with
   * them beats what their PDF happens to print.
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

  /** A location named in the file, by code or by name. Null falls back. */
  function locationIdFor(code: string | null): number | null {
    if (!code) return null
    const wanted = code.trim().toLowerCase()
    const match = locations.find(
      (l) => l.code.toLowerCase() === wanted || l.name.toLowerCase() === wanted,
    )
    return match?.id ?? null
  }

  const totals = useMemo(() => purchaseDocumentFigures(lines), [lines])

  const ready = supplierId !== '' && lines.length > 0 && lines.every((l) => l.qty > 0)

  /** Saves, and optionally issues in the same click. */
  function save(thenIssue: boolean) {
    startTransition(async () => {
      const result = await saveOrderAction(existing?.id ?? null, {
        supplierId: Number(supplierId),
        documentDate,
        expectedDate: expectedDate || null,
        supplierOrderNo: supplierOrderNo || null,
        reference: reference || null,
        notes: notes || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          productCode: l.productCode,
          supplierCode: l.supplierCode || null,
          description: l.description,
          productType: l.productType,
          departmentId: null,
          locationId: l.locationId,
          qtyOrdered: l.qty,
          unitCostExcl: l.unitCostExcl,
          discountPct: l.discountPct,
          discountAmount: l.discountAmount,
          vatRatePct: l.vatRatePct,
          // Carried straight back (163). saveOrder rewrites its lines wholesale,
          // so a line raised from a job part request loses its job the moment
          // somebody edits the order unless this makes the round trip.
          jobCardLineId: l.jobCardLineId ?? null,
        })),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      if (!thenIssue) {
        toast.success('Order saved as a draft.')
        router.push(`/purchasing/${result.id}`)
        return
      }

      // Issued in the same click, but as a SECOND call: issueOrder claims the
      // number and moves the status, and it refuses anything that is not a
      // clean draft. Folding it into the save would hide that refusal.
      const issued = await issueOrderAction(result.id)
      if (!issued.ok) {
        toast.error(issued.error)
        router.push(`/purchasing/${result.id}`)
        return
      }
      toast.success('Order issued to the supplier.')
      router.push(`/purchasing/${result.id}`)
    })
  }

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: `${p.code} · ${formatQty(p.stockOnHand)} on hand`,
    trailing: formatMoney(p.costExcl),
    data: p,
  }))

  return (
    <PageBody>
      {/* The header card across the top and the LINE GRID FULL WIDTH below it,
          which is receiving's shape and for receiving's reason: the grid
          carries up to twenty columns — cost, markup, GP, selling price — and
          squeezing that into two thirds of the page made the buyer scroll
          sideways to see figures that only mean anything beside each other.
          The order header is read once; the grid is worked in. */}
      <Card>
        <CardHeader title="The order" description="Who it goes to, and when it is due." />
        {/* THREE across, where receiving's Delivery card is four. Deliberate:
            six fields at three columns is two full rows, and the same six at
            four would leave a ragged 4 + 2. The shared shape is the one that
            matters — one full-width header card, the line grid below it — not
            an identical column count. */}
        <CardBody className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field
                label="Supplier"
                error={
                  lines.length > 0 && supplierId === '' ? 'Choose who to order from.' : undefined
                }
                hint={
                  supplier && supplier.leadTimeDays > 0
                    ? `Usually ${supplier.leadTimeDays} days to deliver.`
                    : undefined
                }
              >
                <Select
                  value={supplierId}
                  onChange={(e) => {
                    setSupplierId(e.target.value)
                    // Reprice everything already on the order: the same
                    // product from two suppliers is two different prices, and
                    // keeping the old one would send the order out wrong.
                    applyAgreedPrices(Number(e.target.value), lines)
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

              <Field label="Order date">
                <Input
                  type="date"
                  value={documentDate}
                  onChange={(e) => setDocumentDate(e.target.value)}
                />
              </Field>

              <Field label="Expected" hint="What a late-delivery chase is measured against.">
                <Input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </Field>

              <Field label="Their order number" hint="Quote it when chasing them.">
                <Input
                  value={supplierOrderNo}
                  onChange={(e) => setSupplierOrderNo(e.target.value)}
                />
              </Field>

              <Field label="Reference">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>

              <Field label="Notes" hint="Printed on the order.">
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What to order"
          description="Costs are exclusive of VAT — how a supplier quotes."
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
          {/* Two ways in, because an order is built two ways. The box is for
              something whose code you know; the button is for working down a
              supplier's catalogue of things you do not. */}
          {/* Capped rather than filling the row, matching the receive screen: a
              search field is sized by what gets typed into it, and one stretched
              across a wide screen strands the button it belongs with at the far
              edge. */}
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
            {/* A third way in, for a supplier who sends the order as a
                spreadsheet. It fills this grid rather than posting anything —
                the lines still get checked and issued the normal way. */}
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              <Icons.Upload size={16} />
              Import
            </Button>
            {/* And a fourth, for the supplier who sends a quote as a PDF.
                Hidden rather than disabled with no API key: a button that can
                only explain why it does not work is worse than no button. */}
            {scanConfigured && (
              <Button variant="ghost" onClick={() => setScanOpen(true)}>
                <Icons.Sparkles size={16} />
                Read a PDF
              </Button>
            )}
          </div>

          {/* Most orders are for one place. Setting each line separately is
              what the per-line control is for; this is the common case. The
              receive screen carries the same control in the same spot. */}
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
            title="Nothing on this order yet"
            hint="Search for a product above to add the first line."
            icon={<Icons.Truck size={22} />}
          />
        ) : (
          <PurchaseLineGrid
            lines={lines}
            visible={columns.visible}
            mode="order"
            locations={locations}
            documentDiscounts={totals.lines.map((l) => l.documentDiscountExcl)}
            charges={totals.lines.map((l) => l.chargeExcl)}
            sellingVatPct={sellingVatRate}
            onPatch={patchLine}
            onRemove={(key) => setLines((c) => c.filter((l) => l.key !== key))}
          />
        )}
      </Card>

      {/* The totals and the two buttons, kept to the right-hand third under the
          grid — receiving's placement. Full width would put a lone "Issue to
          supplier" across a 2,000px screen, which reads as a page footer rather
          than the one act this screen exists for. */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-start-3">
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Goods (excl.)" value={formatMoney(totals.taxableExcl)} />
              <Row label="VAT" value={formatMoney(totals.vatTotal)} />
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-medium text-ink">Order total</span>
              <span className="numeric text-xl font-semibold text-ink">
                {formatMoney(totals.totalIncl)}
              </span>
            </div>
          </Card>

          {/* Their delivery floor. A warning rather than a block: a supplier
              will often take a small order, and the buyer is better placed
              than this screen to know whether this one is worth the call. */}
          {supplier && supplier.minimumOrder > 0 && totals.taxableExcl < supplier.minimumOrder && (
            <Card className="p-3">
              <p className="text-xs text-warning">
                {supplier.name} usually asks for at least{' '}
                <span className="numeric">{formatMoney(supplier.minimumOrder)}</span>.
              </p>
            </Card>
          )}

          <Button variant="primary" disabled={!ready || pending} onClick={() => save(true)}>
            <Icons.Send size={16} />
            {pending ? 'Saving…' : 'Issue to supplier'}
          </Button>

          <Button variant="ghost" disabled={!ready || pending} onClick={() => save(false)}>
            Save as draft
          </Button>

          {lines.length === 0 && (
            <p className="text-center text-xs text-muted">Add what you want to order.</p>
          )}

          <Card className="p-3">
            <p className="text-xs text-muted">
              An order moves nothing — no stock, no cost, no ledger. It records what was asked for,
              so that a delivery can be checked against it. The PO number is claimed when it is
              issued, not while it is a draft.
            </p>
          </Card>
        </div>
        </div>
      </div>

      {/* Stays OPEN after each pick, so an order of fifteen lines is fifteen
          clicks rather than fifteen round trips through a button. Each pick
          shows a toast, which is the only feedback that the row landed on a
          grid the dialog is covering. */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add stock"
        description="Browse by department, or search by code, barcode or description. Each one you pick goes straight onto the order."
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setPickerOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search" className="min-w-64 flex-1">
              <Input
                autoFocus
                value={pickerTerm}
                placeholder="Code, barcode or description…"
                aria-label="Search products to add to this order"
                icon={<Icons.Search size={15} />}
                onChange={(e) => setPickerTerm(e.target.value)}
                onKeyDown={(e) => {
                  // Enter takes the first match, so a search that has already
                  // narrowed to one thing needs no reach for the mouse.
                  if (e.key === 'Enter' && pickerResults[0]) {
                    e.preventDefault()
                    addProduct(pickerResults[0])
                    toast.success(`${pickerResults[0].description} added.`)
                  }
                }}
              />
            </Field>

            <Field label="Department" className="w-60">
              <Select
                value={pickerDept ?? ''}
                aria-label="Filter products by department"
                onChange={(e) => setPickerDept(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">All departments</option>
                {depts.map((d) => (
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
            {pickerBusy && pickerResults.length === 0 ? (
              <p className="px-1 py-3 text-sm text-muted">Loading products…</p>
            ) : pickerResults.length === 0 ? (
              <p className="px-1 py-3 text-sm text-muted">
                {pickerTerm.trim()
                  ? `Nothing matches “${pickerTerm.trim()}”${pickerDept !== null ? ' in this department' : ''}.`
                  : 'No products in this department.'}
              </p>
            ) : (
              <PickerResults
                results={pickerResults.map((p) => ({
                  key: p.id,
                  label: p.description,
                  // On hand and the cost, because those are the two figures a
                  // buyer checks before deciding to order more.
                  meta: `${p.code} · ${formatQty(p.stockOnHand)} on hand`,
                  trailing: formatMoney(p.costExcl),
                }))}
                onPick={(key) => {
                  const product = pickerResults.find((p) => p.id === Number(key))
                  if (!product) return
                  addProduct(product)
                  toast.success(`${product.description} added.`)
                }}
              />
            )}
          </div>

          {/* Say so when the list is cut short. A picker that silently shows
              the first 500 of 40,000 looks like a complete catalogue, and the
              product someone cannot find is the one they conclude the shop
              does not stock. */}
          {pickerResults.length >= PICKER_LIMIT && (
            <p className="px-1 text-xs text-muted">
              Showing the first <span className="numeric">{PICKER_LIMIT}</span> products. Narrow by
              department or search to see the rest.
            </p>
          )}
        </div>
      </Modal>

      <LineImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onLines={addImportedLines}
        noun="order lines"
      />

      {/* No onHeader: an order has nowhere to put their invoice number or
          total, and the supplier's own reference is the buyer's to type. */}
      <DocumentScanDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onLines={addScannedLines}
        supplierId={supplierId ? Number(supplierId) : null}
        searchProducts={searchProductsForPurchaseAction}
        noun="order lines"
      />
    </PageBody>
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

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}
