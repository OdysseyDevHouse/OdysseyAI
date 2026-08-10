'use client'

import { useEffect, useRef } from 'react'
import type { EventKind } from '@/lib/site/storefrontEvents'
import { recordEventAction } from './eventActions'

/**
 * Records one funnel event when a page is reached.
 *
 * ── ONCE PER MOUNT, GUARDED ──────────────────────────────────────────────
 *
 * React runs effects twice in development's strict mode, and a shopper who
 * refreshes is a real second view while a re-render is not. The ref is what
 * keeps a re-render from inflating the top of the funnel — which would make
 * every conversion rate below it look worse than it is.
 *
 * ── IT NEVER BLOCKS ANYTHING ─────────────────────────────────────────────
 *
 * Fire and forget, with the rejection swallowed. A page that failed to render
 * because its analytics call failed would be a page trading its actual job for
 * a number nobody is watching in real time.
 */
export default function TrackEvent({
  token,
  kind,
  productId,
}: {
  token: string
  kind: EventKind
  productId?: number | null
}) {
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current) return
    sent.current = true
    void recordEventAction(token, kind, productId ?? null).catch(() => {})
  }, [token, kind, productId])

  return null
}
