'use client'

import { BrandLockup } from '@/components/ui'
import DeviceNotLicensed from '@/components/DeviceNotLicensed'
import { deviceId, deviceLabel } from '@/lib/deviceId'
import { startCounterAction } from './deviceActions'
import type { DeviceState } from '@/lib/control/deviceMessages'

/**
 * The invoicing counter, refused.
 *
 * Same screen the till shows — see `DeviceNotLicensed` — because it is the same
 * licence: one row in `cp2_devices`, claimed by this machine, and spent by
 * whichever of the two windows is open on it. A counter that refused in
 * different words would send a supervisor looking for a second setting that
 * does not exist.
 *
 * The lockup is the exception, for the reason `InvoicingGate` gives: the till's
 * `logo-full.png` reads "POINT OF SALE" in the artwork itself, which is the
 * wrong product on a window that writes invoices, and a raster's words cannot
 * be swapped. So this is the icon beside the window's own typeset name, set
 * exactly as the gate and the chrome set it.
 *
 * The DOOR is the other exception. Putting this machine into service is the same
 * act either way, but it is reached on `sales.view` here and on `sales.till`
 * there — so each window brings its own action, both of which land on
 * `registerThisMachine`.
 */
export default function InvoicingNotLicensed({
  reason,
  message,
  offer,
  serial,
  onRetry,
}: {
  /** Which refusal this is, for the heading. */
  reason: Extract<DeviceState, { status: 'blocked' }>['reason']
  /** The specific refusal, from `deviceLabelFor`. */
  message: string
  /** What this machine may do about it, from `deviceOffer`. */
  offer?: Extract<DeviceState, { status: 'blocked' }>['offer']
  /** This machine's id. The one thing support needs to find the licence. */
  serial: string | null
  /** Re-ask the server — for the case where somebody just freed a licence. */
  onRetry: () => void
}) {
  return (
    <DeviceNotLicensed
      wordmark={<BrandLockup size="lg" sub="Invoicing" />}
      reason={reason}
      message={message}
      offer={offer}
      serial={serial}
      onRetry={onRetry}
      /* Read here, not from `serial` — that prop is for display and is null
         until the browser has been asked. See PosNotLicensed. */
      onStart={() => startCounterAction(deviceId() ?? '', deviceLabel())}
    />
  )
}
