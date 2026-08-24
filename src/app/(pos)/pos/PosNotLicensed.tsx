'use client'

import Image from 'next/image'
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
      wordmark={
        /* `.logo-plate` rather than a `dark:` variant: this app has no such
           variant registered — it themes by swapping custom properties under
           [data-theme] — so `dark:bg-white` fired off the OS preference alone
           and put a white plate behind the wordmark on a LIGHT screen. The class
           uses the same three-way selector the tokens do. See globals.css. */
        <Image
          src="/logo-full.png"
          alt="Odyssey Point of Sale"
          width={1109}
          height={304}
          className="logo-plate h-20 w-auto object-contain"
          priority
          unoptimized
        />
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
