import 'server-only'

/**
 * Where this app lives, for links that leave it.
 *
 * ── WHY A HELPER RATHER THAN process.env AT EACH CALL SITE ───────────────
 *
 * A link in an email cannot be relative: the reader is in Gmail, not on the
 * site. Until now nothing in this codebase needed one, so there was no
 * convention — and "read APP_URL and hope" scattered across a few modules is
 * how half of them end up with a trailing slash and the other half without,
 * producing `//store/...` in somebody's inbox.
 *
 * ── IT REFUSES TO GUESS ──────────────────────────────────────────────────
 *
 * With no APP_URL configured this returns null rather than inventing
 * `localhost:4100`. A tracking link pointing at localhost is worse than no
 * link at all: it looks like a real link, it is in a customer's email forever,
 * and it can never work. The caller omits the link instead — the email still
 * says what happened, which was always the important part.
 */
export function appBaseUrl(): string | null {
  const raw = (process.env.APP_URL ?? '').trim()
  if (!raw) return null

  try {
    // Parsed rather than string-trimmed, so a malformed value is caught here
    // instead of producing a link that only fails when someone clicks it.
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // No trailing slash, so every caller can write `${base}/path`.
    return url.origin
  } catch {
    return null
  }
}

/** An absolute URL for a path, or null when the app has no configured home. */
export function absoluteUrl(path: string): string | null {
  const base = appBaseUrl()
  if (!base) return null
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}
