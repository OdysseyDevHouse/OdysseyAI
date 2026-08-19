import { getDocType, type DocTypeDef } from './catalog'
import { BAND_KEYS, MIN_BLOCK_W, clampBlock, overlaps, type BandKey } from './geometry'

/**
 * A printed document as freely-placed BLOCKS.
 *
 * ── WHY BLOCKS ARE THE TRUTH AND MARKUP IS GENERATED ──────────────────────
 *
 * The HTML editor gives full control to someone who writes markup. This is for
 * everyone else: drag the logo where you want it, untick the discount column,
 * rename "Unit price" to "Rate".
 *
 * Keeping HTML as the stored form and parsing it back into draggable boxes is
 * where this would die — a customer hand-edits one thing, their markup stops
 * being parseable, and their document becomes undraggable. With blocks as the
 * source there is nothing to parse back.
 *
 * ── WHY FREE PLACEMENT, AND NOT A LIST OF SLOTS ───────────────────────────
 *
 * This started as an ordered list with drop-gaps between items, and a `row`
 * block that split into cells. It worked and it felt wrong: the page and each
 * cell both contributed drop targets, so two landing strips appeared under one
 * pointer and the whole thing read as buggy.
 *
 * A list-with-gaps answers "what did you drop this ON". A designer is asking
 * "where does this go". So a block now carries an x/y and snaps to its
 * neighbours' edges and centres — the same call FloorCanvas.tsx made when it
 * replaced a dnd-kit floor planner, for the same reason, documented there.
 *
 * ── BANDS ARE THE ONE CONSTRAINT ──────────────────────────────────────────
 *
 * A room does not grow. A line table does — three items or forty — so absolute
 * positions everywhere would print a long order's items on top of the totals.
 * The page is therefore three bands: place freely WITHIN one, and the body band
 * grows and pushes the footer down. Invisible unless dragging, so it reads as
 * one page rather than three boxes.
 *
 * ── IT COMPILES TO THE EXISTING RENDERER ──────────────────────────────────
 *
 * compile.ts turns a spec into the same `{token}` markup render.ts already
 * consumes. catalog.ts stays the security boundary, permission-gated tokens
 * still degrade silently, and there is NO second renderer to disagree with the
 * printed page.
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
   * genuinely stacks two fields in a cell.
   */
  subToken?: string
  /** Percent of the table. Blank columns share what is left over. */
  width?: number
  align?: 'left' | 'right'
}

/**
 * One labelled row of a detail list.
 *
 * The LABEL is the designer's wording, stored beside the token rather than taken
 * from the catalog — whose label is written for a token PICKER ("Payment terms
 * (with unit)") and is the wrong register for a printed page. Storing it also
 * means renaming a row can never change which field it shows.
 */
export type DetailRow = {
  token: string
  label: string
}

export type DocBlock = {
  id: string
  kind: DocBlockKind
  /** Which part of the page. The body band holds the items and nothing else. */
  band: BandKey
  /** Percent of the page width. */
  x: number
  /** Percent down the band. Not clamped at the bottom — the band grows. */
  y: number
  /** Percent of the page width. Height is content, so it is never stored. */
  w: number
  /** How the block's own text lines up inside its box. */
  align?: DocBlockAlign
  /** A heading above the block — "BILL TO", "NOTES". Empty prints none. */
  title?: string
  /** letterhead / partyBlock: which fields, in the order shown. */
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
   * Cannot be removed. The line table IS the document; a purchase order with no
   * items is a letterhead. Enforced by the validator, not just hidden.
   */
  required?: boolean
  /** May appear more than once. A paragraph may; a totals box may not. */
  repeatable?: boolean
  /** Whether the inspector offers a token list for this block. */
  picksTokens?: boolean
  /**
   * Pinned to one band.
   *
   * Only the line table: it is what the body band IS, and a shop that dragged it
   * into the footer would have a document whose items print after its totals.
   */
  band?: BandKey
  /** A sensible width, in percent, for a freshly added block. */
  defaultW?: number
}

export const DOC_BLOCK_CATALOG: Record<DocBlockKind, DocBlockDef> = {
  letterhead: {
    kind: 'letterhead',
    label: 'Your letterhead',
    hint: 'Logo, business name, address and contact details.',
    docTypes: 'all',
    picksTokens: true,
    defaultW: 55,
  },
  docTitle: {
    kind: 'docTitle',
    label: 'Document title',
    hint: 'What the paper is called, its number and date.',
    docTypes: 'all',
    required: true,
    picksTokens: true,
    defaultW: 40,
  },
  partyBlock: {
    kind: 'partyBlock',
    label: 'A name and address',
    hint: 'Who the document is to, or where goods must go.',
    docTypes: 'all',
    repeatable: true,
    picksTokens: true,
    defaultW: 45,
  },
  detailList: {
    kind: 'detailList',
    label: 'A list of details',
    hint: 'Labelled rows — due date, reference, who ordered it. Empty ones hide themselves.',
    docTypes: 'all',
    repeatable: true,
    picksTokens: true,
    defaultW: 45,
  },
  lineTable: {
    kind: 'lineTable',
    label: 'The items',
    hint: 'What was ordered or sold. Choose the columns, their wording and their order.',
    docTypes: 'all',
    required: true,
    // The body band, always. See the note on `band`.
    band: 'body',
    defaultW: 100,
  },
  totals: {
    kind: 'totals',
    label: 'Totals',
    hint: 'Subtotal, VAT and the amount due.',
    docTypes: 'all',
    required: true,
    picksTokens: true,
    defaultW: 40,
  },
  vatSummary: {
    kind: 'vatSummary',
    label: 'VAT breakdown',
    hint: 'VAT by rate. A vendor is obliged to show it on an invoice.',
    docTypes: ['invoice'],
    defaultW: 55,
  },
  banking: {
    kind: 'banking',
    label: 'Banking details',
    hint: 'Where to pay. Prints nothing unless every detail is set.',
    docTypes: ['invoice'],
    defaultW: 45,
  },
  notes: {
    kind: 'notes',
    label: 'Notes from the document',
    hint: 'Whatever was typed on this order or invoice. Hides itself when empty.',
    docTypes: 'all',
    defaultW: 55,
  },
  text: {
    kind: 'text',
    label: 'Your own words',
    hint: 'Terms, a thank-you, delivery instructions — the same on every document.',
    docTypes: 'all',
    repeatable: true,
    defaultW: 100,
  },
  rule: {
    kind: 'rule',
    label: 'A dividing line',
    hint: 'A hairline across the page.',
    docTypes: 'all',
    repeatable: true,
    defaultW: 100,
  },
  spacer: {
    kind: 'spacer',
    label: 'Blank space',
    hint: 'A gap, for signing or for air.',
    docTypes: 'all',
    repeatable: true,
    defaultW: 100,
  },
  html: {
    kind: 'html',
    label: 'Custom HTML',
    hint: 'For something the blocks cannot express. Sanitised like any template.',
    docTypes: 'all',
    repeatable: true,
    defaultW: 100,
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

/** A page is finite and so is patience. */
export const MAX_BLOCKS = 40
export const MAX_COLUMNS = 10

/* ── ids and new blocks ──────────────────────────────────────────────────── */

let idCounter = 0

/**
 * Date-free, so two blocks added in the same millisecond cannot collide. A
 * shared id would mean a shared React key AND a shared drag handle.
 */
export function newBlockId(kind: DocBlockKind): string {
  return `b-${kind}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * A new block, placed somewhere sensible.
 *
 * `y` defaults below everything already in that band rather than at the top: a
 * block added at 0,0 lands on top of the letterhead, which is an overlap the
 * validator then refuses and the designer has to fix before they have done
 * anything. Added-below is the boring, correct default.
 */
export function newBlock(
  kind: DocBlockKind,
  spec: DocumentSpec | null = null,
  over: Partial<DocBlock> = {},
): DocBlock {
  const def = DOC_BLOCK_CATALOG[kind]
  const band = def.band ?? over.band ?? 'header'

  const inBand = (spec?.blocks ?? []).filter((b) => b.band === band)
  const below = inBand.reduce((max, b) => Math.max(max, b.y), 0)

  return {
    ...over,
    id: newBlockId(kind),
    kind,
    // AFTER the spread, so a pinned block cannot be talked out of its band by a
    // caller passing one — the line table belongs with the items whatever is asked.
    band,
    x: over.x ?? 0,
    // A step below the lowest thing there, in band percent.
    y: over.y ?? (inBand.length === 0 ? 0 : Math.min(below + 12, 88)),
    w: over.w ?? def.defaultW ?? 100,
  }
}

/* ── validation ──────────────────────────────────────────────────────────── */

export type SpecValidation = { ok: boolean; errors: string[] }

/**
 * Whether a design is fit to print.
 *
 * Structure and geometry only. The LEGAL requirements still live in validate.ts
 * and run against the compiled markup — one set of rules for both editors, so a
 * document designed by dragging must carry everything a typed one does.
 */
export function validateSpec(
  spec: DocumentSpec,
  docType: string,
  /** Measured heights by block id, where the canvas knows them. */
  heights: Record<string, number> = {},
): SpecValidation {
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
    if (def.band && b.band !== def.band) {
      errors.push(`"${def.label}" belongs with the items and cannot be moved.`)
    }
    if (b.w < MIN_BLOCK_W) {
      errors.push(`"${def.label}" is too narrow to read.`)
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

  /*
   * OVERLAPS.
   *
   * Free placement makes two blocks on top of each other easy to do by accident,
   * and a document where the totals print over the notes is one nobody can read.
   * Only checked where the canvas has told us the heights: without them any
   * answer would be a guess, and refusing to save on a guess is worse than not
   * checking.
   */
  const measured = spec.blocks.filter((b) => heights[b.id] !== undefined)
  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      const a = measured[i]
      const b = measured[j]
      if (a.band !== b.band) continue
      const ra = { x: a.x, y: a.y, w: a.w, h: heights[a.id] }
      const rb = { x: b.x, y: b.y, w: b.w, h: heights[b.id] }
      if (overlaps(ra, rb)) {
        errors.push(
          `"${DOC_BLOCK_CATALOG[a.kind].label}" and "${DOC_BLOCK_CATALOG[b.kind].label}" overlap.`,
        )
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/* ── reading a stored spec ───────────────────────────────────────────────── */

const KIND_SET = new Set<string>(DOC_BLOCK_KINDS)
const ALIGNS = new Set(['left', 'center', 'right'])
const BANDS = new Set<string>(BAND_KEYS)

/**
 * Labelled rows, keeping only those whose token this build still knows.
 *
 * A row naming a field that no longer exists is dropped rather than kept as a
 * label over a permanent blank — the same call cleanColumns makes.
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
    // A column naming a token this build no longer has is dropped, not kept as a
    // blank column with a heading — the saved_reports rule: a spec outlives the
    // catalog that produced it, and what it loses is that field, not itself.
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

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Parse a stored spec, dropping anything this build no longer recognises.
 *
 * Same doctrine as normaliseSections and parseSlip: a spec outlives the code
 * that wrote it, so an unknown block kind costs that block rather than the whole
 * document. Returns null only when the JSON itself is unreadable, so the caller
 * falls back to the shipped design.
 *
 * That is also how a design saved under the OLD list-and-cells model reads: its
 * `row` blocks are a kind this build does not have, so they are dropped, and
 * anything that was inside a cell was nested where this parser does not look.
 * Nothing had been saved when the model changed, so there is nothing to migrate
 * — and a spec that arrives empty falls back to the shipped design rather than
 * printing a blank page.
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

      const def = DOC_BLOCK_CATALOG[kind as DocBlockKind]

      const rawId = (b as { id?: unknown }).id
      let id = typeof rawId === 'string' && rawId ? rawId : newBlockId(kind as DocBlockKind)
      // Duplicates are re-identified rather than dropped: two blocks sharing an
      // id would share a React key and a drag handle, so dragging one moves the
      // other. Losing the block would be worse than renaming it.
      while (seenIds.has(id)) id = `${id}-${out.length}`
      seenIds.add(id)

      const rawBand = (b as { band?: unknown }).band
      // A pinned block ignores whatever the stored band said, so a hand-edited
      // spec cannot put the items table below the totals.
      const band =
        def.band ??
        (typeof rawBand === 'string' && BANDS.has(rawBand) ? (rawBand as BandKey) : 'header')

      const geo = clampBlock({
        x: num((b as { x?: unknown }).x, 0),
        y: num((b as { y?: unknown }).y, 0),
        w: num((b as { w?: unknown }).w, def.defaultW ?? 100),
      })

      const align = (b as { align?: unknown }).align
      const title = (b as { title?: unknown }).title
      const tokens = (b as { tokens?: unknown }).tokens
      const text = (b as { text?: unknown }).text
      const columns = cleanColumns((b as { columns?: unknown }).columns, doc)
      const rows = cleanRows((b as { rows?: unknown }).rows, doc)

      out.push({
        id,
        kind: kind as DocBlockKind,
        band,
        x: geo.x,
        y: geo.y,
        w: geo.w,
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

/* ── editing helpers ─────────────────────────────────────────────────────── */

/** Replace one block. A flat list again, so this is a map. */
export function patchBlock(
  spec: DocumentSpec,
  id: string,
  changes: Partial<DocBlock>,
): DocumentSpec {
  return {
    version: 1,
    blocks: spec.blocks.map((b) => (b.id === id ? { ...b, ...changes } : b)),
  }
}

export function removeBlock(spec: DocumentSpec, id: string): DocumentSpec {
  return { version: 1, blocks: spec.blocks.filter((b) => b.id !== id) }
}

export function findBlock(spec: DocumentSpec, id: string): DocBlock | null {
  return spec.blocks.find((b) => b.id === id) ?? null
}

/** The blocks of one band, in the order they were added. */
export function bandBlocks(spec: DocumentSpec, band: BandKey): DocBlock[] {
  return spec.blocks.filter((b) => b.band === band)
}

export { BAND_KEYS, BAND_INFO, type BandKey } from './geometry'
