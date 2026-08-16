'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Badge,
  Icons,
  TouchRow,
  CategoryTile,
  EmptyState,
  Skeleton,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { listCollectableOrdersAction, type CollectableOrder } from './onlineOrderActions'

/**
 * Web orders waiting to be collected, at the counter.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * A takeaway customer orders a burger and chips online, does not pay, and comes
 * in to fetch it. The cashier finds their order here and taps it; its lines
 * become the basket. The customer then grabs a Coke from the fridge, that goes on
 * the same sale, and the whole thing is paid for and invoiced once.
 *
 * The key used to navigate to the back office's order queue — a screen built for
 * a manager working through a pipeline, not for somebody with a customer waiting
 * at the counter. It also took the till off screen, basket and all.
 *
 * ── WHY A PAID ORDER IS SHOWN BUT NOT TAPPABLE ────────────────────────────
 *
 * An order paid on the web is already invoiced and the money is already taken.
 * Pulling it into a basket would charge for the same food twice. Hiding it
 * outright would be worse than showing it, though: the customer is standing there
 * holding an order number, and a cashier who cannot find it will assume something
 * is broken and start ringing the items up by hand — which is the double charge
 * arriving by a different road. So it is listed, marked Paid, and says to hand it
 * over.
 */
export function OnlineOrdersModal({
  open,
  onClose,
  onCollect,
  busy,
}: {
  open: boolean
  onClose: () => void
  /** Pulls the order into the basket. The shell owns what that means. */
  onCollect: (order: CollectableOrder) => void
  busy: boolean
}) {
  const [orders, setOrders] = useState<CollectableOrder[]>([])
  const [loading, setLoading] = useState(false)

  /* Read on open, every time. An order queue is the definition of a list that
     goes stale — one placed thirty seconds ago is exactly the one somebody is at
     the counter about. */
  useEffect(() => {
    if (!open) return
    setLoading(true)
    listCollectableOrdersAction()
      .then(setOrders)
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Online orders"
      description="Tap one to bring it onto the till. Anything else they pick up goes on the same sale."
      size="lg"
      footer={
        <Button variant="secondary" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {loading && orders.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

        {!loading && orders.length === 0 && (
          <EmptyState
            icon={<Icons.ShoppingCart size={26} />}
            title="No orders waiting"
            hint="Orders placed on the web shop show up here until they are handed over."
          />
        )}

        {orders.map((order) => (
          <TouchRow
            key={order.id}
            icon={
              <CategoryTile
                icon={
                  order.fulfilment === 'deliver' ? (
                    <Icons.Truck size={20} />
                  ) : (
                    <Icons.ShoppingCart size={20} />
                  )
                }
                /* Paid orders read as finished rather than actionable, which is
                   what they are — the till has nothing left to do with them. */
                tone={order.paid ? 'emerald' : 'sky'}
                size="lg"
              />
            }
            title={`${order.orderNumber} · ${order.customerName}`}
            subtitle={subtitleFor(order)}
            trailing={
              <span className="flex items-center gap-2">
                {order.paid ? (
                  <Badge tone="success">Paid</Badge>
                ) : (
                  <Badge tone="neutral">{order.statusName}</Badge>
                )}
                <span className="numeric text-base font-medium text-ink">
                  {formatMoney(order.totalIncl)}
                </span>
              </span>
            }
            /* A paid order is inert rather than absent — see the header. */
            disabled={order.paid || busy}
            onClick={() => onCollect(order)}
          />
        ))}
      </div>
    </Modal>
  )
}

/**
 * The line under the order number.
 *
 * Three things, in the order somebody at a counter needs them: how many items (so
 * the bag can be checked), when it was wanted (so a queue can be worked in the
 * right order), and the phone number (so the right person gets the right bag when
 * two orders are for a "John").
 */
function subtitleFor(order: CollectableOrder): string {
  const items = `${order.lineCount} item${order.lineCount === 1 ? '' : 's'}`
  const when = order.requestedFor ? `for ${timeOf(order.requestedFor)}` : timeOf(order.placedAt)
  const phone = order.contactPhone.trim()
  return phone ? `${items} · ${when} · ${phone}` : `${items} · ${when}`
}

/** Just the clock time. A counter cares about "18:45", not the date. */
function timeOf(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
