import { NextResponse, type NextRequest } from 'next/server'

/**
 * Which release channel this machine is on. Called by the Electron shell before
 * every update check.
 *
 * ── WHY A ROUTE AND NOT A CALL FROM THE SHELL ───────────────────────────────
 *
 * The answer comes from the control panel over a SIGNED request, and everything
 * that signs one — the site key, the client credentials, the signing string —
 * lives in the Next server's module tree, which runs in-process here but is
 * deliberately not on the shell's resolution path (see electron/appModules.js).
 * An HTTP call to a route the server already serves keeps the shell independent
 * of what Next traced into its build. /api/licence/refresh exists for exactly
 * the same reason and is worth reading alongside this.
 *
 * ── THE SERIAL COMES FROM THE CALLER, NOT FROM A COOKIE ─────────────────────
 *
 * leaseSubject.ts reads the device id from a cookie the renderer mirrors it
 * into, which works for a page render and cannot work here: this is a
 * background timer with no browser and no request scope. The shell reads the
 * canonical copy — the `device-id` file in userData — and posts it.
 *
 * That is not a downgrade in trust, because it never was a credential. The
 * portal treats the serial as a CLAIM about which machine is asking and gates
 * nothing on it; what proves the request is the site key, which decides which
 * shop's devices can be asked about at all. Lying about the serial gets you
 * another machine's channel, within your own shop, which is a setting you can
 * already read from the control panel.
 */

export const dynamic = 'force-dynamic'

/**
 * Loopback only, and desktop only.
 *
 * No cron secret, for the same reason /api/licence/refresh has none: this is
 * bound to 127.0.0.1 in the Electron shell and serves one caller in the same
 * process, so a shared secret would be a lock whose key ships in the installer
 * beside it. The worst a local caller can do is ask the control panel a
 * question it was going to ask anyway.
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

/**
 * Kept identical to DEFAULT_CHANNEL in electron/updateChannel.js and to the
 * column default in the control panel's migration 122. Three copies of one
 * decision, and none of them is safe to change alone — but each has to be able
 * to answer without the other two, which is precisely why they are copies.
 */
const DEFAULT_CHANNEL = 'stable'

export async function POST(req: NextRequest) {
  const refused = refusedReason(req)
  if (refused) {
    return NextResponse.json({ ok: false, error: refused }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { serial?: unknown } | null
  const serial = typeof body?.serial === 'string' ? body.serial.trim().slice(0, 190) : ''
  if (!serial) {
    /* A machine with no device id yet — a fresh install that has never been
       registered. It belongs on the shipping release, which is what it gets. */
    return NextResponse.json({ ok: true, channel: DEFAULT_CHANNEL, matched: false })
  }

  /* Imported lazily so a cloud build never pulls the portal client in for a
     route it refuses at the first line. */
  const { send } = await import('@/lib/control/portalApi')
  const result = await send<{ channel?: string; matched?: boolean }>(
    'GET',
    '/update-channel',
    undefined,
    serial,
  )

  if (!result.ok) {
    /* ── UNREACHABLE IS NOT AN ANSWER, AND MUST NOT LOOK LIKE ONE ──────────
     *
     * A 502 here makes the shell keep the channel it already had. Answering
     * `{ channel: 'stable' }` would be a real answer that silently walks a beta
     * tester back onto stable every time the line hiccups — and forward again
     * on the next successful check, downloading a different installer each way.
     *
     * A machine that has never had an answer defaults to stable on its own, in
     * updateChannel.js. That is where the safe default belongs: in the absence
     * of information, not in the misreporting of it. */
    return NextResponse.json(
      { ok: false, error: result.error, reason: result.reason },
      { status: 502 },
    )
  }

  const channel = String(result.data?.channel ?? '').trim().toLowerCase()
  return NextResponse.json({
    ok: true,
    channel: channel || DEFAULT_CHANNEL,
    matched: Boolean(result.data?.matched),
  })
}
