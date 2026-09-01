'use client'

import { BrandLockup } from '@/components/ui'
import DeviceNotLicensed from '@/components/DeviceNotLicensed'
import { deviceId, deviceLabel } from '@/lib/deviceId'
import { startTillAction } from './deviceActions'
import type { DeviceState } from '@/lib/control/deviceMessages'

/**
 * The till, refused.
 *
 * The screen itself is `DeviceNotLicensed`, shared with the invoicing counter
 * because both windows spend the same `cp2_devices` licence and must therefore
 * refuse for the same reasons in the same words. What is left here is the till's
 * own wordmark, and the till's own door — `startTillAction` is guarded on
 * `sales.till`, which the counter's reader does not necessarily hold.
 */
export default function PosNotLicensed({
  modeName,
  reason,
  message,
  offer,
  serial,
  onRetry,
}: {
  /**
   * The module on the lockup's subline — "Retail", "Hospitality", "Invoicing".
   *
   * Passed in rather than read here for the same reason the status bar takes
   * it: this component stays mode-blind, and PosEntry has already resolved
   * which till this machine is. See lib/posMode.
   */
  modeName: string
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
      wordmark={
        /* The TYPESET lockup, not `logo-full.png`.

           That artwork reads "POINT OF SALE" in the raster itself, so a shop
           running tables was refused a licence under the name of a product it
           does not run — and being a raster, the words could not be swapped.
           The kit's lockup says the same thing in the same shape and puts THIS
           till's module on the subline. It is also drawn in ink rather than
           dark navy, which retires the `.logo-plate` workaround this screen
           needed to stay visible in dark mode. */
        <BrandLockup size="lg" sub={modeName} />
      }
      reason={reason}
      message={message}
      offer={offer}
      serial={serial}
      onRetry={onRetry}
      /* The id is read HERE rather than taken from the `serial` prop, which is
         only for display and may be null while the browser is still being asked.
         Registering against a stale null would silently do nothing. */
      onStart={() => startTillAction(deviceId() ?? '', deviceLabel())}
    />
  )
}
