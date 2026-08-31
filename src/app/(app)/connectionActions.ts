'use server'

import { getSession } from '@/lib/session'
import { invalidateControlPool } from '@/lib/db'
import { invalidateAllSitePools } from '@/lib/siteDb'

/**
 * Throw away every cached connection pool, so the next request dials afresh.
 *
 * ── WHY A RELOAD ALONE DOES NOTHING ─────────────────────────────────────────
 *
 * mysql2 builds a pool without connecting. Both caches therefore store a pool
 * aimed at a bad host exactly as they store a working one, and every later
 * request reuses it and fails the same way. Correct the address, press refresh,
 * and the identical `getaddrinfo ENOTFOUND odpvdb101…` comes back — which reads
 * as "my edit did not take" rather than "you are talking to a cached socket".
 *
 * So the retry on ControlUnreachable clears the caches first. Without this it
 * would be a button that cannot, even in principle, change its own outcome.
 *
 * ── WHY THE COOKIE IS ENOUGH TO AUTHORISE IT ────────────────────────────────
 *
 * A Server Action is a public endpoint, so this needs a check — but the usual
 * one, requireSession(), reads the control database, and the database being
 * unreachable is the entire situation. Authorising through it would make the
 * button work only when it was not needed.
 *
 * getSession() verifies the signed session cookie and touches no database, so
 * it still answers while the line is down. That is a weaker check — it does not
 * catch a session revoked upstream — and it is proportionate to what is being
 * authorised: this reads nothing, writes nothing and returns nothing. The worst
 * a stale cookie buys is dropping some idle connections that were about to be
 * rebuilt anyway.
 */
export async function retryConnections(): Promise<void> {
  const session = await getSession()
  if (!session) return

  invalidateControlPool()
  invalidateAllSitePools()
}
