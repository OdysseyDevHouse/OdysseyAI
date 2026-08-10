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
  PageBody,
  Select,
  Textarea,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import type { TillProduct } from '@/lib/site/tillSearch'
import PurchaseLineGrid, {
  ORDER_DEFAULT_COLUMNS,
  PURCHASE_COLUMNS,
  PURCHASE_COLUMN_IDS,
  type GridLine,
} from './PurchaseLineGrid'
import { purchaseDocumentFigures } from './purchaseLine'
import {
  searchProductsForPurchaseAction,
  agreedPricesAction,
  saveOrderAction,
  issueOrderAction,
} from './actions'

/**
 * Raising a purchase order.
 *
 * An order MOVES NOTHING — no stock, no cost, no ledger. It is a statement of
 * what was asked for, and it exists so that receiving can be checked against
 * it. That is why this screen is so much simpler than receiving: no serials, no
 * location, no average-cost preview, nothing that needs a warning.
 *
 * What it does need is the cost and margin columns, because the decision being
 * made here is "should we buy this, at this price". The shared line grid
 * carries those; see PurchaseLineGrid.
 *
 * Save leaves it a draft. Issue claims the PO number — an order that was never
 * sent should not consume one, for the same reason a saved sale does not.
 */

export type OrderScreenLine = GridLine

export default function OrderScreen({
  suppliers,
  defaultVatRate,
  sellingVatRate,
  existing,
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
}) {
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
        locationId: null,
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
          qtyOrdered: l.qty,
          unitCostExcl: l.unitCostExcl,
          discountPct: l.discountPct,
          discountAmount: l.discountAmount,
          vatRatePct: l.vatRatePct,
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
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader title="The order" description="Who it goes to, and when it is due." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
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
            <CardBody>
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
                locations={[]}
                documentDiscounts={totals.lines.map((l) => l.documentDiscountExcl)}
                charges={totals.lines.map((l) => l.chargeExcl)}
                sellingVatPct={sellingVatRate}
                onPatch={patchLine}
                onRemove={(key) => setLines((c) => c.filter((l) => l.key !== key))}
              />
            )}
          </Card>
        </div>

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
