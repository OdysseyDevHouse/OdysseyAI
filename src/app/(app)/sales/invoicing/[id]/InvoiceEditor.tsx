'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
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
import { documentTotals, lineTotals } from '@/lib/documentMath'
import type { SalesDocument } from '@/lib/site/salesDocuments'
import type { PriceStructure, SalesRep } from '@/lib/site/lookups'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import { scanAction, searchProductsAction } from '@/app/(app)/sales/actions'
import {
  finaliseInvoiceAction,
  getInvoiceCustomerAction,
  saveInvoiceAction,
  type InvoicePayload,
} from '../actions'
import TenderPad from '@/app/(app)/sales/new/TenderPad'
import { issueQuoteAction } from '@/app/(app)/sales/quotes/actions'
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

export default function InvoiceEditor({
  document,
  structures,
  reps,
  tenders,
  cashRounding,
  customer: initialCustomer,
  editable,
  canOverrideDiscount,
  canOverridePrice,
  showCost,
}: {
  document: SalesDocument
  structures: PriceStructure[]
  reps: SalesRep[]
  tenders: TenderType[]
  cashRounding: number
  /** The attached account's credit position, or null for a once-off. */
  customer: TillCustomer | null
  editable: boolean
  canOverrideDiscount: boolean
  canOverridePrice: boolean
  /** Whether this person may see cost and margin. */
  showCost: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

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
      salesRepUserId: l.salesRepUserId,
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      vatRatePct: l.vatRatePct,
      unitCostExcl: l.unitCostExcl,
    })),
  )

  const [entry, setEntry] = useState('')
  const entryRef = useRef<HTMLInputElement>(null)

  const [tendering, setTendering] = useState(false)
  const [receipt, setReceipt] = useState<{ number: string; change: number } | null>(null)

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
      if (!cancelled) setCustomer(fresh)
    })
    return () => {
      cancelled = true
    }
  }, [customerId, customer?.id])

  /* ── Totals ──────────────────────────────────────────────────────────── */

  const computed = useMemo(() => {
    const per = lines.map((l) =>
      lineTotals({
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        discountPct: l.discountPct,
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
          // assistant is capturing a whole order.
          salesRepUserId: current[current.length - 1]?.salesRepUserId ?? null,
          qty: 1,
          unitPriceIncl: found.priceIncl,
          discountPct: 0,
          vatRatePct: found.vatRatePct,
          unitCostExcl: found.costExcl,
        },
      ])
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
      customerId,
      customerName: customerName.trim() || null,
      priceStructureId,
      documentDate,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        productCode: l.productCode,
        description: l.description,
        productType: l.productType,
        departmentId: l.departmentId,
        salesRepUserId: l.salesRepUserId,
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        discountPct: l.discountPct,
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
      setReceipt({ number: result.documentNumber, change: result.change })
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

  const isQuote = document.docType === 'quote'
  const noun = isQuote ? 'Quote' : 'Invoice'
  const title = document.documentNumber ?? `${noun} #${document.id}`

  return (
    <>
      <PageHeader
        title={title}
        subtitle={`${customerName || 'No customer'} · ${documentDate}`}
        backHref="/sales/invoicing"
        backLabel="Back to invoicing"
        action={
          <>
            <Badge tone={STATUS_TONE[document.status]}>{STATUS_LABELS[document.status]}</Badge>
            {editable && (
              <>
                <Button
                  variant="secondary"
                  onClick={save}
                  disabled={pending || lines.length === 0}
                >
                  <Icons.Save size={16} />
                  Save (draft)
                </Button>
                {/* A quote takes no payment — it is an offer, not a sale. So
                    the primary action issues it to the customer instead of
                    opening the tender pad. Everything above this point is
                    identical for both, which is the whole reason one editor
                    serves both. */}
                {isQuote ? (
                  <Button onClick={issueQuote} disabled={pending || lines.length === 0}>
                    <Icons.Check size={16} />
                    Issue quote
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
        }
      />

      <PageBody>
        <CustomerBar
          customerId={customerId}
          customerName={customerName}
          editable={editable}
          onPick={(picked) => {
            setCustomerId(picked?.id ?? null)
            setCustomerName(picked?.name ?? '')
          }}
        />

        <Card>
          <div className="flex flex-wrap items-end justify-between gap-4 px-4 py-3.5">
            {/* Not the primary — Finalise is. The dashed entry box below is the
                real affordance; this only moves focus to it. */}
            <Button
              variant="ghost"
              onClick={() => entryRef.current?.focus()}
              disabled={!editable || pending}
            >
              <Icons.Plus size={16} />
              Add product
            </Button>

            <div className="flex flex-wrap items-end gap-3">
              <Field label="Price type" className="w-44">
                <Select
                  value={priceStructureId ?? ''}
                  disabled={!editable}
                  onChange={(e) => setPriceStructureId(e.target.value ? Number(e.target.value) : null)}
                >
                  {structures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Invoice order number" className="w-56">
                <Input
                  value={reference}
                  disabled={!editable}
                  maxLength={64}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>

              <Field label="Invoice date" className="w-44">
                <Input
                  type="date"
                  value={documentDate}
                  disabled={!editable}
                  onChange={(e) => setDocumentDate(e.target.value)}
                />
              </Field>
            </div>
          </div>

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
              <thead>
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
            <CardHeader title="Comment" description="Printed on the invoice." />
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
          pending={pending}
          onFinalise={finalise}
        />

        <Modal
          open={receipt !== null}
          onClose={() => router.push(`/sales/${document.id}`)}
          title="Invoice finalised"
          description={receipt?.number}
          size="sm"
          footer={
            <Button variant="primary" onClick={() => router.push(`/sales/${document.id}`)}>
              View invoice
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">
              {formatMoney(computed.totals.totalIncl)} posted. Stock has moved and the payment is
              recorded against this sale.
            </p>
            {receipt !== null && receipt.change > 0 && (
              <p className="rounded-card bg-success-soft px-4 py-3 text-sm text-success-ink">
                Change due{' '}
                <span className="numeric font-semibold">{formatMoney(receipt.change)}</span>
              </p>
            )}
          </div>
        </Modal>
      </PageBody>
    </>
  )
}
