import { NextResponse } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { activeTemplateBody } from '@/lib/site/stationeryTemplates'

/**
 * The till's active slip design.
 *
 * ── WHY A ROUTE RATHER THAN A PROP ────────────────────────────────────────
 *
 * The slip is composed on the CLIENT: printing.ts turns a ReceiptData into
 * bytes and hands them to the local bridge, because only the browser at the
 * counter can reach a printer plugged into that machine. So the design has to
 * travel to the client, and it cannot come from the database directly.
 *
 * Fetched here rather than threaded through PosShell as a prop, so the till
 * screen needs no new plumbing for it and a design changed in Setup reaches the
 * next slip without the cashier reloading.
 *
 * ── IT NEVER FAILS THE PRINT ──────────────────────────────────────────────
 *
 * A slip that will not print because a settings lookup hiccupped is a queue at
 * the counter. This returns `null` for every failure — no design, no table yet,
 * a database blip — and the caller falls back to the shipped layout, which is
 * the same slip the till printed before any of this existed.
 *
 * Authenticated but not capability-gated beyond the session: anyone standing at
 * a till may print a slip, and the site comes from the session so the route
 * cannot be pointed at another shop's design.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { site } = await requireSiteUser()
    const body = await activeTemplateBody(site.id, 'slip')
    return NextResponse.json(
      { design: body },
      // Briefly cacheable: a till prints many slips a minute and the design
      // changes about once a year. Private, because it is behind a session.
      { headers: { 'cache-control': 'private, max-age=60' } },
    )
  } catch {
    return NextResponse.json({ design: null })
  }
}
