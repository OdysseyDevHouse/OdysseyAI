'use client'

import { useEffect } from 'react'
import { ensureWindowId } from '@/lib/windowSession'

/**
 * Keeps this tab's id present in a cookie, for the counter windows.
 *
 * ── WHY A COMPONENT AND NOT JUST THE SIGN-IN CALL ─────────────────────────
 *
 * The gates mint the id when somebody types a PIN, which covers the moment that
 * matters. What it does not cover is the LIFE of the session afterwards, and
 * two ordinary things break it:
 *
 *   1. A browser restart with the tab restored. `sessionStorage` comes back
 *      with the tab; the cookie, being a session cookie, may not. Without a
 *      rewrite the operator is bounced to the PIN pad despite the tab — and
 *      therefore the person — being exactly the one that signed in.
 *   2. Anything that clears cookies but not storage.
 *
 * `ensureWindowId` is idempotent and rewrites the cookie every call, so
 * mounting this on the counter layouts keeps the two halves in step for as long
 * as the tab lives.
 *
 * ── WHY IT MINTS RATHER THAN ONLY REWRITING ───────────────────────────────
 *
 * A tab that has never signed in gets an id here, before anybody types a PIN.
 * That is harmless — an id grants nothing until a till token is signed to it —
 * and it means the cookie is already in place on the request that FOLLOWS the
 * sign-in, rather than racing it.
 *
 * Renders nothing; it is an effect with a mounting point.
 */
export default function WindowSessionMarker() {
  useEffect(() => {
    ensureWindowId()
  }, [])
  return null
}
