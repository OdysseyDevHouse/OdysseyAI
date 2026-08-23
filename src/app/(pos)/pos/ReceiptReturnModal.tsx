'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  TouchRow,
  useToast,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import type { PickableReason, SegmentedOption } from '@/components/ui'
import type { TenderType } from '@/lib/site/tenderTypes'
import {
  findReceiptAction,
  recentReceiptsAction,
  type ReceiptLookup,
  type ReceiptRange,
  type ReceiptSummary,
} from './returnActions'

type FoundInvoice = Extract<ReceiptLookup, { ok: true }>['invoice']

/**
 * The quick windows across the top of the list.
 *
 * Three, not a date picker: a return is a recent-sale act — same day, or the
 * week if it is a gift — and a till has neither the screen nor the patience for
 * a calendar. Anything older is a back-office credit, where the customer's
 * account is the better way in anyway.
 */
const RANGES: readonly SegmentedOption<ReceiptRange>[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'Last 7 days' },
]

export type ReceiptReturnPick = {
  invoiceId: number
  invoiceNumber: string
  lines: { sourceLineId: number; qty: number }[]
  reasonId: number
  note: string | null
  /** What the picked lines credit, at the ORIGINAL sold prices. */
  total: number
}

/**
 * A return WITH the slip: find the invoice, pick what is coming back, and
 * either refund it now or put the credit toward a replacement (exchange).
 *
 * The prices shown are what the customer PAID — the server re-reads them from
 * the invoice and never trusts this screen. The stepper caps at what is still
 * creditable across every credit note ever raised on the invoice.
 *
 * V1 refunds through ONE tender (defaulting to how they paid); a split refund
 * is the back-office credit screen's job. Online only — the over-credit guard
 * needs every credit note, which a till cannot know offline.
 */
export default function ReceiptReturnModal({
  open,
  online,
  reasons,
  tenders,
  busy,
  onClose,
  onRefund,
  onExchange,
  listReceipts = recentReceiptsAction,
  findReceipt = findReceiptAction,
}: {
  open: boolean
  online: boolean
  reasons: PickableReason[]
  tenders: TenderType[]
  busy: boolean
  onClose: () => void
  /** Credit now, money back through one tender. */
  onRefund: (pick: ReceiptReturnPick, refundTenderTypeId: number) => void
  /** Hold the credit — the till goes into exchange mode for the replacement. */
  onExchange: (pick: ReceiptReturnPick) => void
  /*
   * The two reads, injectable — defaulted to the real actions so the till passes
   * neither. They exist for the Style Guide: /pos is behind a clerk PIN, so the
   * only way to LOOK at this screen is to render it with fixtures, and a
   * component that reaches for a server action directly cannot be. Same reason
   * SplitBillModal takes `loadDestinationLines` as a prop.
   */
  listReceipts?: typeof recentReceiptsAction
  findReceipt?: typeof findReceiptAction
}) {
  const toast = useToast()
  const [scan, setScan] = useState('')
  const [looking, setLooking] = useState(false)
  const [invoice, setInvoice] = useState<FoundInvoice | null>(null)
  const [qtys, setQtys] = useState<Record<number, number>>({})
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [refundTender, setRefundTender] = useState<number | null>(null)

  /* The browse list. `range` is the tapped window; `scan` doubles as its search
     box, because a cashier who HAS the number and one who is hunting for the
     sale are doing the same thing with one field. */
  const [range, setRange] = useState<ReceiptRange>('today')
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([])
  const [listing, setListing] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (!open) return
    setScan('')
    setInvoice(null)
    setQtys({})
    setReasonId(reasons[0]?.id ?? null)
    setNote('')
    setRefundTender(null)
    setRange('today')
  }, [open, reasons])

  const refundable = useMemo(() => tenders.filter((t) => t.allowsRefund), [tenders])

  /**
   * Loads the list for the current window and search.
   *
   * Debounced on the search text rather than fired per keystroke: a scanner
   * delivers a whole number as a burst of keydowns, and a request per character
   * would put a dozen queries on the wire and race their answers back in an
   * order nobody controls. 250ms is under the gap between two scans and over
   * the gap between two characters of one.
   */
  const loadList = useCallback(
    async (nextRange: ReceiptRange, search: string) => {
      setListing(true)
      try {
        const result = await listReceipts({ range: nextRange, search })
        if (!result.ok) {
          toast.error(result.error)
          setReceipts([])
          setTruncated(false)
          return
        }
        setReceipts(result.receipts)
        setTruncated(result.truncated)
      } finally {
        setListing(false)
      }
    },
    [toast, listReceipts],
  )

  useEffect(() => {
    // Only while the list is the thing on screen: an invoice is open means the
    // cashier is picking lines, and refetching behind them is pure waste.
    if (!open || !online || invoice) return
    const search = scan.trim()
    const timer = window.setTimeout(() => void loadList(range, search), search ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [open, online, invoice, range, scan, loadList])

  /** Opens one sale from the list — the same lookup the typed number runs. */
  const openReceipt = useCallback(
    async (number: string) => {
      if (!number.trim()) return
      setLooking(true)
      try {
        const result = await findReceipt(number)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setInvoice(result.invoice)
        setQtys({})
        /* Default the refund to how they paid, when that tender can pay out —
           cash otherwise. The cashier can still change it. */
        const paid = result.invoice.tenders
          .map((t) => refundable.find((r) => r.id === t.tenderTypeId))
          .find((t) => t !== undefined)
        setRefundTender(
          paid?.id ?? refundable.find((t) => t.code === 'CASH')?.id ?? refundable[0]?.id ?? null,
        )
      } finally {
        setLooking(false)
      }
    },
    [refundable, toast, findReceipt],
  )

  const picked = useMemo(() => {
    if (!invoice) return []
    return invoice.lines
      .filter((l) => (qtys[l.lineId] ?? 0) > 0)
      .map((l) => ({ line: l, qty: Math.min(qtys[l.lineId] ?? 0, l.creditable) }))
  }, [invoice, qtys])

  const total = useMemo(
    () => round(picked.reduce((sum, p) => sum + round(p.qty * p.line.unitPriceIncl, 2), 0), 2),
    [picked],
  )

  function pickOf(): ReceiptReturnPick | null {
    if (!invoice || picked.length === 0 || !reasonId) return null
    return {
      invoiceId: invoice.documentId,
      invoiceNumber: invoice.documentNumber,
      lines: picked.map((p) => ({ sourceLineId: p.line.lineId, qty: p.qty })),
      reasonId,
      note: note.trim() || null,
      total,
    }
  }

  const ready = picked.length > 0 && reasonId !== null

  const searching = scan.trim().length > 0
  /* Whether every row on screen is from the same day. A search spans 90 days by
     design, so it is never one day however the window is set. */
  const oneDay = !searching && range !== 'week'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Return against a receipt"
      size="lg"
      /* The filter strip is a subheader rather than the first thing in the body
         so it stays PUT while a long day's sales scroll under it — the whole
         point of the control is saying which slice you are looking at. Only
         while the list is on screen: once a sale is open the strip would filter
         nothing. */
      subheader={
        online && !invoice ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SegmentedControl
              options={RANGES}
              value={range}
              onChange={setRange}
              aria-label="Which sales to show"
              className="shrink-0"
            />
            <Input
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                /* Enter on an exact number opens it straight away — a scanner
                   ends its burst with one, so scanning a slip skips the list
                   entirely rather than making the cashier tap the single row
                   it just filtered down to. */
                if (e.key === 'Enter') void openReceipt(scan)
              }}
              icon={<Icons.Search size={15} />}
              placeholder="Invoice number or customer"
              aria-label="Search for a sale"
              className="sm:flex-1"
              autoFocus
            />
          </div>
        ) : undefined
      }
    >
      {!online ? (
        <Callout tone="brand" title="Receipted returns need the connection">
          Checking what has already been credited needs the server. A no-receipt return
          still works offline — use the Return toggle on the sale pane.
        </Callout>
      ) : !invoice ? (
        <div className="flex flex-col gap-2">
          {/* Said above the list, because it changes what the list MEANS: a
              search ignores the window and looks back three months.

              Suppressed when there is nothing to describe — the empty state
              below carries the instruction in that case, and two of them at
              once contradicted each other ("tap the sale" over no sales). */}
          {receipts.length > 0 && (
            <p className="text-xs text-muted">
              {searching
                ? 'Searching the last 90 days — the window above is ignored while you are typing.'
                : 'Tap the sale that is coming back.'}
            </p>
          )}

          {listing && receipts.length === 0 ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-card" />
              ))}
            </div>
          ) : receipts.length === 0 ? (
            <EmptyState
              icon={<Icons.Receipt size={22} />}
              title={searching ? 'Nothing matched' : 'No sales in this window'}
              hint={
                searching
                  ? 'Check the number on the slip, or try the customer’s name.'
                  : range === 'week'
                    ? 'Nothing was sold on this site in the last seven days. Type a number to look further back.'
                    : `Try ${range === 'today' ? 'yesterday' : 'today'} or the last seven days — or type the number from the slip.`
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {receipts.map((receipt) => (
                <li key={receipt.documentId}>
                  <TouchRow
                    className="w-full"
                    title={receipt.documentNumber}
                    subtitle={[
                      /* A single-day window shows the bare time — it is the
                         fastest thing to match against what the customer
                         remembers, and the day is already stated by the filter.
                         A window that spans days must name the day too, or two
                         rows an hour apart read as the same afternoon. */
                      oneDay
                        ? receipt.finalisedAt ?? receipt.documentDate
                        : [receipt.documentDate, receipt.finalisedAt].filter(Boolean).join(' '),
                      receipt.customerName ?? 'Walk-in',
                      receipt.terminalCode ?? null,
                      receipt.userName || null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    disabled={looking || busy}
                    onClick={() => void openReceipt(receipt.documentNumber)}
                    trailing={
                      <span className="flex items-center gap-2">
                        {/* A sale already credited once is still returnable —
                            the rest of it may not have come back yet. Flagged
                            rather than hidden, so the cashier knows before they
                            open it why the quantities are capped. */}
                        {receipt.partlyCredited && <Badge tone="warning">Credited</Badge>}
                        <span className="numeric text-sm font-semibold text-ink">
                          {formatMoney(receipt.totalIncl)}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          {truncated && (
            <p className="text-xs text-muted">
              Only the most recent sales are listed. Type the number or the customer’s
              name to find an older one.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{invoice.documentNumber}</Badge>
            <span className="text-sm text-ink-2">
              {invoice.documentDate} · {invoice.customerName ?? 'Walk-in'} ·{' '}
              {formatMoney(invoice.totalIncl)}
            </span>
            {/* Back to the list, which is still filtered the way they left it —
                setInvoice(null) alone re-arms the load effect. */}
            <Button variant="ghost" size="sm" onClick={() => setInvoice(null)}>
              <Icons.ChevronLeft size={14} />
              Different sale
            </Button>
          </div>

          <ul className="flex flex-col gap-2">
            {invoice.lines.map((line) => {
              const qty = qtys[line.lineId] ?? 0
              const spent = line.creditable === 0
              return (
                <li
                  key={line.lineId}
                  className={`flex items-center justify-between gap-3 rounded-card border border-border p-3 ${spent ? 'opacity-50' : ''}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{line.description}</p>
                    <p className="text-xs text-muted">
                      {formatQty(line.qtySold)} sold at {formatMoney(line.unitPriceIncl)}
                      {line.alreadyCredited > 0 &&
                        ` · ${formatQty(line.alreadyCredited)} already credited`}
                    </p>
                  </div>
                  {spent ? (
                    <Badge tone="default">All credited</Badge>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        iconOnly
                        aria-label={`Fewer ${line.description}`}
                        disabled={qty === 0}
                        onClick={() =>
                          setQtys((q) => ({ ...q, [line.lineId]: Math.max(0, qty - 1) }))
                        }
                      >
                        <Icons.Minus size={14} />
                      </Button>
                      <span className="numeric w-8 text-center text-sm font-semibold text-ink">
                        {formatQty(qty)}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        iconOnly
                        aria-label={`More ${line.description}`}
                        disabled={qty >= line.creditable}
                        onClick={() =>
                          setQtys((q) => ({
                            ...q,
                            [line.lineId]: Math.min(line.creditable, qty + 1),
                          }))
                        }
                      >
                        <Icons.Plus size={14} />
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Why is it coming back?">
              <Select
                value={reasonId === null ? '' : String(reasonId)}
                onChange={(e) => setReasonId(Number(e.target.value) || null)}
              >
                {reasons.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Refund by">
              <Select
                value={refundTender === null ? '' : String(refundTender)}
                onChange={(e) => setRefundTender(Number(e.target.value) || null)}
              >
                {refundable.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Note (optional)">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. seam split on first wear"
            />
          </Field>

          <div className="flex items-center justify-between rounded-card border border-border bg-surface-2 px-4 py-2.5">
            <span className="text-sm text-muted">Credit at the prices they paid</span>
            <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 justify-center"
              disabled={busy || !ready}
              onClick={() => {
                const pick = pickOf()
                if (pick) onExchange(pick)
              }}
            >
              <Icons.ArrowLeftRight size={15} />
              Exchange for other goods
            </Button>
            <Button
              variant="primary"
              className="flex-1 justify-center"
              disabled={busy || !ready || refundTender === null}
              onClick={() => {
                const pick = pickOf()
                if (pick && refundTender !== null) onRefund(pick, refundTender)
              }}
            >
              <Icons.Check size={15} />
              {busy ? 'Working…' : `Refund ${formatMoney(total)}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
