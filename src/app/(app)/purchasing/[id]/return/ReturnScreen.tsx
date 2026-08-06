'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
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
  Textarea,
  useToast,
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
    <div className="grid gap-4 px-6 pt-4 pb-10 lg:grid-cols-3">
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
            <div className="divide-y divide-border">
              {lines.map((line) => {
                const isSerial = line.productType === 'serial'
                const options = serialOptions[line.id] ?? []
                const picked = chosen[line.id] ?? []
                const q = qtyFor(line)
                const spent = line.returnable <= 0

                return (
                  <div key={line.id} className={`px-6 py-3 ${spent ? 'opacity-60' : ''}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-ink">{line.description}</div>
                        <div className="text-xs text-muted">
                          {line.productCode}
                          <span className="ml-2">{formatQty(line.qtyReceived)} received</span>
                          {line.alreadyReturned > 0 && (
                            <span className="ml-2">
                              · {formatQty(line.alreadyReturned)} already returned
                            </span>
                          )}
                          <span className="ml-2">· {formatMoney(line.unitCostExcl)} each</span>
                        </div>
                      </div>

                      {spent ? (
                        <Badge>fully returned</Badge>
                      ) : isSerial ? (
                        <Badge tone={q > 0 ? 'warning' : 'neutral'}>
                          {q} of {formatQty(line.returnable)} chosen
                        </Badge>
                      ) : (
                        <Field label="Return" className="w-32">
                          <NumberInput
                            value={qty[line.id] ?? 0}
                            precision={3}
                            aria-label={`Quantity of ${line.description} to return`}
                            onChange={(e) =>
                              setQty((c) => ({ ...c, [line.id]: Number(e.target.value) || 0 }))
                            }
                          />
                        </Field>
                      )}
                    </div>

                    {!spent && q > line.returnable + 0.0005 && (
                      <p className="mt-2 text-xs text-danger">
                        Only {formatQty(line.returnable)} left to return on this line.
                      </p>
                    )}

                    {/* A serial line picks units, not a number. */}
                    {isSerial && !spent && (
                      <div className="mt-3 rounded-control border border-border bg-surface-2 p-3">
                        <div className="flex items-center gap-2">
                          <Icons.Barcode size={15} className="text-muted" />
                          <span className="text-sm font-medium text-ink">
                            Which units are going back
                          </span>
                        </div>

                        {options.length === 0 ? (
                          <p className="mt-2 text-xs text-muted">
                            No units of this product are in stock at the location it was received
                            into, so there is nothing to send back.
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
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Why" description="Kept on the return and on the supplier's account." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Reason">
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

        {!ready && (
          <p className="text-center text-xs text-muted">
            {!anything
              ? 'Choose what is going back.'
              : problems.length > 0
                ? `${problems[0].description}: more than is left to return.`
                : 'Give a reason.'}
          </p>
        )}

        <Card className="p-3">
          <p className="text-xs text-muted">
            Stock leaves the location it was received into and {supplierName}&apos;s account is
            credited. The average cost is deliberately not unwound — anything sold since has already
            moved on at the blended figure.
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
