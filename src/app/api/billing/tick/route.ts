import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { runEscalation, runReconciliation } from '@/lib/billing/escalation'

/**
 * Platform billing's heartbeat — call this once a day from cron.
 *
 * Two jobs, both safe to run as often as you like:
 *
 *   ESCALATION    raises the price for accounts whose anniversary is today
 *   RECONCILIATION pushes any local amount PayFast has not accepted yet
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ──────────────────────────────────
 *
 * There is nobody signed in at 05:00. The caller is a cron job, so it proves
 * itself with a secret rather than a cookie. Without BILLING_CRON_SECRET set
 * the route refuses every request: a job that silently ran wide open would be a
 * way for anyone to raise every customer's price.
 *
 * ── WHY IT IS SAFE TO CALL OFTEN, AND SAFE TO MISS ─────────────────────────
 *
 * Escalation claims the year in the WHERE of its own UPDATE, so a second run
 * today — or a second run in December after one in March — escalates nobody.
 * Reconciliation only ever pushes an amount already agreed locally, and
 * PATCHing a figure PayFast already holds is a no-op.
 *
 * Missing a day is the one thing that does cost something: an account whose
 * anniversary was yesterday is not escalated until next year. Daily, early,
 * from a scheduler that alerts on failure.
 *
 * Example crontab entry:
 *   15 5 * * * curl -fsS -H "Authorization: Bearer $BILLING_CRON_SECRET" \
 *     https://your-host/api/billing/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep that talks to PayFast once per account is not instant. */
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
  const secret = process.env.BILLING_CRON_SECRET
  if (!secret) {
    /* Fails CLOSED. An unconfigured price-raising job that ran for anybody who
       found the URL is a worse outcome than one that does not run at all. */
    return NextResponse.json(
      { error: 'Platform billing is not configured (BILLING_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  /* The app's own date, not the database's. Every other date decision in
     billing is made here — the escalation anniversary has to agree with the
     period ends the customer was shown. */
  const today = new Date().toISOString().slice(0, 10)

  try {
    const escalation = await runEscalation(today)
    const reconciliation = await runReconciliation()

    if (escalation.escalated > 0 || reconciliation.pushed > 0) {
      console.info('[payfast-sub] billing tick', { today, escalation, reconciliation })
    }

    return NextResponse.json({ ok: true, today, escalation, reconciliation })
  } catch (error) {
    console.error('[payfast-sub] billing tick failed', error)
    return NextResponse.json({ error: 'The billing tick failed. See the server log.' }, { status: 500 })
  }
}

/**
 * The secret, compared without leaking how much of it matched.
 *
 * Accepts either an Authorization bearer or an x-cron-secret header, because
 * scheduler products differ on which they can send.
 */
function authorised(request: NextRequest, secret: string): boolean {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const header = request.headers.get('x-cron-secret')
  const provided = bearer || header || ''
  return constantTimeEqual(provided, secret)
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — so the lengths are compared first and the result folded in.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
