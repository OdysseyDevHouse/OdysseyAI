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
  ToolbarSearch,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { listTillOrdersAction, type TillOrder } from './orderActions'

/**
 * Orders waiting to be collected, at the counter.
 *
 * ── WHAT TAPPING ONE DOES ─────────────────────────────────────────────────
 *
 * It HANDS THE ORDER OVER. Not "opens it for editing" — the goods are recorded
 * as gone, a linked invoice is raised for exactly what went out, and that
 * invoice becomes the basket to be paid for.
 *
 * That is a heavier act than the quote list's tap, which only puts a price on
 * screen, and the wording here says so rather than leaving a cashier to find
 * out. "Tap one to hand it over" is the sentence somebody reads before they
 * commit stock they cannot un-commit with the same gesture.
 *
 * ── WHY ONLY OUTSTANDING ORDERS ARE HERE ──────────────────────────────────
 *
 * Unlike quotes, where a settled one still answers the question a cashier is
 * asking. An order delivered in full has nothing left to hand over, and listing
 * it invites somebody to collect the same goods twice — refused by the delivery
 * path, but only after a customer has been told they can have it.
 */
export function OrdersModal({
  open,
  onClose,
  onCollect,
  busy,
}: {
  open: boolean
  onClose: () => void
  /** Delivers the order and puts its invoice on the till. The shell owns that. */
  onCollect: (order: TillOrder) => void
  busy: boolean
}) {
  const [orders, setOrders] = useState<TillOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  /* Searched on the SERVER, like the quote list and for the same reason: the
     read is capped at 100, and filtering in the browser would search only the
     first hundred while looking like it searched everything. */
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const timer = setTimeout(
      () => {
        listTillOrdersAction(search.trim() || undefined)
          .then(setOrders)
          .catch(() => setOrders([]))
          .finally(() => setLoading(false))
      },
      search ? 300 : 0,
    )
    return () => clearTimeout(timer)
  }, [open, search])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sales orders"
      description="Tap one to hand it over. The goods go out and an invoice comes onto the till to be paid."
      size="lg"
      /* An unbounded list of documents on a touch screen: the more rows a
         cashier can see without dragging, the faster the handover. */
      bodyGrows
      footer={
        <Button variant="secondary" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Order number, customer or their reference"
          className="w-full"
          aria-label="Search orders"
        />

        {loading && orders.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-touch w-full rounded-card" />
            ))}
          </div>
        )}

        {!loading && orders.length === 0 && (
          <EmptyState
            icon={<Icons.ListOrdered size={26} />}
            title={search ? 'Nothing matches that' : 'Nothing waiting to go out'}
            hint={
              search
                ? 'Try the order number, or part of the customer name.'
                : 'Orders show here until they have been handed over in full.'
            }
          />
        )}

        {orders.map((o) => (
          <TouchRow
            key={o.id}
            icon={
              <CategoryTile
                icon={<Icons.ListOrdered size={20} />}
                /* Amber on a part-delivered order: something has already gone
                   out, and that changes what the cashier is about to hand over. */
                tone={o.fulfilmentStatus === 'part_delivered' ? 'amber' : 'sky'}
                size="lg"
              />
            }
            title={`${o.documentNumber ?? 'Unnumbered'} · ${o.customerName ?? 'No customer'}`}
            subtitle={subtitleFor(o)}
            trailing={
              <span className="flex items-center gap-2">
                {o.reservesStock && <Badge tone="brand">Stock held</Badge>}
                {o.fulfilmentStatus === 'part_delivered' && <Badge tone="warning">Part out</Badge>}
                <span className="numeric text-base font-medium text-ink">
                  {formatMoney(o.totalIncl)}
                </span>
              </span>
            }
            showChevron={o.collectable}
            disabled={!o.collectable || busy}
            onClick={() => onCollect(o)}
          />
        ))}
      </div>
    </Modal>
  )
}

/**
 * The line under the order number.
 *
 * Leads with HOW MUCH IS STILL OWED, because that is what the person at the
 * counter is about to hand over — the order's total is already on the right and
 * on a part-delivered order it is not what is going out today.
 *
 * The customer's own reference comes next when they gave one: a trade customer
 * ringing about "our order 4471" cannot be found by a number the shop invented.
 */
function subtitleFor(o: TillOrder): string {
  const bits: string[] = []

  bits.push(
    o.qtyOutstanding === 1 ? '1 item still owed' : `${o.qtyOutstanding} items still owed`,
  )
  if (o.customerOrderNo?.trim()) bits.push(`their ref ${o.customerOrderNo.trim()}`)
  if (o.deliveryDate) bits.push(`wanted ${o.deliveryDate}`)

  return bits.join(' · ')
}
