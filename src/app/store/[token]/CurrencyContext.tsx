'use client'

/**
 * What money this shop takes, for everything that draws a price.
 *
 * ── A CONTEXT, NOT A PROP ────────────────────────────────────────────────
 *
 * Fifty-three places in the storefront format a price, across a dozen files
 * and several client components — a tile, a basket line, a statement row, a
 * gift-card balance. Threading a symbol through all of them is fifty-three
 * chances to miss one, and the miss is silent: a page where most prices say
 * "$" and one says "R".
 *
 * The shop's own colour is applied the same way and for the same reason — see
 * StoreChrome. A component draws a price without knowing a currency exists.
 *
 * ── AND WHY IT DEFAULTS RATHER THAN THROWING ─────────────────────────────
 *
 * A provider that is missing gives 'R' and 'ZAR', which is what every shop
 * renders today. A price is not the place to discover a wiring mistake by
 * showing an error where a number should be.
 */

import { createContext, useContext, type ReactNode } from 'react'
import { formatMoney } from '@/lib/decimals'

export type Currency = {
  /** What a shopper reads: "R", "$", "£". */
  symbol: string
  /** ISO 4217, for structured data and payment. Never shown to a shopper. */
  code: string
}

export const DEFAULT_CURRENCY: Currency = { symbol: 'R', code: 'ZAR' }

const CurrencyContext = createContext<Currency>(DEFAULT_CURRENCY)

export function CurrencyProvider({
  currency,
  children,
}: {
  currency: Currency
  children: ReactNode
}) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>
}

/**
 * Format a price in the shop's own money.
 *
 * Wraps `formatMoney`, which has taken a currency since it was written and had
 * never been given one. The grouping, the decimals and the minus sign are all
 * still its job — this only decides what goes in front.
 */
export function useMoney(): (value: unknown) => string {
  const { symbol } = useContext(CurrencyContext)
  return (value: unknown) => formatMoney(value, symbol)
}

/** The shop's currency, for the few places that need the code rather than a price. */
export function useCurrency(): Currency {
  return useContext(CurrencyContext)
}
