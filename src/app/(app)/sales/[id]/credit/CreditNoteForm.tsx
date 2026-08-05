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
  NumberInput,
  Select,
  Switch,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { lineTotals, documentTotals } from '@/lib/documentMath'
import { createCreditNoteAction } from '../../actions'

/**
 * Crediting a sale.
 *
 * Line-by-line rather than all-or-nothing: most returns are one item out of a
 * basket of nine, and forcing a full credit then a re-sale is how stock and VAT
 * both end up wrong.
 *
 * The quantity is capped at what remains creditable — the server refuses more
 * anyway, but a field that lets you type an impossible number is a field that
 * wastes the cashier's time in front of a customer.
 */

type CreditLine = {
  id: number
  productId: number | null
  productCode: string | null
  description: string
  productType: string
  departmentId: number | null
  soldQty: number
  alreadyCredited: number
  creditable: number
  unitPriceIncl: number
  vatRatePct: number
  unitCostExcl: number
}

export default function CreditNoteForm({
  invoiceId,
  invoiceNumber,
  customerId,
  customerName,
  terminalId,
  terminalCode,
  lines,
  tenders,
}: {
  invoiceId: number
  invoiceNumber: string
  customerId: number | null
  customerName: string | null
  terminalId: number | null
  terminalCode: string | null
  lines: CreditLine[]
  tenders: { id: number; name: string }[]
}) {
  const [qty, setQty] = useState<Record<number, number>>({})
  const [reason, setReason] = useState('')
  const [refunding, setRefunding] = useState(!customerId)
  const [refundTenderId, setRefundTenderId] = useState(String(tenders[0]?.id ?? ''))
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const chosen = lines.filter((l) => (qty[l.id] ?? 0) > 0)

  const totals = useMemo(() => {
    const computed = chosen.map((l) => ({
      ...lineTotals({ qty: qty[l.id] ?? 0, unitPriceIncl: l.unitPriceIncl, vatRatePct: l.vatRatePct }),
      vatRatePct: l.vatRatePct,
    }))
    return documentTotals(computed)
  }, [chosen, qty])

  function setLineQty(line: CreditLine, value: number) {
    // Clamped here as well as on the server: the server is the authority, this
    // is so the figure on screen is always one that can actually be posted.
    const clamped = Math.max(0, Math.min(round(value, 3), line.creditable))
    setQty((current) => ({ ...current, [line.id]: clamped }))
  }

  function submit() {
    startTransition(async () => {
      const result = await createCreditNoteAction({
        invoiceId,
        customerId,
        customerName,
        reason,
        terminalId,
        terminalCode,
        lines: chosen.map((l) => ({
          sourceLineId: l.id,
          productId: l.productId,
          productCode: l.productCode,
          description: l.description,
          productType: l.productType,
          departmentId: l.departmentId,
          qty: qty[l.id] ?? 0,
          unitPriceIncl: l.unitPriceIncl,
          vatRatePct: l.vatRatePct,
          // From the ORIGINAL line. Re-reading the product would credit at
          // today's cost and manufacture margin that was never earned.
          unitCostExcl: l.unitCostExcl,
        })),
        refunds:
          refunding && refundTenderId
            ? [{ tenderTypeId: Number(refundTenderId), amount: totals.totalIncl }]
            : undefined,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} raised for ${formatMoney(result.total)}.`)
      router.push(`/sales/${result.documentId}`)
    })
  }

  const ready = chosen.length > 0 && reason.trim().length > 0

  return (
    <div className="grid gap-4 px-6 pt-4 pb-10 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader
            title="What is coming back?"
            description={`Anything already credited on ${invoiceNumber} is excluded.`}
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Item</th>
                  <th className={`${TABLE_TH} text-right`}>Sold</th>
                  <th className={`${TABLE_TH} text-right`}>Price</th>
                  <th className={`${TABLE_TH} text-right`}>Credit qty</th>
                  <th className={`${TABLE_TH} text-right`}>Value</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const q = qty[line.id] ?? 0
                  const value = round(q * line.unitPriceIncl, 2)
                  return (
                    <tr key={line.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <div className="text-ink">{line.description}</div>
                        <div className="text-xs text-muted">
                          {line.productCode}
                          {line.alreadyCredited > 0 && (
                            <span className="ml-2 text-warning">
                              {formatQty(line.alreadyCredited)} already credited
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.soldQty)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(line.unitPriceIncl)}
                      </td>
                      <td className={`${TABLE_TD} w-36`}>
                        <div className="flex items-center gap-1.5">
                          <NumberInput
                            value={q}
                            precision={3}
                            onChange={(e) => setLineQty(line, Number(e.target.value) || 0)}
                            className="text-right"
                          />
                          <Button
                            variant="bare"
                            size="sm"
                            onClick={() => setLineQty(line, line.creditable)}
                            title={`Credit all ${formatQty(line.creditable)}`}
                          >
                            All
                          </Button>
                        </div>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                        {value > 0 ? formatMoney(value) : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card className="p-4">
          <dl className="flex flex-col gap-1.5 text-sm">
            <Row label="Subtotal (excl.)" value={formatMoney(Math.abs(totals.subtotalExcl))} />
            <Row label="VAT" value={formatMoney(Math.abs(totals.vatTotal))} />
          </dl>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium text-ink">Credit total</span>
            <span className="numeric text-xl font-semibold text-ink">
              {formatMoney(Math.abs(totals.totalIncl))}
            </span>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex flex-col gap-4">
            <Field label="Reason" hint="Recorded on the credit and in the audit trail.">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Damaged in transit"
              />
            </Field>

            {customerId ? (
              <>
                <Switch
                  checked={refunding}
                  onChange={setRefunding}
                  label="Refund now"
                  hint={
                    refunding
                      ? 'Money goes back out of the drawer.'
                      : `Leaves the credit on ${customerName}'s account, applied to their oldest invoice.`
                  }
                />
                {refunding && tenders.length > 0 && (
                  <Field label="Refund by">
                    <Select
                      value={refundTenderId}
                      onChange={(e) => setRefundTenderId(e.target.value)}
                    >
                      {tenders.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            ) : (
              <Field label="Refund by" hint="A walk-in has no account to credit.">
                <Select value={refundTenderId} onChange={(e) => setRefundTenderId(e.target.value)}>
                  {tenders.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </Card>

        <Button variant="danger" disabled={!ready || pending} onClick={submit}>
          <Icons.Reverse size={16} />
          {pending ? 'Posting…' : `Credit ${formatMoney(Math.abs(totals.totalIncl))}`}
        </Button>

        {!ready && (
          <p className="text-center text-xs text-muted">
            {chosen.length === 0 ? 'Choose what is coming back.' : 'Give a reason.'}
          </p>
        )}

        <Card className="p-3">
          <p className="text-xs text-muted">
            The original invoice keeps saying exactly what it said — the customer may be holding a
            copy of it. This raises a separate document that reverses part of it.
          </p>
        </Card>
      </div>
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
