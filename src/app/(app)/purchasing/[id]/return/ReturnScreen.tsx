'use client'

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
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
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { createSupplierReturnAction, serialsForReturnAction } from '../../actions'

/**
 * Sending goods back to a supplier.
 *
 * The mirror of the credit-note screen: you pick lines off the original
 * document and say how many are going back. What is already returned is shown
 * beside each line, because a second return against the same GRV is normal —
 * one box is faulty this week and another next week — and the receiver needs to
 * see what is left rather than work it out.
 *
 * A serial line is different in kind: the quantity is decided BY the units
 * chosen, not typed. Which physical handset goes back is the whole question,
 * so the tick boxes drive the number rather than the other way round.
 */

type ReturnableLine = {
  id: number
  productId: number | null
  productCode: string | null
  supplierCode: string | null
  description: string
  productType: string
  departmentId: number | null
  qtyReceived: number
  alreadyReturned: number
  returnable: number
  unitCostExcl: number
  vatRatePct: number
  locationId: number | null
}

type SerialOption = {
  id: number
  serial: string
  costExcl: number
  warrantyUntil: string | null
  locationCode: string | null
}

export default function ReturnScreen({
  grvId,
  grvNumber,
  supplierName,
  lines,
}: {
  grvId: number
  grvNumber: string
  supplierName: string
  lines: ReturnableLine[]
}) {
  const [qty, setQty] = useState<Record<number, number>>({})
  const [chosen, setChosen] = useState<Record<number, number[]>>({})
  const [serialOptions, setSerialOptions] = useState<Record<number, SerialOption[]>>({})
  const [reason, setReason] = useState('')
  const [creditNo, setCreditNo] = useState('')
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  // The units each serial line could send back, loaded once. Restricted to the
  // location the goods went into, which is where the stock movement takes them
  // from — offering a unit from another room would break that agreement.
  useEffect(() => {
    const serialLines = lines.filter((l) => l.productType === 'serial' && l.productId && l.returnable > 0)
    if (serialLines.length === 0) return

    let cancelled = false
    Promise.all(
      serialLines.map(async (line) => {
        const items = await serialsForReturnAction(line.productId!, line.locationId)
        return [line.id, items] as const
      }),
    ).then((pairs) => {
      if (!cancelled) setSerialOptions(Object.fromEntries(pairs))
    })

    return () => {
      cancelled = true
    }
  }, [lines])

  /** A serial line's quantity IS how many units are ticked. */
  const qtyFor = (line: ReturnableLine) =>
    line.productType === 'serial' ? (chosen[line.id]?.length ?? 0) : (qty[line.id] ?? 0)

  function toggleSerial(lineId: number, serialId: number, on: boolean) {
    setChosen((current) => {
      const picked = current[lineId] ?? []
      return {
        ...current,
        [lineId]: on ? [...picked, serialId] : picked.filter((x) => x !== serialId),
      }
    })
  }

  const totals = useMemo(() => {
    let excl = 0
    let vat = 0
    for (const line of lines) {
      const q = qtyFor(line)
      if (q <= 0) continue
      const net = round(q * line.unitCostExcl, 2)
      excl = round(excl + net, 2)
      vat = round(vat + net * (line.vatRatePct / 100), 2)
    }
    return { excl, vat, total: round(excl + vat, 2) }
    // qtyFor reads both maps, so both have to be dependencies.
  }, [lines, qty, chosen])

  /** Lines asking to return more than is left, or with too few units ticked. */
  const problems = lines.filter((line) => {
    const q = qtyFor(line)
    if (q <= 0) return false
    if (q > line.returnable + 0.0005) return true
    // A serial line cannot over-tick — the boxes only offer what is in stock —
    // so the only failure left is a fractional quantity, which cannot happen
    // when the count comes from tick boxes.
    return false
  })

  const anything = lines.some((l) => qtyFor(l) > 0)
  const ready = anything && reason.trim().length > 0 && problems.length === 0

  function submit() {
    startTransition(async () => {
      const result = await createSupplierReturnAction({
        grvId,
        reason: reason.trim(),
        supplierCreditNo: creditNo.trim() || null,
        lines: lines
          .filter((l) => qtyFor(l) > 0)
          .map((l) => ({
            sourceLineId: l.id,
            productId: l.productId,
            productCode: l.productCode,
            supplierCode: l.supplierCode,
            description: l.description,
            productType: l.productType,
            departmentId: l.departmentId,
            qtyReturned: qtyFor(l),
            unitCostExcl: l.unitCostExcl,
            vatRatePct: l.vatRatePct,
            locationId: l.locationId,
            serialIds: l.productType === 'serial' ? (chosen[l.id] ?? []) : undefined,
          })),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} raised — stock out, ${supplierName} credited.`)
      router.push(`/purchasing/${result.documentId}`)
    })
  }

  const nothingLeft = lines.every((l) => l.returnable <= 0)

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card>
          <CardHeader
            title="What is going back"
            description="Costs are the landed cost from the receipt — what it actually cost to get the goods here."
          />

          {nothingLeft ? (
            <EmptyState
              title="Everything has already been returned"
              hint={`Every line on ${grvNumber} has gone back in full. There is nothing left to send.`}
              icon={<Icons.PackageOpen size={22} />}
            />
          ) : (
            /* A table, not stacked flex rows: quantities and costs each form a
               column, so the money lines up. Live inputs justify hand-building
               it — it wears the shared TABLE_* skin so it cannot drift. */
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th scope="col" className={TABLE_TH}>
                      Item
                    </th>
                    <th scope="col" className={`${TABLE_TH} text-right`}>
                      Received
                    </th>
                    <th scope="col" className={`${TABLE_TH} text-right`}>
                      Unit cost
                    </th>
                    <th scope="col" className={`${TABLE_TH} w-36 text-right`}>
                      Return
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const isSerial = line.productType === 'serial'
                    const options = serialOptions[line.id] ?? []
                    const picked = chosen[line.id] ?? []
                    const q = qtyFor(line)
                    const spent = line.returnable <= 0
                    const over = !spent && q > line.returnable + 0.0005

                    return (
                      <Fragment key={line.id}>
                        <tr className={`${TABLE_ROW} ${spent ? 'opacity-60' : ''}`}>
                          <td className={TABLE_TD}>
                            <div className="text-ink">{line.description}</div>
                            <div className="text-xs text-muted">
                              {line.productCode}
                              {line.alreadyReturned > 0 && (
                                <span className="ml-2">
                                  · {formatQty(line.alreadyReturned)} already returned
                                </span>
                              )}
                            </div>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {formatQty(line.qtyReceived)}
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {formatMoney(line.unitCostExcl)}
                          </td>
                          <td className={`${TABLE_TD_INPUT} w-36 text-right`}>
                            {spent ? (
                              <Badge>Fully returned</Badge>
                            ) : isSerial ? (
                              /* A count, not a judgement — the ticks below drive it. */
                              <span className="numeric text-sm text-ink-2">
                                {q} of {formatQty(line.returnable)} chosen
                              </span>
                            ) : (
                              <Field
                                error={
                                  over
                                    ? `Only ${formatQty(line.returnable)} left to return.`
                                    : undefined
                                }
                              >
                                <NumberInput
                                  value={qty[line.id] ?? 0}
                                  precision={3}
                                  aria-label={`Quantity of ${line.description} to return`}
                                  onChange={(e) =>
                                    setQty((c) => ({
                                      ...c,
                                      [line.id]: Number(e.target.value) || 0,
                                    }))
                                  }
                                />
                              </Field>
                            )}
                          </td>
                        </tr>

                        {/* A serial line picks units, not a number. */}
                        {isSerial && !spent && (
                          <tr className={TABLE_ROW}>
                            <td colSpan={4} className={TABLE_TD}>
                              <div className="my-1.5 rounded-control border border-border bg-surface-2 p-3">
                                <div className="flex items-center gap-2">
                                  <Icons.Barcode size={15} className="text-muted" />
                                  <span className="text-sm font-medium text-ink">
                                    Which units are going back
                                  </span>
                                </div>

                                {options.length === 0 ? (
                                  <p className="mt-2 text-xs text-muted">
                                    No units of this product are in stock at the location it was
                                    received into, so there is nothing to send back.
                                  </p>
                                ) : (
                                  <ul className="mt-2 flex flex-col gap-1">
                                    {options.map((option) => (
                                      <li key={option.id}>
                                        <label
                                          /* A full-width selectable row with a trailing
                                             figure — not a kit component.
                                             data-kit-ok */
                                          data-kit-ok
                                          className="flex cursor-pointer items-center gap-3 rounded-control px-2 py-1.5 transition hover:bg-surface"
                                        >
                                          <Checkbox
                                            checked={picked.includes(option.id)}
                                            onChange={(e) =>
                                              toggleSerial(line.id, option.id, e.target.checked)
                                            }
                                          />
                                          <span className="numeric min-w-0 flex-1 truncate text-sm text-ink">
                                            {option.serial}
                                          </span>
                                          {option.warrantyUntil && (
                                            <span className="text-xs text-muted">
                                              warranty {String(option.warrantyUntil).slice(0, 10)}
                                            </span>
                                          )}
                                        </label>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Why" description="Kept on the return and on the supplier's account." />
          <CardBody className="flex flex-col gap-4">
            <Field
              label="Reason"
              // Surfaces only once something is chosen — the reason is then the
              // one thing still standing between the user and the button.
              error={
                anything && reason.trim().length === 0
                  ? 'Give a reason — it goes on the return and their account.'
                  : undefined
              }
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="e.g. Two handsets arrived with cracked screens"
              />
            </Field>
            <Field
              label="Their credit note number"
              hint="If they have issued one. The payment run matches against it."
            >
              <Input value={creditNo} onChange={(e) => setCreditNo(e.target.value)} />
            </Field>
          </CardBody>
        </Card>

        <Card className="p-4">
          <dl className="flex flex-col gap-1.5 text-sm">
            <Row label="Goods (excl.)" value={formatMoney(totals.excl)} />
            <Row label="VAT" value={formatMoney(totals.vat)} />
          </dl>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium text-ink">Credit due</span>
            <span className="numeric text-xl font-semibold text-ink">
              {formatMoney(totals.total)}
            </span>
          </div>
        </Card>

        <Button variant="primary" disabled={!ready || pending} onClick={submit}>
          <Icons.Reverse size={16} />
          {pending ? 'Returning…' : 'Send it back'}
        </Button>

        {/* Line and reason problems are marked on their own fields; the only
            state with nowhere to point is an empty selection. */}
        {!anything && <p className="text-center text-xs text-muted">Choose what is going back.</p>}

        <Card className="p-3">
          <p className="text-xs text-muted">
            Stock leaves the location it was received into and {supplierName}&apos;s account is
            credited. The average cost is deliberately not unwound — anything sold since has already
            moved on at the blended figure.
          </p>
        </Card>
      </div>
      </div>
    </PageBody>
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
