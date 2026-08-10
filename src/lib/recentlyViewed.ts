/**
 * The last few products this browser looked at.
 *
 * ── IT LIVES IN THE BROWSER, AND THAT IS THE POINT ───────────────────────
 *
 * No table, no row, no id tied to a person. A shopper's browsing history is
 * the kind of thing that becomes a privacy question the moment it is written
 * down server-side — and the feature is worth exactly nothing more when it is.
 * Keeping it in localStorage means there is nothing to disclose, nothing to
 * expire, and nothing that follows somebody to a different device.
 *
 * ── KEYED BY STORE TOKEN ─────────────────────────────────────────────────
 *
 * The same reasoning as the cart and the wishlist: one browser can shop at two
 * stores on this platform, and one shop's history must not leak into the
 * other's page.
 *
 * Not `server-only` and not a client component — it is plain functions the
 * product page and the section both call.
 */

/** How many to remember. */
export const MAX_RECENT = 12

function key(token: string): string {
  return `odyssey.recent.${token}`
}

/** The ids, most recent first. Empty on a browser that has nothing stored. */
export function readRecent(token: string): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key(token))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Coerced, because localStorage is writable by anything running on this
    // origin and by the person sitting at the keyboard. These ids go on to be
    // sent to a server action, where they are checked again — but there is no
    // reason to send junk in the first place.
    return parsed
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((v) => Number.isInteger(v) && v > 0)
      .slice(0, MAX_RECENT)
  } catch {
    // Unparseable, or storage refused — Safari's private mode throws on read
    // as well as write. Empty is the right answer either way; this is a
    // convenience, and it must never be the thing that breaks a shop page.
    return []
  }
}

/**
 * Note that this browser looked at a product.
 *
 * Moves an existing entry to the front rather than adding a second, so the
 * list is "the last twelve DIFFERENT things" and not "the last twelve page
 * loads" — otherwise re-reading one product would push everything else out.
 */
export function noteViewed(token: string, productId: number): void {
  if (typeof window === 'undefined') return
  if (!Number.isInteger(productId) || productId <= 0) return
  try {
    const next = [productId, ...readRecent(token).filter((id) => id !== productId)].slice(
      0,
      MAX_RECENT,
    )
    window.localStorage.setItem(key(token), JSON.stringify(next))
  } catch {
    // Storage full or refused. Silently doing nothing is correct: the shopper
    // came here to buy something, not to maintain a history.
  }
}
