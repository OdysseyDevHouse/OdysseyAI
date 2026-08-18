import { getDocType, findToken } from './catalog'
import { DOC_BLOCK_CATALOG, type DocBlock, type DocumentSpec } from './blocks'

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
 * The same rule the hand-written defaults carry, and for the same reason:
 * "Reference" over a blank reads as a reference someone forgot to type. Done in
 * CSS because the template language has no conditionals on purpose — one rule
 * covers every such row, and it needs no feature that then needs supporting.
 */
const STYLE = `<style>
.sd-row:has(dd:empty) { display: none; }
.sd-block:has(> .sd-value:empty) { display: none; }
.sd-line:empty { display: none; }
</style>`

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

  return (
    `<table class="w-full border-collapse text-sm">` +
    `<thead><tr class="border-y border-border bg-surface-2">${head}</tr></thead>` +
    `<tbody>{#each lines}<tr class="border-b border-border last:border-b-0">${body}</tr>{/each}</tbody>` +
    `</table>`
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
  const grand = last
    ? `<div class="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">` +
      `<span class="font-medium text-ink">${esc(lastDef?.label ?? 'Total')}</span>` +
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
      return b.text ? `<p class="text-xs text-muted">${esc(b.text)}</p>` : ''
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

/* ── laying blocks out ───────────────────────────────────────────────────── */

/**
 * Group the flat list into rows.
 *
 * A `left` block pairs with the `right` block that follows it into one
 * two-column row; anything else spans the page. Two columns and no more,
 * because a printed document is a flow: three columns of an unknown-length
 * table is a page that reflows differently on every order.
 *
 * A `left` with nothing after it, or a `right` on its own, simply spans — a
 * half-width block alone on a row looks like a mistake, and dragging its
 * partner away should not leave a hole.
 */
type Row = { left: DocBlock; right: DocBlock } | { full: DocBlock }

export function rowsOf(blocks: DocBlock[]): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const next = blocks[i + 1]
    if (b.span === 'left' && next?.span === 'right') {
      rows.push({ left: b, right: next })
      i++
      continue
    }
    rows.push({ full: b })
  }
  return rows
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

  const parts: string[] = []

  for (const row of rowsOf(spec.blocks)) {
    if ('full' in row) {
      const html = compileBlock(row.full, docKey)
      if (!html) continue
      const align = row.full.align ? ALIGN_CLASS[row.full.align] : ''
      const wrap = needsWrapper(row.full) ? 'sd-block' : ''
      parts.push(`<section class="${wrap} py-4 ${align}">${html}</section>`)
      continue
    }

    const l = compileBlock(row.left, docKey)
    const r = compileBlock(row.right, docKey)
    const lAlign = row.left.align ? ALIGN_CLASS[row.left.align] : ''
    const rAlign = row.right.align ? ALIGN_CLASS[row.right.align] : 'text-right'

    parts.push(
      `<section class="flex items-start justify-between gap-8 py-4">` +
        `<div class="${lAlign}">${l}</div>` +
        `<div class="${rAlign}">${r}</div>` +
        `</section>`,
    )
  }

  return `${STYLE}<article class="${PAGE}">${parts.join('')}</article>`
}

/**
 * Whether a block's whole section should vanish when its value is empty.
 *
 * Only the ones that are a heading plus one value — an empty NOTES block is a
 * caption over nothing. A line table with no rows still has headings, and a
 * letterhead is never empty.
 */
function needsWrapper(b: DocBlock): boolean {
  return b.kind === 'notes' || b.kind === 'banking' || b.kind === 'vatSummary'
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
  for (const b of spec.blocks) out[b.id] = compileBlock(b, docKey)
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
