/**
 * The order-email template language.
 *
 * Pure and free of `server-only`, because the setup screen runs this in the
 * BROWSER to show a preview and the sender runs it on the server to produce
 * the real thing. Two implementations would mean a preview that lies.
 *
 * ── WHY A DENY-LIST SANITISER ────────────────────────────────────────────
 *
 * The author here is the shop's own staff, pasting layout markup from a
 * designer or a previous mail tool. An allow-list would strip the table
 * scaffolding every email in the world is built from, and they would give up.
 * So the rule is: keep the markup, remove the things that execute.
 *
 * That is a weaker guarantee than an allow-list and it is chosen knowingly.
 * The threat here is not a stranger — it is a colleague with a back-office
 * login pasting something they do not understand.
 */

export type MergeField = {
  token: string
  label: string
  /** True when the value is markup we build ourselves, not text to escape. */
  html?: boolean
}

/**
 * What a shop may drop into a template.
 *
 * `items` is the ONLY field whose value is inserted as markup. Adding another
 * without matching the renderer is precisely how this becomes an injection
 * hole, so the flag lives on the field rather than in the renderer.
 */
export const MERGE_FIELDS: MergeField[] = [
  { token: 'order_number', label: 'Order number' },
  { token: 'customer_name', label: "Customer's full name" },
  { token: 'first_name', label: "Customer's first name" },
  { token: 'status', label: 'The status it just reached' },
  { token: 'items', label: 'The items, as a table', html: true },
  { token: 'total', label: 'Order total' },
  { token: 'delivery_fee', label: 'Delivery fee' },
  { token: 'fulfilment', label: 'Collection or delivery' },
  { token: 'delivery_address', label: 'Delivery address' },
  { token: 'payment', label: 'How it is being paid' },
  { token: 'customer_note', label: 'Their note to you' },
  { token: 'store_name', label: 'Your shop name' },
  /*
   * The link that lets a shopper follow the order without an account.
   *
   * Plain TEXT, not html — it is inserted as a URL and escaped like any other
   * value. Making it markup would mean building an anchor here, and `items` is
   * deliberately the only field whose value is trusted as markup.
   *
   * Empty when the app has no configured public address, so a template using
   * it degrades to an email with no link rather than one pointing at
   * localhost — see appUrl.ts.
   */
  { token: 'track_link', label: 'Link to follow the order' },
]

const HTML_FIELDS = new Set(MERGE_FIELDS.filter((f) => f.html).map((f) => f.token))

/** Escapes the four characters that can break out of text content or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Fill `{{token}}` placeholders.
 *
 * An UNKNOWN token is left exactly as it was written. A visible `{{totl}}` is
 * a typo the shop can see and fix; blanking it produces an email that reads
 * "Your order total is ." and nobody finds out until a customer says so.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, rawToken: string) => {
    const token = rawToken.toLowerCase()
    if (!(token in values)) return whole
    const value = values[token] ?? ''
    return HTML_FIELDS.has(token) ? value : escapeHtml(value)
  })
}

/** Anything past this is not an email, it is a mistake or an attack. */
const MAX_HTML = 200_000

/**
 * Remove what executes, keep what renders.
 *
 * Runs up to five passes, stopping as soon as a pass changes nothing. One pass
 * is not enough: `<scr<script>ipt>` becomes `<script>` after the inner match is
 * removed, so a single sweep can CREATE the tag it was meant to delete.
 */
export function sanitiseEmailHtml(input: string): string {
  let html = String(input ?? '').slice(0, MAX_HTML)

  for (let pass = 0; pass < 5; pass++) {
    const before = html

    // Whole element and its contents — the content of a <script> is the
    // payload, so removing only the tags would leave the code as text that
    // some clients still run.
    html = html.replace(
      /<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    // The same tags unclosed or self-closing.
    html = html.replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')

    // Every on* handler, in any quoting style including none.
    html = html.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    html = html.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    html = html.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')

    // Navigational URLs: no javascript:, no data:. A data: URL in an href is a
    // page of someone else's choosing wearing this shop's name.
    html = html.replace(
      /\s+(href|xlink:href|action|formaction)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'>\s]*("|')?/gi,
      '',
    )
    // Source URLs: data: is allowed ONLY for images, so a shop can inline its
    // own logo rather than hosting it somewhere the email cannot reach.
    html = html.replace(
      /\s+(src|background|poster)\s*=\s*("|')?\s*(javascript|vbscript):[^"'>\s]*("|')?/gi,
      '',
    )
    html = html.replace(
      /\s+(src|background|poster)\s*=\s*("|')?\s*data:(?!image\/)[^"'>\s]*("|')?/gi,
      '',
    )
    // srcdoc is a whole document inline — every protection above, bypassed.
    html = html.replace(/\s+srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')

    if (html === before) break
  }

  return html
}

/**
 * A plain-text version of the email.
 *
 * Every mail client can show text, and some people prefer it. Derived from the
 * HTML rather than authored separately, so the two cannot say different things.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li|table|thead|tbody)\s*>/gi, '\n')
    .replace(/<\s*\/\s*(td|th)\s*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The email a shop starts from when it first chooses "send my own".
 *
 * Styled INLINE, because mail clients drop a <style> block — and the sanitiser
 * removes it anyway, so a template written with one would look right in the
 * editor and arrive unstyled.
 */
export function starterTemplate(statusName: string): { subject: string; html: string } {
  const name = statusName.trim() || 'updated'
  return {
    subject: `Order {{order_number}} — ${name}`,
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#111827">',
      '<p>Hi {{first_name}},</p>',
      `<p>Your order <strong>{{order_number}}</strong> is now <strong>${escapeHtml(name)}</strong>.</p>`,
      '{{items}}',
      '<p><strong>Total: {{total}}</strong></p>',
      '<p>Kind regards,<br>{{store_name}}</p>',
      '</div>',
    ].join('\n'),
  }
}
