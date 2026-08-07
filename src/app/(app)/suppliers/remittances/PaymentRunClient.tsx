'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  Input,
  Switch,
  TableToolbar,
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
import { createRunAction } from './actions'

/**
 * Choosing what to pay.
 *
 * Per-invoice, not per-supplier — because a payment run's whole purpose is
 * telling the supplier WHICH invoices the money settles. A screen that only
 * took a total per supplier would make the remittance a guess again, and the
 * guess is what the advice exists to replace.
 *
 * Part payments are first-class: the amount against each invoice is editable,
 * defaulting to what is outstanding.
 */

type Invoice = {
  txnId: number
  docNumber: string | null
  docDate: string
  dueDate: string | null
  outstanding: number
  daysOverdue: number
  /** What paying by the deadline still earns. Zero once the window has passed. */
  discountAvailable: number
  discountDeadline: string | null
  discountDaysRemaining: number
}

type Supplier = {
  supplierId: number
  code: string
  name: string
  email: string | null
  balance: number
  overdueTotal: number
  discountAvailable: number
  nextDiscountDeadline: string | null
  invoices: Invoice[]
}

export default function PaymentRunClient({ suppliers }: { suppliers: Supplier[] }) {
  const [amounts, setAmounts] = useState<Record<number, number>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [paymentDate, setPaymentDate] = useState(todayIso())
  const [reference, setReference] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(true)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  const visible = useMemo(
    () =>
      suppliers
        .map((s) => ({
          ...s,
          invoices: overdueOnly ? s.invoices.filter((i) => i.daysOverdue > 0) : s.invoices,
        }))
        .filter((s) => s.invoices.length > 0),
    [suppliers, overdueOnly],
  )

  const chosen = useMemo(() => {
    return visible
      .map((supplier) => ({
        supplierId: supplier.supplierId,
        name: supplier.name,
        allocations: supplier.invoices
          .filter((i) => (amounts[i.txnId] ?? 0) > 0)
          .map((i) => {
            const amount = amounts[i.txnId]
            // The discount is claimed only when the amount typed settles the
            // invoice net of it, to the cent. Any other figure is an ordinary
            // part payment — the server refuses a discount that does not clear
            // the invoice, and claiming one here would just bounce the run.
            const takesDiscount =
              i.discountAvailable > 0 &&
              round(amount + i.discountAvailable, 2) === round(i.outstanding, 2)
            return {
              txnId: i.txnId,
              amount,
              discount: takesDiscount ? i.discountAvailable : 0,
            }
          }),
      }))
      .filter((p) => p.allocations.length > 0)
  }, [visible, amounts])

  const total = chosen.reduce(
    (sum, p) => round(sum + p.allocations.reduce((s, a) => s + a.amount, 0), 2),
    0,
  )

  /** Discount actually being claimed by the current selection. */
  const discountTaken = chosen.reduce(
    (sum, p) => round(sum + p.allocations.reduce((s, a) => s + a.discount, 0), 2),
    0,
  )

  /** Everything still on offer across the visible suppliers, taken or not. */
  const totalDiscountOnOffer = visible.reduce(
    (sum, s) => round(sum + s.discountAvailable, 2),
    0,
  )

  /** What to pay to settle an invoice: its balance, less any discount on offer. */
  function payableNow(invoice: Invoice): number {
    return round(invoice.outstanding - invoice.discountAvailable, 2)
  }

  function payAll(supplier: Supplier) {
    setAmounts((current) => {
      const next = { ...current }
      for (const invoice of supplier.invoices) next[invoice.txnId] = payableNow(invoice)
      return next
    })
    setExpanded((current) => new Set(current).add(supplier.supplierId))
  }

  function payEverythingOverdue() {
    const next: Record<number, number> = {}
    for (const supplier of visible) {
      for (const invoice of supplier.invoices) {
        if (invoice.daysOverdue > 0) next[invoice.txnId] = payableNow(invoice)
      }
    }
    setAmounts(next)
    setExpanded(new Set(visible.map((s) => s.supplierId)))
  }

  /**
   * Select everything with a discount still on offer.
   *
   * A separate action from "pay everything overdue" because it answers a
   * different question: not "who is chasing us" but "what do we lose by
   * waiting". The two lists barely overlap — a discount window is usually open
   * while an invoice is still well within terms.
   */
  function takeEveryDiscount() {
    const next: Record<number, number> = { ...amounts }
    const touched = new Set(expanded)
    for (const supplier of visible) {
      for (const invoice of supplier.invoices) {
        if (invoice.discountAvailable > 0) {
          next[invoice.txnId] = payableNow(invoice)
          touched.add(supplier.supplierId)
        }
      }
    }
    setAmounts(next)
    setExpanded(touched)
  }

  function prepare() {
    startTransition(async () => {
      const result = await createRunAction({
        paymentDate,
        reference: reference || null,
        payments: chosen.map((p) => ({ supplierId: p.supplierId, allocations: p.allocations })),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      router.push(`/suppliers/remittances/${result.runId}`)
    })
  }

  return (
    <Card>
      {/* One primary per screen: the header keeps only the act of preparing.
          Everything that shapes the selection lives in the toolbar below. */}
      <CardHeader
        title="Prepare a payment run"
        description="Pick the invoices to settle. Nothing is paid until the run is posted."
        action={
          <Button variant="primary" disabled={chosen.length === 0 || pending} onClick={prepare}>
            <Icons.Wallet size={15} />
            {pending ? 'Preparing…' : `Prepare ${formatMoney(total)}`}
          </Button>
        }
      />

      <TableToolbar
        className="border-b border-border px-4 py-3.5"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={payEverythingOverdue} disabled={pending}>
              <Icons.Check size={15} />
              Select everything overdue
            </Button>
            {totalDiscountOnOffer > 0 && (
              <Button variant="ghost" size="sm" onClick={takeEveryDiscount} disabled={pending}>
                <Icons.Percent size={15} />
                Take every discount ({formatMoney(totalDiscountOnOffer)})
              </Button>
            )}
          </>
        }
      >
        <Field label="Payment date" hint="When the money leaves.">
          <Input
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            className="w-44"
          />
        </Field>
        <Field label="Bank reference" hint="Whatever the bank calls the batch.">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. EFT-2026-08"
            className="w-56"
          />
        </Field>
        <Switch
          checked={overdueOnly}
          onChange={setOverdueOnly}
          label="Only overdue invoices"
          hint="Turn off to pay early."
        />
      </TableToolbar>

      {visible.length === 0 ? (
        overdueOnly ? (
          <EmptyState
            title="Nothing is overdue"
            hint="Every invoice is still within terms. Turn off the filter to pay early."
            icon={<Icons.Wallet size={28} strokeWidth={1.75} />}
            action={
              <Button variant="secondary" onClick={() => setOverdueOnly(false)}>
                Show every invoice
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Nothing outstanding"
            hint="Every supplier is settled — there is nothing to pay."
            icon={<Icons.StatusSuccess size={28} strokeWidth={1.75} />}
          />
        )
      ) : (
        /* A table, not stacked flex rows: the outstanding figures and the
           amount boxes each form a column, so the money lines up and a run can
           be checked at a glance. Live inputs justify hand-building it — it
           wears the shared TABLE_* skin so it cannot drift from DataTable. */
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th scope="col" className={TABLE_TH}>
                  Invoice
                </th>
                <th scope="col" className={TABLE_TH}>
                  Date
                </th>
                <th scope="col" className={TABLE_TH}>
                  Status
                </th>
                <th scope="col" className={`${TABLE_TH} text-right`}>
                  Outstanding
                </th>
                <th scope="col" className={`${TABLE_TH} w-44 text-right`}>
                  Paying
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((supplier) => {
                const isOpen = expanded.has(supplier.supplierId)
                const chosenHere = supplier.invoices
                  .filter((i) => (amounts[i.txnId] ?? 0) > 0)
                  .reduce((sum, i) => round(sum + amounts[i.txnId], 2), 0)

                return (
                  <Fragment key={supplier.supplierId}>
                    {/* The supplier is a section header, not a data row. */}
                    <tr className="border-b border-border bg-surface-2">
                      <td colSpan={5} className="px-4 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setExpanded((c) => {
                                const next = new Set(c)
                                next.has(supplier.supplierId)
                                  ? next.delete(supplier.supplierId)
                                  : next.add(supplier.supplierId)
                                return next
                              })
                            }
                            aria-expanded={isOpen}
                            /* A disclosure row, not a kit button: it spans the
                               width and carries two lines of its own layout. */
                            data-kit-ok
                            className="flex min-w-0 items-center gap-2 text-left"
                          >
                            <Icons.ChevronRight
                              size={15}
                              className={`shrink-0 text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-ink">
                                {supplier.name}
                              </span>
                              <span className="block text-xs text-muted">
                                {supplier.code} · {supplier.invoices.length} invoice
                                {supplier.invoices.length === 1 ? '' : 's'} ·{' '}
                                {formatMoney(supplier.balance)} owing
                              </span>
                            </span>
                          </button>

                          <div className="flex items-center gap-2">
                            {/* No email means no remittance advice — worth
                                knowing BEFORE the run is posted. */}
                            {!supplier.email && <Badge tone="warning">No email</Badge>}
                            {chosenHere > 0 && <Badge tone="brand">{formatMoney(chosenHere)}</Badge>}
                            <Button variant="ghost" size="sm" onClick={() => payAll(supplier)}>
                              Pay all
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>

                    {isOpen &&
                      supplier.invoices.map((invoice) => (
                        <tr key={invoice.txnId} className={TABLE_ROW}>
                          <td className={`${TABLE_TD} text-ink`}>
                            {invoice.docNumber ?? `#${invoice.txnId}`}
                          </td>
                          <td className={TABLE_TD}>{invoice.docDate}</td>
                          <td className={TABLE_TD}>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {invoice.daysOverdue > 0 && (
                                <Badge tone="danger">
                                  {invoice.daysOverdue} day{invoice.daysOverdue === 1 ? '' : 's'}{' '}
                                  overdue
                                </Badge>
                              )}
                              {invoice.discountAvailable > 0 && (
                                <Badge tone="success">
                                  Save {formatMoney(invoice.discountAvailable)}
                                  {invoice.discountDaysRemaining <= 3
                                    ? invoice.discountDaysRemaining === 0
                                      ? ' — today only'
                                      : ` — ${invoice.discountDaysRemaining} day${invoice.discountDaysRemaining === 1 ? '' : 's'} left`
                                    : ` by ${invoice.discountDeadline}`}
                                </Badge>
                              )}
                              {invoice.daysOverdue <= 0 && invoice.discountAvailable <= 0 && (
                                <span className="text-xs text-faint">Within terms</span>
                              )}
                            </div>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {formatMoney(invoice.outstanding)}
                          </td>
                          <td className={`${TABLE_TD_INPUT} w-44`}>
                            <CurrencyInput
                              value={amounts[invoice.txnId] ?? 0}
                              aria-label={`Amount to pay against ${invoice.docNumber ?? `invoice ${invoice.txnId}`}`}
                              onChange={(e) => {
                                const typed = Number(String(e.target.value).replace(',', '.')) || 0
                                // Capped at what is outstanding: the server refuses
                                // more anyway, and a field that lets you type an
                                // impossible figure wastes the user's time.
                                setAmounts((c) => ({
                                  ...c,
                                  [invoice.txnId]: Math.min(round(typed, 2), invoice.outstanding),
                                }))
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {chosen.length > 0 && (
        <CardFooter className="justify-between">
          <span className="text-sm text-ink-2">
            {chosen.length} supplier{chosen.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-baseline gap-4">
            {/* Stated separately: the amount leaving the bank is the total, but
                the invoices being closed are worth this much more. */}
            {discountTaken > 0 && (
              <Badge tone="success">{formatMoney(discountTaken)} discount captured</Badge>
            )}
            <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
          </div>
        </CardFooter>
      )}
    </Card>
  )
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
