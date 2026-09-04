'use client'

import { useState } from 'react'
import { Button, Icons } from '@/components/ui'
import { retryConnections } from './connectionActions'

/**
 * How long to wait for the action before reloading anyway.
 *
 * ── WHY THERE HAS TO BE A CEILING AT ALL ────────────────────────────────────
 *
 * A Server Action is not just the function body: Next re-renders the route
 * afterwards and streams the result back, and the client `await` does not
 * settle until that whole round trip does. On THIS screen the render being
 * waited on is the one that is already failing — so the button's response time
 * is the failure's response time, and the failure is a database that may take
 * ten seconds a connection to give up, or a proxy in front of the server that
 * never answers at all.
 *
 * Without a ceiling the button then sits on "Reconnecting…", disabled, with no
 * error and no way out. That is indistinguishable from the app having frozen,
 * and it is the one reading a person cannot act on.
 *
 * Eight seconds is longer than a healthy retry (well under a second, locally)
 * and shorter than any of the stalls above, so a slow-but-working server still
 * gets to finish the action before the fallback fires.
 */
const RETRY_TIMEOUT_MS = 8_000

/**
 * The retry on ControlUnreachable.
 *
 * Drops the server's cached pools BEFORE reloading — see connectionActions.ts
 * for why a plain reload cannot change its own outcome here.
 *
 * The reload happens whether or not the action succeeded, and now whether or
 * not it ANSWERED. If it failed the page is no worse off than before the click;
 * if it hung, reloading is still the better move, because the browser's own
 * loading state at least says something is happening. The alternative in both
 * cases is a dead button while the user is already unsure whether their edit
 * took.
 */
export default function RetryConnectionButton() {
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          /* Racing rather than aborting: a Server Action in flight cannot be
             cancelled from here, and it does not need to be. Dropping a pool is
             idempotent and touches nothing the reload depends on, so letting a
             late one land after the page has gone costs nothing. */
          await Promise.race([
            retryConnections(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('retry timed out')), RETRY_TIMEOUT_MS),
            ),
          ])
        } catch {
          /* Deliberately swallowed: reload regardless, see above. */
        }
        window.location.reload()
      }}
    >
      <Icons.Refresh size={18} />
      {busy ? 'Reconnecting…' : 'Try again'}
    </Button>
  )
}
