'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Icons,
  NumberInput,
  PageBody,
  ReasonPicker,
  Select,
  type PickableReason,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  Switch,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
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
  reasons,
}: {
  invoiceId: number
  invoiceNumber: string
  customerId: number | null
  customerName: string | null
  terminalId: number | null
  terminalCode: string | null
  lines: CreditLine[]
  tenders: { id: number; name: string }[]
  /** The site's return reasons, active only. */
  reasons: PickableReason[]
}) {
  const [qty, setQty] = useState<Record<number, number>>({})
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')
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
    if (reasonId === null) return
    startTransition(async () => {
      const result = await createCreditNoteAction({
        invoiceId,
        customerId,
        customerName,
        reasonId,
        note: note.trim() || null,
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

  const ready = chosen.length > 0 && reasonId !== null

  return (
    <PageBody className="grid lg:grid-cols-3">
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
                      <td className={`${TABLE_TD_INPUT} w-44`}>
                        <div className="flex items-center gap-1.5">
                          <NumberInput
                            value={q}
                            precision={3}
                            onChange={(e) => setLineQty(line, Number(e.target.value) || 0)}
                            className="text-right"
                          />
                          <Button
                            variant="ghost"
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
        <Card>
          <CardHeader
            title="Reason and refund"
            description="The original invoice keeps saying exactly what it said — the customer may be holding a copy. This raises a separate document that reverses part of it."
          />
          <CardBody className="flex flex-col gap-4">
            <ReasonPicker
              reasons={reasons}
              value={reasonId}
              note={note}
              onChange={setReasonId}
              onNoteChange={setNote}
              label="Why is it coming back?"
              hint="Recorded on the credit and in the audit trail, and what a returns report groups by."
              error={chosen.length > 0 && reasonId === null ? 'Choose a reason.' : undefined}
              disabled={pending}
            />

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
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Totals" />
          <CardBody>
            <SummaryList>
              <SummaryRow
                label="Subtotal (excl.)"
                value={formatMoney(Math.abs(totals.subtotalExcl))}
              />
              <SummaryRow label="VAT" value={formatMoney(Math.abs(totals.vatTotal))} />
              <SummaryTotal label="Credit total" value={formatMoney(Math.abs(totals.totalIncl))} />
            </SummaryList>
          </CardBody>
          {/* Primary, not danger: crediting is the routine job this screen
              exists for, and the confirm already spells out what it does. */}
          <CardFooter className={!ready && chosen.length === 0 ? 'justify-between' : ''}>
            {!ready && chosen.length === 0 && (
              <span className="text-xs text-muted">Choose what is coming back.</span>
            )}
            <Button variant="primary" disabled={!ready || pending} onClick={submit}>
              <Icons.Reverse size={16} />
              {pending ? 'Posting…' : `Credit ${formatMoney(Math.abs(totals.totalIncl))}`}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageBody>
  )
}
