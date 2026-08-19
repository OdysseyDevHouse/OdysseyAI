'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import DeclarationModal from '@/app/(pos)/pos/DeclarationModal'

/**
 * Reads a signed cash-up back, in the dialog that produced it.
 *
 * ── WHY A WRAPPER AND NOT A LINK ─────────────────────────────────────────
 *
 * "Recent cash-ups" is rendered by a SERVER component, and the declaration is
 * a client dialog with its own state. Something has to hold the open/closed
 * flag, and a whole client island around the table would drag the entire list
 * across the boundary for one button per row. This is the smallest piece that
 * can own that flag: a button and the dialog it opens.
 *
 * ── WHY THE SAME DIALOG ──────────────────────────────────────────────────
 *
 * Because there is one cash-up screen. This row's declaration was counted in
 * that dialog at the till; reading it back in a different rendering would be
 * the second screen this change exists to delete — and the two would drift
 * apart again the moment either was touched.
 *
 * The dialog renders a signed cash-up read-only on its own: `finalizedAt` is
 * on the view it fetches, so nothing here has to tell it, and nothing here can
 * get that wrong.
 */
export default function ViewDeclarationButton({ shiftId }: { shiftId: number }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        View
      </Button>
      {/* Mounted only once asked for. The dialog fetches the whole declaration
          on open, and a closed copy per row would be one such fetch per row of
          a list that is mostly scrolled past. */}
      {open && (
        <DeclarationModal
          open
          shiftId={shiftId}
          /* A signed record needs no owner default, and this shift's till is
             not this machine's. */
          terminalId={null}
          /* No outbox in the back office — see the note in CashupClient. */
          pendingSales={0}
          onClose={() => setOpen(false)}
          /* It is already signed; nothing here can finalize it again. */
          onFinalized={() => setOpen(false)}
        />
      )}
    </>
  )
}
