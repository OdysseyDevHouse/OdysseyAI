/**
 * Allowlist sanitiser for a designed stationery template.
 *
 * ── WHY lib/html.ts IS NOT REUSED ─────────────────────────────────────────
 *
 * That sanitiser exists for the rich-text "extra description": prose typed into
 * a product, rendered back into a page. Its allowlist (lib/htmlTags.ts) has no
 * table tags at all and deliberately permits no `style`, `class` or `id` —
 * "style would let a link be drawn over the rest of the page".
 *
 * A stationery template is the opposite shape of problem. It IS a layout: a
 * letterhead, a line table, a totals box, positioned. It needs tables and it
 * needs CSS. Widening the rich-text allowlist to suit would hand every product
 * description the ability to position itself over the page around it, so the
 * two stay separate — a wider allowlist for markup that is only ever rendered
 * ALONE, in the bare (print) group, with no application chrome to cover.
 *
 * ── WHAT THIS STILL REFUSES ───────────────────────────────────────────────
 *
 * Everything that executes, and everything that talks to the network:
 *
 *   scripts        <script>, <iframe>, <object>, <embed>, on* attributes,
 *                  javascript: URLs — the ordinary XSS set.
 *   the network    <link>, and any url() / @import / src pointing off-site.
 *                  A document must not phone home when it is printed. A
 *                  template fetching a "font" is a template that tells someone
 *                  else every time this shop invoices a customer, and paper
 *                  that renders differently depending on whether the counter
 *                  has internet is worse than paper that renders plainly.
 *   forms          <form>, <input>, <button> — a printed document has no
 *                  actions, and a form inside the app's own origin is a
 *                  credential-phishing surface for anyone who can save one.
 *
 * ── SERVER-SIDE, AT SAVE ──────────────────────────────────────────────────
 *
 * Enforced in the save action. Client-side cleaning would be theatre: anyone
 * can post straight to the action. The designer runs `unsupportedIn()` from
 * this same module to WARN before saving, so the two cannot drift, but this
 * function is the only thing that decides.
 */

/**
 * Tags a template may keep.
 *
 * Structure, tables and inline emphasis. No `<style>` in this list — it is
 * handled separately below, because its CONTENT is CSS rather than markup and
 * needs its own pass.
 */
export const ALLOWED_TAGS = [
  'div', 'p', 'span', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'header', 'footer', 'section', 'article', 'aside', 'main', 'nav',
  'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code',
] as const

const TAG_SET = new Set<string>(ALLOWED_TAGS)

/** The same list as a sentence, for a hint under the editor. */
export const ALLOWED_TAG_LIST = ALLOWED_TAGS.join(', ')

/**
 * Elements removed WITH their content, not just unwrapped.
 *
 * Dropping only the tags of a <script> would leave its body as text — which
 * reads as gibberish on the page at best, and is re-parsed as code by anything
 * that later re-serialises the fragment.
 */
const VOID_WHOLE = /<(script|iframe|object|embed|noscript|template|form|svg|math)\b[\s\S]*?<\/\1\s*>/gi

/** Self-closing forms of the same, plus tags that only ever load something. */
const VOID_SELF = /<(script|iframe|object|embed|link|base|meta|input|button|textarea|select|form|svg)\b[^>]*\/?>/gi

/**
 * Attributes any element may carry.
 *
 * `style` is the point of this sanitiser existing. `class` is permitted because
 * a template that repeats a look on twenty rows should say it once; the classes
 * mean nothing outside the document, which renders alone.
 */
const GLOBAL_ATTRS = new Set(['style', 'class', 'id', 'title', 'dir', 'lang'])

/** Attributes only meaningful on particular elements. */
const TAG_ATTRS: Record<string, Set<string>> = {
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align', 'valign']),
  th: new Set(['colspan', 'rowspan', 'align', 'valign', 'scope']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span']),
  table: new Set(['cellpadding', 'cellspacing', 'border', 'width']),
  ol: new Set(['start', 'type']),
}

/**
 * Where an <img> may point.
 *
 * Only this site's own uploads, and only by the relative path the uploads
 * helper hands out. A data: URI is refused too: it is the standard way to smuggle
 * an SVG, and an SVG is a script container.
 */
function safeImageSrc(value: string): string | null {
  const trimmed = value.trim()
  // Same defanging as lib/html.ts: characters a browser ignores inside a
  // scheme but a naive check does not.
  // Written as escapes rather than literals so the intent stays readable.
  const collapsed = trimmed
    .replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff\u00ad]/g, '')
    .toLowerCase()
  if (collapsed === '') return null
  // Anything with a scheme, and anything protocol-relative, is off-site.
  if (/^[a-z][a-z0-9+.-]*:/.test(collapsed)) return null
  if (collapsed.startsWith('//')) return null
  // A site-owned upload path, and nothing else. No traversal.
  if (trimmed.includes('..')) return null
  if (!/^\/(uploads|api\/(product-images|store-images|storefront-images))\//.test(trimmed)) {
    return null
  }
  return trimmed
}

/**
 * CSS with every way out of the document removed.
 *
 * Applied to both a `style` attribute and the body of a `<style>` block, since
 * `url()` and `expression()` are equally dangerous in each.
 */
export function sanitiseCss(css: string): string {
  return (
    css
      // Anything that fetches: url(...), @import, and the old IE expression().
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\s*\([^)]*\)/gi, '')
      .replace(/expression\s*\([^)]*\)/gi, '')
      // -moz-binding loaded XBL; behavior loaded an HTC. Both are code.
      .replace(/(-moz-binding|behavior)\s*:[^;]*;?/gi, '')
      // A scheme inside CSS can only be an attempt to reach something.
      .replace(/javascript\s*:/gi, '')
      // Comments can hide the above from a reader while a parser still sees it.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
  )
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/**
 * Returns template markup containing only allowed tags and attributes.
 *
 * The `{token}` and `{#each}` holes are left completely alone — they are not
 * markup, they are text, and the renderer resolves them AFTER this has run. So
 * a token can never introduce a tag this pass would have removed.
 */
export function sanitiseTemplate(input: string | null | undefined): string {
  if (!input) return ''

  let html = input.replace(VOID_WHOLE, '').replace(VOID_SELF, '').replace(/<!--[\s\S]*?-->/g, '')

  // <style> blocks survive, but only their cleaned CSS does. Hoisted out before
  // the tag walk so the CSS is never treated as text and escaped.
  const styles: string[] = []
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, body: string) => {
    const css = sanitiseCss(body)
    if (css) styles.push(css)
    return ''
  })

  const out: string[] = []
  const openTags: string[] = []
  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g

  const SELF_CLOSING = new Set(['br', 'hr', 'img', 'col'])

  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(html)) !== null) {
    const [full, rawName, rawAttrs, text] = match

    if (text !== undefined) {
      out.push(escapeText(text))
      continue
    }

    const name = rawName.toLowerCase()
    const isClosing = full.startsWith('</')

    if (!TAG_SET.has(name)) continue

    if (isClosing) {
      // Only close a tag we actually opened, so stray closers cannot break out.
      const idx = openTags.lastIndexOf(name)
      if (idx === -1) continue
      openTags.splice(idx, 1)
      out.push(`</${name}>`)
      continue
    }

    const attrs: string[] = []
    const permitted = TAG_ATTRS[name]
    if (rawAttrs) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
      let a: RegExpExecArray | null
      while ((a = attrRe.exec(rawAttrs)) !== null) {
        const attrName = a[1].toLowerCase()
        const value = a[2] ?? a[3] ?? a[4] ?? ''

        // Every event handler, in one rule rather than a list that ages.
        if (attrName.startsWith('on')) continue

        const allowed = GLOBAL_ATTRS.has(attrName) || permitted?.has(attrName)
        if (!allowed) continue

        if (attrName === 'style') {
          const css = sanitiseCss(value)
          if (!css) continue
          attrs.push(`style="${escapeAttr(css)}"`)
          continue
        }
        if (attrName === 'src') {
          const src = safeImageSrc(value)
          if (!src) continue
          attrs.push(`src="${escapeAttr(src)}"`)
          continue
        }
        attrs.push(`${attrName}="${escapeAttr(value)}"`)
      }
    }

    const attrText = attrs.length ? ' ' + attrs.join(' ') : ''
    if (SELF_CLOSING.has(name)) {
      out.push(`<${name}${attrText}>`)
    } else {
      openTags.push(name)
      out.push(`<${name}${attrText}>`)
    }
  }

  // Close anything left open, innermost first, so the fragment is well formed.
  while (openTags.length) out.push(`</${openTags.pop()}>`)

  const body = out.join('').trim()
  return styles.length ? `<style>${styles.join('\n')}</style>${body}` : body
}

/**
 * The tags in this markup the server will drop, in the order first seen.
 *
 * Advisory only — it reports rather than rewrites, so the designer can say what
 * will be lost BEFORE someone saves and finds half their layout gone. A
 * client-side check is never a security control.
 */
export function unsupportedIn(html: string): string[] {
  const seen = new Set<string>()
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const name = m[1].toLowerCase()
    if (name === 'style') continue // kept, with its CSS cleaned
    if (!TAG_SET.has(name)) seen.add(name)
  }
  return [...seen]
}
