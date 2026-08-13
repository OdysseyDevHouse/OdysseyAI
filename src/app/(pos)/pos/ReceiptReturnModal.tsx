'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  useToast,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import type { PickableReason } from '@/components/ui'
import type { TenderType } from '@/lib/site/tenderTypes'
import { findReceiptAction, type ReceiptLookup } from './returnActions'

type FoundInvoice = Extract<ReceiptLookup, { ok: true }>['invoice']

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
}) {
  const toast = useToast()
  const [scan, setScan] = useState('')
  const [looking, setLooking] = useState(false)
  const [invoice, setInvoice] = useState<FoundInvoice | null>(null)
  const [qtys, setQtys] = useState<Record<number, number>>({})
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [refundTender, setRefundTender] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setScan('')
    setInvoice(null)
    setQtys({})
    setReasonId(reasons[0]?.id ?? null)
    setNote('')
    setRefundTender(null)
  }, [open, reasons])

  const refundable = useMemo(() => tenders.filter((t) => t.allowsRefund), [tenders])

  async function lookUp() {
    if (!scan.trim()) return
    setLooking(true)
    try {
      const result = await findReceiptAction(scan)
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
      setRefundTender(paid?.id ?? refundable.find((t) => t.code === 'CASH')?.id ?? refundable[0]?.id ?? null)
    } finally {
      setLooking(false)
    }
  }

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

  return (
    <Modal open={open} onClose={onClose} title="Return against a receipt">
      {!online ? (
        <Callout tone="brand" title="Receipted returns need the connection">
          Checking what has already been credited needs the server. A no-receipt return
          still works offline — use the Return toggle on the sale pane.
        </Callout>
      ) : !invoice ? (
        <div className="flex flex-col gap-3">
          <Field
            label="Invoice number"
            hint="On the customer’s slip — scan it or type it."
          >
            <Input
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void lookUp()
              }}
              placeholder="INV_01_01_000123"
              autoFocus
            />
          </Field>
          <Button variant="primary" disabled={looking || !scan.trim()} onClick={() => void lookUp()}>
            <Icons.Search size={15} />
            {looking ? 'Looking…' : 'Find the sale'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{invoice.documentNumber}</Badge>
            <span className="text-sm text-ink-2">
              {invoice.documentDate} · {invoice.customerName ?? 'Walk-in'} ·{' '}
              {formatMoney(invoice.totalIncl)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setInvoice(null)}>
              Different slip
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
