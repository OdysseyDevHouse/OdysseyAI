'use client'

import { useEffect } from 'react'
import { setDisplayPrecision } from '@/lib/decimals'

/**
 * Carries the shop's decimal preferences into the CLIENT half of the tree.
 *
 * ── WHY THE LAYOUT'S CALL IS NOT ENOUGH ─────────────────────────────────────
 *
 * `lib/decimals` is imported by both server and client components, and those
 * are two different module instances in two different runtimes. The layout sets
 * the value on the server copy; nothing has ever set it on the browser's, so a
 * client table would format with the defaults while the server-rendered row
 * above it used the shop's setting — the same number in two shapes on one
 * screen.
 *
 * ── AND WHY IT RUNS DURING RENDER, NOT ONLY IN AN EFFECT ────────────────────
 *
 * An effect runs AFTER the first paint. A table formatted during that first
 * render would draw with the defaults and then silently reformat, which is a
 * visible flicker on every page load and — worse — a hydration mismatch, since
 * the server produced the shop's format and the client produced the default.
 *
 * So the value is set during render, which for a module-level assignment is
 * safe and idempotent: it writes the same two numbers every time. The effect
 * re-applies it when the numbers change, which is what makes a save on the
 * setup screen take effect without a reload.
 *
 * Renders nothing. It exists for its side effect, which is why it takes
 * children rather than being a wrapper with markup of its own.
 */
export default function PrecisionProvider({
  qty,
  cost,
  children,
}: {
  qty: number
  cost: number
  children: React.ReactNode
}) {
  /* During render, so the first paint already has the right format. Guarded to
     the browser: on the server the layout has already set it, and doing it
     again here would be one module write per component render. */
  if (typeof window !== 'undefined') setDisplayPrecision({ qty, cost })

  useEffect(() => {
    setDisplayPrecision({ qty, cost })
  }, [qty, cost])

  return <>{children}</>
}
