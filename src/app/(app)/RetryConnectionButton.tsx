'use client'

import { useState } from 'react'
import { Button, Icons } from '@/components/ui'
import { retryConnections } from './connectionActions'

/**
 * The retry on ControlUnreachable.
 *
 * Drops the server's cached pools BEFORE reloading — see connectionActions.ts
 * for why a plain reload cannot change its own outcome here.
 *
 * The reload happens whether or not the action succeeded. If it failed the page
 * is no worse off than before the click, and the alternative is a button that
 * appears to do nothing while the user is already unsure whether their edit
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
          await retryConnections()
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
