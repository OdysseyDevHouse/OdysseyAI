'use client'

import { useEffect } from 'react'
import { deviceId, deviceKind, deviceLabel, devicePlatform, deviceRole } from '@/lib/deviceId'

/**
 * Tells the shop that this machine exists, once per page load.
 *
 * Renders nothing. Mounted in the (app) layout so a back-office PC registers
 * itself — a till already announces its id through the catalog feed, but an
 * office machine never opens the till and would otherwise be invisible to
 * Setup → Printing, which is the one screen that needs to know about it.
 *
 * Fire-and-forget by design. Every failure is swallowed: a machine that cannot
 * register must still be able to work, and the cost of failing is a row missing
 * from a setup list rather than anything a person is doing right now. The
 * server's own write is throttled (see touchDevice), so calling this on every
 * page load is cheap.
 */
export default function DeviceHeartbeat() {
  useEffect(() => {
    /* Only in the browser, and only once storage has given us an id. `null`
       means private browsing or a locked-down kiosk — a real state, and one
       where there is nothing stable to register. */
    const id = deviceId()
    if (!id) return

    const controller = new AbortController()
    void fetch('/api/device/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: id,
        label: deviceLabel(),
        kind: deviceKind(),
        platform: devicePlatform(),
        appRole: deviceRole(),
      }),
      signal: controller.signal,
      keepalive: true,
    }).catch(() => undefined)

    return () => controller.abort()
  }, [])

  return null
}
