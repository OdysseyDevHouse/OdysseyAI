import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { readOrderTrackToken } from '@/lib/orderTrackToken'
import { storefrontContext } from '@/lib/site/storefront'
import { getOrder } from '@/lib/site/onlineOrders'
import { listOrderStatuses } from '@/lib/site/onlineStore'
import { formatMoney } from '@/lib/decimals'
import { Badge, Icons } from '@/components/ui'

/**
 * Following an order, without an account.
 *
 * ── WHY THIS PAGE IS REACHED BY A SIGNED LINK ────────────────────────────
 *
 * Guest checkout is the ordinary path for a corner shop, so most orders belong
 * to nobody with a password. The order NUMBER alone cannot open this page —
 * numbers are short, sequential and printed on slips, so anyone could walk
 * their way through a shop's whole order book. The link carries a signed token
 * naming exactly one order, and it expires (see orderTrackToken.ts).
 *
 * ── EVERY FAILURE IS THE SAME 404 ────────────────────────────────────────
 *
 * A bad token, an expired one, a token minted for another shop, and an order
 * that has since been deleted all render identically. Distinguishing them would
 * confirm which orders exist to someone guessing.
 *
 * ── THE TIMELINE IS THE SHOP'S OWN PIPELINE ──────────────────────────────
 *
 * Not a fixed New → Ready → Done. The statuses, their names and their order are
 * the shop's (see 034_online_store.sql), so this reads them and shows where the
 * order has got to along whatever the shop actually does. A cancelled order is
 * drawn as its own end state rather than as a step, because it is not one.
 */

export const dynamic = 'force-dynamic'

async function resolve(token: string, track: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null

  const claim = await readOrderTrackToken(track)
  if (!claim) return null

  // The token names a site AND the link names a store. They must agree, or a
  // token minted at one shop would read an order id out of another's database.
  if (claim.siteId !== siteId) return null

  const context = await storefrontContext(siteId)
  if (!context) return null

  const order = await getOrder(siteId, claim.orderId)
  if (!order) return null

  return { context, order }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; track: string }>
}): Promise<Metadata> {
  const { token, track } = await params
  const found = await resolve(token, track)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  return {
    title: `Order ${found.order.orderNumber} · ${found.context.storeName}`,
    // Never indexed, and never followed. This page is one person's address.
    robots: { index: false, follow: false },
  }
}

export default async function TrackOrderPage({
  params,
}: {
  params: Promise<{ token: string; track: string }>
}) {
  const { token, track } = await params
  const found = await resolve(token, track)
  if (!found) notFound()

  const { context, order } = found
  const statuses = await listOrderStatuses(context.siteId, true)

  const cancelled = order.statusRole === 'cancelled'
  /*
   * The steps this order will actually pass through.
   *
   * Two are dropped:
   *
   *   cancelled  — an outcome, not a stage. Drawn as a future step on every
   *                healthy order it reads as a threat.
   *   dispatched — "Out for delivery" is meaningless on a COLLECTION order,
   *                where the shopper is the one doing the travelling. Kept
   *                when the order is being delivered, and kept regardless if
   *                the order has somehow reached it, so a timeline never hides
   *                the step an order is actually sitting in.
   */
  const steps = statuses.filter((s) => {
    if (s.role === 'cancelled') return false
    if (s.role === 'dispatched' && order.fulfilment !== 'deliver') {
      return s.id === order.statusId
    }
    return true
  })
  const currentIndex = steps.findIndex((s) => s.id === order.statusId)

  const lineTotal = order.lines.reduce((sum, l) => sum + l.lineTotalIncl, 0)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <p className="text-sm text-muted">Order</p>
        <h1 className="text-xl font-semibold text-ink">{order.orderNumber}</h1>
        <p className="mt-1 text-sm text-muted">
          Placed {order.placedAt ? order.placedAt.toLocaleDateString('en-ZA') : ''} ·{' '}
          {order.fulfilment === 'deliver' ? 'Delivery' : 'Collection'}
        </p>
      </div>

      {/* ── Where it has got to ── */}
      <section className="rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Progress</h2>
          <Badge tone={cancelled ? 'danger' : order.statusTone}>{order.statusName}</Badge>
        </div>

        {cancelled ? (
          <div className="mt-3 rounded-control bg-danger-soft px-3 py-2.5">
            <p className="text-sm text-danger">
              This order was cancelled
              {order.declineReason ? `: ${order.declineReason}` : '.'}
            </p>
            <p className="mt-1 text-sm text-ink-2">
              Nothing is owed. Please contact {context.storeName} if you were expecting it.
            </p>
          </div>
        ) : (
          <ol className="mt-4 flex flex-col gap-0">
            {steps.map((step, i) => {
              const done = currentIndex >= 0 && i < currentIndex
              const now = i === currentIndex
              return (
                <li key={step.id} className="flex gap-3">
                  {/* The rail: a dot per step, joined by a line that is only
                      drawn between them — a tail below the last dot would point
                      at a step that does not exist. */}
                  <span className="flex flex-col items-center">
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center rounded-pill border-2 ${
                        now
                          ? 'border-brand bg-brand text-white'
                          : done
                            ? 'border-success bg-success-soft text-success'
                            : 'border-border bg-surface text-faint'
                      }`}
                    >
                      {done ? (
                        <Icons.Check size={13} />
                      ) : (
                        <span className="size-1.5 rounded-pill bg-current" />
                      )}
                    </span>
                    {i < steps.length - 1 && (
                      <span
                        className={`w-0.5 flex-1 ${done ? 'bg-success' : 'bg-border'}`}
                        style={{ minHeight: '1.5rem' }}
                      />
                    )}
                  </span>
                  <span className="min-w-0 pb-5">
                    <span
                      className={`block text-sm ${
                        now ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-muted'
                      }`}
                    >
                      {step.name}
                    </span>
                    {now && (
                      <span className="mt-0.5 block text-xs text-muted">
                        {order.fulfilment === 'deliver'
                          ? 'We’ll be in touch about delivery.'
                          : 'The shop will let you know when it’s ready.'}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {/* ── What was ordered ── */}
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="text-base font-semibold text-ink">What you ordered</h2>
        <ul className="mt-3 flex flex-col gap-2.5">
          {order.lines.map((line) => (
            <li key={line.id} className="flex items-baseline gap-3">
              <span className="numeric shrink-0 text-sm text-muted">{line.qty} ×</span>
              <span className="min-w-0 flex-1 text-sm text-ink">{line.description}</span>
              <span className="numeric shrink-0 text-sm text-ink-2">
                {formatMoney(line.lineTotalIncl)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
          <Row label="Items" value={formatMoney(lineTotal)} />
          {order.deliveryFeeIncl > 0 && (
            <Row label="Delivery" value={formatMoney(order.deliveryFeeIncl)} />
          )}
        </div>
        <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
          <span className="text-sm font-semibold text-ink">Total</span>
          <span className="numeric text-base font-semibold text-ink">
            {formatMoney(order.totalIncl)}
          </span>
        </div>
        {order.payOnAccount && (
          <p className="mt-2 text-xs text-muted">Charged to your account.</p>
        )}
      </section>

      {/* ── Where it is going ── */}
      {order.fulfilment === 'deliver' && order.deliveryLine1 && (
        <section className="rounded-card border border-border bg-surface p-4">
          <h2 className="text-base font-semibold text-ink">Delivering to</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-2">
            {[
              order.contactName,
              order.deliveryLine1,
              order.deliverySuburb,
              order.deliveryPostcode,
            ]
              .filter(Boolean)
              .join('\n')}
          </p>
          {order.deliveryNotes && (
            <p className="mt-2 text-sm text-muted">{order.deliveryNotes}</p>
          )}
        </section>
      )}

      <p className="text-sm text-muted">
        Something not right?{' '}
        <span className="text-ink-2">Contact {context.storeName}</span> and quote{' '}
        <span className="numeric font-medium text-ink">{order.orderNumber}</span>.
      </p>

      <Link
        href={`/store/${token}`}
        className="text-sm font-medium text-brand underline-offset-2 hover:underline"
      >
        ← Back to the shop
      </Link>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="numeric text-ink">{value}</span>
    </div>
  )
}
