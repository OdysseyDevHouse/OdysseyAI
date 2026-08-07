import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { tickSite } from '@/lib/contracts/tick'

/**
 * Contract billing's heartbeat — call this once a day from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────────
 *
 * There is nobody signed in at 05:00. The caller is a cron job, so it proves
 * itself with a secret rather than a cookie. Without CONTRACT_CRON_SECRET set
 * the route refuses every request: a biller that silently ran wide open would be
 * a way for anyone to raise invoices against every customer in the system.
 *
 * ── WHY IT IS SAFE TO CALL OFTEN ─────────────────────────────────────────────
 *
 * Every period is claimed in contract_invoices before it is billed, under a
 * unique key on (contract_id, for_date) — so calling this twice a minute bills
 * nothing twice. Calling it RARELY is also safe: a contract left un-ticked for
 * three months bills three invoices on the next run, one per period, each at the
 * price that was correct for its own month.
 *
 * Once a day is the right cadence. Billing days are dates, not times, and an
 * invoice raised at 05:00 or 05:05 is the same invoice.
 *
 * Example crontab entry:
 *   5 5 * * * curl -fsS -H "Authorization: Bearer $CONTRACT_CRON_SECRET" \
 *     https://your-host/api/contracts/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites, each rendering and emailing PDFs, is not quick. */
export const maxDuration = 300

export async function POST(request: NextRequest) {
  return handle(request)
}

// GET as well, because most cron services only issue GETs. The secret is what
// authorises the call either way.
export async function GET(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const secret = process.env.CONTRACT_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Contract billing is not configured (CONTRACT_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  // The origin the emailed pay-links must point at. Taken from the request so
  // the same build works on localhost and in production — a link built against
  // the wrong host is a payment that can never be made.
  const origin = publicOrigin(request)

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let billed = 0
  let sent = 0
  let failed = 0

  for (const siteId of siteIds) {
    try {
      const result = await tickSite(siteId, origin)
      billed += result.billed
      sent += result.sent
      failed += result.failed
      // Only report sites that actually did something — a quiet site is the
      // normal case and logging it every day buries the real events.
      if (result.billed > 0 || result.sent > 0 || result.failed > 0) {
        results.push({ siteId, ...result })
      }
    } catch (e) {
      failed++
      // One site's database being unreachable must not stop the others.
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The tick failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    billed,
    sent,
    failed,
    results,
  })
}

/**
 * Accepts the secret as a bearer token or an `?key=` parameter, since cron
 * services vary in what they can send. Compared in constant time so the
 * endpoint cannot be used as an oracle to recover the secret byte by byte.
 */
function authorised(request: NextRequest, secret: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const query = request.nextUrl.searchParams.get('key') ?? ''
  return safeEqual(bearer, secret) || safeEqual(query, secret)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — so the lengths are compared first and the result folded in.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function publicOrigin(request: NextRequest): string {
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost:4100'
  const proto =
    request.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
