'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Switch,
  useToast,
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
      <CardHeader
        title="Prepare a payment run"
        description="Pick the invoices to settle. Nothing is paid until the run is posted."
        action={
          <div className="flex items-center gap-2">
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
            <Button variant="primary" disabled={chosen.length === 0 || pending} onClick={prepare}>
              <Icons.Wallet size={15} />
              {pending ? 'Preparing…' : `Prepare ${formatMoney(total)}`}
            </Button>
          </div>
        }
      />

      <CardBody className="flex flex-wrap items-end gap-4 border-b border-border">
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
        <div className="pb-2">
          <Switch
            checked={overdueOnly}
            onChange={setOverdueOnly}
            label="Only overdue invoices"
            hint="Turn off to pay early."
          />
        </div>
      </CardBody>

      {visible.length === 0 ? (
        <CardBody>
          <p className="text-sm text-muted">
            {overdueOnly
              ? 'Nothing is overdue. Turn off the filter to pay early.'
              : 'Nothing outstanding — every supplier is settled.'}
          </p>
        </CardBody>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((supplier) => {
            const isOpen = expanded.has(supplier.supplierId)
            const chosenHere = supplier.invoices
              .filter((i) => (amounts[i.txnId] ?? 0) > 0)
              .reduce((sum, i) => round(sum + amounts[i.txnId], 2), 0)

            return (
              <div key={supplier.supplierId} className="px-6 py-3">
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
                    /* A disclosure row, not a kit button: it spans the width and
                       carries two lines of its own layout. */
                    data-kit-ok
                    className="flex min-w-0 items-center gap-2 text-left"
                  >
                    <Icons.ChevronRight
                      size={15}
                      className={`shrink-0 text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{supplier.name}</span>
                      <span className="block text-xs text-muted">
                        {supplier.code} · {supplier.invoices.length} invoice
                        {supplier.invoices.length === 1 ? '' : 's'} ·{' '}
                        {formatMoney(supplier.balance)} owing
                        {!supplier.email && <span className="ml-2 text-warning">no email</span>}
                      </span>
                    </span>
                  </button>

                  <div className="flex items-center gap-2">
                    {chosenHere > 0 && <Badge tone="brand">{formatMoney(chosenHere)}</Badge>}
                    <Button variant="ghost" size="sm" onClick={() => payAll(supplier)}>
                      Pay all
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-3 flex flex-col gap-2 pl-6">
                    {supplier.invoices.map((invoice) => (
                      <div
                        key={invoice.txnId}
                        className="flex flex-wrap items-center gap-3 rounded-control border border-border px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink">
                            {invoice.docNumber ?? `#${invoice.txnId}`}
                          </div>
                          <div className="text-xs text-muted">
                            {invoice.docDate}
                            {invoice.daysOverdue > 0 && (
                              <span className="ml-2 text-danger">
                                {invoice.daysOverdue} day{invoice.daysOverdue === 1 ? '' : 's'} overdue
                              </span>
                            )}
                            {invoice.discountAvailable > 0 && (
                              <span className="ml-2 text-success">
                                save {formatMoney(invoice.discountAvailable)} if paid by{' '}
                                {invoice.discountDeadline}
                                {invoice.discountDaysRemaining <= 3 && (
                                  <> — {invoice.discountDaysRemaining === 0
                                    ? 'today'
                                    : `${invoice.discountDaysRemaining} day${invoice.discountDaysRemaining === 1 ? '' : 's'} left`}</>
                                )}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="numeric text-sm text-muted">
                          {formatMoney(invoice.outstanding)} due
                        </div>

                        <div className="w-40">
                          <CurrencyInput
                            value={amounts[invoice.txnId] ?? 0}
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
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {chosen.length > 0 && (
        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-6 py-3">
          <span className="text-sm text-ink-2">
            {chosen.length} supplier{chosen.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-baseline gap-4">
            {/* Stated separately: the amount leaving the bank is the total, but
                the invoices being closed are worth this much more. */}
            {discountTaken > 0 && (
              <span className="text-sm text-success">
                {formatMoney(discountTaken)} discount captured
              </span>
            )}
            <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
          </div>
        </div>
      )}
    </Card>
  )
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
