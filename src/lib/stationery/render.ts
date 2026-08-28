import { formatMoney, formatQty } from '../decimals'
import { getDocType, getSection, findToken, type TokenFormat } from './catalog'
import { conditionHolds } from './conditions'
import { isQrTarget, resolveQrUrl, type QrContext } from './qrTarget'
import { qrDataUri, barcodeDataUri } from './qr'
import { isBarcodeSource, resolveBarcodeText } from './barcodeSource'

/**
 * Turning a designed template into the HTML that goes on paper.
 *
 * ── THE DATA IS NEVER TRUSTED EITHER ──────────────────────────────────────
 *
 * sanitise.ts guards the TEMPLATE — markup a person wrote. This module guards
 * the VALUES — a supplier name, a product description, a note someone typed
 * into a purchase order weeks ago. Both are needed and neither substitutes for
 * the other: a template can be spotless while a product called
 * `<img onerror=…>` turns the document it lands on into a script.
 *
 * So every value is HTML-escaped on the way in, always, with one deliberate
 * exception — `multiline`, which converts newlines to <br> AFTER escaping, so
 * a typed address still breaks across lines without the text ever being able
 * to introduce a tag.
 *
 * ── VALUES COME FROM A FLAT BAG, NOT THE MODEL ────────────────────────────
 *
 * The caller hands over `Record<string, unknown>` keyed by catalog token, built
 * by a per-document adapter. The renderer therefore cannot reach anything the
 * adapter did not deliberately put there — no walking a `doc.` path into an
 * object that happens to carry a cost field. It is the same reason the report
 * builder makes the catalog own every expression.
 *
 * ── WHY THE TEMPLATE LANGUAGE STOPS HERE ──────────────────────────────────
 *
 * Substitution and one repeat. No conditionals, no expressions, no nesting.
 * `{#if}` is the door to a template language, and a template language is a
 * second product to support — with its own bugs, its own escaping rules and its
 * own way of failing at 5pm on a Friday when an order will not print. Where a
 * document genuinely needs "show this only when set", the value carries it:
 * `doc.statusBanner` prints DRAFT or nothing, decided in TypeScript where it
 * can be tested.
 */

export type TokenValues = Record<string, unknown>

export type RenderInput = {
  /** Document-level values, keyed by catalog token. */
  values: TokenValues
  /** One bag per row, per repeating section. */
  sections: Partial<Record<string, TokenValues[]>>
  /** Decides which permission-gated tokens resolve to a value. */
  capabilities: { isOwner: boolean; granted: ReadonlySet<string> }
  /**
   * The ids of pictures THIS SITE owns.
   *
   * A picture block resolves only to an id in here, so a design cannot name a
   * file belonging to anyone else however it was written. Absent means no
   * pictures resolve, which is the safe direction for a caller that has not
   * been updated to supply them.
   */
  pictures?: ReadonlySet<number>
  /**
   * What a QR block may point at. Absent means no QR renders — the same
   * fail-closed direction `pictures` takes.
   */
  qr?: QrContext
  /**
   * What this business calls its sales tax — VAT, HST, Tax.
   *
   * ── WHY THE LABEL TRAVELS WITH THE VALUES ─────────────────────────────────
   *
   * Two things on a document say the word, and only one of them is a token
   * value. `totals.vat` resolves to a NUMBER, and the word beside it is the
   * catalog's `label` — printed straight onto the page by both renderers (see
   * the `totals` case in pdf.ts). The VAT-summary block's heading is a
   * hardcoded default in the same place.
   *
   * Neither is reachable by changing an adapter, because neither is a value.
   * They are the renderer's own furniture, and this is how the renderer is told
   * what to call it.
   *
   * Absent falls back to 'VAT' at every use, so a caller that has not been
   * taught to pass it prints exactly what it printed before — the same
   * discipline `pictures` and `qr` follow, and the only acceptable failure for
   * something that goes on an invoice.
   */
  taxLabel?: string
}

/** Where a picture block's <img> points. One place, so the route and the tag cannot drift. */
export const PICTURE_URL = '/api/stationery-images'

/**
 * The only markup a `markup` token may emit: a single `<img>` whose `src` is
 * this app's own logo route, plus inline sizing.
 *
 * Written as one narrow shape rather than "no script tags", because an
 * allowlist of the thing we actually produce cannot be widened by an encoding
 * nobody thought of.
 *
 * A picture block does NOT come through here. It is not a token — the compiler
 * emits a marker and this module builds the tag from an id it has checked
 * against the site's own pictures, so there is no user-supplied string to
 * validate. Widening this regex to cover it would have loosened the one rule
 * that keeps the logo path narrow.
 */
const SAFE_MARKUP = /^<img src="\/api\/document-logo\?v=[A-Za-z0-9._%-]+" alt="" style="[a-z0-9:;\-\s]*">$/

/** Undo escapeHtml for a value read back out of an attribute. */
function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * One value as the text that will appear on paper.
 *
 * Formatting is the catalog's decision, not the template's, so a money field
 * cannot print as `1234.5` because someone wrote the token in the wrong place.
 * An absent value is an empty string rather than "null" or "0" — a blank on a
 * document reads as "not applicable", while a zero is a claim about an amount.
 */
export function formatValue(value: unknown, format: TokenFormat): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' && value.trim() === '') return ''

  switch (format) {
    case 'money':
      return escapeHtml(formatMoney(value))
    /*
     * ── `exact` IS THE PRINT RULE, NOT A DEFERRAL ────────────────────────────
     *
     * Paper shows a quantity's decimals when it HAS them and nothing when it
     * does not: 1 prints as "1", 1.5 prints as "1.5". A whole number padded to
     * "1.000" on a slip is noise on the one document a customer reads standing
     * at a counter, and the padding buys nothing there — a column of screen
     * figures lines up because they all pad, and a slip line does not line up
     * with anything.
     *
     * That is exactly what `exact` does at every setting, which is why the
     * whole print path passes it: escpos/slips.ts, slipSpec.ts, slipHtml.ts,
     * stationery/pdf.ts and the two slip components.
     *
     * COSTS never reach paper at all — no print path formats one, because a
     * customer document does not carry what the business paid. So there is no
     * cost-precision decision to make here.
     */
    case 'qty':
      return escapeHtml(formatQty(value, { exact: true }))
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || n === 0) return ''
      return escapeHtml(`${formatQty(n, { exact: true })}%`)
    }
    case 'multiline':
      // Escaped FIRST, then newlines become breaks: the text can never
      // introduce a tag, but a typed address still lays out as written.
      return escapeHtml(String(value)).replace(/\r?\n/g, '<br>')
    case 'markup':
      /*
       * The one unescaped path. See the note on TokenFormat: only a value the
       * SERVER composed may carry this format.
       *
       * Narrowed anyway, to exactly the shape the one such token produces. A
       * future token wrongly marked `markup`, or an adapter bug that let user
       * text reach here, then emits nothing rather than whatever it was handed
       * — the check costs one regex and removes the whole category of mistake
       * this format would otherwise re-open.
       */
      return SAFE_MARKUP.test(String(value)) ? String(value) : ''
    case 'date':
    case 'text':
    default:
      return escapeHtml(String(value))
  }
}

/** Whether this caller may see what a token carries. */
function permitted(
  key: string,
  docKey: string,
  capabilities: RenderInput['capabilities'],
): boolean {
  const doc = getDocType(docKey)
  if (!doc) return false
  const def = findToken(doc, key)
  if (!def) return false
  if (!def.permission) return true
  return capabilities.isOwner || capabilities.granted.has(def.permission)
}

/**
 * Substitute every `{token}` in one fragment.
 *
 * A token that is unknown, or that this caller may not see, resolves to an
 * empty string — never to the literal `{token}`, which would print braces on a
 * document going to a customer, and never to an error. This is the silent
 * degradation the catalog header describes: the junior gets the same purchase
 * order without the cost column, not a failed print.
 */
function substitute(
  fragment: string,
  docKey: string,
  values: TokenValues,
  capabilities: RenderInput['capabilities'],
): string {
  const doc = getDocType(docKey)
  if (!doc) return ''

  return fragment.replace(/\{([a-zA-Z][a-zA-Z0-9.]*)\}/g, (_m, key: string) => {
    const def = findToken(doc, key)
    if (!def) return ''
    if (!permitted(key, docKey, capabilities)) return ''
    return formatValue(values[key], def.format)
  })
}

/**
 * A template plus its data, as printable HTML.
 *
 * Repeating sections are expanded first — an `{#each lines}` block is cut out,
 * rendered once per row with the row's own values merged over the document's,
 * and spliced back — then the whole result is substituted. Doing the rows first
 * means a row can use `{site.name}` without any special case.
 */
export function renderTemplate(body: string, docKey: string, input: RenderInput): string {
  const doc = getDocType(docKey)
  if (!doc) return ''

  /*
   * ── QR CODES ────────────────────────────────────────────────────────────
   *
   * `{{qr:TARGET:SIZE}}` is what the compiler emits, and the address is
   * resolved HERE — the compiler could not know it, because a document's own
   * tracking link does not exist until there is a document.
   *
   * The typed address for a `custom` target rides on the enclosing element as
   * `data-qr-url`, so the one part a shop types never has to survive the
   * marker's own punctuation. It is re-cleaned rather than trusted: it passed
   * cleanCustomUrl when it was saved, but a design can be older than the rules.
   *
   * No address means NO SQUARE — see resolveQrUrl. A code that scans to a dead
   * host is worse than a document that never offered one, and the caption still
   * prints so the layout does not jump.
   */
  /*
   * ── BARCODES ────────────────────────────────────────────────────────────
   *
   * `{{barcode:SOURCE:HEIGHT}}` becomes a picture, from a value read out of
   * THIS document's own token bag — so the number under the bars and the number
   * printed in the corner are the same number by construction.
   *
   * A value CODE128 cannot carry produces nothing rather than a broken symbol.
   * A barcode that scans as the wrong thing is worse than one that is absent:
   * absent is noticed, wrong is acted on.
   */
  /*
   * ── THE TAX LABEL ───────────────────────────────────────────────────────
   *
   * `{{tax}}` is what the compiler emits wherever a catalog label said VAT, and
   * it is resolved HERE for the reason the two markers below are: the compiler
   * runs at design time and its output is SAVED, so a word baked in then would
   * be frozen into the template — and a design copied to another shop would
   * carry the first one's tax name with it.
   *
   * First, so a label reaching the barcode or QR passes below unchanged.
   */
  const withTax = body.replace(/\{\{tax\}\}/g, input.taxLabel ?? 'VAT')

  const withBarcodes = withTax.replace(
    /<div class="sd-block sd-barcode"([^>]*)>\{\{barcode:([a-zA-Z]+):(\d+)\}\}/g,
    (whole, attrs: string, source: string, rawH: string) => {
      const strip = () => whole.replace(/\{\{barcode:[^}]*\}\}/, '')
      if (!isBarcodeSource(source)) return strip()
      const typed = /data-bc-text="([^"]*)"/.exec(attrs)?.[1]
      const text = resolveBarcodeText(source, typed ? decodeAttr(typed) : undefined, input.values)
      if (!text) return strip()

      const pt = Math.min(Math.max(Number(rawH) || 40, 16), 120)
      const uri = barcodeDataUri(text, { moduleWidth: 2, height: Math.round(pt * 2) })
      if (!uri) return strip()
      return whole.replace(
        /\{\{barcode:[^}]*\}\}/,
        `<img src="${uri}" alt="" style="height:${pt}px;max-width:100%">`,
      )
    },
  )

  const withQr = withBarcodes.replace(
    /<div class="sd-block sd-qr"([^>]*)>\{\{qr:([a-z]+):(\d+)\}\}/g,
    (whole, attrs: string, target: string, rawSize: string) => {
      if (!input.qr || !isQrTarget(target)) return whole.replace(/\{\{qr:[^}]*\}\}/, '')
      const typed = /data-qr-url="([^"]*)"/.exec(attrs)?.[1]
      const url = resolveQrUrl(target, typed ? decodeAttr(typed) : undefined, input.qr)
      if (!url) return whole.replace(/\{\{qr:[^}]*\}\}/, '')

      const pt = Math.min(Math.max(Number(rawSize) || 90, 40), 200)
      /*
       * The scale is chosen from the printed size, not fixed: a 40pt square
       * built at scale 8 is a large image squeezed into a small box, and a
       * 200pt one built at scale 2 is a blurry one stretched into a big box.
       * Three device pixels per module at the printed size is the honest middle.
       */
      const scale = Math.min(Math.max(Math.round(pt / 30), 2), 8)
      const uri = qrDataUri(url, { scale })
      return `${whole.replace(/\{\{qr:[^}]*\}\}/, `<img src="${uri}" alt="" style="width:${pt}px;height:${pt}px">`)}`
    },
  )

  /*
   * ── PICTURES, FROM A LIST THIS SITE OWNS ────────────────────────────────
   *
   * `{{picture:ID:HEIGHT}}` is what the compiler emits for a picture block. It
   * becomes a tag HERE, and only for an id in `pictures` — which the caller
   * built from this site's own rows. An id naming a picture this shop does not
   * have (a copied design, a deleted picture, a hand-edited spec) resolves to
   * nothing, so the marker can never be used to point a tag anywhere.
   *
   * The tag is built in TypeScript rather than stored, for the same reason the
   * logo's is: what is on disk is then never the thing that decides what a
   * document loads.
   */
  const withPictures = withQr.replace(
    /\{\{picture:(\d+):(\d+)\}\}/g,
    (_m, rawId: string, rawH: string) => {
      const id = Number(rawId)
      if (!input.pictures?.has(id)) return ''
      const h = Math.min(Math.max(Number(rawH) || 90, 8), 400)
      return `<img src="${PICTURE_URL}/${id}" alt="" style="max-height:${h}px;width:auto">`
    },
  )

  /*
   * ── CONDITIONS FIRST ────────────────────────────────────────────────────
   *
   * `{#when rule}…{/when}` marks a block the designer said to show only
   * sometimes. It is resolved BEFORE anything else for two reasons: a hidden
   * block must not have its tokens resolved — asking for a permission-gated
   * value inside a paragraph nobody will read is wasted work at best — and a
   * hidden `{#each}` must not loop over rows it will then throw away.
   *
   * A rule this build does not recognise leaves the CONTENT and drops the
   * marker, matching parseSpec: a design outliving one of its rules should lose
   * the condition, not the words.
   */
  const shown = withPictures.replace(
    /\{#when\s+([a-zA-Z]+)\s*\}([\s\S]*?)\{\/when\}/g,
    (_m, rule: string, inner: string) => (conditionHolds(rule, input.values) ? inner : ''),
  )

  const expanded = shown.replace(
    /\{#each\s+([a-zA-Z]+)\s*\}([\s\S]*?)\{\/each\}/g,
    (_m, sectionKey: string, inner: string) => {
      const section = getSection(doc, sectionKey)
      if (!section) return ''

      const rows = input.sections[sectionKey] ?? []
      return rows
        .map((row) => substitute(inner, docKey, { ...input.values, ...row }, input.capabilities))
        .join('')
    },
  )

  return substitute(expanded, docKey, input.values, input.capabilities)
}

/**
 * Whether a template will render anything for a given token.
 *
 * Used by the adapters to decide whether an optional column deserves a heading:
 * a "Discount" column of dashes on a document going to the person who set the
 * prices is noise, so the default templates ask before drawing one.
 */
export function usesToken(body: string, key: string): boolean {
  return new RegExp(`\\{${key.replace(/\./g, '\\.')}\\}`).test(body)
}
