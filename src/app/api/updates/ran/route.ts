import { NextResponse, type NextRequest } from 'next/server'

/**
 * "I have taken my scheduled update." Posted by the Electron shell in the
 * moment before it restarts into the new build.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * A booked window is one-shot: the control panel records a date and time, the
 * machine acts on it, and the booking is cleared. Something has to do the
 * clearing, and the honest candidate is the machine — because it is the only
 * party that knows whether anything actually happened.
 *
 * The alternative, a sweep on the portal that clears any window whose moment
 * has passed, clears bookings for machines that were switched OFF at 02:00 —
 * which are precisely the machines that still need the update. A shop that
 * closed early would silently miss its window and nobody would find out. So the
 * booking stays live until this call, and a machine that was off on the night
 * takes it the next time it is running.
 *
 * ── IT IS A RELAY, LIKE ITS NEIGHBOUR ───────────────────────────────────────
 *
 * Same shape and same reasoning as /api/updates/channel: the call has to be
 * SIGNED with the site key, and everything that signs one lives in the Next
 * server's module tree rather than on the shell's resolution path (see
 * electron/appModules.js). The shell posts here; this signs and forwards.
 */

export const dynamic = 'force-dynamic'

/**
 * Loopback only, and desktop only.
 *
 * No cron secret, for the same reason /api/updates/channel has none: this is
 * bound to 127.0.0.1 in the Electron shell and serves one caller in the same
 * process, so a shared secret would be a lock whose key ships in the installer
 * beside it.
 *
 * The worst a local caller can do is clear a booking on this machine — which is
 * a machine whose own app they are already running, and a button the control
 * panel offers to the shop's own account anyway. The write is scoped to the
 * signing site by the portal, so it cannot reach anybody else's estate.
 */
function refusedReason(req: NextRequest): string | null {
  if (process.env.APP_MODE !== 'desktop') return 'not a desktop install'

  const host = req.headers.get('host') ?? ''
  const hostname = host.replace(/:\d+$/, '')
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    return 'not a loopback request'
  }
  return null
}

export async function POST(req: NextRequest) {
  const refused = refusedReason(req)
  if (refused) {
    return NextResponse.json({ ok: false, error: refused }, { status: 403 })
  }

  /* ── THE SERIAL COMES FROM THE CALLER, AS IT DOES NEXT DOOR ──────────────
   *
   * Identical to /api/updates/channel and for the identical reason: this is a
   * background timer with no browser and no request scope, so the cookie
   * leaseSubject.ts reads is not available. The shell reads the canonical copy
   * — the `device-id` file in userData — and posts it.
   *
   * That is not a downgrade in trust, because it never was a credential. The
   * portal treats the serial as a CLAIM about which machine is asking; what
   * proves the request is the site key, which decides whose devices can be
   * touched at all. The worst a local caller can do by lying is clear a booking
   * on another machine WITHIN ITS OWN SHOP — a button that shop already has. */
  const body = (await req.json().catch(() => null)) as { serial?: unknown } | null
  const serial = typeof body?.serial === 'string' ? body.serial.trim().slice(0, 190) : ''
  if (!serial) {
    /* No device id yet means this machine has never registered, so it cannot
       have had a window booked for it. Nothing to clear, and not an error. */
    return NextResponse.json({ ok: true, cleared: false })
  }

  const { send } = await import('@/lib/control/portalApi')
  const result = await send<{ ok?: boolean; cleared?: boolean }>(
    'POST',
    '/update-ran',
    {},
    serial,
  )

  if (!result.ok) {
    /* The install is already under way and cannot be called back, so this is
       reported rather than acted on. The machine comes back up to date with a
       booking still live, finds nothing to install on its next check, and
       clears it then — see the note in the portal's route. */
    return NextResponse.json(
      { ok: false, error: result.error, reason: result.reason },
      { status: 502 },
    )
  }

  return NextResponse.json({ ok: true, cleared: Boolean(result.data?.cleared) })
}
