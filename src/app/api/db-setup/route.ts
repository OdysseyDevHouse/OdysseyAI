import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { provisionStatements } from '@/lib/dbSetup/sql'
import { createStoreOwner, hasAnyUser } from '@/lib/dbSetup/firstUser'

/**
 * The setup wizard's back end, reachable only by the wizard.
 *
 * ── WHY ELECTRON TALKS TO NEXT OVER HTTP AT ALL ─────────────────────────────
 *
 * Because the provisioning logic is TypeScript in src/lib and the thing that
 * installs MariaDB is CommonJS in electron/. They are the same process — the
 * Next server runs in-process inside Electron — but not the same module graph,
 * and main.js cannot import a module that only exists compiled inside .next.
 *
 * ── AND WHY THE PLAN GOES TO MAIN RATHER THAN TO THE SCREEN ─────────────────
 *
 * `SetupPlan` carries the shop's database password in the clear; its own type
 * says it must never be logged or shown. A renderer is a browser, and what a
 * browser holds is one devtools window from being read. So the full plan is
 * answered to Electron main, which provisions with it and hands the SCREEN only
 * `redact(plan)`.
 *
 * ── THE KEY, AND WHY IT IS THE WHOLE GUARD ──────────────────────────────────
 *
 * These routes would otherwise be an unauthenticated way to read a shop's
 * database password off localhost — no session is involved, because the wizard
 * runs before there is anything to have a session with. Anything else on that
 * machine could ask.
 *
 * So main.js mints a random key at startup and puts it in the environment the
 * Next server inherits. A caller that cannot present it gets 404, not 403:
 * telling an unknown caller that an interesting endpoint exists here is itself
 * information.
 *
 * That single check also decides WHICH BUILD has these routes, and deliberately
 * so. Only Odyssey Database Setup sets the key, so on a back office or a till
 * this file is dead weight rather than a second guard that might disagree with
 * the first about what "the setup build" means.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_FOUND = new NextResponse(null, { status: 404 })

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
function keyMatches(offered: string | null): boolean {
  const expected = process.env.ODYSSEY_SETUP_KEY || ''
  if (!expected || !offered) return false
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!keyMatches(request.headers.get('x-odyssey-setup-key'))) return NOT_FOUND

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const action = String(body.action || '')

  switch (action) {
    /* ── WHAT IS LEFT HERE, AND WHY ────────────────────────────────────────
     *
     * sign-in, sites and plan have moved to the POS API — see
     * electron/posApi.js. They asked the control DATABASE questions that a
     * customer's machine can no longer ask, and should never have been asking
     * over a MySQL socket from a shop's counter.
     *
     * These two remain because they are not control-panel questions at all.
     * Both act on the SHOP'S OWN database, on this machine, which is exactly
     * what this route can reach and the API cannot. */

    case 'statements': {
      /* ── THE LAN WIDENING IS OPT-IN, NEVER A DEFAULT ─────────────────────
       *
       * Loopback alone serves a LOCAL site: one machine, its own app, nothing
       * else reaching the database. A HYBRID box is different — ten tills on
       * the shop network connect to it — but that is a real widening of who can
       * reach a shop's data, so sql.ts requires the caller to ask for it rather
       * than handing it out. The wizard asks; this only passes it on. */
      const allowFrom = ['127.0.0.1']
      const extra = typeof body.allowFrom === 'string' ? body.allowFrom.trim() : ''
      if (extra) allowFrom.push(extra)

      /* Generated HERE rather than in the main process because writing GRANTs
         is the one thing a second copy would be genuinely dangerous to get
         subtly different, and sql.ts is not requireable from CommonJS. */
      return NextResponse.json({
        statements: provisionStatements({
          databaseName: String(body.databaseName || ''),
          username: String(body.username || ''),
          password: String(body.password || ''),
          allowFrom,
        }),
      })
    }

    case 'has-users': {
      return NextResponse.json({ ok: true, any: await hasAnyUser(Number(body.siteId)) })
    }

    case 'create-owner': {
      const result = await createStoreOwner(
        Number(body.siteId),
        String(body.name || ''),
        String(body.pin || ''),
        body.email ? String(body.email) : null,
      )
      return NextResponse.json(result)
    }

    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
  }
}
