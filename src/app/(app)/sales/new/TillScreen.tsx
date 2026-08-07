'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  Combobox,
  ConfirmModal,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  NumberInput,
  Select,
  useToast,
  TABLE,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { lineTotals, documentTotals } from '@/lib/documentMath'
import { deviceId, deviceLabel } from '@/lib/deviceId'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { Terminal } from '@/lib/site/terminals'
import {
  searchProductsAction,
  scanAction,
  saveSaleAction,
  finaliseSaleAction,
  saveForLaterAction,
  saveAsOrderAction,
  refreshCustomerAction,
} from '../actions'
import { createLaybyAction } from '../laybys/actions'
import { claimTerminalAction } from '../../setup/terminals/actions'
import { tillSignOutAction } from './pinActions'
import TenderPad from './TenderPad'
import CustomerPicker from './CustomerPicker'
import OverridePrompt from './OverridePrompt'

/**
 * The till.
 *
 * One screen, three regions: the basket on the left, the search at the top of
 * it, and the totals plus tender on the right. That layout is not decoration —
 * a cashier's eyes go search → line → total, and putting the total anywhere but
 * beside the basket means looking away from the customer to find it.
 *
 * The basket lives in client state and is only written to the database when the
 * sale is saved or finalised. A draft row per keystroke would fill the table
 * with abandoned baskets, and nothing downstream needs them.
 */

export type BasketLine = {
  /** Stable within the basket only — the database line id does not exist yet. */
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: TillProduct['productType']
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  maxDiscountPct: number
  /** The structure price, so the modal can tell a change from the shelf figure. Null when the product is priced at the counter. */
  shelfPriceIncl: number | null
  allowFractions: boolean
}

/** Product types that carry no quantity, so stock never applies to them. */
const UNSTOCKED: ReadonlySet<string> = new Set(['service', 'buyout'])

/**
 * The stock note beside a search result, or nothing at all.
 *
 * Silent when there is plenty and none of it is spoken for — which is the
 * overwhelmingly common case, and a note on every line is a note nobody reads.
 * It speaks up for the two situations that change what the cashier should say
 * to the customer: some of this is promised to someone else, or there is none.
 */
function stockNote(product: TillProduct): string {
  if (UNSTOCKED.has(product.productType)) return ''

  if (product.reservedQty > 0) {
    return ` · ${formatQty(product.availableQty)} available of ${formatQty(product.stockOnHand)} (${formatQty(product.reservedQty)} on order)`
  }
  if (product.stockOnHand <= 0) return ' · none on hand'
  return ''
}

export default function TillScreen({
  terminals,
  tenders,
  priceStructureId,
  savedCount,
  cashRounding,
  canOverrideDiscount,
  canOverridePrice,
  operatorName,
}: {
  terminals: Terminal[]
  tenders: TenderType[]
  priceStructureId: number | null
  savedCount: number
  cashRounding: number
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /** Who entered a PIN to open this till. */
  operatorName: string
}) {
  const [lines, setLines] = useState<BasketLine[]>([])
  const [documentId, setDocumentId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [customer, setCustomer] = useState<TillCustomer | null>(null)
  const [tendering, setTendering] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [editing, setEditing] = useState<BasketLine | null>(null)
  const [receipt, setReceipt] = useState<{ number: string; change: number } | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()
  const searchRef = useRef<HTMLDivElement>(null)

  // Terminal identity is browser-only, so it is resolved after mount.
  const [device, setDevice] = useState<{ id: string | null; label: string }>({ id: null, label: '' })
  useEffect(() => setDevice({ id: deviceId(), label: deviceLabel() }), [])
  const terminal = device.id ? terminals.find((t) => t.deviceId === device.id) : undefined

  const totals = useMemo(() => {
    const computed = lines.map((line) => ({
      ...lineTotals({
        qty: line.qty,
        unitPriceIncl: line.unitPriceIncl,
        discountPct: line.discountPct,
        vatRatePct: line.vatRatePct,
      }),
      vatRatePct: line.vatRatePct,
    }))
    return { perLine: computed, doc: documentTotals(computed) }
  }, [lines])

  /* ── Search ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }
    // Debounced: a scanner types a whole barcode in milliseconds, and querying
    // on every character of it would fire a dozen useless searches.
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsAction(query, priceStructureId)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query, priceStructureId])

  function addProduct(product: TillProduct, qty = 1) {
    setLines((current) => {
      // Same product again bumps the quantity rather than adding a second line
      // — which is what a cashier scanning three tins expects to see.
      const existing = current.findIndex(
        (l) => l.productId === product.id && l.discountPct === 0,
      )
      if (existing !== -1 && !product.askPriceAtSale) {
        const next = [...current]
        next[existing] = { ...next[existing], qty: round(next[existing].qty + qty, 3) }
        return next
      }

      return [
        ...current,
        {
          key: `${product.id}-${Date.now()}-${current.length}`,
          productId: product.id,
          productCode: product.code,
          description: product.description,
          productType: product.productType,
          departmentId: product.departmentId,
          qty,
          unitPriceIncl: product.scannedPrice ?? product.priceIncl,
          discountPct: 0,
          vatRatePct: product.vatRatePct,
          unitCostExcl: product.costExcl,
          maxDiscountPct: product.maxDiscountPct,
          shelfPriceIncl: product.askPriceAtSale ? null : product.priceIncl,
          allowFractions: product.allowFractions,
        },
      ]
    })

    setQuery('')
    setOptions([])
  }

  /** Handles a scan that the Combobox could not match to a listed option. */
  function onScan(code: string) {
    startTransition(async () => {
      const product = await scanAction(code, priceStructureId)
      if (!product) {
        toast.error(`Nothing found for "${code}".`)
        return
      }
      addProduct(product, product.scannedQty ?? 1)
    })
  }

  function updateLine(key: string, changes: Partial<BasketLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)))
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key))
  }

  function clearBasket() {
    setLines([])
    setDocumentId(null)
    setCustomerName('')
    setClearing(false)
  }

  /* ── Posting ─────────────────────────────────────────────────────────── */

  function salePayload() {
    return {
      // The id is what makes it an ACCOUNT sale; the name alone is a walk-in
      // snapshot on the document and creates no debtor record.
      customerId: customer?.id ?? null,
      customerName: customerName.trim() || 'Walk-in',
      customerVatNo: customer?.vatNumber ?? null,
      customerPhone: customer?.phone ?? null,
      terminalId: terminal?.id ?? null,
      terminalCode: terminal?.code ?? null,
      priceStructureId,
      lines: lines.map((line) => ({
        productId: line.productId,
        productCode: line.productCode,
        description: line.description,
        productType: line.productType,
        departmentId: line.departmentId,
        qty: line.qty,
        unitPriceIncl: line.unitPriceIncl,
        discountPct: line.discountPct,
        vatRatePct: line.vatRatePct,
        unitCostExcl: line.unitCostExcl,
      })),
    }
  }

  function finalise(paid: { tenderTypeId: number; amount: number; reference?: string | null }[]) {
    startTransition(async () => {
      const result = await finaliseSaleAction(documentId, salePayload(), paid)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setTendering(false)
      setReceipt({ number: result.documentNumber, change: result.change })
      clearBasket()
      router.refresh()
    })
  }

  function saveForLater() {
    startTransition(async () => {
      const saved = await saveSaleAction(documentId, salePayload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      const setAside = await saveForLaterAction(saved.documentId)
      if (!setAside.ok) {
        toast.error(setAside.error)
        return
      }
      toast.success('Sale saved.')
      clearBasket()
      router.refresh()
    })
  }

  /**
   * Saves the basket as an order instead of selling it.
   *
   * Nothing posts — the goods stay on the shelf, but reserved, so they stop
   * counting as available to the next customer. The till then goes to the
   * order so a delivery date can be set.
   */
  function saveAsOrder() {
    startTransition(async () => {
      const saved = await saveAsOrderAction(documentId, salePayload())
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      toast.success('Order saved — stock is reserved, nothing has been sold.')
      clearBasket()
      router.push(`/sales/orders/${saved.documentId}`)
    })
  }

  /**
   * Turns the basket into a lay-by.
   *
   * The deposit is whatever the customer hands over now — asked for on the
   * next screen rather than here, because it is a real payment through a real
   * tender and belongs with the other payments, not buried in a save button.
   */
  function saveAsLayby() {
    startTransition(async () => {
      const result = await createLaybyAction({
        customerId: customer!.id,
        terminalId: terminal?.id ?? null,
        lines: lines.map((line) => ({
          productId: line.productId,
          productCode: line.productCode,
          description: line.description,
          productType: line.productType,
          departmentId: line.departmentId,
          qty: line.qty,
          unitPriceIncl: line.unitPriceIncl,
          discountPct: line.discountPct,
          vatRatePct: line.vatRatePct,
          unitCostExcl: line.unitCostExcl,
        })),
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      clearBasket()
      router.push(`/sales/laybys/${result.laybyId}`)
    })
  }

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((product) => ({
    value: String(product.id),
    label: product.description,
    // Stock is only mentioned when a stocked item is short or spoken for.
    // Printing "12 available" beside every line would train the cashier to stop
    // reading it, and the one time it matters is the one time they need to.
    hint: `${product.code}${product.barcode ? ` · ${product.barcode}` : ''}${stockNote(product)}`,
    trailing: formatMoney(product.priceIncl),
    data: product,
  }))

  return (
    <div className="flex flex-1 flex-col gap-4 px-6 pt-4 pb-6 lg:flex-row">
      {/* ── Basket ─────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div ref={searchRef} className="flex items-center gap-2">
          <div className="flex-1">
            <Combobox
              options={comboOptions}
              query={query}
              onQueryChange={setQuery}
              onSelect={(option) => option.data && addProduct(option.data)}
              placeholder="Scan a barcode, or search by code or description…"
              loading={searching}
              autoFocus
              clearOnSelect
              emptyText={
                query.trim().length >= 2 ? 'No product matches — press Enter to scan it.' : 'Keep typing…'
              }
            />
          </div>
          <Button
            variant="ghost"
            onClick={() => query.trim() && onScan(query.trim())}
            disabled={pending || !query.trim()}
          >
            <Icons.Barcode size={15} />
            Scan
          </Button>
        </div>

        <Card className="flex flex-1 flex-col overflow-hidden">
          {lines.length === 0 ? (
            /* Centred in the card's full height, so the layout does not jump
               the moment the first item is scanned. */
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                title="Nothing on this sale yet"
                hint="Scan an item or search for it above."
                icon={<Icons.Receipt size={22} />}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className={TABLE}>
                <tbody>
                  {lines.map((line, index) => {
                    const computed = totals.perLine[index]
                    return (
                      <tr key={line.key} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <div className="text-ink">{line.description}</div>
                          <div className="text-xs text-muted">
                            {line.productCode}
                            {line.discountPct > 0 && (
                              <span className="ml-2 text-warning">−{line.discountPct}%</span>
                            )}
                          </div>
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                          {formatQty(line.qty)} × {formatMoney(line.unitPriceIncl)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                          {formatMoney(computed.lineTotalIncl)}
                        </td>
                        <td className={`${TABLE_TD} w-px`}>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="bare"
                              size="sm"
                              iconOnly
                              aria-label={`Edit ${line.description}`}
                              onClick={() => setEditing(line)}
                            >
                              <Icons.Pencil size={15} />
                            </Button>
                            <Button
                              variant="bare"
                              size="sm"
                              iconOnly
                              aria-label={`Void line: ${line.description}`}
                              title="Void this line"
                              onClick={() => removeLine(line.key)}
                            >
                              <Icons.Close size={15} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* ── Totals and actions ─────────────────────────────────────────── */}
      <div className="flex w-full flex-col gap-3 lg:w-80">
        <Card className="p-4">
          <CustomerPicker
            customer={customer}
            walkInName={customerName}
            onAttach={(next) => {
              setCustomer(next)
              setCustomerName(next.name)
            }}
            onClear={() => {
              setCustomer(null)
              setCustomerName('')
            }}
            onWalkInName={setCustomerName}
          />
        </Card>

        <Card className="p-4">
          <dl className="flex flex-col gap-1.5 text-sm">
            <Row label="Subtotal (excl.)" value={formatMoney(totals.doc.subtotalExcl)} />
            {totals.doc.discountTotal > 0 && (
              <Row label="Discount" value={`−${formatMoney(totals.doc.discountTotal)}`} />
            )}
            {totals.doc.vatByRate.map((rate) => (
              <Row
                key={rate.ratePct}
                label={rate.ratePct > 0 ? `VAT @ ${rate.ratePct}%` : 'Zero-rated'}
                value={formatMoney(rate.vat)}
              />
            ))}
          </dl>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium text-ink">Total</span>
            <span className="numeric text-2xl font-semibold text-ink">
              {formatMoney(totals.doc.totalIncl)}
            </span>
          </div>
        </Card>

        <Button
          variant="success"
          disabled={lines.length === 0 || pending}
          onClick={() => {
            // Re-read the credit position before offering it. The basket may
            // have sat on screen while someone else settled — or used up — the
            // same account at another till.
            if (customer) {
              startTransition(async () => {
                const fresh = await refreshCustomerAction(customer.id)
                if (fresh) setCustomer(fresh)
                setTendering(true)
              })
            } else {
              setTendering(true)
            }
          }}
        >
          <Icons.Banknote size={16} />
          Pay {formatMoney(totals.doc.totalIncl)}
        </Button>

        {/* Pay stays the loudest thing on the rail. Save and Void stay visible
            — they are the two everyday exits — and the occasional exits
            (order, lay-by, recalling a saved sale) share one menu instead of
            stacking three more full-width buttons under the total. */}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            className="flex-1"
            disabled={lines.length === 0 || pending}
            onClick={saveForLater}
          >
            <Icons.Clock size={15} />
            Save
          </Button>
          <Button
            variant="danger-ghost"
            className="flex-1"
            disabled={lines.length === 0 || pending}
            onClick={() => setClearing(true)}
          >
            <Icons.Trash size={15} />
            Void sale
          </Button>
          <Menu label="More" align="right">
            <MenuItem
              onClick={saveAsOrder}
              disabled={lines.length === 0 || pending || !customer}
            >
              <Icons.ListOrdered size={15} />
              Save as order
            </MenuItem>
            <MenuItem
              onClick={saveAsLayby}
              disabled={lines.length === 0 || pending || !customer}
            >
              <Icons.Package size={15} />
              Save as lay-by
            </MenuItem>
            {savedCount > 0 && (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => router.push('/sales?status=saved')}>
                  <Icons.Receipt size={15} />
                  {savedCount} saved sale{savedCount === 1 ? '' : 's'}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>

        <TerminalNotice
          terminal={terminal}
          terminals={terminals}
          device={device}
          pending={pending}
          onClaim={(id) =>
            startTransition(async () => {
              if (!device.id) return
              const result = await claimTerminalAction(id, device.id, device.label)
              if (result.ok) {
                toast.success(result.message)
                router.refresh()
              } else {
                toast.error(result.error)
              }
            })
          }
        />

        {/* Handing the till to the next person: a quiet footer row, not a
            full-width button competing with the sale actions above it. */}
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="truncate text-xs text-muted">Signed in as {operatorName}</span>
          <Button
            variant="bare"
            size="sm"
            iconOnly
            aria-label={`Sign out ${operatorName}`}
            disabled={pending || lines.length > 0}
            title={
              lines.length > 0
                ? 'Finish or clear the sale in progress first.'
                : `Sign out ${operatorName}`
            }
            onClick={() =>
              startTransition(async () => {
                await tillSignOutAction()
                router.refresh()
              })
            }
          >
            <Icons.LogOut size={15} />
          </Button>
        </div>
      </div>

      <TenderPad
        open={tendering}
        onClose={() => setTendering(false)}
        tenders={tenders}
        totalIncl={totals.doc.totalIncl}
        cashRounding={cashRounding}
        customer={customer}
        pending={pending}
        onFinalise={finalise}
      />

      <LineModal
        line={editing}
        canOverrideDiscount={canOverrideDiscount}
        canOverridePrice={canOverridePrice}
        onClose={() => setEditing(null)}
        onSave={(changes) => {
          if (editing) updateLine(editing.key, changes)
          setEditing(null)
        }}
      />

      <ConfirmModal
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={clearBasket}
        title="Void this sale?"
        message="Everything on the basket is discarded. Nothing has been posted, so nothing is recorded and no number is used."
        confirmLabel="Void the sale"
      />

      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />
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

/* ── Terminal ────────────────────────────────────────────────────────────── */

function TerminalNotice({
  terminal,
  terminals,
  device,
  pending,
  onClaim,
}: {
  terminal: Terminal | undefined
  terminals: Terminal[]
  device: { id: string | null; label: string }
  pending: boolean
  onClaim: (id: number) => void
}) {
  const [picking, setPicking] = useState(false)
  const [choice, setChoice] = useState('')

  if (terminal) {
    return (
      <p className="text-center text-xs text-muted">
        <Icons.Terminal size={12} className="mr-1 inline" />
        {terminal.code} — {terminal.name}
      </p>
    )
  }

  const available = terminals.filter((t) => t.isActive)

  return (
    <>
      <Callout
        tone="warning"
        title="Not registered to a till"
        action={
          available.length > 0 && device.id ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPicking(true)}
              disabled={pending}
            >
              <Icons.Terminal size={15} />
              Choose a till
            </Button>
          ) : undefined
        }
      >
        Sales will still post, but they will not say which register rang them up.
      </Callout>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Which till is this?"
        description="Registered once per machine. A manager can move or revoke it later."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!choice || pending}
              onClick={() => {
                onClaim(Number(choice))
                setPicking(false)
              }}
            >
              Use this till
            </Button>
          </>
        }
      >
        <Field label="Till">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">— Choose —</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
                {t.deviceId ? ' (claimed elsewhere)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>
    </>
  )
}

/* ── Line editor ─────────────────────────────────────────────────────────── */

function LineModal({
  line,
  canOverrideDiscount,
  canOverridePrice,
  onClose,
  onSave,
}: {
  line: BasketLine | null
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  onClose: () => void
  onSave: (changes: Partial<BasketLine>) => void
}) {
  const [qty, setQty] = useState(1)
  const [price, setPrice] = useState(0)
  const [discount, setDiscount] = useState(0)
  const [seeded, setSeeded] = useState<string | null>(null)

  /**
   * A supervisor's authorisation, held only while this modal is open.
   *
   * Deliberately per-line and not remembered: authorising one discount is not
   * authorising every discount for the rest of the shift, and a permission
   * that quietly persists is one nobody can reason about afterwards.
   */
  const [authorised, setAuthorised] = useState<{ price: boolean; discount: boolean }>({
    price: false,
    discount: false,
  })
  const [asking, setAsking] = useState<'price' | 'discount' | null>(null)
  const toast = useToast()

  if (line && seeded !== line.key) {
    setSeeded(line.key)
    setQty(line.qty)
    setPrice(line.unitPriceIncl)
    setDiscount(line.discountPct)
    setAuthorised({ price: false, discount: false })
  }
  if (!line && seeded !== null) setSeeded(null)

  // max_discount_pct has been on the product table since the first migration
  // with nothing enforcing it. This is where it finally bites.
  const cap = line?.maxDiscountPct ?? 0
  const mayDiscount = canOverrideDiscount || authorised.discount
  const overCap = cap > 0 && discount > cap && !mayDiscount

  // A product with no shelf price is priced at the counter by design — see
  // priceGuard.ts. Locking its price box would stop the till working.
  const shelf = line?.shelfPriceIncl ?? null
  const mayPrice = canOverridePrice || authorised.price || shelf === null
  const priceChanged = shelf !== null && Math.abs(price - shelf) > 0.005
  const priceLocked = !mayPrice

  return (
    <Modal
      open={line !== null}
      onClose={onClose}
      title={line?.description ?? ''}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={overCap || qty === 0}
            onClick={() => onSave({ qty, unitPriceIncl: price, discountPct: discount })}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Quantity"
          hint={line?.allowFractions ? 'Fractions allowed for this item.' : 'Whole units only.'}
        >
          <NumberInput
            value={qty}
            precision={line?.allowFractions ? 3 : 0}
            onChange={(e) => setQty(Number(e.target.value) || 0)}
          />
        </Field>

        <Field
          label="Unit price (incl. VAT)"
          hint={
            priceLocked
              ? `Sells at ${formatMoney(shelf ?? 0)}. A supervisor can authorise a change.`
              : shelf === null
                ? 'This item is priced at the counter.'
                : authorised.price
                  ? 'Authorised.'
                  : undefined
          }
        >
          <div className="flex items-center gap-2">
            <CurrencyInput
              value={price}
              disabled={priceLocked}
              onChange={(e) => setPrice(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
            {priceLocked && (
              <Button variant="secondary" onClick={() => setAsking('price')}>
                <Icons.KeyRound size={15} />
                Authorise
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="Discount %"
          hint={cap > 0 ? `This item allows up to ${cap}%.` : undefined}
          error={overCap ? `Above the ${cap}% limit for this item.` : undefined}
        >
          <div className="flex items-center gap-2">
            <NumberInput
              value={discount}
              onChange={(e) => setDiscount(Number(e.target.value) || 0)}
            />
            {overCap && (
              <Button variant="secondary" onClick={() => setAsking('discount')}>
                <Icons.KeyRound size={15} />
                Authorise
              </Button>
            )}
          </div>
        </Field>
      </div>

      {asking && (
        <OverridePrompt
          capability={asking === 'price' ? 'sales.price_override' : 'sales.discount_override'}
          title={asking === 'price' ? 'Authorise a price change' : 'Authorise this discount'}
          reason={
            asking === 'price'
              ? `${line?.description ?? 'This item'} sells at ${formatMoney(shelf ?? 0)}.`
              : `${discount}% is above the ${cap}% this item allows.`
          }
          onAuthorised={(by) => {
            setAuthorised((current) => ({ ...current, [asking]: true }))
            setAsking(null)
            // Named rather than a bare "authorised": the cashier should be able
            // to say who approved it if anybody asks later.
            toast.success(`Authorised by ${by}.`)
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </Modal>
  )
}

/* ── Receipt ─────────────────────────────────────────────────────────────── */

function ReceiptModal({
  receipt,
  onClose,
}: {
  receipt: { number: string; change: number } | null
  onClose: () => void
}) {
  return (
    <Modal
      open={receipt !== null}
      onClose={onClose}
      title="Sale complete"
      size="sm"
      footer={
        <>
          {receipt && (
            <Button variant="ghost" onClick={() => window.open(`/sales/print/${receipt.number}`)}>
              <Icons.Printer size={15} />
              Print
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Next sale
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 py-2">
        <Badge tone="success">{receipt?.number}</Badge>
        {receipt && receipt.change > 0 && (
          <div className="text-center">
            <p className="text-sm text-muted">Change due</p>
            <p className="numeric text-3xl font-semibold text-ink">{formatMoney(receipt.change)}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
