'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Modal,
  SegmentedControl,
  TableToolbar,
  Textarea,
  ToolbarSearch,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { OnlineOrder, Repricing } from '@/lib/site/onlineOrders'
import type { OrderStatus } from '@/lib/site/onlineStore'
import { acceptOrderAction, archiveOrderAction, cancelOrderAction, moveOrderAction } from './actions'
import OrderDetail from './OrderDetail'

/**
 * The queue.
 *
 * Built around one question: what needs doing next. So it opens on the live
 * orders oldest-first, the "new" ones carry the loudest badge, and the primary
 * action on a row is the single next step for that order rather than a menu of
 * everything possible. Anything rarer — cancelling, archiving, reading the
 * basket — is one click away in the detail panel.
 */

export default function OrdersQueue({
  orders,
  statuses,
  counts,
  archived,
  storeOpen,
}: {
  orders: OnlineOrder[]
  statuses: OrderStatus[]
  counts: Record<string, number>
  archived: boolean
  storeOpen: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [cancelling, setCancelling] = useState<OnlineOrder | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  /** Shown after an accept that moved prices — staff have to tell the customer. */
  const [repriced, setRepriced] = useState<{ order: string; lines: Repricing[] } | null>(null)

  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (statusFilter !== 'all' && String(o.statusId) !== statusFilter) return false
      if (!term) return true
      return (
        o.orderNumber.toLowerCase().includes(term) ||
        o.contactName.toLowerCase().includes(term) ||
        o.contactPhone.includes(term)
      )
    })
  }, [orders, statusFilter, search])

  /** The one step this order moves to next, or null when it is finished. */
  function nextFor(order: OnlineOrder): OrderStatus | null {
    const current = byId.get(order.statusId)
    if (!current || current.role === 'completed' || current.role === 'cancelled') return null
    return (
      statuses.find(
        (s) =>
          s.isActive &&
          s.sortOrder > current.sortOrder &&
          s.role !== 'cancelled' &&
          !(s.role === 'dispatched' && order.fulfilment === 'collect'),
      ) ?? null
    )
  }

  function accept(order: OnlineOrder) {
    startAction(async () => {
      const result = await acceptOrderAction(order.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.alreadyAccepted) {
        toast.info(`Order ${order.orderNumber} was already accepted.`)
      } else if (result.repriced.length > 0) {
        // Not a toast: prices moving between order and acceptance is something
        // the customer has to be told, so it needs acknowledging rather than
        // fading away after four seconds.
        setRepriced({ order: order.orderNumber, lines: result.repriced })
      } else {
        toast.success(`Order ${order.orderNumber} accepted — a draft sale is waiting at the till.`)
      }
      router.refresh()
    })
  }

  function moveAlong(order: OnlineOrder, status: OrderStatus) {
    startAction(async () => {
      const result = await moveOrderAction(order.id, status.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Order ${order.orderNumber} is now ${status.name.toLowerCase()}.`)
      router.refresh()
    })
  }

  function confirmCancel() {
    if (!cancelling) return
    startAction(async () => {
      const result = await cancelOrderAction(cancelling.id, cancelReason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Order ${cancelling.orderNumber} cancelled.`)
      setCancelling(null)
      setCancelReason('')
      router.refresh()
    })
  }

  function setArchived(order: OnlineOrder, next: boolean) {
    startAction(async () => {
      const result = await archiveOrderAction(order.id, next)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(next ? 'Order archived.' : 'Order restored.')
      router.refresh()
    })
  }

  const columns: Column<OnlineOrder>[] = [
    {
      key: 'order',
      header: 'Order',
      cell: (o) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-ink">{o.orderNumber}</span>
          <span className="text-xs text-muted">
            {o.placedAt.toLocaleString('en-ZA', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      ),
      sortValue: (o) => o.placedAt.getTime(),
      sortable: true,
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (o) => (
        <div className="min-w-0">
          <span className="block truncate text-ink">{o.contactName || 'Guest'}</span>
          {o.contactPhone && <span className="text-xs text-muted">{o.contactPhone}</span>}
        </div>
      ),
      sortValue: (o) => o.contactName.toLowerCase(),
      sortable: true,
    },
    {
      key: 'fulfilment',
      header: 'How',
      cell: (o) => (
        <span className="flex items-center gap-1.5 text-sm text-ink-2">
          {o.fulfilment === 'deliver' ? (
            <>
              <Icons.Truck size={15} className="text-muted" />
              {o.deliverySuburb || 'Delivery'}
            </>
          ) : (
            <>
              <Icons.Store size={15} className="text-muted" />
              Collect
            </>
          )}
        </span>
      ),
      sortValue: (o) => o.fulfilment,
      width: 'w-40',
    },
    {
      key: 'items',
      header: 'Items',
      numeric: true,
      cell: (o) => formatQty(o.lineCount),
      sortValue: (o) => o.lineCount,
      width: 'w-20',
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (o) => formatMoney(o.totalIncl),
      sortValue: (o) => o.totalIncl,
      sortable: true,
      width: 'w-32',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (o) => (
        <div className="flex items-center gap-2">
          <Badge tone={o.statusTone}>{o.statusName}</Badge>
          {/* The sale is the thing staff chase at the till, so its number is
              shown the moment one exists. */}
          {o.documentNumber && (
            <Link
              href={`/sales/${o.documentId}`}
              className="text-xs font-medium text-brand hover:underline"
            >
              {o.documentNumber}
            </Link>
          )}
          {o.documentId && !o.documentNumber && (
            <Link
              href={`/sales/invoicing/${o.documentId}`}
              className="text-xs font-medium text-brand hover:underline"
            >
              Draft
            </Link>
          )}
        </div>
      ),
      sortValue: (o) => o.statusName,
      width: 'w-56',
    },
  ]

  const statusOptions = [
    { value: 'all', label: `All (${orders.length})` },
    ...statuses
      .filter((s) => (counts[s.id] ?? 0) > 0)
      .map((s) => ({ value: String(s.id), label: `${s.name} (${counts[s.id] ?? 0})` })),
  ]

  return (
    <>
      {!storeOpen && !archived && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-ink">Your online store is closed.</p>
              <p className="text-muted">
                Existing orders still need working, but no new ones can arrive.{' '}
                <Link href="/online-store/setup" className="font-medium text-brand hover:underline">
                  Open the store
                </Link>
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <TableToolbar
          actions={
            <Button
              variant="secondary"
              onClick={() =>
                router.push(archived ? '/online-store/orders' : '/online-store/orders?archived=1')
              }
            >
              <Icons.Archive size={15} />
              {archived ? 'Back to the queue' : 'Archive'}
            </Button>
          }
        >
          {!archived && statusOptions.length > 2 && (
            <SegmentedControl
              value={statusFilter}
              onChange={setStatusFilter}
              options={statusOptions}
            />
          )}
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Order number, name or phone"
          />
        </TableToolbar>

        {visible.length === 0 ? (
          <EmptyState
            icon={<Icons.Receipt size={22} />}
            title={
              orders.length === 0
                ? archived
                  ? 'Nothing archived yet'
                  : 'No online orders yet'
                : 'No orders match'
            }
            hint={
              orders.length === 0
                ? archived
                  ? 'Completed and cancelled orders you file away appear here.'
                  : storeOpen
                    ? 'Orders placed on your storefront land here.'
                    : 'Open your store so customers can start ordering.'
                : 'Try a different status or search term.'
            }
            action={
              orders.length > 0 ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setStatusFilter('all')
                    setSearch('')
                  }}
                >
                  Clear filters
                </Button>
              ) : !storeOpen && !archived ? (
                <Link href="/online-store/setup">
                  <Button variant="secondary">Set up your store</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={visible}
            getRowKey={(o) => o.id}
            onRowClick={(o) => setDetailId(o.id)}
            actionsOnHover
            actions={(o) => {
              const next = nextFor(o)
              const isNew = o.statusRole === 'new'
              const finished = o.statusRole === 'completed' || o.statusRole === 'cancelled'

              return (
                <div className="flex items-center justify-end gap-1">
                  {/* success, not primary: a queue of new orders would render a
                      dozen primaries, and "accept" is a positive go anyway. */}
                  {!archived && isNew && (
                    <Button variant="success" size="sm" disabled={busy} onClick={() => accept(o)}>
                      Accept
                    </Button>
                  )}
                  {!archived && !isNew && next && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => moveAlong(o, next)}
                    >
                      {next.name}
                    </Button>
                  )}
                  {!archived && finished && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Archive ${o.orderNumber}`}
                      disabled={busy}
                      onClick={() => setArchived(o, true)}
                    >
                      <Icons.Archive size={15} />
                    </Button>
                  )}
                  {archived && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setArchived(o, false)}
                    >
                      <Icons.ArchiveRestore size={15} />
                      Restore
                    </Button>
                  )}
                  {!archived && !finished && (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Cancel ${o.orderNumber}`}
                      disabled={busy}
                      onClick={() => {
                        setCancelling(o)
                        setCancelReason('')
                      }}
                    >
                      <Icons.Close size={15} />
                    </Button>
                  )}
                </div>
              )
            }}
          />
        )}
      </Card>

      <OrderDetail orderId={detailId} onClose={() => setDetailId(null)} />

      <Modal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={`Cancel order ${cancelling?.orderNumber ?? ''}`}
        description="The customer should be told why, so the reason is kept on the order."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Keep the order
            </Button>
            <Button variant="danger" onClick={confirmCancel} disabled={busy}>
              {busy ? 'Cancelling…' : 'Cancel the order'}
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Kept on the order so anyone can see why it was turned down.">
          <Textarea
            value={cancelReason}
            rows={3}
            maxLength={190}
            placeholder="e.g. Out of stock until Thursday"
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </Field>
        {cancelling?.documentId && (
          <p className="mt-3 text-sm text-muted">
            The draft sale raised for this order will be discarded with it.
          </p>
        )}
      </Modal>

      <Modal
        open={repriced !== null}
        onClose={() => setRepriced(null)}
        title="Prices changed since this was ordered"
        description={`Order ${repriced?.order ?? ''} has been accepted, but tell the customer before they pay.`}
        footer={
          <Button variant="primary" onClick={() => setRepriced(null)}>
            Got it
          </Button>
        }
      >
        <ul className="flex flex-col divide-y divide-border">
          {repriced?.lines.map((line, i) => (
            <li key={i} className="flex items-center justify-between gap-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-ink">{line.description}</span>
              {line.nowIncl === null ? (
                <Badge tone="danger">No longer available</Badge>
              ) : (
                <span className="numeric shrink-0 text-sm">
                  <span className="text-muted line-through">{formatMoney(line.wasIncl)}</span>
                  <span className="ml-2 font-medium text-ink">{formatMoney(line.nowIncl)}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  )
}
