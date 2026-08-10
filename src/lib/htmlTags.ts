/**
 * Which HTML the extra description is allowed to keep.
 *
 * No `server-only` marker and no server imports, because the HTML view in the
 * editor needs the same list the sanitiser enforces — so it can tell the user
 * what will be stripped BEFORE they save rather than after. The list belongs to
 * neither half in particular, and duplicating it is how the warning and the
 * sanitiser drift apart.
 *
 * lib/html.ts is still the only thing that ENFORCES this. Everything here is
 * advisory, and a client-side check is never a security control.
 */

/** Tags sanitiseHtml keeps. lib/html.ts imports this, so there is one list. */
export const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4',
  'a', 'span', 'div',
] as const

/** The same list as a sentence, for a hint under the HTML view. */
export const ALLOWED_TAG_LIST = ALLOWED_TAGS.join(', ')

/**
 * The tags in this markup that the server will drop, in the order first seen.
 *
 * Deliberately reports the TAG rather than rewriting the input: the point is to
 * warn, not to silently edit what someone typed.
 */
export function unsupportedTagsIn(html: string): string[] {
  const allowed = new Set<string>(ALLOWED_TAGS)
  const seen = new Set<string>()

  for (const match of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const name = match[1].toLowerCase()
    if (!allowed.has(name)) seen.add(name)
  }

  return [...seen]
}

/**
 * True when the markup carries something whose CONTENT is dropped too.
 *
 * <script> and <style> are removed wholesale by the sanitiser — contents and
 * all — where every other rejected tag only loses its angle brackets. Worth
 * saying, because "style is removed" reads very differently from "your CSS
 * disappears".
 */
export function hasContentDroppingTags(html: string): boolean {
  return /<\s*(script|style)\b/i.test(html)
}
