'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, NumberInput, useToast } from '@/components/ui'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { useCart } from '../../CartContext'

/** Quantity picker plus the add button, on a product page. */
export default function AddToBasket({
  product,
  token,
}: {
  product: StorefrontProduct
  token: string
}) {
  const cart = useCart()
  const toast = useToast()
  const router = useRouter()
  const [qty, setQty] = useState(1)

  if (!product.inStock) {
    return (
      <p className="text-sm text-muted">
        This one is out of stock at the moment. Ask us when it&apos;s back.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          aria-label="One fewer"
          onClick={() => setQty((q) => Math.max(1, q - 1))}
        >
          <Icons.ChevronDown size={15} />
        </Button>
        <NumberInput
          value={qty}
          min={1}
          aria-label="Quantity"
          onChange={(e) => setQty(Math.max(1, Math.min(9999, Number(e.target.value) || 1)))}
          className="w-20"
        />
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          aria-label="One more"
          onClick={() => setQty((q) => Math.min(9999, q + 1))}
        >
          <Icons.ChevronUp size={15} />
        </Button>
      </div>

      <Button
        variant="primary"
        onClick={() => {
          cart.add(
            {
              productId: product.id,
              code: product.code,
              description: product.description,
              priceIncl: product.priceIncl,
            },
            qty,
          )
          toast.success(`${qty} × ${product.description} added.`)
        }}
      >
        <Icons.Plus size={16} />
        Add to basket
      </Button>

      <Button variant="ghost" onClick={() => router.push(`/store/${token}/checkout`)}>
        Go to basket
      </Button>
    </div>
  )
}
