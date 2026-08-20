import { getDocType, type DocTypeDef } from './catalog'
import { isConditionRule, type ConditionRule } from './conditions'
import { isQrTarget, cleanCustomUrl, type QrTarget } from './qrTarget'
import { isBarcodeSource, cleanBarcodeText, type BarcodeSource } from './barcodeSource'
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
  'logo',
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
  'signature',
  'image',
  'qr',
  'barcode',
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
  /**
   * lineTable only: which repeating section to loop over.
   *
   * Defaults to the document's items. A statement has a second one — the age
   * ladder, whose rung headings change with the account cycle — and it is a
   * table like any other, so it is the same block pointing somewhere else
   * rather than a block kind of its own.
   */
  section?: string
  /** detailList / totals only: labelled rows, in the order shown. */
  rows?: DetailRow[]
  /** text: the words. html: raw markup, sanitised like anything else. */
  text?: string
  /** qr only: what the code points at. See lib/stationery/qrTarget. */
  qrTarget?: QrTarget
  /** qr only: the typed address, for the `custom` target and nothing else. */
  qrUrl?: string
  /** qr only: words under the square — "Scan to rate us". */
  qrCaption?: string
  /** qr only: how big to print it, in points. */
  qrSize?: number
  /** barcode only: which value it carries. See lib/stationery/barcodeSource. */
  barcodeSource?: BarcodeSource
  /** barcode only: the typed value, for the `custom` source and nothing else. */
  barcodeText?: string
  /** barcode only: how tall the bars print, in points. */
  barcodeHeight?: number
  /**
   * image only: which of the shop's pictures, by id.
   *
   * The id and not the disk name: the name is an implementation detail of
   * lib/uploads and a design should not carry one. A design naming a picture
   * that has since been deleted prints nothing, exactly as a missing FILE does.
   */
  imageId?: number
  /**
   * image only: how tall to print it, in points. Width follows, so the picture
   * keeps its shape — the same answer the logo needed.
   */
  imageHeight?: number
  /**
   * Show this block only when the document answers a named question — see
   * lib/stationery/conditions.
   *
   * Absent means always, which is what every design saved before this existed
   * means and what the overwhelming majority of blocks want.
   */
  showWhen?: ConditionRule
  /**
   * logo only: how tall to print it, in points.
   *
   * The one thing a logo needs that a width cannot express. `w` is the box the
   * logo sits in and decides where it can be dragged to; this is how large the
   * image itself is drawn inside it, and a shop with a tall crest wants a
   * different answer from one with a wide wordmark.
   */
  logoHeight?: number
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
   * Which documents cannot do without it. `true` means every document that may
   * use the block at all.
   *
   * ── WHY IT IS A LIST AND NOT A FLAG ─────────────────────────────────────
   *
   * It was a flag, and the flag said a totals block is required — which is true
   * of an invoice and of a purchase order and NOT of a delivery note, whose
   * whole point is that it carries no money. The first delivery note refused to
   * validate for want of a totals box it must never have.
   *
   * "Required" is a fact about a DOCUMENT, not about a block.
   */
  required?: true | readonly string[]
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
  /*
   * THE LOGO IS ITS OWN BLOCK.
   *
   * It is also still a token the letterhead can include, and both are wanted.
   * Inside the letterhead it sits above the business name and moves with it,
   * which is what most documents want and what the shipped default does.
   *
   * As a block it can be dragged anywhere and sized on its own — the thing the
   * user asked for first, in those words: "if a customer wants to move his logo
   * he can simply drag it". A token inside another block cannot be dragged,
   * because there is nothing to take hold of.
   */
  logo: {
    kind: 'logo',
    label: 'Your logo',
    hint: 'The uploaded logo on its own, to put wherever you like. Prints nothing when none is set.',
    docTypes: 'all',
    defaultW: 25,
  },
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
    // A document that does not say what it is cannot be filed by whoever gets it.
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
    // Every document that has one at all: a purchase order with no items is a
    // letterhead, and a delivery note with none is an empty van.
    required: true,
    /*
     * MORE THAN ONE IS ALLOWED, and no longer pinned to the items band.
     *
     * Both were right when a document had exactly one table. A statement has
     * two: the movements, and the age ladder below them — which is the same
     * block walking a different section, not a block kind of its own.
     *
     * The validator still insists on at least one, and a design with two in the
     * BODY band would simply stack them, which is what a designer asking for
     * that would want.
     */
    repeatable: true,
    defaultW: 100,
  },
  totals: {
    kind: 'totals',
    label: 'Totals',
    hint: 'Subtotal, VAT and the amount due.',
    docTypes: 'all',
    /*
     * NOT on a delivery note, which carries no money at all — see catalog.ts for
     * why that is a boundary rather than a preference. Naming the documents is
     * what lets one block be indispensable on an invoice and forbidden on the
     * paper that travels with the goods.
     */
    required: ['purchase_order', 'invoice'],
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
  /*
   * ── WHY THIS IS A BLOCK AND NOT TWO TOKENS ──────────────────────────────
   *
   * It was tokens first: sign.receivedBy and sign.date, always empty, so a
   * detail list would draw a label with a blank beside it. They vanished. The
   * renderer treats a whitespace-only value as absent — deliberately, so a field
   * a shop never filled in reads as "not applicable" rather than as a caption
   * over nothing — and the hide rule then removed the row.
   *
   * Feeding it a non-breaking space to sneak past that check was the wrong
   * instinct: it fights a rule that is right, with a character nobody reading
   * the file would understand.
   *
   * A blank line to sign on is not a VALUE that happens to be empty. It is a
   * rule drawn on the page, which is a thing a block does and no token can say.
   */
  signature: {
    kind: 'signature',
    label: 'A line to sign on',
    hint: 'A labelled rule — "Received by", "Date". Filled in by hand, so it prints empty on purpose.',
    docTypes: 'all',
    repeatable: true,
    defaultW: 45,
  },
  barcode: {
    kind: 'barcode',
    label: 'A barcode',
    hint: 'CODE128 — the document number, so a counter can scan it back in.',
    /* Every document, slip included: a thermal head draws a barcode itself,
       exactly as it does a QR. See EscPos.barcode. */
    docTypes: 'all',
    defaultW: 40,
    repeatable: true,
  },
  qr: {
    kind: 'qr',
    label: 'A QR code',
    hint: 'A square customers scan — your store, a review page, or this document online.',
    /*
     * EVERY document, including the slip. Unlike a picture, a QR is something a
     * thermal head does WELL: GS ( k hands the payload to the firmware, which
     * lays the modules down at its own dot pitch. See EscPos.qr.
     */
    docTypes: 'all',
    defaultW: 22,
    repeatable: true,
  },
  image: {
    kind: 'image',
    label: 'A picture',
    hint: 'One of your own pictures — equipment you fit, an accreditation, a promotion.',
    /*
     * A4 ONLY, and stated as a list rather than 'all'.
     *
     * A thermal head has no raster this design uses: GS v 0 exists, but at
     * 203dpi it is slow, coarse and paper-hungry, and a shop wanting equipment
     * photos wants them on a quote rather than on a till slip. The block is
     * ABSENT from the slip palette rather than shown and refused — a line that
     * cannot print is not a line.
     */
    docTypes: ['purchase_order', 'invoice', 'delivery_note', 'statement'],
    defaultW: 30,
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

/** The blocks a given document cannot do without. */
export function requiredBlockKinds(docType: string): DocBlockKind[] {
  return DOC_BLOCK_KINDS.filter((k) => {
    const req = DOC_BLOCK_CATALOG[k].required
    if (!req) return false
    if (req === true) return true
    return req.includes(docType)
  })
}

/** A page is finite and so is patience. */
/* A picture, in points. Wider bounds than the logo: a letterhead crest is
   small by nature, while an equipment photo on a quote is meant to be looked
   at. */
/* A QR, in points. Below about 50pt a phone struggles at arm's length on
   thermal paper; above 200 it is a poster. */
/* Bar height, in points. Short bars scan badly at an angle; tall ones waste
   paper. 40 is the usual retail compromise. */
export const MIN_BARCODE_PT = 16
export const MAX_BARCODE_PT = 120
export const DEFAULT_BARCODE_PT = 40

export const MIN_QR_PT = 40
export const MAX_QR_PT = 200
export const DEFAULT_QR_PT = 90

export const MIN_IMAGE_H = 12
export const MAX_IMAGE_H = 320
export const DEFAULT_IMAGE_H = 90

export const MAX_BLOCKS = 40
export const MAX_COLUMNS = 10

/**
 * How tall a logo may be printed, in points.
 *
 * The floor is a logo still recognisable at arm's length; the ceiling is one
 * that has not taken over the page. A shop wanting more than a third of an A4
 * height in letterhead is designing something other than a purchase order.
 */
export const MIN_LOGO_HEIGHT = 16
export const MAX_LOGO_HEIGHT = 240
export const DEFAULT_LOGO_HEIGHT = 56

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
 *
 * ── BELOW THEIR BOTTOMS, WHICH NEEDS HEIGHTS ──────────────────────────────
 *
 * The first version stepped below the lowest `y` in the band, which is not the
 * same thing: a block at y 56 that is 40 tall ends at 96, so the "step below"
 * landed at 68 — straight on top of it. Adding a logo did exactly that, visibly.
 *
 * A block's height is measured, never stored, so this cannot work it out and the
 * caller passes what the canvas measured. With no heights it falls back to the
 * old behaviour, which is a guess but a bounded one; the designer drags it
 * anyway, and the validator still refuses a real overlap.
 */
export function newBlock(
  kind: DocBlockKind,
  spec: DocumentSpec | null = null,
  over: Partial<DocBlock> = {},
  /** Measured heights by block id, in band percent. From the canvas. */
  heights: Record<string, number> = {},
): DocBlock {
  const def = DOC_BLOCK_CATALOG[kind]
  const band = def.band ?? over.band ?? 'header'

  const inBand = (spec?.blocks ?? []).filter((b) => b.band === band)
  const below = inBand.reduce(
    // The BOTTOM of each block where its height is known, its top otherwise.
    (max, b) => Math.max(max, b.y + (heights[b.id] ?? 0)),
    0,
  )

  return {
    ...over,
    id: newBlockId(kind),
    kind,
    // AFTER the spread, so a pinned block cannot be talked out of its band by a
    // caller passing one — the line table belongs with the items whatever is asked.
    band,
    x: over.x ?? 0,
    /*
     * A small gap below the lowest bottom.
     *
     * No ceiling on it: a band is as tall as its contents, so pushing a new
     * block back up into the crowd to keep the number under 88 would put it on
     * top of something to save space that costs nothing.
     */
    y: over.y ?? (inBand.length === 0 ? 0 : below + 4),
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
  const present = new Set<DocBlockKind>()

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
    /*
     * TWO DIFFERENT QUESTIONS, and they shared one set until a line table was
     * allowed to repeat: "have I seen this kind before" decides a duplicate,
     * "is this kind present at all" decides a missing requirement. A repeatable
     * block was never recorded, so the required check stopped seeing it and a
     * statement with two tables reported having none.
     */
    present.add(b.kind)
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

  for (const k of requiredBlockKinds(docType)) {
    if (allowed.has(k) && !present.has(k)) {
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
/**
 * A block's chosen tokens, keeping only those THIS document has.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `rows` and `columns` were cleaned against the catalog from the start and
 * `tokens` was not — it was checked for being strings and nothing more. That
 * gap is invisible while a design stays on the document it was made for, and it
 * surfaced the moment designs became copyable: a delivery note copied onto an
 * invoice arrived carrying `{deliverTo}` and `{doc.fulfilment}`, which an
 * invoice has no idea about. The validator called them unknown tokens and
 * refused to save the copy.
 *
 * They would have rendered blank rather than leaked — `substitute` resolves an
 * unknown token to nothing — but a letterhead with two invisible lines in it is
 * a design nobody can account for, and a save that fails on tokens the shop
 * never typed is worse.
 *
 * The same rule the other two follow: what this document does not know is
 * dropped on read, so a design survives a field being renamed rather than
 * failing to open.
 */
function cleanTokens(raw: unknown[], doc: DocTypeDef | null): string[] {
  const strings = raw.filter((t): t is string => typeof t === 'string').slice(0, 20)
  if (!doc) return strings

  const known = new Set([...doc.tokens, ...doc.sections.flatMap((s) => s.tokens)].map((t) => t.key))
  return strings.filter((t) => known.has(t))
}

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

function cleanColumns(
  raw: unknown,
  doc: DocTypeDef | null,
  /** Which repeating section the columns belong to. See DocBlock.section. */
  section = 'lines',
): ColumnSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined

  /*
   * The columns of a table may only name tokens from the section that table
   * walks. It was hard-coded to the items; a statement has a second section —
   * the age ladder — and its columns name bucket tokens, which the items list
   * does not contain and would therefore have stripped on read.
   */
  const lineTokens = new Set(
    doc?.sections.find((s) => s.key === section)?.tokens.map((t) => t.key) ?? [],
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
      const rawH = (b as { logoHeight?: unknown }).logoHeight
      const logoHeight =
        typeof rawH === 'number' && Number.isFinite(rawH)
          ? Math.min(Math.max(Math.round(rawH), MIN_LOGO_HEIGHT), MAX_LOGO_HEIGHT)
          : undefined

      /*
       * Which section a table loops over, kept only when the document HAS one by
       * that name — a stored design naming a section this build no longer has
       * would otherwise loop over nothing and print an empty table with headings.
       */
      const rawSection = (b as { section?: unknown }).section
      const section =
        typeof rawSection === 'string' && doc?.sections.some((x) => x.key === rawSection)
          ? rawSection
          : undefined

      /*
       * A condition is kept only when this build still HAS that rule. A design
       * naming one that has since been retired loses the condition and keeps
       * the block — the words a shop wrote are the part worth saving, and a
       * paragraph that silently stopped printing is the harder bug to find.
       */
      /*
       * A picture id is kept whatever it points at. Whether the picture still
       * EXISTS is a question for the renderer — this parse has no database, and
       * dropping the id here would quietly empty a block for a shop whose site
       * simply had not finished loading.
       */
      /*
       * The target is kept only when this build still HAS it, and the typed URL
       * only when it is a real https address — cleaned by the same function the
       * designer and the renderer use, so a stored design cannot carry an
       * address the other two would have refused.
       */
      const rawSource = (b as { barcodeSource?: unknown }).barcodeSource
      const barcodeSource = isBarcodeSource(rawSource) ? rawSource : undefined
      const rawBcText = (b as { barcodeText?: unknown }).barcodeText
      const barcodeText =
        typeof rawBcText === 'string' ? (cleanBarcodeText(rawBcText) ?? undefined) : undefined
      const rawBcH = (b as { barcodeHeight?: unknown }).barcodeHeight
      const barcodeHeight =
        typeof rawBcH === 'number' && Number.isFinite(rawBcH)
          ? Math.min(Math.max(Math.round(rawBcH), MIN_BARCODE_PT), MAX_BARCODE_PT)
          : undefined

      const rawTarget = (b as { qrTarget?: unknown }).qrTarget
      const qrTarget = isQrTarget(rawTarget) ? rawTarget : undefined
      const rawQrUrl = (b as { qrUrl?: unknown }).qrUrl
      const qrUrl =
        typeof rawQrUrl === 'string' ? (cleanCustomUrl(rawQrUrl) ?? undefined) : undefined
      const rawCaption = (b as { qrCaption?: unknown }).qrCaption
      const qrCaption = typeof rawCaption === 'string' ? rawCaption.slice(0, 60) : undefined
      const rawQrSize = (b as { qrSize?: unknown }).qrSize
      const qrSize =
        typeof rawQrSize === 'number' && Number.isFinite(rawQrSize)
          ? Math.min(Math.max(Math.round(rawQrSize), MIN_QR_PT), MAX_QR_PT)
          : undefined

      const rawImageId = (b as { imageId?: unknown }).imageId
      const imageId =
        typeof rawImageId === 'number' && Number.isInteger(rawImageId) && rawImageId > 0
          ? rawImageId
          : undefined
      const rawImageH = (b as { imageHeight?: unknown }).imageHeight
      const imageHeight =
        typeof rawImageH === 'number' && Number.isFinite(rawImageH)
          ? Math.min(Math.max(Math.round(rawImageH), MIN_IMAGE_H), MAX_IMAGE_H)
          : undefined

      const rawWhen = (b as { showWhen?: unknown }).showWhen
      const showWhen = isConditionRule(rawWhen) && rawWhen !== 'always' ? rawWhen : undefined

      const columns = cleanColumns((b as { columns?: unknown }).columns, doc, section)
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
        ...(Array.isArray(tokens) ? { tokens: cleanTokens(tokens, doc) } : {}),
        ...(columns ? { columns } : {}),
        ...(section ? { section } : {}),
        ...(rows ? { rows } : {}),
        ...(typeof text === 'string' ? { text: text.slice(0, 4000) } : {}),
        ...(barcodeSource ? { barcodeSource } : {}),
        ...(barcodeText ? { barcodeText } : {}),
        ...(barcodeHeight !== undefined ? { barcodeHeight } : {}),
        ...(qrTarget ? { qrTarget } : {}),
        ...(qrUrl ? { qrUrl } : {}),
        ...(qrCaption ? { qrCaption } : {}),
        ...(qrSize !== undefined ? { qrSize } : {}),
        ...(imageId !== undefined ? { imageId } : {}),
        ...(imageHeight !== undefined ? { imageHeight } : {}),
        ...(showWhen ? { showWhen } : {}),
        ...(logoHeight !== undefined ? { logoHeight } : {}),
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
