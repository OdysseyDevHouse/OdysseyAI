'use client'

import { useEffect } from 'react'
import { noteViewed } from '@/lib/recentlyViewed'

/**
 * Writes the product being looked at into this browser's own trail.
 *
 * The trail is read by RecentlyViewed; this is the only thing that writes it.
 *
 * Its own component, and its own effect, rather than a line inside TrackEvent:
 * that one reports to the SHOP and this one is the SHOPPER's history. They
 * happen to fire together today, and a shop switching analytics off must not
 * take a shopper's back-trail with it.
 */
export default function RememberView({
  token,
  productId,
}: {
  token: string
  productId: number
}) {
  useEffect(() => {
    noteViewed(token, productId)
  }, [token, productId])

  return null
}
