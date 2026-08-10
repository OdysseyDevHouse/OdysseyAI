'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { recordEventAction } from './eventActions'

/**
 * The shopper's basket.
 *
 * Lives entirely in the browser, in localStorage, and holds only product ids
 * and quantities. It deliberately does NOT hold prices as anything but a
 * display hint: every figure that matters is recomputed server-side when the
 * order is placed, so a basket edited in devtools buys nothing at a discount.
 *
 * Keyed per store token, because one browser may shop at two stores and the
 * baskets must not bleed into each other.
 */

export type CartLine = {
  productId: number
  code: string
  description: string
  /** For display only. The server prices the order from its own catalogue. */
  priceIncl: number
  qty: number
}

type CartApi = {
  lines: CartLine[]
  count: number
  /** Indicative only — the real total comes back from checkout. */
  subtotal: number
  add: (line: Omit<CartLine, 'qty'>, qty?: number) => void
  setQty: (productId: number, qty: number) => void
  remove: (productId: number) => void
  clear: () => void
  /** False until localStorage has been read, so SSR and first paint agree. */
  ready: boolean
}

const CartContext = createContext<CartApi | null>(null)

export function useCart(): CartApi {
  const context = useContext(CartContext)
  if (!context) throw new Error('useCart must be used inside CartProvider')
  return context
}

export function CartProvider({ token, children }: { token: string; children: ReactNode }) {
  const storageKey = `odyssey.cart.${token}`
  const [lines, setLines] = useState<CartLine[]>([])
  const [ready, setReady] = useState(false)

  // Read once on mount rather than in useState's initialiser: the server
  // renders this component too, and touching localStorage there would throw.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as CartLine[]
        if (Array.isArray(parsed)) {
          setLines(
            parsed.filter(
              (l) => Number.isInteger(l?.productId) && Number(l?.qty) > 0,
            ),
          )
        }
      }
    } catch {
      /* unreadable or disabled storage — start with an empty basket */
    }
    setReady(true)
  }, [storageKey])

  useEffect(() => {
    if (!ready) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(lines))
    } catch {
      /* quota or private mode — the basket just won't survive a reload */
    }
  }, [lines, ready, storageKey])

  const add = useCallback(
    (line: Omit<CartLine, 'qty'>, qty = 1) => {
      setLines((prev) => {
        const existing = prev.find((l) => l.productId === line.productId)
        if (existing) {
          return prev.map((l) =>
            l.productId === line.productId ? { ...l, qty: Math.min(l.qty + qty, 9999) } : l,
          )
        }
        return [...prev, { ...line, qty: Math.min(qty, 9999) }]
      })

      /*
       * The middle of the funnel, recorded HERE because every route into a
       * basket comes through this function — a tile, a product page, a
       * restored saved basket. Recording it at each call site instead would
       * mean the next one added quietly does not count.
       *
       * Fire and forget: adding to a basket must never wait on, or fail
       * because of, a measurement.
       */
      void recordEventAction(token, 'add_to_cart', line.productId).catch(() => {})
    },
    [token],
  )

  const setQty = useCallback((productId: number, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => l.productId !== productId)
        : prev.map((l) => (l.productId === productId ? { ...l, qty: Math.min(qty, 9999) } : l)),
    )
  }, [])

  const remove = useCallback((productId: number) => {
    setLines((prev) => prev.filter((l) => l.productId !== productId))
  }, [])

  const clear = useCallback(() => setLines([]), [])

  const value = useMemo<CartApi>(
    () => ({
      lines,
      count: lines.reduce((sum, l) => sum + l.qty, 0),
      subtotal: lines.reduce((sum, l) => sum + l.qty * l.priceIncl, 0),
      add,
      setQty,
      remove,
      clear,
      ready,
    }),
    [lines, add, setQty, remove, clear, ready],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
