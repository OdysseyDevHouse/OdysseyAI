import { getDocType, findToken, getSection, type DocTypeDef, type SectionKey } from './catalog'

/**
 * Whether a designed template is fit to print, and what is wrong when it is not.
 *
 * Two very different jobs, deliberately in one pass:
 *
 *   STRUCTURE — the template parses. Unclosed `{#each}`, an unknown token, a
 *   line token written outside the loop that gives it meaning. These are
 *   mistakes; the message should say which and where.
 *
 *   LEGALITY — the document still carries what the law requires it to carry.
 *   This is not a style rule and it is not advisory: an invoice missing its
 *   supplier VAT number is a document a customer cannot claim input VAT on, and
 *   it will come back. See the header of lib/invoices/pdf.ts for the statute.
 *
 * ── RUN AT SAVE *AND* AT RENDER ───────────────────────────────────────────
 *
 * At save, so nobody ships a broken document. At render as well, because the
 * REQUIRED set can grow after a template was saved — a later change to the law,
 * or a field we should have demanded from the start. A template that no longer
 * passes falls back to the shipped default rather than printing something
 * unlawful, and says so on the setup screen.
 *
 * Same shape as reportBuilder/spec.ts validateSpec: client-safe, pure, and run
 * by the editor so the warning a designer sees is the decision the server makes.
 */

export type ValidationError = {
  /** Machine-readable, so the editor can highlight rather than only tell. */
  kind: 'unknown-token' | 'misplaced-token' | 'unclosed-section' | 'unknown-section' | 'missing-required'
  message: string
  /** The token or section at fault, where there is one. */
  token?: string
}

export type ValidationResult = {
  ok: boolean
  errors: ValidationError[]
}

/**
 * What each document must carry, whatever else a designer does to it.
 *
 * `tokens` — must appear somewhere in the template.
 * `literals` — words that must appear as text. A tax invoice has to SAY
 *   "tax invoice"; no token supplies those words, so they are checked directly.
 *
 * Purchase order: an order a supplier cannot identify is an order that gets
 * filled twice or not at all, so the number and the parties are required. This
 * is a commercial minimum rather than a statutory one — the statute bites on
 * invoices, which arrive with the invoice doc type.
 */
const REQUIRED: Record<string, { tokens: string[]; literals: string[] }> = {
  purchase_order: {
    tokens: ['doc.number', 'site.name', 'supplier.name'],
    literals: [],
  },
  /*
   * VAT Act s20(4), and this one is a statute rather than good sense.
   *
   * A tax invoice must carry the words "tax invoice", both parties' names, the
   * supplier's VAT number, a serial number, the date, and the VAT shown
   * separately or stated as included. A customer cannot claim input VAT on a
   * document missing any of them, so an invoice designed without one does not
   * merely look wrong — it comes back, and the shop finds out weeks later.
   *
   * `doc.heading` covers the words: it prints TAX INVOICE for a vendor and
   * INVOICE for a non-vendor, decided in the adapter from whether the business
   * has a VAT number. Requiring the literal string instead would force a
   * non-vendor to print a claim about itself that is not true.
   *
   * `totals.vatSummary` rather than `totals.vat`: the analysis by rate is what
   * the section asks for, and a document with two rates on it cannot satisfy
   * that with a single summed figure.
   */
  invoice: {
    tokens: [
      'doc.heading',
      'doc.number',
      'doc.date',
      'site.name',
      'site.vatLine',
      'customer.name',
      'totals.vatSummary',
      'totals.totalIncl',
    ],
    literals: [],
  },
  /*
   * A delivery note answers to no statute — it is a receipt for goods, not for
   * money — so what it must carry is what makes it USABLE by the person
   * signing it.
   *
   * Who sent the goods, who they are for, where they went, and what is in the
   * boxes. A delivery note without the delivery address is a piece of paper the
   * driver cannot act on; one without the customer's name cannot be filed by
   * whoever receives it.
   *
   * There is no required TOTAL, because there is no total: a delivery note
   * carries quantities and no prices at all. See the catalog for why that is a
   * boundary rather than a default.
   */
  delivery_note: {
    tokens: ['doc.heading', 'doc.date', 'site.name', 'customer.name', 'deliverTo'],
    literals: [],
  },
  /*
   * A statement answers to no statute either, so what it must carry is what
   * makes it actionable: who is asking, whose account it is, over what period,
   * and the figure to act on. Without the period it is a list of movements
   * nobody can reconcile; without the figure it is not a statement at all.
   */
  statement: {
    tokens: ['doc.heading', 'site.name', 'account.name', 'doc.period', 'totals.dueNow'],
    literals: [],
  },
}

/** Every `{token}` in the template, with where it sits. */
type FoundToken = { key: string; inSection: SectionKey | null }

/**
 * "an invoice", "a quote" — the document's name with the right article.
 *
 * Every message below names the document type, and the four that did it by hand
 * all read "a invoice", because `invoice` is the one common doc type starting
 * with a vowel. Small, but these sentences are what a shop reads when its own
 * stationery is refused, and a typo there costs the warning its authority.
 */
function aDoc(label: string): string {
  const lower = label.toLowerCase()
  return `${/^[aeiou]/.test(lower) ? 'an' : 'a'} ${lower}`
}

/** "an invoice" → "An invoice", for a sentence that starts with it. */
function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Walk the template once, tracking which `{#each}` we are inside.
 *
 * A hand-written scan rather than a parser: the grammar is two productions
 * (a token, a section) and nothing nests, so a parser would be a larger thing
 * to maintain than the language it reads.
 */
function scan(body: string): { tokens: FoundToken[]; errors: ValidationError[] } {
  const tokens: FoundToken[] = []
  const errors: ValidationError[] = []

  let section: SectionKey | null = null
  /*
   * ── THE DOUBLED BRACES ARE NOT TOKENS ───────────────────────────────────
   *
   * `{{tax}}`, `{{barcode:…}}` and `{{qr:…}}` are COMPILER markers, resolved by
   * render.ts long after this runs — `{{tax}}` becomes the shop's word for VAT,
   * which is why it cannot be baked in at design time (see render.ts).
   *
   * Without the guards below the scanner matched the INNER `{tax}` of `{{tax}}`
   * and reported it as a token no invoice can print. That marker is in the
   * SHIPPED default invoice, so every shop saving the standard layout was told
   * its own stationery was broken — twice, once per marker — and the warning
   * named a token they had never typed.
   *
   * `(?<!\{)` and `(?!\})` say: a token is a single brace on each side.
   */
  const re =
    /\{#each\s+([a-zA-Z]+)\s*\}|\{\/each\}|(?<!\{)\{([a-zA-Z][a-zA-Z0-9.]*)\}(?!\})/g

  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const [full, openKey, tokenKey] = m

    if (openKey !== undefined) {
      if (section) {
        errors.push({
          kind: 'unclosed-section',
          message: `A repeating section for "${section}" was opened and never closed before "${openKey}" started. Sections cannot be nested.`,
          token: openKey,
        })
      }
      section = openKey as SectionKey
      continue
    }

    if (full === '{/each}') {
      if (!section) {
        errors.push({
          kind: 'unclosed-section',
          message: 'A {/each} closes a repeating section that was never opened.',
        })
      }
      section = null
      continue
    }

    if (tokenKey !== undefined) tokens.push({ key: tokenKey, inSection: section })
  }

  if (section) {
    errors.push({
      kind: 'unclosed-section',
      message: `The repeating section "${section}" was never closed. Add {/each} where it should end.`,
      token: section,
    })
  }

  return { tokens, errors }
}

/**
 * Check a template against its document type.
 *
 * Note what is NOT checked: whether the caller may use a token. A template is a
 * property of the SITE, printed by many people with different rights, so a
 * token the author cannot see is still legitimate — it simply prints empty for
 * them. Validating against the author's capabilities would let one person's
 * permissions quietly delete a column from everyone else's paperwork.
 */
export function validateTemplate(docTypeKey: string, body: string): ValidationResult {
  const doc = getDocType(docTypeKey)
  if (!doc) {
    return {
      ok: false,
      errors: [
        {
          kind: 'unknown-section',
          message: 'This template is for a kind of document that no longer exists.',
        },
      ],
    }
  }

  const { tokens, errors } = scan(body)

  for (const found of tokens) {
    const def = findToken(doc, found.key)
    if (!def) {
      errors.push({
        kind: 'unknown-token',
        message: `"{${found.key}}" is not something ${aDoc(doc.label)} can print. It will be left blank.`,
        token: found.key,
      })
      continue
    }

    // A section token outside its section has no row to read from.
    const owner = doc.sections.find((s) => s.tokens.some((t) => t.key === found.key))
    if (owner && found.inSection !== owner.key) {
      errors.push({
        kind: 'misplaced-token',
        message: `"{${found.key}}" only means something inside {#each ${owner.key}} … {/each}.`,
        token: found.key,
      })
    }
    if (!owner && found.inSection) {
      // Document-level tokens inside a loop are fine — the letterhead may
      // legitimately repeat on every row of a table. Nothing to report.
    }
  }

  for (const s of body.matchAll(/\{#each\s+([a-zA-Z]+)\s*\}/g)) {
    if (!getSection(doc, s[1])) {
      errors.push({
        kind: 'unknown-section',
        message: `"${s[1]}" is not a repeating section on ${aDoc(doc.label)}.`,
        token: s[1],
      })
    }
  }

  errors.push(...missingRequired(doc, body, tokens))

  return { ok: errors.length === 0, errors }
}

/** The legal/commercial minimum, as errors that block a save. */
function missingRequired(doc: DocTypeDef, body: string, tokens: FoundToken[]): ValidationError[] {
  const rule = REQUIRED[doc.key]
  if (!rule) return []

  const out: ValidationError[] = []
  const present = new Set(tokens.map((t) => t.key))

  for (const key of rule.tokens) {
    if (!present.has(key)) {
      const def = findToken(doc, key)
      out.push({
        kind: 'missing-required',
        message: `${capitalise(aDoc(doc.label))} must show ${def?.label.toLowerCase() ?? key}. Add {${key}} to the template.`,
        token: key,
      })
    }
  }

  const text = body.toLowerCase()
  for (const literal of rule.literals) {
    if (!text.includes(literal.toLowerCase())) {
      out.push({
        kind: 'missing-required',
        message: `${capitalise(aDoc(doc.label))} must carry the words "${literal}".`,
      })
    }
  }

  return out
}

/** One line for a toast or a log, when the list itself is shown elsewhere. */
export function summarise(result: ValidationResult): string {
  if (result.ok) return ''
  const blocking = result.errors.filter((e) => e.kind === 'missing-required')
  if (blocking.length) return blocking.map((e) => e.message).join(' ')
  return result.errors[0]?.message ?? 'This template cannot be saved.'
}
