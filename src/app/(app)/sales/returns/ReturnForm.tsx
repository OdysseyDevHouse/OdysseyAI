'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  CurrencyInput,
  EmptyState,
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
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { lineTotals, documentTotals } from '@/lib/documentMath'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TenderType } from '@/lib/site/tenderTypes'
import { searchReturnProductsAction, createNoReceiptReturnAction } from './actions'

/**
 * Taking goods back with no invoice behind them.
 *
 * The price is EDITABLE and defaults to the current shelf price, because
 * without a receipt nobody knows what was actually paid. Refunding today's
 * price for something bought on promotion is a real cost, so the figure is put
 * in front of the person deciding rather than assumed.
 *
 * The cost comes from the product's average cost and is never shown or edited:
 * it is a stock-valuation figure, not a negotiation, and exposing it at the
 * counter invites someone to "adjust" the margin on a return.
 */

type ReturnLine = {
  key: string
  productId: number
  productCode: string
  description: string
  productType: string
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  vatRatePct: number
  unitCostExcl: number
}

const REASONS = [
  'Faulty',
  'Wrong item',
  'Changed their mind',
  'Damaged in transit',
  'Gift return',
  'Other',
]

export default function ReturnForm({ tenders }: { tenders: TenderType[] }) {
  const [lines, setLines] = useState<ReturnLine[]>([])
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [refund, setRefund] = useState(true)
  const [tenderId, setTenderId] = useState<number | null>(tenders[0]?.id ?? null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      searchReturnProductsAction(query).then(setOptions)
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  const totals = useMemo(
    () =>
      documentTotals(
        lines.map((line) => ({
          ...lineTotals({
            qty: line.qty,
            unitPriceIncl: line.unitPriceIncl,
            vatRatePct: line.vatRatePct,
          }),
          vatRatePct: line.vatRatePct,
        })),
      ),
    [lines],
  )

  function addProduct(product: TillProduct) {
    setLines((current) => [
      ...current,
      {
        key: `${product.id}-${current.length}`,
        productId: product.id,
        productCode: product.code,
        description: product.description,
        productType: product.productType,
        departmentId: product.departmentId,
        qty: 1,
        unitPriceIncl: product.priceIncl,
        vatRatePct: product.vatRatePct,
        unitCostExcl: product.costExcl,
      },
    ])
    setQuery('')
    setOptions([])
  }

  function submit() {
    startTransition(async () => {
      const result = await createNoReceiptReturnAction({
        reason: note.trim() ? `${reason} — ${note.trim()}` : reason,
        customerName: customerName || null,
        lines: lines.map((line) => ({
          productId: line.productId,
          productCode: line.productCode,
          description: line.description,
          productType: line.productType,
          departmentId: line.departmentId,
          qty: line.qty,
          unitPriceIncl: line.unitPriceIncl,
          vatRatePct: line.vatRatePct,
          unitCostExcl: line.unitCostExcl,
        })),
        refunds:
          refund && tenderId
            ? [{ tenderTypeId: tenderId, amount: Math.abs(totals.totalIncl) }]
            : undefined,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} raised. The stock is back on hand.`)
      router.push(`/sales/${result.documentId}`)
    })
  }

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((product) => ({
    value: String(product.id),
    label: product.description,
    hint: product.code,
    trailing: formatMoney(product.priceIncl),
    data: product,
  }))

  return (
    <>
      <Card>
        <CardHeader
          title="What is coming back"
          description="Search by code, description or barcode. The price defaults to today's shelf price — change it if you know what was paid."
        />
        <CardBody>
          <Combobox
            options={comboOptions}
            query={query}
            onQueryChange={setQuery}
            onSelect={(option) => option.data && addProduct(option.data)}
            placeholder="Scan or search for the item…"
          />
        </CardBody>

        {lines.length === 0 ? (
          <EmptyState
            title="Nothing added yet"
            hint="Find the item the customer is bringing back."
            icon={<Icons.Reverse size={22} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Item</th>
                  <th className={`${TABLE_TH} text-right`}>Qty</th>
                  <th className={`${TABLE_TH} text-right`}>Refund each</th>
                  <th className={`${TABLE_TH} text-right`}>Total</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <div className="text-ink">{line.description}</div>
                      <div className="text-xs text-muted">{line.productCode}</div>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <div className="flex justify-end">
                        <div className="w-24">
                          <NumberInput
                            value={line.qty}
                            min={0}
                            step={1}
                            onChange={(e) =>
                              setLines((current) =>
                                current.map((l) =>
                                  l.key === line.key
                                    ? { ...l, qty: Math.max(0, round(Number(e.target.value) || 0, 3)) }
                                    : l,
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <div className="flex justify-end">
                        <div className="w-32">
                          <CurrencyInput
                            value={line.unitPriceIncl}
                            onChange={(e) =>
                              setLines((current) =>
                                current.map((l) =>
                                  l.key === line.key
                                    ? {
                                        ...l,
                                        unitPriceIncl: Math.max(
                                          0,
                                          round(Number(String(e.target.value).replace(',', '.')) || 0, 2),
                                        ),
                                      }
                                    : l,
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                      {formatMoney(round(line.qty * line.unitPriceIncl, 2))}
                    </td>
                    <td className={TABLE_TD}>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Remove ${line.description}`}
                        onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Why it is coming back" description="Recorded against you on the exception report." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reason" hint="Required.">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Customer name" hint="Optional — helps if it is queried later.">
              <Input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Walk-in"
              />
            </Field>
          </div>

          <Field label="Note" hint="Anything the reason code does not cover.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Screen cracked, still in the box"
            />
          </Field>

          <div className="flex flex-wrap items-end gap-4">
            <Switch
              checked={refund}
              onChange={setRefund}
              label="Refund now"
              hint="Turn off to leave the credit on account."
            />
            {refund && (
              <Field label="Refund by">
                <Select
                  value={tenderId ?? ''}
                  onChange={(e) => setTenderId(Number(e.target.value) || null)}
                >
                  {tenders.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <div className="text-sm text-muted">Refund total</div>
            <div className="numeric text-2xl font-semibold text-ink">
              {formatMoney(Math.abs(totals.totalIncl))}
            </div>
          </div>
          <Button
            variant="primary"
            disabled={pending || lines.length === 0 || totals.totalIncl === 0 || (refund && !tenderId)}
            onClick={submit}
          >
            <Icons.Reverse size={15} />
            {pending ? 'Recording…' : 'Record the return'}
          </Button>
        </div>
      </Card>
    </>
  )
}
