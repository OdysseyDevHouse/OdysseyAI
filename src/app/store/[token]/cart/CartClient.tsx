'use client'

/**
 * The basket, as a page.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM CHECKOUT ─────────────────────────────
 *
 * `/checkout` has been the basket as well as the checkout, so no page said
 * "here is what you are buying" without immediately asking for an address. The
 * drawer is the only other basket view and it is `md:hidden`, which means a
 * shopper on a laptop had no way to look at their basket at all — only a count
 * in the masthead and a button that jumps straight to a form.
 *
 * ── AND WHY CHECKOUT IS LEFT ALONE ───────────────────────────────────────
 *
 * `Checkout.tsx` is a thousand lines holding delivery, addresses, discounts,
 * gift cards, loyalty and account credit in one interleaved block of state,
 * and its own header argues — correctly — for one page rather than a wizard.
 * Extracting the basket half would risk all of that to save duplicating a list
 * of lines and a stepper. This page is written fresh; checkout keeps showing
 * the basket it always did, which is also what a shopper wants at the moment
 * they confirm.
 */

import Link from 'next/link'
import { Button, Icons } from '@/components/ui'
import { useCart } from '../CartContext'
import { useMoney } from '../CurrencyContext'

export default function CartClient({ token }: { token: string }) {
  const cart = useCart()
  const money = useMoney()
  const base = `/store/${token}`

  /*
   * Nothing is drawn until localStorage has been read.
   *
   * The basket lives in the browser, so the server renders an empty one and the
   * first client paint would replace it — "Your basket is empty" flashing on
   * every load for a shopper who has three things in it. `ready` is the cart's
   * own answer to that, and it exists for exactly this.
   */
  if (!cart.ready) {
    return <div className="py-10 text-center text-sm text-muted">Loading your basket…</div>
  }

  if (cart.lines.length === 0) {
    return (
      <div className="py-12 text-center">
        <h1 className="text-xl font-semibold text-ink">Your basket is empty</h1>
        <p className="mt-2 text-sm text-muted">Nothing in it yet.</p>
        <Link
          href={base}
          className="mt-5 inline-block text-sm font-medium text-brand hover:underline"
        >
          Start shopping
        </Link>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink">Your basket</h1>

      <ul className="mt-4 flex flex-col divide-y divide-border border-y border-border">
        {cart.lines.map((line) => (
          <li key={line.productId} className="flex items-center gap-3 py-3">
            <span className="min-w-0 flex-1">
              {/*
                The name is a LINK back to the product. Somebody looking at
                their basket and hesitating over a line wants to check it, and
                sending them to search for it again is how a basket gets
                abandoned rather than corrected.
              */}
              <Link
                href={`${base}/p/${line.productId}`}
                className="block truncate text-sm font-medium text-ink hover:text-brand"
              >
                {line.description}
              </Link>
              <span className="numeric block text-xs text-muted">{money(line.priceIncl)} each</span>
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
              <span className="numeric min-w-6 text-center text-sm font-medium text-ink">
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

            <span className="numeric w-20 shrink-0 text-right text-sm font-medium text-ink">
              {money(line.qty * line.priceIncl)}
            </span>

            {/*
              Remove is separate from the minus button, deliberately. Stepping
              a line down to nothing is four taps on a quantity of four, and a
              shopper who has decided against something has decided once.
            */}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove ${line.description}`}
              onClick={() => cart.remove(line.productId)}
            >
              <Icons.Trash size={15} />
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-muted">Subtotal</span>
        <span className="numeric text-lg font-semibold text-ink">{money(cart.subtotal)}</span>
      </div>
      {/*
        Said here rather than left as a surprise at the last step. The delivery
        fee depends on an address nobody has typed yet, so this page genuinely
        cannot show a total — and a subtotal presented as though it were one is
        the commonest reason a basket is abandoned at the payment screen.
      */}
      <p className="mt-1 text-right text-xs text-muted">
        Delivery, if you need it, is worked out at checkout.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Link href={base} className="text-sm font-medium text-brand hover:underline">
          Keep shopping
        </Link>
        <Button onClick={() => window.location.assign(`${base}/checkout`)}>
          Checkout
          <Icons.ChevronRight size={16} />
        </Button>
      </div>
    </div>
  )
}
