import { NextResponse, type NextRequest } from 'next/server'
import { requireModuleCapability } from '@/lib/auth'
import { readLinkState, calendarRedirectUri } from '@/lib/calendarLinkState'
import { providerFor } from '@/lib/site/calendarProviders'
import { linkCalendarAccount } from '@/lib/site/jobCalendar'

/**
 * Step two: the provider sends the person back with a code.
 *
 * ── EVERY FAILURE LANDS ON A SCREEN, NOT IN JSON ────────────────────────────
 *
 * This is a browser redirect, not an API call — a person is looking at it. So
 * problems come back as a message on the setup screen rather than as a 400 with
 * a JSON body, which in a browser is a white page of machine text that tells
 * somebody nothing about what to do next.
 *
 * ── THE THREE THINGS THAT MUST AGREE ────────────────────────────────────────
 *
 * The session says who is asking. The state token says who ASKED, on which site,
 * for which provider. They must match, or this is a callback replayed into
 * somebody else's session — the attack the signed state exists to stop, and
 * signing alone does not stop it. A valid token from user 4's link attempt is
 * still valid when it arrives in user 9's browser; only the comparison below
 * makes that useless.
 */
export async function GET(request: NextRequest) {
  const { siteId, actor } = await requireModuleCapability('job_cards', 'jobs.setup')

  const back = (message: string) =>
    NextResponse.redirect(
      new URL(`/setup/job-calendar?message=${encodeURIComponent(message)}`, request.nextUrl.origin),
    )

  /*
   * The person said no at the consent screen.
   *
   * Not an error, and not reported as one: declining to hand over a personal
   * calendar is a legitimate answer, and a red failure banner would read as an
   * accusation.
   */
  const denied = request.nextUrl.searchParams.get('error')
  if (denied) return back('No calendar was linked.')

  const code = request.nextUrl.searchParams.get('code')
  const stateRaw = request.nextUrl.searchParams.get('state')
  if (!code || !stateRaw) return back('That link attempt was incomplete. Try again.')

  const state = await readLinkState(stateRaw)
  if (!state) {
    return back('That link attempt has expired. Start again from this screen.')
  }

  if (state.siteId !== siteId || state.userId !== actor.userId) {
    /*
     * Deliberately vague, and deliberately not logged as an attack.
     *
     * The overwhelmingly likely cause is somebody who signed into a different
     * store in another tab while the consent screen was open. Telling them the
     * useful thing — start again — covers both that and the malicious case,
     * and neither needs the detail.
     */
    return back('That link attempt was for a different account. Start again from this screen.')
  }

  try {
    const provider = providerFor(state.provider)
    const { refreshToken, email } = await provider.exchangeCode(
      code,
      calendarRedirectUri(request.nextUrl.origin),
    )
    const saved = await linkCalendarAccount(siteId, actor, {
      userId: actor.userId,
      userName: actor.userName,
      provider: state.provider,
      refreshToken,
      accountEmail: email,
    })
    if (!saved.ok) return back(saved.error)
    return back(email ? `Linked ${email}.` : 'Calendar linked.')
  } catch (err) {
    /*
     * The provider's own words.
     *
     * "Linking failed" would be useless: the real messages here are things a
     * person can act on — a redirect URI that does not match what is
     * registered, a consent that returned no refresh token, a clock skew. The
     * exchange carries no secret in its error text, so it is safe to show.
     */
    return back(err instanceof Error ? err.message : 'The calendar could not be linked.')
  }
}
