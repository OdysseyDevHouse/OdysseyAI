'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ColumnPicker,
  Combobox,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
  Select,
  TableToolbar,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import ChargesEditor, { type ChargeRow } from './ChargesEditor'
import type { TillProduct } from '@/lib/site/tillSearch'
import PurchaseLineGrid, {
  PURCHASE_COLUMNS,
  PURCHASE_COLUMN_IDS,
  RECEIVE_DEFAULT_COLUMNS,
  type GridLine,
} from '../PurchaseLineGrid'
import { purchaseDocumentFigures } from '../purchaseLine'
import {
  searchProductsForPurchaseAction,
  receiveGoodsAction,
  loadOrderAction,
  productPositionsAction,
} from '../actions'

/**
 * Receiving goods.
 *
 * The screen shows what each line will do to the product's average cost BEFORE
 * anything is posted. That is the point: a receipt at an unusual price quietly
 * moves the cost every future margin is measured against, and seeing it in
 * advance is the difference between catching a keying error and finding it in
 * next month's GP report.
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
}

export default function ReceiveScreen({
  suppliers,
  openOrders,
  defaultVatRate,
  sellingVatRate,
  initialOrderId,
  locations,
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
  /** Active stock locations. Always at least one — the main location. */
  locations: StockLocationOption[]
}) {
  // Every new line starts here, so a single-location site never sees the
  // control and a multi-location one gets the sensible default rather than an
  // empty box it must fill in ten times.
  const mainLocationId = locations.find((l) => l.isMain)?.id ?? locations[0]?.id ?? null
  const multiLocation = locations.length > 1
  const [supplierId, setSupplierId] = useState('')
  const [orderId, setOrderId] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [docDiscountPct, setDocDiscountPct] = useState(0)
  const [docDiscountAmount, setDocDiscountAmount] = useState(0)
  const [lines, setLines] = useState<ReceiveLine[]>([])
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()

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
            locationId: mainLocationId,
            serials: [],
            warrantyUntil: '',
            currentAverage: positionFor.get(l.productId ?? -1)?.averageCost ?? 0,
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
        departmentId: product.departmentId,
        qtyOrdered: 0,
        qty: 1,
        qtyBonus: 0,
        unitCostExcl: product.costExcl,
        discountPct: 0,
        discountAmount: 0,
        vatRatePct: defaultVatRate,
        // Inherits whatever the previous line used, so allocating a whole
        // delivery to the warehouse is one choice rather than one per line.
        locationId: current[current.length - 1]?.locationId ?? mainLocationId,
        serials: [],
        warrantyUntil: '',
        currentAverage: product.costExcl,
        currentStock: product.stockOnHand,
        sellIncl: product.priceIncl,
      },
    ])
    setQuery('')
    setOptions([])
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

  function submit() {
    startTransition(async () => {
      const result = await receiveGoodsAction({
        supplierId: Number(supplierId),
        orderId: orderId ? Number(orderId) : null,
        supplierInvoiceNo: invoiceNo || null,
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
          vatRatePct: l.vatRatePct,
          // Only for the lines that carry them, so an ordinary receipt posts
          // exactly the payload it always did.
          serials: l.productType === 'serial' ? l.serials : undefined,
          warrantyUntil: l.productType === 'serial' ? l.warrantyUntil || null : undefined,
        })),
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

  const ready =
    supplierId !== '' &&
    lines.length > 0 &&
    lines.every((l) => l.qty > 0) &&
    serialGaps.length === 0

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: `${p.code} · ${formatQty(p.stockOnHand)} on hand`,
    trailing: formatMoney(p.costExcl),
    data: p,
  }))

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card>
          <CardHeader title="Delivery" description="Who it came from, and what it came with." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
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
              onPatch={patchLine}
              onRemove={(key) => setLines((c) => c.filter((l) => l.key !== key))}
              /* Serial capture, for the lines that need it. Rendered inline
                 rather than behind a dialog: the delivery note is in the
                 receiver's hand now, and a modal per line would make a
                 ten-line delivery ten interruptions. */
              renderAfterRow={(line) => {
                const l = lines.find((x) => x.key === line.key)
                if (!l || l.productType !== 'serial') return null
                return (
                  <SerialCapture
                    serials={l.serials}
                    warrantyUntil={l.warrantyUntil}
                    qtyReceived={l.qty + l.qtyBonus}
                    onChange={(patch) => patchLine(l.key, patch as Partial<GridLine>)}
                  />
                )
              }}
            />
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card className="p-4">
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

        <Button variant="primary" disabled={!ready || pending} onClick={submit}>
          <Icons.PackageOpen size={16} />
          {pending ? 'Receiving…' : 'Receive the goods'}
        </Button>

        {/* Everything that blocks the button is marked at its source — the
            supplier field, a quantity box, or a line's serial badge. The only
            state with nowhere to point is an empty delivery. */}
        {lines.length === 0 && (
          <p className="text-center text-xs text-muted">Add what arrived.</p>
        )}

        <Card className="p-3">
          <p className="text-xs text-muted">
            Receiving moves stock in, blends the landed cost into each product&apos;s average, and
            credits the supplier&apos;s account. It is the only thing in the system that changes
            average cost.
          </p>
        </Card>
      </div>
      </div>
    </PageBody>
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
      <div className="flex flex-wrap items-end justify-between gap-3">
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

        <Field label="Warranty until" className="w-44">
          <Input
            type="date"
            value={warrantyUntil}
            onChange={(e) => onChange({ warrantyUntil: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3 max-w-md">
        <Input
          value={entry}
          placeholder="Scan or type a serial, then press Enter"
          aria-label="Serial number"
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="numeric text-ink-2">{value}</dd>
    </div>
  )
}
