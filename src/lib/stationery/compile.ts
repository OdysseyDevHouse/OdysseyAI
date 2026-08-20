import { getDocType, findToken } from './catalog'
import { BAND_REM } from './geometry'
import { escapeHtml } from './render'
import {
  BAND_KEYS,
  DEFAULT_IMAGE_H,
  DEFAULT_BARCODE_PT,
  DEFAULT_QR_PT,
  DEFAULT_LOGO_HEIGHT,
  DOC_BLOCK_CATALOG,
  type BandKey,
  type DocBlock,
  type DocumentSpec,
} from './blocks'

/**
 * A block document, compiled to the markup the existing renderer consumes.
 *
 * ── WHY THIS IS THE WHOLE DESIGN ──────────────────────────────────────────
 *
 * The visual designer could have had its own renderer, walking blocks straight
 * to a page. It does not, and that is deliberate: render.ts, sanitise.ts,
 * validate.ts and the token catalog would then all have a second customer, and
 * the two would disagree eventually — at exactly the moment somebody trusted
 * the preview.
 *
 * Instead a spec compiles to `{token}` markup, which is what the HTML editor
 * produces by hand. Everything downstream is unchanged:
 *
 *   the token catalog stays the security boundary — a block cannot name a
 *   field the catalog does not expose, because the token it emits would
 *   resolve to nothing;
 *
 *   permission-gated tokens still degrade silently, so a cost column is blank
 *   for someone without products.cost rather than an error;
 *
 *   the legal validator still runs against the compiled markup, so a document
 *   designed by dragging cannot escape what a hand-written one must carry.
 *
 * ── THE OUTPUT IS THE HTML EDITOR'S INPUT ─────────────────────────────────
 *
 * Which is what makes "Edit as HTML" a one-line conversion rather than a
 * feature: compile the spec, store the markup, change the format. It only goes
 * that way — parsing markup back into blocks is the thing this design exists to
 * avoid.
 */

/* ── the shared look ─────────────────────────────────────────────────────────
 *
 * The classes are the app's own, exactly as the hand-written defaults use them,
 * because a printed page renders inside the app where they exist. Kept as
 * constants rather than inline so a change to how a designed document looks is
 * one edit, and so the compiled output stays diffable against the templates it
 * replaces.
 */

const PAGE = 'mx-auto w-full max-w-[52rem] bg-surface p-8 text-ink'
const MUTED_XS = 'text-xs text-muted'
const LABEL = 'text-xs font-medium tracking-wide text-muted'
const TH =
  'px-4 pt-3 pb-2.5 align-top text-[13px] font-normal leading-tight text-muted'
const TD = 'px-4 py-1.5'

/**
 * Rows and blocks that came out empty remove themselves.
 *
 * EXPORTED, because the designer's canvas needs the very same rules. It renders
 * each block on its own rather than the whole document, so without them an empty
 * notes block showed a "NOTES" caption over nothing on screen while correctly
 * disappearing on paper — the canvas lying about the printed page, which is the
 * one failure this whole compile-don't-render design exists to prevent.
 *
 * The same rule the hand-written defaults carry, and for the same reason:
 * "Reference" over a blank reads as a reference someone forgot to type. Done in
 * CSS because the template language has no conditionals on purpose — one rule
 * covers every such row, and it needs no feature that then needs supporting.
 *
 * ── THE ONE !important, AND WHY IT IS EARNED ──────────────────────────────
 *
 * `{site.logo}` resolves to a tag built server-side with an INLINE max-height,
 * inline precisely so a template cannot be made to point it elsewhere. Inline
 * styles outrank every ordinary selector, so a logo block's own height had no
 * way to win: the first version of it capped the wrapper and the image stayed at
 * 56px whatever the shop typed — a control that silently did nothing.
 *
 * `!important` is the one thing that does outrank an inline style. It is scoped
 * to `.sd-logo img`, which is a class this compiler emits and nothing else uses,
 * and the height comes through a variable so there is one declaration rather
 * than one per size anybody might choose.
 */
export const BLOCK_STYLE = `
.sd-row:has(dd:empty) { display: none; }
.sd-block:has(> .sd-value:empty) { display: none; }
.sd-line:empty { display: none; }
.sd-table:has(tbody:empty) { display: none; }
.sd-logo img { max-height: var(--sd-logo-h) !important; height: auto; width: auto; }`

/**
 * A block whose whole content is one token and nothing else.
 *
 * Such a block hides itself when the token comes out empty, the way a notes
 * block does — the invoice's closing line is blank on a tax invoice and carries
 * a warning on a quote, and reserving a line for it either way is wrong.
 *
 * One definition because two callers need the same answer: the compiler decides
 * what to emit, needsWrapper decides whether to wrap it, and a block wrapped but
 * not marked (or the reverse) simply never hides.
 */
function isLoneToken(text: string | undefined): boolean {
  return !!text && /^\{[a-zA-Z0-9._]+\}$/.test(text.trim())
}

const ALIGN_CLASS: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

/** Escape text a designer typed, so a heading cannot introduce markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ── per-block compilers ─────────────────────────────────────────────────── */

/**
 * The logo on its own.
 *
 * ── THE SIZE IS SET HERE, NOT IN THE TOKEN ────────────────────────────────
 *
 * `{site.logo}` resolves to a complete `<img>` with its own max-height, built
 * server-side so a template cannot point the src anywhere else. That tag is
 * fixed, so a per-block height has to be applied around it: the wrapper caps the
 * height and the image is told to fit, which beats trying to rewrite an
 * attribute inside a string the sanitiser is deliberately strict about.
 *
 * `[&>img]` reaches the token's own tag, which is the one thing inside here.
 */
function logoBlock(b: DocBlock): string {
  const h = b.logoHeight ?? DEFAULT_LOGO_HEIGHT

  /*
   * `sd-logo` and a CSS variable, rather than a utility class on the wrapper.
   *
   * The token's own tag carries an INLINE `max-height`, built server-side so the
   * src cannot be tampered with — and an inline style beats any ordinary class,
   * so the first version of this capped the wrapper and left the image at 56px
   * whatever the shop typed. The height control silently did nothing.
   *
   * The rule in BLOCK_STYLE overrides it with `!important`, which is the one
   * thing that outranks an inline style, and the size arrives as a variable so
   * there is a single declaration rather than one per height a shop might pick.
   */
  return (
    `<div class="sd-block sd-logo" style="--sd-logo-h:${h}px">` +
    `<span class="sd-value">{site.logo}</span>` +
    `</div>`
  )
}

/**
 * A picture the shop uploaded, as a placeholder the RENDERER fills in.
 *
 * ── WHY IT IS NOT AN <img> HERE ───────────────────────────────────────────
 *
 * Compiling has no database, and the tag has to name a real picture belonging
 * to this site. Worse, a tag written into stored markup would be a tag a shop
 * could later hand-edit — and lib/stationery/render's SAFE_MARKUP exists
 * precisely so that the only image a document can carry is one the server built.
 *
 * So the compiler emits a MARKER carrying the id and the height, and
 * renderTemplate turns it into a tag from its own list of this site's pictures.
 * An id naming a picture that has been deleted resolves to nothing, which is
 * the same thing a missing file does.
 *
 * The marker's shape is deliberately not a {token}: substitute() only resolves
 * keys the catalog declares, and a per-picture token would mean a catalog that
 * changes as a shop uploads.
 */
function imageBlock(b: DocBlock): string {
  if (!b.imageId) return ''
  const h = Math.round(b.imageHeight ?? DEFAULT_IMAGE_H)
  return `<div class="sd-block sd-image">{{picture:${b.imageId}:${h}}}</div>`
}

/**
 * A QR code, as a placeholder the RENDERER fills in.
 *
 * Same shape as a picture and for the same reason: compiling has no idea what
 * this document's tracking URL is, because the document does not exist yet. The
 * marker carries the target and the size; renderTemplate resolves the address
 * and encodes the square.
 *
 * The typed URL is NOT in the marker. It goes through as its own escaped
 * attribute so that a shop's address — the one piece of this a person types —
 * can never be confused with the marker's own punctuation.
 */
/**
 * A barcode, as a placeholder the RENDERER fills in.
 *
 * Same shape as the QR, and for a reason particular to this block: the value it
 * carries usually comes from the DOCUMENT — the number this invoice happens to
 * have — which the compiler cannot know. Even the fixed case goes through the
 * marker rather than being written out here, so both sources travel one road
 * and the encoder is asked in one place.
 */
function barcodeBlock(b: DocBlock): string {
  const source = b.barcodeSource ?? 'docNumber'
  const h = Math.round(b.barcodeHeight ?? DEFAULT_BARCODE_PT)
  const typed = b.barcodeText ? ` data-bc-text="${escapeHtml(b.barcodeText)}"` : ''
  return `<div class="sd-block sd-barcode"${typed}>{{barcode:${source}:${h}}}</div>`
}

function qrBlock(b: DocBlock): string {
  const target = b.qrTarget ?? 'store'
  const size = Math.round(b.qrSize ?? DEFAULT_QR_PT)
  const caption = b.qrCaption?.trim()
    ? `<div class="sd-qr-caption">${escapeHtml(b.qrCaption.trim())}</div>`
    : ''
  const custom = b.qrUrl ? ` data-qr-url="${escapeHtml(b.qrUrl)}"` : ''
  return (
    `<div class="sd-block sd-qr"${custom}>` +
    `{{qr:${target}:${size}}}` +
    caption +
    `</div>`
  )
}

function letterhead(b: DocBlock): string {
  const tokens = b.tokens ?? []
  // The logo is markup rather than text, so it stands alone above the name
  // rather than being one of the stacked lines.
  const logo = tokens.includes('site.logo') ? '{site.logo}' : ''
  const name = tokens.includes('site.name')
    ? `<h1 class="text-lg font-semibold text-ink">{site.name}</h1>`
    : ''
  const rest = tokens
    .filter((t) => t !== 'site.logo' && t !== 'site.name')
    .map((t) => `<span class="sd-line block">{${t}}</span>`)
    .join('')

  return `${logo}${name}<p class="mt-1 ${MUTED_XS} leading-relaxed">${rest}</p>`
}

function docTitle(b: DocBlock): string {
  const tokens = b.tokens ?? []
  const heading = b.title
    ? `<h2 class="text-xl font-semibold tracking-wide text-ink">${esc(b.title)}</h2>`
    : ''
  const lines = tokens
    .map((t) => `<p class="sd-line mt-0.5 text-sm text-ink-2">{${t}}</p>`)
    .join('')
  return `${heading}${lines}`
}

function partyBlock(b: DocBlock): string {
  const title = b.title ? `<p class="${LABEL}">${esc(b.title)}</p>` : ''
  const lines = (b.tokens ?? [])
    .map((t, i) =>
      i === 0
        ? `<p class="sd-line mt-1 font-medium text-ink">{${t}}</p>`
        : `<p class="sd-line text-sm text-muted">{${t}}</p>`,
    )
    .join('')
  return `${title}${lines}`
}

/**
 * Labelled rows — "Required by", "Reference".
 *
 * The LABEL is the designer's wording and the value is a token, which is why a
 * detail list stores tokens and a title rather than free text: renaming the
 * label must not be able to change which field it shows.
 */
function detailList(b: DocBlock): string {
  const title = b.title ? `<p class="${LABEL} mb-1">${esc(b.title)}</p>` : ''
  const rows = (b.rows ?? [])
    .map(
      (r) =>
        `<div class="sd-row flex justify-between gap-6">` +
        `<dt class="text-muted">${esc(r.label)}</dt>` +
        `<dd class="text-ink">{${r.token}}</dd></div>`,
    )
    .join('')
  return `${title}<dl class="flex flex-col gap-1 text-sm">${rows}</dl>`
}

/**
 * The items.
 *
 * Columns are the designer's: which fields, in what order, under what heading,
 * at what width. The TOKEN decides the value and its formatting; the heading is
 * only words. That split is what lets a shop rename "Unit price" to "Rate"
 * without any risk of the column then showing something else.
 */
function lineTable(b: DocBlock): string {
  const cols = b.columns ?? []
  if (cols.length === 0) return ''

  // Which repeating section this table walks. See the note on DocBlock.section.
  const section = b.section ?? 'lines'

  const head = cols
    .map((c) => {
      const align = ALIGN_CLASS[c.align ?? 'left']
      const width = c.width ? ` style="width:${c.width}%"` : ''
      return `<th class="${TH} ${align}"${width}>${esc(c.heading)}</th>`
    })
    .join('')

  const body = cols
    .map((c) => {
      const align = c.align === 'right' ? 'numeric text-right whitespace-nowrap' : ''
      // A second field under the first, smaller — the supplier's code beneath
      // the description, which is how a real order reads.
      const sub = c.subToken
        ? `<div class="sd-line text-xs text-muted">{${c.subToken}}</div>`
        : ''
      const main = sub ? `<div class="text-ink">{${c.token}}</div>` : `{${c.token}}`
      return `<td class="${TD} ${align} text-ink-2">${main}${sub}</td>`
    })
    .join('')

  /*
   * A TABLE WITH NO ROWS TAKES ITS HEADINGS WITH IT.
   *
   * The age ladder is empty on a remittance — nothing is overdue on money
   * already paid — and it was printing "Age  Amount" over nothing. Headings
   * over an empty table read as a table that failed to load.
   *
   * The  wrapper and its rule in BLOCK_STYLE do it in CSS, like every
   * other hide-when-empty case, because the template language has no
   * conditionals on purpose. An empty tbody is what  matches.
   */
  return (
    `<div class="sd-table">` +
    `<table class="w-full border-collapse text-sm">` +
    `<thead><tr class="border-y border-border bg-surface-2">${head}</tr></thead>` +
    `<tbody>{#each ${section}}<tr class="border-b border-border last:border-b-0">${body}</tr>{/each}</tbody>` +
    `</table></div>`
  )
}

/** Subtotal, VAT and the amount due — the last one loud. */
function totals(b: DocBlock, docKey: string): string {
  const doc = getDocType(docKey)
  const tokens = b.tokens ?? []
  // The last token is the total: it gets the rule above it and the big type,
  // because that is the number every reader is looking for.
  const above = tokens.slice(0, -1)
  const last = tokens[tokens.length - 1]

  const rows = above
    .map((t) => {
      const def = doc ? findToken(doc, t) : null
      return (
        `<div class="sd-row flex justify-between gap-6">` +
        `<dt class="text-muted">${esc(def?.label ?? t)}</dt>` +
        `<dd class="numeric text-ink">{${t}}</dd></div>`
      )
    })
    .join('')

  const lastDef = last && doc ? findToken(doc, last) : null
  /*
   * The grand total's wording, from the block's own title where it has one.
   *
   * The catalog label is written for a token PICKER and is the wrong register
   * for a printed page. It usually reads well enough — "Total" — but a
   * statement's figure is money we WANT on a customer statement, money we OWE
   * on a supplier one and money already SENT on a remittance, and no single
   * fixed label is right for all three. The title lets the design say so, and
   * a token in it resolves like anywhere else.
   */
  const grandLabel = b.title ?? lastDef?.label ?? 'Total'
  const grand = last
    ? `<div class="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">` +
      `<span class="font-medium text-ink">${esc(grandLabel)}</span>` +
      `<span class="numeric text-xl font-semibold text-ink">{${last}}</span></div>`
    : ''

  return (
    `<div class="ml-auto w-full max-w-xs">` +
    `<dl class="flex flex-col gap-1.5 text-sm">${rows}</dl>${grand}</div>`
  )
}

/** A titled block whose whole self disappears when the value is empty. */
function titledValue(title: string, token: string, pre = true): string {
  const heading = title ? `<p class="${LABEL} mb-2">${esc(title)}</p>` : ''
  const cls = pre ? 'sd-value whitespace-pre-line text-sm text-ink-2' : 'sd-value text-sm text-ink-2'
  return `${heading}<p class="${cls}">{${token}}</p>`
}

function compileBlock(b: DocBlock, docKey: string): string {
  switch (b.kind) {
    case 'logo':
      return logoBlock(b)
    case 'image':
      return imageBlock(b)
    case 'qr':
      return qrBlock(b)
    case 'barcode':
      return barcodeBlock(b)
    case 'letterhead':
      return letterhead(b)
    case 'docTitle':
      return docTitle(b)
    case 'partyBlock':
      return partyBlock(b)
    case 'detailList':
      return detailList(b)
    case 'lineTable':
      return lineTable(b)
    case 'totals':
      return totals(b, docKey)
    case 'vatSummary':
      return titledValue(b.title ?? 'VAT SUMMARY', 'totals.vatSummary')
    case 'banking':
      return titledValue(b.title ?? 'BANKING DETAILS', 'banking')
    case 'notes':
      return titledValue(b.title ?? 'NOTES', 'doc.notes')
    case 'text':
      /*
       * A designer's own words, and they may contain tokens.
       *
       * Escaped as TEXT — the `html` block is where markup goes — but the braces
       * survive escaping, so "Please quote {doc.number}" resolves like anywhere
       * else. That is what a footer needs: a fixed sentence with one fact in it.
       * A token the catalog does not know renders empty, exactly as it would in
       * a hand-written template.
       */
      /*
       * A block that is ONE TOKEN and nothing else hides itself when that token
       * comes out empty, the way a notes block does.
       *
       * The invoice's closing line is exactly this: {doc.closing} carries a
       * warning on a quote and a pro forma, and is deliberately blank on a tax
       * invoice — so the shipped invoice would otherwise reserve space on every
       * page for a sentence that never prints.
       *
       * Only for a lone token. "Please quote {doc.number}" has words of its own
       * and should print them even if the number is missing, because the
       * sentence is still an instruction to the reader.
       */
      if (!b.text) return ''
      return /^\{[a-zA-Z0-9._]+\}$/.test(b.text.trim())
        ? `<p class="sd-value text-xs text-muted">${esc(b.text)}</p>`
        : `<p class="text-xs text-muted">${esc(b.text)}</p>`
    case 'signature': {
      /*
       * A rule to sign on, with its label UNDER it — where a signature line puts
       * it, because the space above the line is the part being written in.
       *
       * The rule is drawn rather than typed. A row of underscores never lines up
       * across two columns and breaks differently at every font size.
       */
      const label = b.title ?? 'Received by'
      return (
        `<div class="pt-8"><hr class="border-ink-2"></div>` +
        `<p class="mt-1 ${MUTED_XS}">${esc(label)}</p>`
      )
    }
    case 'rule':
      return `<hr class="border-border">`
    case 'spacer':
      return `<div class="h-6"></div>`
    case 'html':
      // Passed through as written. sanitiseTemplate runs over the whole
      // compiled document at save, so this is no more trusted than any other
      // markup a person typed — it is simply not escaped here.
      return b.text ?? ''
    default:
      return ''
  }
}

/* ── laying blocks out ───────────────────────────────────────────────────────
 *
 * ── THREE BANDS, AND WHY ──────────────────────────────────────────────────
 *
 * A block carries an x/y, so the obvious compilation is one absolutely
 * positioned page. That would be wrong, and it would be wrong only for long
 * documents — which is the worst kind of wrong, because it passes every test
 * written against a three-line order and then prints the items over the totals
 * on a forty-line one.
 *
 * The line table is the one thing on the page whose height nobody knows in
 * advance. So the page is three stacked bands, and only the two that DON'T grow
 * are positioned absolutely:
 *
 *   header   absolute boxes inside a relative section
 *   body     ordinary flow — the table sets its own height
 *   footer   absolute boxes again, pushed down by whatever the body became
 *
 * That is the whole trick, and it is what lets free placement coexist with a
 * document that has to keep working when the order gets long.
 *
 * ── PERCENTAGES SURVIVE TO PRINT ──────────────────────────────────────────
 *
 * `left` and `width` are percentages of the page, so the screen and the paper
 * agree without either knowing the other's pixel width. `top` cannot be: a
 * percentage top inside a container whose height is `min-height` resolves
 * against a height that isn't fixed, so it collapses. Vertical position is
 * therefore emitted in `em`, which scales with the type rather than the viewport
 * — the same reason the hand-written defaults size their spacing in `rem`.
 */

/** A band with nothing in it should not reserve space it isn't using. */
function bandHeight(blocks: DocBlock[]): number {
  return blocks.reduce((max, b) => Math.max(max, b.y), 0)
}

/**
 * One block, wrapped in its positioned box.
 *
 * The inner markup is exactly what `compileBlock` produces for the canvas, so
 * the designer is looking at the same HTML the printer gets. Only the wrapper
 * differs, which is the property that keeps the preview honest.
 */
/**
 * A block's own markup, wrapper and all.
 *
 * THE ONE PLACE a block becomes HTML, so the canvas and the printed page cannot
 * disagree about it. They did: the document path put `sd-block` on the
 * positioned box while the canvas path put it on an inner div, and an empty notes
 * block kept its caption on screen and lost it on paper. Same rendering,
 * different markup — which is the drift that becomes a real divergence next time
 * somebody edits one of them.
 *
 * Everything OUTSIDE this — where the block sits, how wide it is, whether it is
 * selected — belongs to whoever is placing it, because a canvas needs a
 * draggable box and a page needs a printed one.
 */
export function blockMarkup(b: DocBlock, docKey: string): string {
  const html = compileBlock(b, docKey)
  if (!html) return ''
  const align = b.align ? ALIGN_CLASS[b.align] : ''
  const inner = align ? `<div class="${align}">${html}</div>` : html
  return needsWrapper(b) ? `<div class="sd-block">${inner}</div>` : inner
}

/**
 * A conditional block's markup, wrapped so the RENDERER can decide.
 *
 * ── WHY THIS CANNOT BE DECIDED HERE ───────────────────────────────────────
 *
 * Compiling and rendering happen at different times on the A4 path. A design
 * becomes markup when it is SAVED, and that markup meets the document's data
 * later, in renderTemplate — so at this point there is no invoice to ask
 * whether it is overdue. The same reason hide-when-empty is done with CSS
 * rather than by omitting the block.
 *
 * So the condition travels IN the markup, as `{#when rule}…{/when}` — the same
 * shape as the `{#each}` that was already there, resolved in the same place by
 * the same pass. The PDF and the slip need none of this: they hold the block
 * and the data at once and simply skip it.
 *
 * ── AND WHY NOT IN blockMarkup ────────────────────────────────────────────
 *
 * blockMarkup is shared with the designer's canvas, which must SHOW a
 * conditional block — a designer cannot arrange what has vanished. The canvas
 * marks it as situational instead. Only the printed path wraps.
 */
function whenWrapped(b: DocBlock, html: string): string {
  if (!html || !b.showWhen || b.showWhen === 'always') return html
  return `{#when ${b.showWhen}}${html}{/when}`
}

function positioned(b: DocBlock, docKey: string): string {
  const html = blockMarkup(b, docKey)
  if (!html) return ''

  const style =
    `position:absolute;left:${b.x.toFixed(2)}%;` +
    `top:${(b.y * BAND_REM).toFixed(2)}rem;` +
    `width:${b.w.toFixed(2)}%`

  return whenWrapped(b, `<div style="${style}">${html}</div>`)
}

/**
 * A block in flowing layout, for the body band.
 *
 * The body is not positioned, so its blocks keep their WIDTH and their
 * alignment but take their vertical place from the flow. `y` still orders them,
 * which is why the caller sorts — a designer who drags one body block above
 * another means it to print first.
 */
/**
 * The one block per band that is laid out in FLOW rather than absolutely.
 *
 * It is the lowest, and it is what gives the section its height — see the note
 * where it is chosen. Everything about it is placed the same way as its
 * absolute siblings except the vertical, which comes from a margin so the
 * element still occupies space in the flow.
 */
function flowedAt(b: DocBlock, docKey: string): string {
  const html = blockMarkup(b, docKey)
  if (!html) return ''
  const style =
    `margin-left:${b.x.toFixed(2)}%;` +
    `margin-top:${(b.y * BAND_REM).toFixed(2)}rem;` +
    `width:${b.w.toFixed(2)}%`
  return whenWrapped(b, `<div style="${style}">${html}</div>`)
}

function flowed(b: DocBlock, docKey: string): string {
  const html = blockMarkup(b, docKey)
  if (!html) return ''
  const style = b.w < 100 ? ` style="width:${b.w.toFixed(2)}%"` : ''
  return whenWrapped(b, `<div${style}>${html}</div>`)
}

/**
 * A block document as printable markup.
 *
 * Returns '' for an unreadable spec rather than throwing: the caller falls back
 * to the shipped design, and a document that will not print is worse than one
 * that prints plainly.
 */
export function compileDocument(spec: DocumentSpec, docKey: string): string {
  if (!spec || !Array.isArray(spec.blocks)) return ''

  const sections: string[] = []

  for (const band of BAND_KEYS) {
    /*
     * Sorted top to bottom, then LEFT TO RIGHT.
     *
     * It changes nothing about where an absolute box lands, but it decides the
     * body's order and the order a screen reader hears — and it is how the
     * compiled document reads to whoever inherits it.
     *
     * The x tiebreak is not cosmetic. Two blocks at the same height sorted only
     * by y come out in whatever order the array happened to hold, so splitting
     * the logo out of the letterhead silently moved the document title ahead of
     * the address: same words, different order, which is a different document to
     * anyone reading it aloud.
     */
    const blocks = spec.blocks
      .filter((b) => b.band === band)
      .sort((a, b) => a.y - b.y || a.x - b.x)
    if (blocks.length === 0) continue

    if (band === 'body') {
      const inner = blocks.map((b) => flowed(b, docKey)).filter(Boolean).join('')
      if (inner) sections.push(`<section class="py-4">${inner}</section>`)
      continue
    }

    const inner = blocks.map((b) => positioned(b, docKey)).filter(Boolean).join('')
    if (!inner) continue

    /*
     * `min-height` rather than `height`.
     *
     * A block's real height is its content's, so a letterhead that grew by a
     * line must be able to make the band taller instead of spilling out of it.
     * The floor is the lowest block's `y` plus room for that block itself —
     * without it a block at the bottom of the band would have its own content
     * hanging over whatever comes next.
     *
     * ── THE ALLOWANCE CANNOT BE A CONSTANT ──────────────────────────────
     *
     * It was a fixed twelve units — a guess at how tall the lowest block might
     * be — and a five-row detail list is twenty-nine units tall. So on the
     * delivery note the items table began inside the address block and ran
     * straight through it. Only a browser knows a rendered height, and the
     * compiler has none.
     *
     * So the LOWEST block in each band is laid out in normal FLOW rather than
     * absolutely, pushed down by a margin to where its coordinates put it. It
     * then takes exactly its own height, whatever that turns out to be, and the
     * section grows to hold it — no allowance, no guess, and nothing for a long
     * address to overflow.
     *
     * One copy, not two. An invisible strut alongside the absolute copy would
     * also have worked and was tried: it duplicates the block's text, so the
     * words appear twice to a screen reader and twice in any extraction of the
     * page — which the parity tests caught immediately.
     *
     * The block keeps its own x and width, so side-by-side layout is unaffected;
     * only its vertical placement changes mechanism, and only for the one block
     * that decides how tall the band must be.
     */
    const lowest = blocks.reduce((low, b) => (b.y >= low.y ? b : low), blocks[0])
    const rest = blocks.filter((b) => b !== lowest)

    const positioned_ = rest.map((b) => positioned(b, docKey)).filter(Boolean).join('')
    const tail = flowedAt(lowest, docKey)

    sections.push(`<section class="relative py-4">${positioned_}${tail}</section>`)
  }

  return `<style>${BLOCK_STYLE}</style><article class="${PAGE}">${sections.join('')}</article>`
}

/**
 * How tall a band is, in the same percent the designer's `y` is in.
 *
 * The canvas needs it to size its own drop area and to hand `snapBlock` a height
 * to snap the page centre against. Exported so the two cannot disagree about
 * where the middle of a band is.
 */
export function bandExtent(spec: DocumentSpec, band: BandKey): number {
  return bandHeight(spec.blocks.filter((b) => b.band === band))
}

/**
 * Whether a block's whole section should vanish when its value is empty.
 *
 * Only the ones that are a heading plus one value — an empty NOTES block is a
 * caption over nothing. A line table with no rows still has headings, and a
 * letterhead is never empty.
 */
function needsWrapper(b: DocBlock): boolean {
  if (b.kind === 'notes' || b.kind === 'banking' || b.kind === 'vatSummary') return true
  /*
   * A text block that is ONE TOKEN and nothing else — see the `text` case. The
   * wrapper is what the hide rule matches on, so without it the `sd-value` there
   * would be a class with nothing acting on it.
   */
  return b.kind === 'text' && !!b.text && /^\{[a-zA-Z0-9._]+\}$/.test(b.text.trim())
}

/**
 * Each block compiled on its own, keyed by id.
 *
 * For the DESIGNER, which draws every block in its own selectable box and
 * therefore needs them apart rather than joined. Deliberately the same
 * `compileBlock` the whole-document path uses — the canvas showing something
 * the page would not print is the exact failure this whole design avoids.
 *
 * The caller renders each fragment through the ordinary token renderer, so a
 * block on the canvas resolves its values exactly as it will on paper,
 * including the permission-gated ones.
 */
export function compileBlocks(spec: DocumentSpec, docKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!spec || !Array.isArray(spec.blocks)) return out
  // The very same markup the printed page gets — see blockMarkup.
  for (const b of spec.blocks) out[b.id] = blockMarkup(b, docKey)
  return out
}

/**
 * Which document kinds the visual designer can currently express.
 *
 * A guard rather than an assumption: a document type whose default this cannot
 * reproduce should not offer the visual editor at all, because a shop that
 * switches to it would silently lose part of their paperwork.
 */
export function supportsBlocks(docKey: string): boolean {
  const doc = getDocType(docKey)
  return !!doc && doc.medium === 'a4'
}

export { DOC_BLOCK_CATALOG }
