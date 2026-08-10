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
  PickerResults,
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
import {
  computeSpecials,
  effectiveDiscountPct,
  type Special,
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
} from '@/app/(app)/sales/actions'
import {
  finaliseInvoiceAction,
  getInvoiceCustomerAction,
  saveInvoiceAction,
  type InvoicePayload,
} from '../actions'
import TenderPad from './TenderPad'
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

/**
 * How many products the picker loads at once.
 *
 * Enough that a shop of ordinary size sees its whole catalogue without
 * filtering, and bounded so a chain with fifty thousand lines does not ship all
 * of them to the browser. Past this the dialog says so rather than pretending
 * the list is complete.
 */
const PICKER_LIMIT = 500

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

  /*
   * ── What each line is entitled to ──────────────────────────────────────
   *
   * Recomputed when the lines change, and DELIBERATELY NOT on a timer — unlike
   * the till. A till is worked in seconds and a slip must match the shelf edge
   * right now; an invoice is edited over minutes, and re-pricing it under
   * someone's cursor while they type would be worse than a figure that is a
   * few minutes stale. It refreshes on the next edit or reload.
   */
  const lineSpecials = useMemo(() => {
    if (specials.length === 0) return lines.map(() => undefined)
    return computeSpecials(
      lines.map((l) => ({
        productId: l.productId ?? -1,
        departmentId: l.departmentId ?? null,
        priceIncl: l.unitPriceIncl,
        // A credit line earns nothing — see the engine's note on refunds.
        qty: Math.max(l.qty, 0),
      })),
      specials,
      new Date(),
    ).lineSpecials
  }, [lines, specials])

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
        discountPct: 0,
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
        specialId: lineSpecials[i]?.specialId ?? null,
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
            {/* Not the primary — Finalise is. Opens the search dialog, because
                the dashed entry box below already covers the case where the
                code is known; this is for when it is not. */}
            <Button variant="ghost" onClick={openSearch} disabled={!editable || pending}>
              <Icons.Search size={16} />
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
