import { getDocType, type DocTypeDef } from './catalog'

/**
 * A printed document as an ordered list of BLOCKS.
 *
 * ── WHY BLOCKS ARE THE TRUTH AND MARKUP IS GENERATED ──────────────────────
 *
 * The HTML editor gives full control to someone who writes markup. This is for
 * everyone else: drag the logo to the other side, untick the discount column,
 * rename "Unit price" to "Rate".
 *
 * The alternative — keep HTML as the stored form and parse it back into
 * draggable boxes — is where this feature would die. A customer hand-edits one
 * thing and their markup stops being parseable, so their document becomes
 * undraggable; and a round-trip through a parser silently loses formatting
 * nobody asked it to touch. With blocks as the source there is nothing to parse
 * back, so dragging always works.
 *
 * ── IT COMPILES TO THE EXISTING RENDERER ──────────────────────────────────
 *
 * compile.ts turns a spec into the same `{token}` markup render.ts already
 * consumes. That is the load-bearing decision: catalog.ts stays the security
 * boundary, permission-gated tokens still degrade silently, the sanitiser and
 * validator are unchanged, and there is NO second renderer to disagree with the
 * printed page.
 *
 * ── A FLAT BAG, NOT A DISCRIMINATED UNION ─────────────────────────────────
 *
 * Blocks are interchangeable in every code path except rendering and editing —
 * which is exactly what makes drag-and-drop, undo/redo and a uniform compile
 * signature simple. A union would force narrowing at every one of those call
 * sites. The storefront's HomeSection made the same call for the same reason.
 */

export const DOC_BLOCK_KINDS = [
  'letterhead',
  'docTitle',
  'partyBlock',
  'detailList',
  'lineTable',
  'totals',
  'vatSummary',
  'banking',
  'notes',
  'text',
  'rule',
  'spacer',
  'html',
] as const

export type DocBlockKind = (typeof DOC_BLOCK_KINDS)[number]

/**
 * Where a block sits across the page.
 *
 * `full` spans it; `left` and `right` pair up into one row. Two columns and no
 * more: a printed page is a flow, and free positioning breaks the moment an
 * order runs to forty lines and the blocks below it are pinned.
 */
export type DocBlockSpan = 'full' | 'left' | 'right'

export type DocBlockAlign = 'left' | 'center' | 'right'

/** One column of the line table, as the customer has arranged it. */
export type ColumnSpec = {
  /** A token from the document's `lines` section. The catalog decides format. */
  token: string
  /** The customer's own wording. "Unit price" becomes "Rate" if they say so. */
  heading: string
  /**
   * A second token under the first, smaller — the supplier's code beneath the
   * description. One nesting level only: this is the one place a real document
   * genuinely stacks two fields in a cell, and making it general would invite a
   * column of four.
   */
  subToken?: string
  /** Percent of the table. Blank columns share what is left over. */
  width?: number
  align?: 'left' | 'right'
}

/**
 * One labelled row of a detail list.
 *
 * The LABEL is the designer's wording, stored beside the token rather than
 * taken from the catalog. The catalog's label is written for a token PICKER
 * ("Payment terms (with unit)") and is the wrong register for a printed page,
 * where the row should read "Terms". Storing it also means renaming a row can
 * never change which field it shows.
 */
export type DetailRow = {
  token: string
  label: string
}

export type DocBlock = {
  id: string
  kind: DocBlockKind
  span?: DocBlockSpan
  align?: DocBlockAlign
  /** A heading above the block — "BILL TO", "NOTES". Empty prints none. */
  title?: string
  /** letterhead / partyBlock / detailList: which fields, in the order shown. */
  tokens?: string[]
  /** lineTable only. */
  columns?: ColumnSpec[]
  /** detailList / totals only: labelled rows, in the order shown. */
  rows?: DetailRow[]
  /** text: the words. html: raw markup, sanitised like anything else. */
  text?: string
}

export type DocumentSpec = { version: 1; blocks: DocBlock[] }

export type DocBlockDef = {
  kind: DocBlockKind
  label: string
  hint: string
  /**
   * Which documents may use it. A `banking` block on a purchase order would be
   * asking the supplier to pay us.
   */
  docTypes: readonly string[] | 'all'
  /**
   * Cannot be removed. The line table IS the document; a purchase order with
   * no items is a letterhead. Enforced by the validator, not just hidden here.
   */
  required?: boolean
  /** May appear more than once. A rule or a paragraph may; a totals box may not. */
  repeatable?: boolean
  /** Whether the inspector offers a token list for this block. */
  picksTokens?: boolean
}

export const DOC_BLOCK_CATALOG: Record<DocBlockKind, DocBlockDef> = {
  letterhead: {
    kind: 'letterhead',
    label: 'Your letterhead',
    hint: 'Logo, business name, address and contact details.',
    docTypes: 'all',
    picksTokens: true,
  },
  docTitle: {
    kind: 'docTitle',
    label: 'Document title',
    hint: 'What the paper is called, its number and date.',
    docTypes: 'all',
    required: true,
    picksTokens: true,
  },
  partyBlock: {
    kind: 'partyBlock',
    label: 'A name and address',
    hint: 'Who the document is to, or where goods must go.',
    docTypes: 'all',
    repeatable: true,
    picksTokens: true,
  },
  detailList: {
    kind: 'detailList',
    label: 'A list of details',
    hint: 'Labelled rows — due date, reference, who ordered it. Empty ones hide themselves.',
    docTypes: 'all',
    repeatable: true,
    picksTokens: true,
  },
  lineTable: {
    kind: 'lineTable',
    label: 'The items',
    hint: 'What was ordered or sold. Choose the columns, their wording and their order.',
    docTypes: 'all',
    required: true,
  },
  totals: {
    kind: 'totals',
    label: 'Totals',
    hint: 'Subtotal, VAT and the amount due.',
    docTypes: 'all',
    required: true,
    picksTokens: true,
  },
  vatSummary: {
    kind: 'vatSummary',
    label: 'VAT breakdown',
    hint: 'VAT by rate. A vendor is obliged to show it on an invoice.',
    docTypes: ['invoice'],
  },
  banking: {
    kind: 'banking',
    label: 'Banking details',
    hint: 'Where to pay. Prints nothing unless every detail is set.',
    docTypes: ['invoice'],
  },
  notes: {
    kind: 'notes',
    label: 'Notes from the document',
    hint: 'Whatever was typed on this order or invoice. Hides itself when empty.',
    docTypes: 'all',
  },
  text: {
    kind: 'text',
    label: 'Your own words',
    hint: 'Terms, a thank-you, delivery instructions — the same on every document.',
    docTypes: 'all',
    repeatable: true,
  },
  rule: {
    kind: 'rule',
    label: 'A dividing line',
    hint: 'A hairline across the page.',
    docTypes: 'all',
    repeatable: true,
  },
  spacer: {
    kind: 'spacer',
    label: 'Blank space',
    hint: 'A gap, for signing or for air.',
    docTypes: 'all',
    repeatable: true,
  },
  html: {
    kind: 'html',
    label: 'Custom HTML',
    hint: 'For something the blocks cannot express. Sanitised like any template.',
    docTypes: 'all',
    repeatable: true,
  },
}

/** The blocks a given document may use, in palette order. */
export function blockKindsFor(docType: string): DocBlockKind[] {
  return DOC_BLOCK_KINDS.filter((k) => {
    const def = DOC_BLOCK_CATALOG[k]
    return def.docTypes === 'all' || def.docTypes.includes(docType)
  })
}

export const REQUIRED_BLOCK_KINDS: DocBlockKind[] = DOC_BLOCK_KINDS.filter(
  (k) => DOC_BLOCK_CATALOG[k].required,
)

/** A roll of paper is finite and so is patience. */
export const MAX_BLOCKS = 40
export const MAX_COLUMNS = 10

/* ── ids ─────────────────────────────────────────────────────────────────── */

let idCounter = 0

/**
 * Date-free, so two blocks added in the same millisecond cannot collide.
 * A shared id would mean a shared React key AND a shared drag handle.
 */
export function newBlockId(kind: DocBlockKind): string {
  return `b-${kind}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`
}

export function newBlock(kind: DocBlockKind, over: Partial<DocBlock> = {}): DocBlock {
  return { id: newBlockId(kind), kind, ...over }
}

/* ── validation ──────────────────────────────────────────────────────────── */

export type SpecValidation = { ok: boolean; errors: string[] }

/**
 * Whether a block document is fit to print.
 *
 * Structure only. The LEGAL requirements still live in validate.ts and run
 * against the compiled markup — one set of rules for both editors, so a
 * document designed visually cannot escape what a hand-written one must carry.
 */
export function validateSpec(spec: DocumentSpec, docType: string): SpecValidation {
  const errors: string[] = []

  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.blocks)) {
    return { ok: false, errors: ['That design cannot be read.'] }
  }
  if (spec.blocks.length > MAX_BLOCKS) {
    errors.push(`A document may have at most ${MAX_BLOCKS} blocks.`)
  }

  const allowed = new Set(blockKindsFor(docType))
  const seen = new Set<DocBlockKind>()

  for (const b of spec.blocks) {
    const def = DOC_BLOCK_CATALOG[b.kind]
    if (!def) {
      errors.push('The design contains a block this version does not understand.')
      continue
    }
    if (!allowed.has(b.kind)) {
      errors.push(`"${def.label}" does not belong on this document.`)
      continue
    }
    if (!def.repeatable) {
      if (seen.has(b.kind)) errors.push(`"${def.label}" appears more than once.`)
      seen.add(b.kind)
    }
    if (b.kind === 'lineTable') {
      const cols = b.columns ?? []
      if (cols.length === 0) errors.push('The items table needs at least one column.')
      if (cols.length > MAX_COLUMNS) {
        errors.push(`The items table may have at most ${MAX_COLUMNS} columns.`)
      }
    }
  }

  for (const k of REQUIRED_BLOCK_KINDS) {
    if (allowed.has(k) && !seen.has(k)) {
      errors.push(`A document must have "${DOC_BLOCK_CATALOG[k].label}".`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/* ── reading a stored spec ───────────────────────────────────────────────── */

const KIND_SET = new Set<string>(DOC_BLOCK_KINDS)
const SPANS = new Set(['full', 'left', 'right'])
const ALIGNS = new Set(['left', 'center', 'right'])

/**
 * Labelled rows, keeping only those whose token this build still knows.
 *
 * A row naming a field that no longer exists is dropped rather than kept as a
 * label over a permanent blank — the same call cleanColumns makes, and the same
 * one saved_reports makes for a renamed field.
 */
function cleanRows(raw: unknown, doc: DocTypeDef | null): DetailRow[] | undefined {
  if (!Array.isArray(raw)) return undefined

  const known = new Set(
    doc ? [...doc.tokens, ...doc.sections.flatMap((s) => s.tokens)].map((t) => t.key) : [],
  )

  const out: DetailRow[] = []
  for (const r of raw.slice(0, 20)) {
    if (!r || typeof r !== 'object') continue
    const token = (r as { token?: unknown }).token
    if (typeof token !== 'string' || !known.has(token)) continue
    const label = (r as { label?: unknown }).label
    out.push({ token, label: typeof label === 'string' ? label.slice(0, 40) : '' })
  }
  return out
}

function cleanColumns(raw: unknown, doc: DocTypeDef | null): ColumnSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined

  const lineTokens = new Set(
    doc?.sections.find((s) => s.key === 'lines')?.tokens.map((t) => t.key) ?? [],
  )

  const out: ColumnSpec[] = []
  for (const c of raw.slice(0, MAX_COLUMNS)) {
    if (!c || typeof c !== 'object') continue
    const token = (c as { token?: unknown }).token
    // A column naming a token this build no longer has is dropped, not kept as
    // a blank column with a heading — the saved_reports rule: a spec outlives
    // the catalog that produced it, and what it loses is that field, not itself.
    if (typeof token !== 'string' || !lineTokens.has(token)) continue

    const heading = (c as { heading?: unknown }).heading
    const sub = (c as { subToken?: unknown }).subToken
    const width = (c as { width?: unknown }).width
    const align = (c as { align?: unknown }).align

    out.push({
      token,
      heading: typeof heading === 'string' ? heading.slice(0, 40) : '',
      ...(typeof sub === 'string' && lineTokens.has(sub) ? { subToken: sub } : {}),
      ...(typeof width === 'number' && width > 0 && width <= 100
        ? { width: Math.round(width) }
        : {}),
      ...(align === 'left' || align === 'right' ? { align } : {}),
    })
  }
  return out
}

/**
 * Parse a stored spec, dropping anything this build no longer recognises.
 *
 * Same doctrine as normaliseSections and parseSlip: a spec outlives the code
 * that wrote it, so an unknown block kind costs that block rather than the whole
 * document. Returns null only when the JSON itself is unreadable, so the caller
 * falls back to the shipped design.
 *
 * KEY ORDER IS PART OF THE CONTRACT. The designer decides "is this dirty?" by
 * comparing JSON strings, so every field is written in the same order whatever
 * the block is, and the object is built by assignment rather than by spreading
 * whatever came out of the database.
 */
export function parseSpec(json: string, docType: string): DocumentSpec | null {
  try {
    const raw = JSON.parse(json) as unknown
    if (!raw || typeof raw !== 'object') return null
    const blocks = (raw as { blocks?: unknown }).blocks
    if (!Array.isArray(blocks)) return null

    const doc = getDocType(docType)
    const allowed = new Set<string>(blockKindsFor(docType))
    const seenIds = new Set<string>()
    const out: DocBlock[] = []

    for (const b of blocks.slice(0, MAX_BLOCKS)) {
      if (!b || typeof b !== 'object') continue
      const kind = (b as { kind?: unknown }).kind
      if (typeof kind !== 'string' || !KIND_SET.has(kind) || !allowed.has(kind)) continue

      const rawId = (b as { id?: unknown }).id
      let id = typeof rawId === 'string' && rawId ? rawId : newBlockId(kind as DocBlockKind)
      // Duplicates are re-identified rather than dropped: two blocks sharing an
      // id would share a React key and a drag handle, so dragging one moves the
      // other. Losing the block would be worse than renaming it.
      while (seenIds.has(id)) id = `${id}-${out.length}`
      seenIds.add(id)

      const span = (b as { span?: unknown }).span
      const align = (b as { align?: unknown }).align
      const title = (b as { title?: unknown }).title
      const tokens = (b as { tokens?: unknown }).tokens
      const text = (b as { text?: unknown }).text
      const columns = cleanColumns((b as { columns?: unknown }).columns, doc)
      const rows = cleanRows((b as { rows?: unknown }).rows, doc)

      out.push({
        id,
        kind: kind as DocBlockKind,
        ...(typeof span === 'string' && SPANS.has(span) ? { span: span as DocBlockSpan } : {}),
        ...(typeof align === 'string' && ALIGNS.has(align)
          ? { align: align as DocBlockAlign }
          : {}),
        ...(typeof title === 'string' ? { title: title.slice(0, 60) } : {}),
        ...(Array.isArray(tokens)
          ? { tokens: tokens.filter((t): t is string => typeof t === 'string').slice(0, 20) }
          : {}),
        ...(columns ? { columns } : {}),
        ...(rows ? { rows } : {}),
        ...(typeof text === 'string' ? { text: text.slice(0, 4000) } : {}),
      })
    }

    return { version: 1, blocks: out }
  } catch {
    return null
  }
}

export function serialiseSpec(spec: DocumentSpec): string {
  return JSON.stringify({ version: 1, blocks: spec.blocks })
}
