/**
 * Turning pasted formatting into blocks.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────
 *
 * It is a CONVERTER, not a sanitiser. Markup goes in, `RichBlock[]` comes out,
 * and the markup is thrown away — nothing it saw is stored and nothing it
 * failed to understand is passed through. That is the whole reason pasting
 * from Word can be supported without abandoning the decision `RichBlock`
 * documents: there is no allowlist here to get wrong, because there is no
 * branch that emits a tag.
 *
 * An element this does not recognise contributes its TEXT and nothing else. A
 * <script> contributes the characters between its brackets, as text, escaped by
 * React like any other string. There is no input that produces markup, for the
 * same structural reason there is none in the renderer.
 *
 * `normaliseSections` still runs on write, unchanged. This does not move the
 * security boundary; it only decides what an owner sees in the editor before
 * that boundary is reached.
 *
 * ── WHY IT TAKES A TREE RATHER THAN A STRING ─────────────────────────────
 *
 * Parsing HTML is `DOMParser`'s job and it lives in the browser. Taking a
 * already-parsed tree means this module has no DOM dependency at all, so the
 * walk — which is where every real bug lives — is testable in Node against
 * hand-built nodes and against payloads captured from real editors.
 *
 * `parsePastedHtml` in the browser does the two-line DOMParser call and hands
 * the result here.
 */
import {
  MAX_RICH_BLOCKS,
  MAX_RICH_SPANS,
  MAX_SPAN_TEXT,
  mergeAdjacentSpans,
  richBlockHasText,
  safeLinkTarget,
  type RichAlign,
  type RichBlock,
  type RichBlockType,
  type RichSpan,
} from './storefrontModel'

/**
 * The shape this walks — the part of a DOM node it actually reads.
 *
 * Structural rather than `Node`, so a test can build one from an object
 * literal and so this file never needs lib.dom. A real Element satisfies it as
 * it stands.
 */
export type PastedNode = {
  /** 1 for an element, 3 for text — the DOM's own numbering. */
  nodeType: number
  /** Uppercase, as the DOM reports it. Absent on text nodes. */
  tagName?: string
  textContent?: string | null
  childNodes?: ArrayLike<PastedNode>
  /** Only the properties we read, so a plain object can stand in. */
  style?: { fontWeight?: string; fontStyle?: string; textAlign?: string }
  getAttribute?: (name: string) => string | null
}

/** What one run of text carries down the walk. */
type Inherited = {
  bold: boolean
  italic: boolean
  href: string
  align: RichAlign | null
}

const BLOCKISH = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'TR', 'TABLE', 'PRE', 'FIGURE', 'FIGCAPTION',
])

/**
 * Elements whose content is not writing.
 *
 * Their text is dropped rather than kept, because it is not prose an owner
 * meant to paste — a <script>'s body pasted as a paragraph of JavaScript is
 * noise, and <style> is worse. Everything NOT listed here keeps its text.
 */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK'])

/** The heading level we render, from the one that was pasted. */
function headingType(tag: string): RichBlockType | null {
  if (tag === 'H1' || tag === 'H2') return 'h2'
  if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'h3'
  return null
}

/**
 * Is this element bold, given what it inherited?
 *
 * ── THE GOOGLE DOCS TRAP ─────────────────────────────────────────────────
 *
 * Docs wraps an entire pasted document in `<b style="font-weight:normal">`.
 * Reading <b> as "bold" therefore bolds EVERY word of a paste from the most
 * common source there is — and it looks deliberate, so nobody would guess why.
 *
 * So an explicit weight always wins over the tag: `font-weight:normal` or a
 * number below 600 turns bold OFF even inside <b>, and 600+ turns it on
 * anywhere. Only with no weight stated at all does the tag decide.
 *
 * The same shape handles the other half of the trap: Docs marks real bold as
 * `font-weight:700` on a <span>, which no tag check would ever catch.
 */
function isBold(tag: string, weight: string, inherited: boolean): boolean {
  const stated = weight.trim().toLowerCase()
  if (stated) {
    if (stated === 'normal' || stated === 'lighter') return false
    if (stated === 'bold' || stated === 'bolder') return true
    const numeric = Number(stated)
    if (Number.isFinite(numeric)) return numeric >= 600
  }
  if (tag === 'B' || tag === 'STRONG') return true
  return inherited
}

function isItalic(tag: string, style: string, inherited: boolean): boolean {
  const stated = style.trim().toLowerCase()
  if (stated === 'normal') return false
  if (stated === 'italic' || stated === 'oblique') return true
  if (tag === 'I' || tag === 'EM') return true
  return inherited
}

/** A pasted text-align, but only the three we can render. */
function readAlign(value: string): RichAlign | null {
  const raw = value.trim().toLowerCase()
  if (raw === 'center' || raw === 'centre') return 'center'
  if (raw === 'right' || raw === 'end') return 'right'
  if (raw === 'left' || raw === 'start') return 'left'
  return null
}

/**
 * Collapse whitespace the way HTML rendering does.
 *
 * Pasted markup is full of newlines and indentation that mean nothing on a
 * page. Keeping them literally would turn one pasted paragraph into a ragged
 * column, because the model's text is rendered as written.
 */
function collapse(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ')
}

/**
 * What a paste produced, and what did not fit.
 *
 * `dropped` is counted rather than silently discarded because truncating a
 * long document is exactly the kind of loss nobody notices until it is
 * published — the same failure the span cap once had. The editor says it out
 * loud.
 */
export type PasteResult = {
  blocks: RichBlock[]
  /** Blocks beyond the cap that were not kept. 0 when everything fitted. */
  dropped: number
}

/**
 * Blocks from a parsed clipboard tree.
 *
 * Colour is deliberately NOT carried across. A pasted `#1155cc` is a value,
 * and the whole point of `RichColour` is that a colour is a named role that
 * follows the shop's theme — mapping a near-miss would produce writing that is
 * subtly off-brand with nothing on screen explaining why. Dropped colour is
 * visible immediately and is one click to put back.
 */
export function blocksFromPastedTree(root: PastedNode): PasteResult {
  const blocks: RichBlock[] = []
  /** The block being filled. Spans accumulate here until a block boundary. */
  let spans: RichSpan[] = []
  let type: RichBlockType = 'p'
  let align: RichAlign = 'left'

  const flush = () => {
    if (spans.length === 0) {
      return
    }
    const block = mergeAdjacentSpans({ type, spans, align })
    // A block of pure whitespace is not writing — it is the gap between two
    // paragraphs in the source markup.
    if (richBlockHasText(block)) {
      /*
       * Trim the OUTER edges of the block, not each span.
       *
       * Source markup is indented, so the first span of a paragraph usually
       * opens with the newline and spaces that followed the <p> — and the last
       * closes with the ones before the </p>. Both would render as a stray
       * indent. The spaces BETWEEN spans are load-bearing and are left alone:
       * "Call us on " ends with one that separates it from the bold number.
       */
      const trimmed = block.spans.slice(0, MAX_RICH_SPANS)
      if (trimmed.length) {
        trimmed[0] = { ...trimmed[0], text: trimmed[0].text.replace(/^\s+/, '') }
        const last = trimmed.length - 1
        trimmed[last] = { ...trimmed[last], text: trimmed[last].text.replace(/\s+$/, '') }
      }
      block.spans = trimmed
      blocks.push(block)
    }
    spans = []
  }

  const walk = (node: PastedNode, inherited: Inherited, listType: 'ul' | 'ol' | null) => {
    if (node.nodeType === 3) {
      const text = collapse(node.textContent ?? '')
      if (text === '') return
      /*
       * Leading whitespace is dropped only at the START of a block, not
       * between spans: "Call us on " ends with a space that separates it from
       * the bold number, and eating it would run the two words together.
       */
      if (spans.length === 0 && text.trim() === '') return
      spans.push({
        text: text.slice(0, MAX_SPAN_TEXT),
        bold: inherited.bold,
        italic: inherited.italic,
        href: inherited.href,
      })
      return
    }

    if (node.nodeType !== 1) return

    const tag = (node.tagName ?? '').toUpperCase()
    if (SKIP.has(tag)) return

    if (tag === 'BR') {
      // A line break inside a paragraph starts a new block, because the model
      // has no way to express a break within one.
      flush()
      return
    }

    const nextList = tag === 'UL' ? 'ul' : tag === 'OL' ? 'ol' : listType
    const statedAlign = readAlign(node.style?.textAlign ?? '')

    const next: Inherited = {
      bold: isBold(tag, node.style?.fontWeight ?? '', inherited.bold),
      italic: isItalic(tag, node.style?.fontStyle ?? '', inherited.italic),
      href:
        tag === 'A'
          ? safeLinkTarget(node.getAttribute?.('href') ?? '').slice(0, 300)
          : inherited.href,
      align: statedAlign ?? inherited.align,
    }

    const heading = headingType(tag)
    const isListItem = tag === 'LI'
    const startsBlock = BLOCKISH.has(tag) || heading !== null

    if (startsBlock) {
      flush()
      /*
       * The type is decided when the block OPENS and read when it flushes, so
       * a heading's own children cannot change it. `listType` comes from the
       * enclosing <ul>/<ol> rather than the <li>, which is what makes a
       * numbered list stay numbered.
       */
      type = heading ?? (isListItem ? (nextList ?? 'ul') : 'p')
      align = next.align ?? 'left'
    }

    const children = node.childNodes
    if (children) {
      for (let i = 0; i < children.length; i++) walk(children[i], next, nextList)
    }

    // A block-level element ends its block, so the next one does not inherit
    // its type — otherwise everything after a heading would also be a heading.
    if (startsBlock) {
      flush()
      type = 'p'
      align = 'left'
    }
  }

  walk(root, { bold: false, italic: false, href: '', align: null }, null)
  flush()

  const kept = blocks.slice(0, MAX_RICH_BLOCKS)
  return { blocks: kept, dropped: Math.max(0, blocks.length - kept.length) }
}

/**
 * Blocks from clipboard HTML, in a browser.
 *
 * The only part of this feature that needs a DOM, kept to three lines so that
 * everything worth testing lives in `blocksFromPastedTree`.
 *
 * `DOMParser` builds an INERT document: it runs no script, loads no image and
 * fires no handler. That matters — this is hostile input by definition, since
 * a clipboard can hold anything — and it is why parsing is safe to do at all
 * rather than only pattern-matching the string.
 */
export function parsePastedHtml(html: string): PasteResult {
  if (typeof DOMParser === 'undefined') return { blocks: [], dropped: 0 }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return blocksFromPastedTree(doc.body as unknown as PastedNode)
}

/**
 * Blocks from plain text — one block per line.
 *
 * The fallback when the clipboard has no HTML at all, and worth having on its
 * own: pasting five lines from Notepad should produce five paragraphs, not one
 * paragraph with the line breaks eaten by `collapse`.
 */
export function blocksFromPastedText(text: string): PasteResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const kept = lines.slice(0, MAX_RICH_BLOCKS)
  return {
    blocks: kept.map((line) => ({
      type: 'p' as RichBlockType,
      spans: [{ text: line.slice(0, MAX_SPAN_TEXT) }],
      align: 'left' as RichAlign,
    })),
    dropped: Math.max(0, lines.length - kept.length),
  }
}
