'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { useCart } from '../../CartContext'

/**
 * Putting a saved basket back into the cart.
 *
 * ── IT ASKS FIRST ────────────────────────────────────────────────────────
 *
 * The cart lives in this browser and may already have something in it — a
 * shopper who opened the email on their laptop while mid-shop on it would
 * otherwise have their current basket silently overwritten by a week-old one.
 * So the saved items are shown, and restoring is a button.
 *
 * ── IT REPLACES RATHER THAN MERGES ───────────────────────────────────────
 *
 * Merging two baskets sounds kinder and is worse: quantities double for
 * anything in both, and there is no way for the shopper to tell which of the
 * two a line came from. Replacing is one clear outcome, and the button says so
 * when there is something to lose.
 */

export type RestorableLine = {
  productId: number
  code: string
  description: string
  priceIncl: number
  qty: number
  inStock: boolean
}

export default function RestoreBasket({
  token,
  lines,
  missingCount,
  storeName,
  showStock,
}: {
  token: string
  lines: RestorableLine[]
  /** Saved items the shop no longer sells. Named, not silently dropped. */
  missingCount: number
  storeName: string
  showStock: boolean
}) {
  const cart = useCart()
  const router = useRouter()
  const [done, setDone] = useState(false)

  const total = lines.reduce((sum, l) => sum + l.priceIncl * l.qty, 0)
  const hasCurrent = cart.ready && cart.lines.length > 0

  function restore() {
    cart.clear()
    for (const line of lines) {
      cart.add(
        {
          productId: line.productId,
          code: line.code,
          description: line.description,
          priceIncl: line.priceIncl,
        },
        line.qty,
      )
    }
    setDone(true)
    router.push(`/store/${token}/checkout`)
  }

  if (lines.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Icons.Package size={22} />}
          title="This basket is no longer available"
          hint={`The items in it are not on sale at ${storeName} at the moment.`}
          action={
            <Link href={`/store/${token}`}>
              <Button variant="primary">Start shopping</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-xl font-semibold text-ink">Your saved basket</h1>
      <p className="mt-1 text-sm text-muted">
        Here is what you left at {storeName}. Prices are today&rsquo;s.
      </p>

      <Card className="mt-4">
        <div className="p-4">
          <ul className="flex flex-col gap-3">
            {lines.map((line) => (
              <li key={line.productId} className="flex items-center gap-3">
                <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-pill bg-brand px-1.5 text-xs font-semibold text-white">
                  {line.qty}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{line.description}</span>
                  {showStock && !line.inStock && (
                    <Badge tone="warning" className="mt-0.5">
                      Sold out
                    </Badge>
                  )}
                </span>
                <span className="numeric shrink-0 text-sm text-ink">
                  {formatMoney(line.priceIncl * line.qty)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-base font-semibold text-ink">Total</span>
            <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
          </div>

          {missingCount > 0 && (
            <p className="mt-3 rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
              {missingCount === 1
                ? 'One item you saved is no longer on sale, so it is not included.'
                : `${missingCount} items you saved are no longer on sale, so they are not included.`}
            </p>
          )}

          {/* Only when there is genuinely something to lose. Warning about
              replacing an empty basket is noise. */}
          {hasCurrent && (
            <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 text-sm text-ink-2">
              You already have {cart.count} {cart.count === 1 ? 'item' : 'items'} in your basket.
              Restoring this will replace them.
            </p>
          )}

          <Button
            variant="primary"
            className="mt-4 w-full"
            disabled={done}
            onClick={restore}
          >
            {done ? 'Restoring…' : hasCurrent ? 'Replace my basket with this' : 'Put it back in my basket'}
          </Button>

          <Link
            href={`/store/${token}`}
            className="mt-3 block text-center text-sm text-brand underline-offset-2 hover:underline"
          >
            No thanks — take me to the shop
          </Link>
        </div>
      </Card>
    </div>
  )
}
