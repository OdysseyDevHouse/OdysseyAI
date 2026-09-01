'use client'

import { useEffect } from 'react'
import { setDisplayPrecision } from '@/lib/decimals'

/**
 * Carries the shop's decimal preferences into the CLIENT half of the tree.
 *
 * ── WHY THE LAYOUT'S CALL IS NOT ENOUGH ─────────────────────────────────────
 *
 * `lib/decimals` is imported by both server and client components, and those
 * are two different module instances — not two runtimes but two MODULE GRAPHS.
 * A `'use client'` component is rendered twice: once on the server to build the
 * initial HTML, and again in the browser to hydrate it. BOTH of those renders
 * read the client graph's copy, and the layout's `setDisplayPrecision` writes
 * the server graph's. So without this component a client table formats with the
 * defaults while a server-rendered figure beside it uses the shop's setting.
 *
 * ── AND WHY THE WRITE IS NOT GUARDED TO THE BROWSER ─────────────────────────
 *
 * It used to be, and that was the bug. `typeof window !== 'undefined'` skipped
 * the write during SSR, so the initial HTML carried `QTY_TRIM` — the server
 * printed a negative pile as `-3` — and the browser, where the guard let the
 * write through, hydrated the same row as `-3.00`. React reported the mismatch
 * and repaired it, which is why the screen looked right and the console did
 * not. Every one of the 40 client components that formats a quantity had the
 * same exposure; it surfaced on products because a negative stock figure is
 * where trimmed and fixed formatting visibly disagree.
 *
 * Unguarded, both renders read the same two numbers and agree.
 *
 * ── WHY DURING RENDER, AND WHY THIS IS SAFE PER REQUEST ─────────────────────
 *
 * An effect runs after the first paint: too late for the HTML, and a visible
 * reformat on every load. So the value is set during render, which for a
 * module-level assignment is idempotent — it writes the same two numbers every
 * time.
 *
 * On the server this is a write to a module shared by concurrent requests, and
 * it is safe for the same reason the layout's own call is: a render is
 * synchronous from this component down through the children it wraps, so no
 * other shop's render interleaves between this write and the formatting that
 * reads it.
 *
 * The effect stays for the job it is right for: re-applying the numbers when
 * they CHANGE, which is what makes a save on the setup screen take effect
 * without a reload.
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
  /* Both renders — SSR and hydration — so the HTML and the browser agree. */
  setDisplayPrecision({ qty, cost })

  useEffect(() => {
    setDisplayPrecision({ qty, cost })
  }, [qty, cost])

  return <>{children}</>
}
