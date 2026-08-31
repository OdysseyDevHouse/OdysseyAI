import { NextResponse, type NextRequest } from 'next/server'

/**
 * Renew this machine's licence lease. Called by the Electron shell on a timer.
 *
 * ── WHY A ROUTE AND NOT A CALL FROM THE SHELL ───────────────────────────────
 *
 * Everything the renewal needs — the control pool, the site database, the
 * entitlement rules — lives in the Next server's module tree, which runs
 * in-process but is NOT on the shell's resolution path (see
 * electron/appModules.js on why the two trees are deliberately separate).
 * Reaching into compiled server chunks from the shell would couple the shell to
 * Next's tracing output; an HTTP call to a route the server already serves does
 * not. main.js already waits on /api/health the same way.
 *
 * ── WHAT RENEWS THE LEASE ───────────────────────────────────────────────────
 *
 * Nothing here writes one. It calls entitlementsForSite(), which reads the
 * control database and — on success only — records the lease through the same
 * path a page render always used. That keeps `checked_at` honest: it moves on a
 * real answer and on nothing else, which is the property the seven days rest on.
 *
 * So this route is a TRIGGER, not a second implementation. If the control
 * database cannot be reached it does nothing at all, the existing lease stands,
 * and the machine locks on schedule if that goes on for LEASE_DAYS.
 */

export const dynamic = 'force-dynamic'

/**
 * Loopback only, and desktop only.
 *
 * No cron secret, unlike the /api/*\/tick routes: those are reachable from the
 * internet on a cloud deployment and need one. This is bound to 127.0.0.1 in
 * the Electron shell and serves exactly one caller in the same process, so the
 * secret would be a shared constant baked into a build a customer can unpack —
 * a lock whose key ships beside it.
 *
 * It carries no data either way. The worst a local caller can do is make the
 * machine ask the control panel a question it was going to ask anyway.
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

  /* Imported lazily so a cloud build never pulls the control modules in for a
     route it refuses at the first line. */
  const { resolveOfflineSite } = await import('@/lib/licence/offlineSite')
  const siteId = (await resolveOfflineSite())?.siteId ?? null
  if (!siteId) {
    /* Not an error: a desktop install that Setup has not finished, or one whose
       lease has never been planted. There is nothing to renew and nothing to
       report. */
    return NextResponse.json({ ok: true, refreshed: false, reason: 'no site' })
  }

  try {
    const { refreshEntitlements } = await import('@/lib/control/modules')
    const result = await refreshEntitlements(siteId)
    return NextResponse.json({
      ok: true,
      refreshed: result.reached,
      siteId,
      /* `leased` means the answer came from the lease rather than the control
         panel — i.e. the renewal did not happen. Reported rather than hidden so
         the shell log says which of the two it was. */
      source: result.reached ? 'control' : 'lease',
    })
  } catch (err) {
    /* A failed renewal is the ordinary state of a machine with no line. Answer
       200 with refreshed:false rather than an error status: the shell logs
       this, and a red line every five hours on a shop that is simply offline
       trains everybody to ignore the log. */
    return NextResponse.json({
      ok: true,
      refreshed: false,
      siteId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
