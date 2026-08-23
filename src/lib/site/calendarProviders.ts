import 'server-only'
import type {
  BusyBlock,
  CalendarProvider,
  CalendarProviderName,
  OutboundEvent,
} from '../calendarModel'

/**
 * Google and Microsoft, behind one interface (§46.13).
 *
 * Everything provider-specific in the whole feature is in this file: two sets of
 * URLs, two scope strings, two JSON shapes. Everything above it — jobCalendar.ts,
 * the setup screen, the conflict check — is written once.
 *
 * ── WHY fetch() AND NOT THE OFFICIAL SDKs ───────────────────────────────────
 *
 * googleapis is around 50MB installed and generates clients for two hundred
 * services this app will never call; @microsoft/microsoft-graph-client brings
 * its own auth abstraction that would have to be bridged to the token handling
 * here anyway. What is actually needed is five HTTP calls each, and they are
 * below. The trade is that a breaking API change has to be noticed by us rather
 * than absorbed by a dependency — acceptable for endpoints Google and Microsoft
 * have both kept stable for a decade, and both version in the URL.
 *
 * ── EVERY CALL CAN FAIL, AND SAYS SO IN WORDS ───────────────────────────────
 *
 * A network call to somebody else's service fails routinely: the token was
 * revoked, the quota is spent, the service is down. Each throws with a message
 * meant for last_error on the account row, which a person reads on the setup
 * screen. "Request failed" would be worthless there, so the provider's own error
 * text is included where it gives one.
 */

/** The app's own credentials, from the environment. Never per site. */
function credentials(provider: CalendarProviderName): { id: string; secret: string } {
  const id =
    provider === 'google'
      ? process.env.GOOGLE_CALENDAR_CLIENT_ID
      : process.env.MICROSOFT_CALENDAR_CLIENT_ID
  const secret =
    provider === 'google'
      ? process.env.GOOGLE_CALENDAR_CLIENT_SECRET
      : process.env.MICROSOFT_CALENDAR_CLIENT_SECRET

  if (!id || !secret) {
    throw new Error(
      `${provider === 'google' ? 'Google' : 'Microsoft'} calendar sync is not configured on this ` +
        `server — the client id and secret are missing from the environment.`,
    )
  }
  return { id, secret }
}

/** True when a provider can be offered at all. For the setup screen to check. */
export function providerConfigured(provider: CalendarProviderName): boolean {
  try {
    credentials(provider)
    return true
  } catch {
    return false
  }
}

/** A failed response, as a sentence somebody can act on. */
async function fail(what: string, res: Response): Promise<never> {
  let detail = ''
  try {
    const body = await res.text()
    // Both providers return JSON with the useful sentence nested differently, so
    // the raw text is trimmed rather than parsed — it is for a human to read.
    detail = body.slice(0, 300)
  } catch {
    /* A body that cannot be read is not a reason to lose the status code. */
  }
  throw new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`)
}

/* ── Google ─────────────────────────────────────────────────────────────── */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3'

const google: CalendarProvider = {
  name: 'google',

  authUrl(redirectUri, state) {
    const { id } = credentials('google')
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: 'code',
      /*
       * calendar.events, not calendar.
       *
       * The narrower scope cannot read or change a person's calendar SETTINGS,
       * cannot create or delete calendars, and cannot touch sharing. It is
       * everything this feature needs and nothing else, and it is what the
       * consent screen shows the technician — who is being asked to hand over
       * their personal calendar and is entitled to see a modest request.
       */
      scope: 'https://www.googleapis.com/auth/calendar.events email',
      /*
       * offline + consent together, and both are required.
       *
       * offline asks for a refresh token. consent forces the prompt even when
       * the user has approved before — without it Google returns NO refresh
       * token on a re-link, the row saves with a null token, and the sync fails
       * at the next tick with an error about a token that was never issued.
       */
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
    return `${GOOGLE_AUTH}?${params.toString()}`
  },

  async exchangeCode(code, redirectUri) {
    const { id, secret } = credentials('google')
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) await fail('Linking the Google account', res)
    const json = (await res.json()) as { refresh_token?: string; id_token?: string }
    if (!json.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. That happens when access was granted before — ' +
          'remove this app from your Google account permissions and link again.',
      )
    }
    return { refreshToken: json.refresh_token, email: emailFromIdToken(json.id_token) }
  },

  async accessToken(refreshToken) {
    const { id, secret } = credentials('google')
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: id,
        client_secret: secret,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) await fail('Refreshing the Google token', res)
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('Google returned no access token.')
    return json.access_token
  },

  async writeEvent(accessToken, calendarId, externalId, event) {
    const body = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.startsAt.toISOString() },
      end: { dateTime: event.endsAt.toISOString() },
      status: event.cancelled ? 'cancelled' : 'confirmed',
    }
    const base = `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events`
    const res = await fetch(
      externalId ? `${base}/${encodeURIComponent(externalId)}` : base,
      {
        method: externalId ? 'PATCH' : 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) await fail('Writing the Google event', res)
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new Error('Google returned an event with no id.')
    return json.id
  },

  async removeEvent(accessToken, calendarId, externalId) {
    const res = await fetch(
      `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } },
    )
    /*
     * 404 and 410 are SUCCESS here.
     *
     * They mean the event is already gone — somebody deleted it by hand, or a
     * previous run got further than its bookkeeping did. The goal is that the
     * event does not exist, and it does not. Treating this as a failure would
     * leave a link row that retries forever against an event nobody can delete
     * because it is not there.
     */
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await fail('Deleting the Google event', res)
    }
  },

  async busy(accessToken, calendarId, from, to) {
    const res = await fetch(`${GOOGLE_API}/freeBusy`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      }),
    })
    if (!res.ok) await fail('Reading Google busy time', res)
    const json = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>
    }
    /*
     * freeBusy returns ONLY times, never ids — which is exactly the opaque shape
     * 226 wants, and means Google's busy blocks cannot be matched to our own
     * pushed events by id. See markOurOwn in jobCalendar.ts for how that is
     * handled instead.
     */
    const blocks = json.calendars?.[calendarId]?.busy ?? []
    return blocks.map((b) => ({
      startsAt: new Date(b.start),
      endsAt: new Date(b.end),
      externalId: null,
    }))
  },
}

/* ── Microsoft ──────────────────────────────────────────────────────────── */

const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MS_API = 'https://graph.microsoft.com/v1.0/me'

const microsoft: CalendarProvider = {
  name: 'microsoft',

  authUrl(redirectUri, state) {
    const { id } = credentials('microsoft')
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: 'code',
      /*
       * offline_access is what yields a refresh token on this provider — the
       * equivalent of Google's access_type=offline, and just as easy to leave
       * out and just as silent when missing.
       */
      scope: 'offline_access Calendars.ReadWrite User.Read',
      state,
    })
    return `${MS_AUTH}?${params.toString()}`
  },

  async exchangeCode(code, redirectUri) {
    const { id, secret } = credentials('microsoft')
    const res = await fetch(MS_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) await fail('Linking the Outlook account', res)
    const json = (await res.json()) as { refresh_token?: string; access_token?: string }
    if (!json.refresh_token) throw new Error('Outlook did not return a refresh token.')

    // The identity, from Graph rather than from the token: Microsoft puts the
    // address in different claims depending on the account type, and asking is
    // one call that always answers the same way.
    let email = ''
    if (json.access_token) {
      try {
        const who = await fetch(MS_API, {
          headers: { authorization: `Bearer ${json.access_token}` },
        })
        if (who.ok) {
          const me = (await who.json()) as { mail?: string; userPrincipalName?: string }
          email = me.mail ?? me.userPrincipalName ?? ''
        }
      } catch {
        // A missing address is cosmetic — it only labels the setup screen.
      }
    }
    return { refreshToken: json.refresh_token, email }
  },

  async accessToken(refreshToken) {
    const { id, secret } = credentials('microsoft')
    const res = await fetch(MS_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: id,
        client_secret: secret,
        grant_type: 'refresh_token',
        scope: 'offline_access Calendars.ReadWrite User.Read',
      }),
    })
    if (!res.ok) await fail('Refreshing the Outlook token', res)
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('Outlook returned no access token.')
    return json.access_token
  },

  async writeEvent(accessToken, calendarId, externalId, event) {
    /*
     * Graph has no "cancelled" event status the way Google does, so a called-off
     * visit is deleted instead. The visible difference to the technician is a
     * hole in the day rather than a struck-through entry — worse, and not worth
     * a second mechanism to paper over.
     */
    if (event.cancelled) {
      if (externalId) await microsoft.removeEvent(accessToken, calendarId, externalId)
      return externalId ?? ''
    }

    const body = {
      subject: event.summary,
      body: { contentType: 'text', content: event.description },
      location: { displayName: event.location },
      // UTC explicitly, matching how everything else in this app stores time.
      start: { dateTime: event.startsAt.toISOString(), timeZone: 'UTC' },
      end: { dateTime: event.endsAt.toISOString(), timeZone: 'UTC' },
    }
    const base =
      calendarId && calendarId !== 'primary'
        ? `${MS_API}/calendars/${encodeURIComponent(calendarId)}/events`
        : `${MS_API}/events`
    const res = await fetch(
      externalId ? `${MS_API}/events/${encodeURIComponent(externalId)}` : base,
      {
        method: externalId ? 'PATCH' : 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) await fail('Writing the Outlook event', res)
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new Error('Outlook returned an event with no id.')
    return json.id
  },

  async removeEvent(accessToken, _calendarId, externalId) {
    const res = await fetch(`${MS_API}/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    // Already gone is success. Same reasoning as Google's.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await fail('Deleting the Outlook event', res)
    }
  },

  async busy(accessToken, calendarId, from, to) {
    /*
     * calendarView rather than getSchedule.
     *
     * getSchedule is the closer analogue of Google's freeBusy, but it answers
     * about a MAILBOX rather than a calendar and returns no event ids at all.
     * calendarView returns ids, which lets our own pushed events be recognised
     * and excluded properly rather than by the time-matching fallback Google
     * forces. The cost is that it returns subjects too — which are dropped here,
     * at the boundary, and never reach the database. See 226's header.
     */
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $select: 'id,start,end,showAs',
      $top: '250',
    })
    const base =
      calendarId && calendarId !== 'primary'
        ? `${MS_API}/calendars/${encodeURIComponent(calendarId)}/calendarView`
        : `${MS_API}/calendarView`
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}`, prefer: 'outlook.timezone="UTC"' },
    })
    if (!res.ok) await fail('Reading Outlook busy time', res)
    const json = (await res.json()) as {
      value?: { id?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; showAs?: string }[]
    }
    return (json.value ?? [])
      /*
       * 'free' and 'workingElsewhere' are not busy.
       *
       * Outlook lets somebody mark an event as not blocking their time, and a
       * great many calendar entries are exactly that: a reminder, a shared
       * all-day marker, a "focus time" block. Treating those as busy would have
       * the scheduler refuse to book anybody who keeps a tidy calendar.
       */
      .filter((e) => e.showAs !== 'free' && e.showAs !== 'workingElsewhere')
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        // Graph returns UTC without the Z when asked via the prefer header.
        startsAt: new Date(`${e.start!.dateTime!.replace(/Z?$/, '')}Z`),
        endsAt: new Date(`${e.end!.dateTime!.replace(/Z?$/, '')}Z`),
        externalId: e.id ?? null,
      }))
  },
}

/** The address out of a Google id_token, without verifying it. */
function emailFromIdToken(token: string | undefined): string {
  if (!token) return ''
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string
    }
    /*
     * Deliberately NOT verified, and that is safe here for one reason: this
     * value is a LABEL on a setup screen and nothing else. It grants nothing,
     * is never matched against a user, and never gates a permission — the
     * refresh token in the same response is what actually carries the access.
     *
     * If it ever becomes an identity, it must be verified against Google's keys
     * first.
     */
    return json.email ?? ''
  } catch {
    return ''
  }
}

export function providerFor(name: CalendarProviderName): CalendarProvider {
  return name === 'google' ? google : microsoft
}
