import { NextResponse, type NextRequest } from 'next/server'
import { requireModuleCapability } from '@/lib/auth'
import { isCalendarProvider } from '@/lib/calendarModel'
import { createLinkState, calendarRedirectUri } from '@/lib/calendarLinkState'
import { providerFor, providerConfigured } from '@/lib/site/calendarProviders'

/**
 * Step one of linking a calendar: send the person to Google or Microsoft.
 *
 * ── WHY THIS IS SESSION-GATED, UNLIKE THE OTHER JOB api/ ROUTES ─────────────
 *
 * The tick routes carry a shared secret because nobody is logged in at 05:20.
 * Here somebody IS logged in — they just clicked "Link my calendar" — and the
 * whole operation concerns their own account, so the session is exactly the
 * right credential and PUBLIC_EXACT must NOT list this path.
 *
 * The callback is session-gated for the same reason, which works because the
 * provider redirects the person's own browser back and the cookie rides along.
 */
export async function GET(request: NextRequest) {
  /*
   * jobs.setup, not a self-service capability.
   *
   * Linking starts pushing customer names and addresses to a third party. That
   * is a decision about how the business runs its work, which is what
   * jobs.setup gates everywhere else in this module.
   */
  const { siteId, actor } = await requireModuleCapability('job_cards', 'jobs.setup')

  const raw = request.nextUrl.searchParams.get('provider') ?? ''
  if (!isCalendarProvider(raw)) {
    return NextResponse.json({ error: 'Unknown calendar provider.' }, { status: 400 })
  }
  if (!providerConfigured(raw)) {
    return NextResponse.json(
      { error: 'That calendar is not configured on this server.' },
      { status: 503 },
    )
  }

  /*
   * WHOSE calendar. Always the person clicking.
   *
   * An explicit userId is refused rather than checked: linking on somebody
   * else's behalf cannot work anyway, because only they can sign in at the
   * consent screen. A parameter that cannot work should not look as though it
   * might.
   */
  if (request.nextUrl.searchParams.has('userId')) {
    return NextResponse.json(
      { error: 'A calendar can only be linked by the person it belongs to.' },
      { status: 400 },
    )
  }

  const state = await createLinkState(siteId, actor.userId, raw)
  const url = providerFor(raw).authUrl(calendarRedirectUri(request.nextUrl.origin), state)
  return NextResponse.redirect(url)
}
