/**
 * Carrying a list screen's state through an edit and back.
 *
 * A filtered list is a WORKLIST: someone narrows the catalogue to ten products
 * and then edits them one after another. Every trip out to a product and back
 * used to land on the bare `/products`, so the filter had to be re-applied ten
 * times — the list was destroyed by the first save.
 *
 * The fix is to carry the list's own URL along as `from`, and to send the user
 * back to THAT rather than to the path with its query string thrown away.
 *
 * ── WHY THIS IS VALIDATED ──────────────────────────────────────────────────
 *
 * `from` arrives in a URL and is handed to `redirect()`, which will happily
 * send someone to another origin. That is an open redirect: a link to our own
 * domain that bounces to somebody else's login page. So a return target is
 * only ever accepted when it is a plain in-app path — one leading slash, no
 * scheme, no host — and anything else falls back to the caller's default.
 *
 * Deliberately not 'use client': server components build these hrefs and the
 * server actions consume them.
 */

/**
 * A safe in-app return path, or null.
 *
 * Rejects anything that could leave the app:
 *   - a scheme or a protocol-relative `//host`, which are other origins
 *   - a backslash, which some browsers normalise to a forward slash
 *   - anything not starting with a single `/`
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path.startsWith('/')) return null
  // `//host` and `/\host` are both ways of writing another origin.
  if (path.startsWith('//') || path.startsWith('/\\')) return null
  if (path.includes('\\')) return null
  // A scheme cannot appear in a path that already starts with '/', but a
  // control character can smuggle one past a naive check.
  if (/[\x00-\x1f\x7f]/.test(path)) return null
  return path
}

/**
 * Where to go back to: the carried list URL, or the screen's own default.
 *
 * The default is what every detail screen used to hard-code, so passing it
 * keeps the behaviour identical for anyone arriving without a `from`.
 */
export function returnToOr(value: unknown, fallback: string): string {
  return safeReturnTo(value) ?? fallback
}
