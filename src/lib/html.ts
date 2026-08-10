/**
 * Allowlist sanitiser for the rich-text "extra description".
 *
 * That field is HTML typed by a user and later rendered back into a page, which
 * makes it a stored-XSS vector if trusted. Everything not explicitly permitted
 * here is stripped. An allowlist rather than a blocklist: blocklists lose to
 * encodings and tags nobody thought of.
 *
 * Runs on the SERVER, at save time. Client-side cleaning is cosmetic — anyone
 * can post whatever they like straight to the action.
 */
import { ALLOWED_TAGS as ALLOWED_TAG_NAMES } from './htmlTags'

// From the shared list rather than a second copy: the editor's HTML view warns
// against the same set, and two hand-maintained lists would drift the moment
// one of them gained a tag.
const ALLOWED_TAGS = new Set<string>(ALLOWED_TAG_NAMES)

// Only href, and only on <a>. No style/class/id — style would let a link be
// drawn over the rest of the page, and event handlers must never survive.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
}

/** javascript:, data:, vbscript: — anything that executes when clicked. */
function safeHref(value: string): string | null {
  const trimmed = value.trim()
  // Strip characters a browser ignores inside a scheme but a naive check does
  // not, so "java\nscript:" or "java\tscript:" cannot slip through. Written as
  // escapes rather than literals so the intent stays readable.
  const collapsed = trimmed
    .replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff\u00ad]/g, '')
    .toLowerCase()
  if (/^(javascript|data|vbscript|file):/.test(collapsed)) return null
  if (/^[a-z][a-z0-9+.-]*:/.test(collapsed)) {
    // An absolute URL with some other scheme — permit only http and https.
    if (!/^https?:/.test(collapsed)) return null
  }
  return trimmed
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/**
 * Returns HTML containing only allowed tags and attributes.
 *
 * Parsing is deliberately simple — a tokeniser over `<...>` — because the input
 * is a small fragment from our own editor. Anything it cannot classify is
 * dropped rather than passed through.
 */
export function sanitiseHtml(input: string | null | undefined): string {
  if (!input) return ''

  // Remove whole elements whose *content* is dangerous, not just their tags.
  let html = input
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const out: string[] = []
  const openTags: string[] = []
  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g

  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(html)) !== null) {
    const [full, rawName, rawAttrs, text] = match

    if (text !== undefined) {
      out.push(escapeText(text))
      continue
    }

    const name = rawName.toLowerCase()
    const isClosing = full.startsWith('</')
    const isSelfClosing = /\/>$/.test(full) || name === 'br'

    if (!ALLOWED_TAGS.has(name)) continue

    if (isClosing) {
      // Only close a tag we actually opened, so stray closers cannot break out.
      const idx = openTags.lastIndexOf(name)
      if (idx === -1) continue
      openTags.splice(idx, 1)
      out.push(`</${name}>`)
      continue
    }

    const attrs: string[] = []
    const permitted = ALLOWED_ATTRS[name]
    if (permitted && rawAttrs) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
      let a: RegExpExecArray | null
      while ((a = attrRe.exec(rawAttrs)) !== null) {
        const attrName = a[1].toLowerCase()
        if (!permitted.has(attrName)) continue
        const value = a[2] ?? a[3] ?? a[4] ?? ''
        if (attrName === 'href') {
          const href = safeHref(value)
          if (!href) continue
          attrs.push(`href="${escapeAttr(href)}"`)
        } else {
          attrs.push(`${attrName}="${escapeAttr(value)}"`)
        }
      }
    }

    // Links always open in a new tab without handing the opener over.
    if (name === 'a' && attrs.some((x) => x.startsWith('href='))) {
      attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
    }

    const attrText = attrs.length ? ' ' + attrs.join(' ') : ''
    if (isSelfClosing) {
      out.push(`<${name}${attrText}>`)
    } else {
      openTags.push(name)
      out.push(`<${name}${attrText}>`)
    }
  }

  // Close anything left open, innermost first, so the fragment is well formed.
  while (openTags.length) out.push(`</${openTags.pop()}>`)

  return out.join('').trim()
}

/** Plain text from sanitised HTML — for list previews and search. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-4]|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
