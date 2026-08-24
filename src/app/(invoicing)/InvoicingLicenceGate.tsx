'use client'

import { useCallback, useEffect, useState } from 'react'
import { deviceId } from '@/lib/deviceId'
import { checkCounterDeviceAction } from './deviceActions'
import type { DeviceState } from '@/lib/control/deviceMessages'
import InvoicingNotLicensed from './InvoicingNotLicensed'

/**
 * The counter, or a refusal — decided on the CLIENT, because only it knows the
 * machine.
 *
 * ── WHY THE COUNTER IS GATED AT ALL ───────────────────────────────────────
 *
 * An invoice typed here is a sale: it takes money, it moves stock, and
 * `finaliseSaleAction` already refuses to write one from an unlicensed device
 * (see `requireLicensedDevice`). Before this existed, an unregistered machine
 * could open the window, be handed a customer, and have a document typed line
 * by line — and only discover the refusal at the tender pad, with the customer
 * standing there. That is the exact failure the till's `PosNotLicensed` was
 * built to prevent, and this window had no equivalent.
 *
 * So it refuses at the door, the way the till does, in the same words.
 *
 * ── WHY IT IS A CLIENT COMPONENT WRAPPING THE LAYOUT ──────────────────────
 *
 * The layout is a server component and the device id is not a server fact —
 * it lives in the Electron shell's userData file or the browser's
 * localStorage. So the server renders the counter as usual, and this asks the
 * question the moment it can and replaces the counter if the answer is no.
 *
 * Mounted INSIDE the layout rather than repeated on each screen: it wraps the
 * chrome, so all four screens are covered by one check that survives client
 * navigation between them rather than re-running on every link.
 *
 * ── AND WHY IT SITS AFTER THE PIN GATE ────────────────────────────────────
 *
 * Same order the till uses. A clerk who cannot sign in learns nothing useful
 * from a licensing message, and the layout renders `InvoicingGate` above this
 * for exactly that reason.
 */
export default function InvoicingLicenceGate({ children }: { children: React.ReactNode }) {
  /* `undefined` is "not asked yet", which is NOT "blocked". Rendering a refusal
     during that gap would flash "not set up as a till" at a perfectly licensed
     counter on every load. */
  const [licence, setLicence] = useState<DeviceState | undefined>(undefined)
  const [serial, setSerial] = useState<string | null>(null)

  /* Bumped to re-ask, for the case that actually happens: a supervisor links
     this machine in the back office on another screen, then comes back and taps
     "Check again" rather than explaining a reload to somebody mid-shift. */
  const [nonce, setNonce] = useState(0)
  const recheck = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    const id = deviceId()
    setSerial(id)

    /*
     * NO IDENTIFIER AT ALL — private browsing, or storage blocked.
     *
     * Allowed through rather than refused. `deviceId()` returns null there by
     * design, the invoice save path treats an absent serial the same way, and
     * the till makes the identical call in `PosEntry` — so this is one decision
     * made consistently rather than three that could disagree.
     */
    if (!id) {
      setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
      return
    }

    void checkCounterDeviceAction(id)
      .then((state) => {
        if (!cancelled) setLicence(state)
      })
      .catch(() => {
        /* The control database is unreachable. Trade on — the same trade
           `requireLicensedDevice` makes server-side, and for the same reason: a
           counter stopped by a licence server hiccup is a far worse failure
           than a few minutes of unverified invoicing. */
        if (!cancelled) {
          setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [nonce])

  /* Blank rather than a spinner: the answer arrives in milliseconds, and a
     spinner that flashes on every load is worse than nothing. */
  if (licence === undefined) return null

  if (licence.status === 'blocked') {
    return (
      <InvoicingNotLicensed
        reason={licence.reason}
        message={licence.message}
        offer={licence.offer}
        serial={serial}
        onRetry={recheck}
      />
    )
  }

  return <>{children}</>
}
