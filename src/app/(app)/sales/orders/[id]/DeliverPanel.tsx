'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  Field,
  Icons,
  Input,
  NumberInput,
  Switch,
  Textarea,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { saveDetailsAction, deliverAction, cancelOrderAction } from '../actions'

/**
 * Delivering an order.
 *
 * Per line, defaulting to everything still outstanding — the common case is
 * "the stock arrived, send it all", and the per-line box exists for the case
 * where only some of it did.
 *
 * Availability is shown beside each line because it is the question the person
 * delivering actually has: not "how many are on the shelf" but "how many can I
 * send without breaking someone else's order". Those differ whenever two
 * customers have ordered the same thing.
 */

type Line = {
  id: number
  description: string
  productCode: string | null
  qty: number
  qtyDelivered: number
  qtyOutstanding: number
  unitPriceIncl: number
  onHand: number | null
  available: number | null
}

export default function DeliverPanel({
  documentId,
  canDeliver,
  fulfilmentStatus,
  deliveryDate,
  expiresAt,
  customerOrderNo,
  reservesStock,
  lines,
}: {
  documentId: number
  canDeliver: boolean
  fulfilmentStatus: string
  deliveryDate: string | null
  expiresAt: string | null
  customerOrderNo: string | null
  reservesStock: boolean
  lines: Line[]
}) {
  const [qty, setQty] = useState<Record<number, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.qtyOutstanding])),
  )
  const [editing, setEditing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [date, setDate] = useState(deliveryDate ?? '')
  const [expiry, setExpiry] = useState(expiresAt ?? '')
  const [theirRef, setTheirRef] = useState(customerOrderNo ?? '')
  const [reserves, setReserves] = useState(reservesStock)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  const chosen = useMemo(
    () => lines.filter((l) => (qty[l.id] ?? 0) > 0).map((l) => ({ lineId: l.id, qty: qty[l.id] })),
    [lines, qty],
  )

  const value = useMemo(
    () =>
      lines.reduce(
        (sum, l) => round(sum + (qty[l.id] ?? 0) * l.unitPriceIncl, 2),
        0,
      ),
    [lines, qty],
  )

  // A line asked to deliver more than is actually available is not refused —
  // the stock may be arriving today — but it is worth saying out loud.
  const short = lines.filter(
    (l) => l.available !== null && (qty[l.id] ?? 0) > l.available,
  )

  function deliver() {
    startTransition(async () => {
      const result = await deliverAction(documentId, chosen)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      if (result.invoiceId) router.push(`/sales/${result.invoiceId}`)
      else router.refresh()
    })
  }

  function saveDetails() {
    startTransition(async () => {
      const result = await saveDetailsAction(documentId, {
        deliveryDate: date || null,
        expiresAt: expiry || null,
        customerOrderNo: theirRef || null,
        reservesStock: reserves,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setEditing(false)
      router.refresh()
    })
  }

  function cancel() {
    startTransition(async () => {
      const result = await cancelOrderAction(documentId, cancelReason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setCancelling(false)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader
        title={canDeliver ? 'Deliver this order' : 'Order lines'}
        description={
          canDeliver
            ? 'Enter what is going out. An invoice is raised for exactly that, and the rest stays on order.'
            : `This order is ${fulfilmentStatus.replace('_', ' ')}.`
        }
        action={
          <div className="flex items-center gap-2">
            {canDeliver && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} disabled={pending}>
                  <Icons.Calendar size={15} />
                  {editing ? 'Close' : 'Delivery details'}
                </Button>
                <Button variant="danger-ghost" size="sm" onClick={() => setCancelling(true)} disabled={pending}>
                  <Icons.Ban size={15} />
                  Cancel order
                </Button>
                <Button variant="primary" onClick={deliver} disabled={pending || chosen.length === 0}>
                  <Icons.Truck size={15} />
                  {pending ? 'Delivering…' : `Deliver ${formatMoney(value)}`}
                </Button>
              </>
            )}
          </div>
        }
      />

      {editing && canDeliver && (
        <CardBody className="flex flex-wrap items-end gap-4 border-b border-border">
          <Field label="Deliver by" hint="When the customer expects it.">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
          </Field>
          <Field label="Reservation expires" hint="After this, the stock is released.">
            <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="w-44" />
          </Field>
          <Field label="Their order number" hint="The customer's own reference.">
            <Input
              value={theirRef}
              onChange={(e) => setTheirRef(e.target.value)}
              placeholder="e.g. PO-4471"
              className="w-52"
            />
          </Field>
          <div className="pb-2">
            <Switch
              checked={reserves}
              onChange={setReserves}
              label="Hold stock for this order"
              hint="Keeps it off available to sell."
            />
          </div>
          <div className="pb-2">
            <Button variant="secondary" onClick={saveDetails} disabled={pending}>
              Save details
            </Button>
          </div>
        </CardBody>
      )}

      {short.length > 0 && canDeliver && (
        <CardBody className="border-b border-border">
          <p className="flex items-start gap-2 text-sm text-warning">
            <Icons.StatusWarning size={16} className="mt-0.5 shrink-0" />
            <span>
              {short.length === 1 ? 'One line asks' : `${short.length} lines ask`} for more than is
              available to sell. Delivering anyway will oversell — fine if the stock is arriving,
              otherwise someone else&apos;s order is about to break.
            </span>
          </p>
        </CardBody>
      )}

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>Item</th>
              <th className={`${TABLE_TH} text-right`}>Ordered</th>
              <th className={`${TABLE_TH} text-right`}>Delivered</th>
              <th className={`${TABLE_TH} text-right`}>Outstanding</th>
              <th className={`${TABLE_TH} text-right`}>On hand</th>
              <th className={`${TABLE_TH} text-right`}>Available</th>
              {canDeliver && <th className={`${TABLE_TH} text-right`}>Deliver now</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className={TABLE_ROW}>
                <td className={TABLE_TD}>
                  <div className="text-ink">{line.description}</div>
                  {line.productCode && <div className="text-xs text-muted">{line.productCode}</div>}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{line.qty}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {line.qtyDelivered > 0 ? line.qtyDelivered : <span className="text-faint">—</span>}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {line.qtyOutstanding > 0 ? (
                    <span className="text-ink">{line.qtyOutstanding}</span>
                  ) : (
                    <Badge tone="success">Done</Badge>
                  )}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{line.onHand ?? '—'}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {line.available === null ? (
                    '—'
                  ) : (
                    <span className={line.available < line.qtyOutstanding ? 'text-warning' : 'text-ink'}>
                      {line.available}
                    </span>
                  )}
                </td>
                {canDeliver && (
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <div className="flex justify-end">
                      <div className="w-28">
                        <NumberInput
                          value={qty[line.id] ?? 0}
                          min={0}
                          max={line.qtyOutstanding}
                          step={1}
                          disabled={line.qtyOutstanding === 0}
                          onChange={(e) => {
                            const typed = Number(e.target.value) || 0
                            setQty((c) => ({
                              ...c,
                              // Capped at what is outstanding: the server refuses
                              // more anyway, and a box that accepts an impossible
                              // number wastes the user's time.
                              [line.id]: Math.max(0, Math.min(round(typed, 3), line.qtyOutstanding)),
                            }))
                          }}
                        />
                      </div>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={cancel}
        title="Cancel this order?"
        confirmLabel="Cancel the order"
        busy={pending}
        message={
          <span className="flex flex-col gap-3">
            <span>
              The undelivered balance is released back to available stock. Nothing is reversed — an
              order never moved stock or posted to the ledger. Anything already delivered stays
              invoiced.
            </span>
            <Field label="Reason" hint="Kept on the order's history.">
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={2}
                placeholder="e.g. Customer changed their mind"
              />
            </Field>
          </span>
        }
      />
    </Card>
  )
}
