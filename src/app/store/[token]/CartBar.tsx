'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { useCart } from './CartContext'

/**
 * The basket, on a phone.
 *
 * ── PHONES ONLY ──────────────────────────────────────────────────────────
 *
 * On a wide screen the masthead basket is always visible, so a second one
 * pinned to the bottom would be clutter. On a phone the masthead scrolls away
 * and this is the only way back to the order.
 *
 * ── IT OPENS, IT DOES NOT NAVIGATE ───────────────────────────────────────
 *
 * Checking what is in the basket is a peek, not a destination. A drawer closes
 * back to the same scroll position in the catalogue; a cart page loses it, and
 * the shopper has to find where they were.
 *
 * ── NOT ON THE CHECKOUT ──────────────────────────────────────────────────
 *
 * The order summary there IS the basket, and a floating bar over it would
 * cover the button it is trying to point at.
 */
export default function CartBar({ token }: { token: string }) {
  const cart = useCart()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const onCheckout = pathname?.startsWith(`/store/${token}/checkout`) ?? false

  // Escape closes, and while the drawer is open the page behind it must not
  // scroll — otherwise a thumb dragging the basket slides the catalogue.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    // Restores the PREVIOUS value rather than clearing it, so this cannot
    // clobber a scroll lock something else set.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  // `ready` gates the first paint: the basket is read from storage in an
  // effect, so rendering before that flashes an empty bar at a shopper who
  // has a basket.
  if (onCheckout || !cart.ready || cart.count === 0) return null

  return (
    <div className="md:hidden">
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 py-3 shadow-pop">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          {/* Not a kit Button: this is a full-width summary strip carrying a
              count pill, a total and a state word — no button variant
              expresses that, and forcing one would restyle all three. */}
          <button
            data-kit-ok
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex flex-1 items-center gap-2 text-left"
          >
            <span className="flex h-6 min-w-6 items-center justify-center rounded-pill bg-brand px-1.5 text-xs font-semibold text-white">
              {cart.count}
            </span>
            <span className="numeric text-base font-medium text-ink">
              {formatMoney(cart.subtotal)}
            </span>
            <span className="text-sm text-muted">{open ? 'Hide' : 'View'}</span>
          </button>

          <Link href={`/store/${token}/checkout`}>
            <Button>Checkout</Button>
          </Link>
        </div>
      </div>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-ink/45"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label="Your basket"
            aria-modal="true"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-card border-t border-border bg-surface px-4 pb-4 pt-3"
          >
            <div className="mx-auto w-full max-w-3xl">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink">Your basket</h2>
                <Button variant="ghost" size="sm" iconOnly aria-label="Close basket" onClick={() => setOpen(false)}>
                  <Icons.Close size={18} />
                </Button>
              </div>

              <ul className="mt-3 flex flex-col gap-2">
                {cart.lines.map((line) => (
                  <li key={line.productId} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {line.description}
                      </span>
                      <span className="numeric block text-xs text-muted">
                        {formatMoney(line.priceIncl)} each
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        iconOnly
                        aria-label={`One fewer ${line.description}`}
                        onClick={() => cart.setQty(line.productId, line.qty - 1)}
                      >
                        <Icons.Minus size={15} />
                      </Button>
                      <span className="numeric min-w-5 text-center text-sm font-medium text-ink">
                        {line.qty}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        iconOnly
                        aria-label={`One more ${line.description}`}
                        onClick={() => cart.setQty(line.productId, line.qty + 1)}
                      >
                        <Icons.Plus size={15} />
                      </Button>
                    </span>

                    <span className="numeric w-16 shrink-0 text-right text-sm text-ink">
                      {formatMoney(line.qty * line.priceIncl)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-base font-semibold text-ink">
                <span>Total</span>
                <span className="numeric">{formatMoney(cart.subtotal)}</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                Delivery, if you choose it, is worked out at checkout.
              </p>

              <Link
                href={`/store/${token}/checkout`}
                onClick={() => setOpen(false)}
                className="mt-3 block"
              >
                <Button className="w-full">Checkout · {formatMoney(cart.subtotal)}</Button>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
