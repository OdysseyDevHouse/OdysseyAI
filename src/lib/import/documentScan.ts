import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '@/lib/siteDb'
import { supplierQuery } from '@/lib/site/customerDb'
import { norm } from './lookups'

/**
 * Reading a supplier's PDF into document lines.
 *
 * ── WHY THIS SITS BESIDE documentLines.ts AND NOT INSIDE IT ──────────────
 *
 * Same destination, different journey. That module reads a file whose columns
 * are LABELLED — a header row says which column is the quantity, and the work
 * is mapping names to fields. A supplier's invoice has no header row it can be
 * trusted on: the figures sit in a table drawn with lines, or in three columns
 * of a layout that changes when they change accounting package. Extraction is
 * a different problem from mapping, so it is a different file.
 *
 * What is deliberately IDENTICAL is where it stops. Both produce a list of
 * lines and a list of things that did not resolve, and neither writes anything.
 * The screen fills its grid, the buyer checks it, and they press the same Post
 * button they always press. Read the header of documentLines.ts — that whole
 * argument applies here unchanged, and more strongly: a model's reading of a
 * scanned invoice is exactly the kind of input that must never post itself.
 *
 * ── THE MODEL NEVER NAMES A PRODUCT ──────────────────────────────────────
 *
 * This is the security and correctness boundary, and it is the same one
 * askReport.ts draws. The model is asked ONLY for what the PDF says: the text
 * of a code, a description, a quantity, a price. It is never shown the
 * catalogue and never returns a product id. Resolution happens afterwards, in
 * SQL, against the same columns documentLines resolves against — plus the
 * supplier's own code, which is the identifier an invoice actually quotes.
 *
 * So a hallucinated product code cannot become a line. It becomes an unmatched
 * row the buyer is shown and asked about. The failure mode is "this needs a
 * human", never "the wrong stock moved".
 *
 * ── WHY MATCHES ARE SCORED RATHER THAN JUST FOUND ────────────────────────
 *
 * A supplier code hit is near-certain; a description that merely looks similar
 * is a guess worth showing but not worth trusting. Collapsing both into
 * "matched" would put a guess into the grid wearing the same face as a
 * certainty, and the buyer posts what looks settled. So each line carries HOW
 * it was matched, and the screen shows the weak ones differently.
 */

const MODEL = 'claude-opus-5'

/** Bigger than any real delivery note; a guard against a runaway response. */
const MAX_LINES = 400

/** 32MB is the API's request ceiling; stop well short with a clear message. */
const MAX_PDF_BYTES = 20 * 1024 * 1024

export class ScanNotConfiguredError extends Error {}

let cachedClient: Anthropic | null = null

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ScanNotConfiguredError(
      'Reading documents is not set up. An administrator needs to add an Anthropic API key.',
    )
  }
  cachedClient ??= new Anthropic()
  return cachedClient
}

export function isScanConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/* ── what comes back ───────────────────────────────────────────────────────── */

/** How a line found its product. Drives how much the screen trusts it. */
export type MatchKind =
  | 'supplier_code'
  | 'code'
  | 'barcode'
  | 'description'
  | 'none'

export type ScannedLine = {
  /** Position on the supplier's document, for talking about a row out loud. */
  line: number
  /** Exactly what the PDF called it — kept whatever happens to the match. */
  reference: string
  /** The PDF's own wording, shown beside our description when they differ. */
  scannedDescription: string
  qty: number
  unitCostExcl: number | null
  discountPct: number | null
  matchKind: MatchKind
  /** Null when nothing resolved — the line still comes back, to be fixed. */
  productId: number | null
  code: string | null
  description: string | null
  productType: string | null
  /**
   * Their pack multiplied out, when product_suppliers knows the pack size and
   * the invoice billed cases. Null when there was nothing to convert.
   */
  packNote: string | null
}

/** What the PDF said about the document as a whole. */
export type ScannedHeader = {
  supplierName: string | null
  /** Their invoice or delivery-note number, for the GRV's own field. */
  documentNumber: string | null
  /** ISO, or null when the date could not be read unambiguously. */
  documentDate: string | null
  /** Their stated total including VAT — feeds the tie-out the GRV already has. */
  totalIncl: number | null
  /** Which of our supplier records this looks like. Never guessed loosely. */
  supplierId: number | null
}

export type ScanResult =
  | {
      ok: true
      header: ScannedHeader
      lines: ScannedLine[]
      /** How many resolved to a product with no human help needed. */
      matched: number
      /** Lines the buyer must resolve before posting. */
      unmatched: number
    }
  | { ok: false; error: string }

/* ── the schema the model must emit ────────────────────────────────────────── */

/**
 * Deliberately flat, and deliberately all-strings for the numbers.
 *
 * Money on an invoice arrives as "1 234,56" or "(12.00)" or "R 45.00", and a
 * numeric JSON field forces the model to silently decide what those mean. A
 * string field asks it only to copy what is printed, and parseAmount below —
 * ordinary, testable code — decides. Every extraction bug then has one place to
 * be fixed rather than being a prompt-tuning exercise.
 */
const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplierName: {
      type: ['string', 'null'],
      description: 'The supplier/vendor issuing this document, as printed.',
    },
    documentNumber: {
      type: ['string', 'null'],
      description: 'Their invoice or delivery note number.',
    },
    documentDate: {
      type: ['string', 'null'],
      description: 'The document date as YYYY-MM-DD. Null if ambiguous.',
    },
    totalIncl: {
      type: ['string', 'null'],
      description: 'The document total including tax, exactly as printed.',
    },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reference: {
            type: 'string',
            description:
              "The supplier's product/stock code for this line, as printed. Empty string if the line shows no code.",
          },
          description: {
            type: 'string',
            description: 'The line description as printed.',
          },
          qty: {
            type: 'string',
            description: 'The quantity as printed.',
          },
          unitCost: {
            type: ['string', 'null'],
            description:
              'The unit price BEFORE tax, as printed. Null if the document shows no unit price.',
          },
          discountPct: {
            type: ['string', 'null'],
            description: 'A per-line discount percentage, as printed. Null if none.',
          },
        },
        required: ['reference', 'description', 'qty', 'unitCost', 'discountPct'],
      },
    },
  },
  required: ['supplierName', 'documentNumber', 'documentDate', 'totalIncl', 'lines'],
} as const

const SYSTEM = `You read supplier documents for a retail back office: purchase invoices, delivery notes, and supplier quotes. You transcribe what is printed. You do not calculate, infer, or tidy up.

RULES:

Transcribe, never compute. Copy each figure exactly as it appears — including its thousands separators, decimal comma or point, and any currency symbol or brackets. Never add up a column, never derive a unit price by dividing a line total, and never correct a document whose lines do not sum to its total. Somebody downstream needs to see that discrepancy.

Goods lines only. A line is a product being supplied. Skip delivery charges, freight, fuel levies, pallet deposits, tax subtotals, running balances, "brought forward" lines, and any footer text. Those are handled elsewhere and a charge transcribed as a product becomes a stock movement that never happened.

Unit price EXCLUDING tax. If the document prints tax-inclusive unit prices and shows no exclusive figure, return null for unitCost rather than dividing it out. A null means "not stated"; a wrong number means a wrong cost on the shelf.

The code is theirs, not ours. reference is the supplier's own stock code as printed on the line. If a line shows several codes, prefer the one in a column headed as a code, part number, SKU, or similar. If the line shows no code at all, return an empty string — do not put the description there, and do not invent one.

Quantity is what was supplied. Where a document shows both an ordered and a delivered/supplied quantity, take the delivered one. Where it shows cases and units, take the figure the unit price is priced against.

Multi-page documents continue. Lines run across page breaks; a repeated column header mid-document is a new page, not a new table.

If the document is not a supplier invoice, delivery note, or quote — or you cannot read it — return an empty lines array rather than guessing at its contents.`

/* ── parsing what the model copied ─────────────────────────────────────────── */

/**
 * A printed money or quantity figure, as a number.
 *
 * Handles the shapes a South African supplier document actually uses: a space
 * or comma as the thousands separator, a comma or point as the decimal, a
 * currency prefix, and brackets for a credit. Returns null for anything it
 * cannot read with confidence — a null becomes a line the buyer looks at, and
 * a wrong guess becomes a cost nobody notices.
 */
export function parsePrinted(value: string | null): number | null {
  if (value == null) return null
  const raw = value.trim()
  if (!raw) return null

  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-')
  // Strip currency words/symbols and spaces, keeping only digits and separators.
  const bare = raw.replace(/[()]/g, '').replace(/[^\d.,-]/g, '')
  if (!bare || !/\d/.test(bare)) return null

  const lastComma = bare.lastIndexOf(',')
  const lastDot = bare.lastIndexOf('.')

  let normalised: string
  if (lastComma === -1 && lastDot === -1) {
    normalised = bare
  } else if (lastComma > lastDot) {
    // Comma is the decimal: "1.234,56" or "1234,56".
    normalised = bare.replace(/\./g, '').replace(',', '.')
  } else if (lastDot > lastComma) {
    // Point is the decimal: "1,234.56" or "1234.56".
    normalised = bare.replace(/,/g, '')
  } else {
    normalised = bare
  }

  // A lone separator with exactly three digits after it is a thousands mark,
  // not a decimal: "1,500" is fifteen hundred. Two decimals is the giveaway
  // for money, so only the three-digit case is reinterpreted.
  const trailing = normalised.match(/\.(\d+)$/)
  if (trailing && trailing[1].length === 3 && !/\.\d+\./.test(normalised)) {
    const separators = (bare.match(/[.,]/g) ?? []).length
    if (separators === 1 && lastComma > lastDot) normalised = normalised.replace('.', '')
  }

  const parsed = Number(normalised.replace(/-/g, ''))
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
}

/* ── the scan ──────────────────────────────────────────────────────────────── */

/**
 * Reads a PDF into resolved lines.
 *
 * `supplierId` narrows product resolution to what that supplier sells, which is
 * what makes the supplier-code match reliable: two suppliers can and do use the
 * same code for different things. Passing null still works — it just means
 * supplier codes are matched across every supplier, and an ambiguous hit is
 * demoted rather than trusted.
 */
export async function scanPurchaseDocument(
  siteId: number,
  file: { name: string; base64: string },
  supplierId: number | null,
): Promise<ScanResult> {
  if (!/\.pdf$/i.test(file.name)) {
    return { ok: false, error: 'Only PDF files can be read. For a spreadsheet, use Import lines.' }
  }

  // base64 is 4 characters per 3 bytes; check before spending an API call.
  const bytes = Math.floor((file.base64.length * 3) / 4)
  if (bytes > MAX_PDF_BYTES) {
    return {
      ok: false,
      error: 'That PDF is too large to read. Split it, or send the pages with the lines on them.',
    }
  }

  let extracted: {
    supplierName: string | null
    documentNumber: string | null
    documentDate: string | null
    totalIncl: string | null
    lines: {
      reference: string
      description: string
      qty: string
      unitCost: string | null
      discountPct: string | null
    }[]
  }

  try {
    const anthropic = client()
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCAN_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: file.base64 },
            },
            {
              type: 'text',
              text: 'Transcribe the goods lines and the header details from this supplier document.',
            },
          ],
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      return { ok: false, error: 'That document could not be read. Enter the lines by hand.' }
    }

    // json_schema CONSTRAINS the output, but only messages.parse() pre-parses
    // it — from create() the JSON arrives as an ordinary text block, and
    // reading a `parsed_output` that create() never sets is how this silently
    // reported "nothing could be read" from a response that was entirely fine.
    const parsed = readJson<typeof extracted>(response)
    if (!parsed) {
      return { ok: false, error: 'Nothing could be read from that document.' }
    }
    extracted = parsed
  } catch (error) {
    if (error instanceof ScanNotConfiguredError) return { ok: false, error: error.message }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, error: 'Too many documents at once. Wait a moment and try again.' }
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, error: 'The document service is unavailable. Try again shortly.' }
    }
    throw error
  }

  const rows = extracted.lines.slice(0, MAX_LINES)
  if (rows.length === 0) {
    return {
      ok: false,
      error:
        'No product lines were found. Check it is a supplier invoice, delivery note or quote — a statement or remittance has no lines to receive.',
    }
  }

  // Every reference and description in one resolution pass, for the same reason
  // documentLines does it: a 200-line invoice must not be 200 round trips.
  const matches = await resolveScanned(
    siteId,
    supplierId,
    rows.map((r) => ({ reference: r.reference, description: r.description })),
  )

  const lines: ScannedLine[] = []
  rows.forEach((row, index) => {
    const qty = parsePrinted(row.qty)
    // A line whose quantity could not be read is still shown — with zero — so
    // the buyer sees it exists. Dropping it silently is how a delivery gets
    // received short and nobody knows which line went missing.
    const match = matches[index]

    lines.push({
      line: index + 1,
      reference: row.reference.trim(),
      scannedDescription: row.description.trim(),
      qty: qty !== null && qty > 0 ? qty : 0,
      unitCostExcl: parsePrinted(row.unitCost),
      discountPct: clampPct(parsePrinted(row.discountPct)),
      matchKind: match?.kind ?? 'none',
      productId: match?.product.id ?? null,
      code: match?.product.code ?? null,
      description: match?.product.description ?? null,
      productType: match?.product.productType ?? null,
      packNote:
        match && match.product.packSize > 1
          ? `Their pack is ${match.product.packSize} of ours`
          : null,
    })
  })

  const header: ScannedHeader = {
    supplierName: extracted.supplierName?.trim() || null,
    documentNumber: extracted.documentNumber?.trim() || null,
    documentDate: isoDateOrNull(extracted.documentDate),
    totalIncl: parsePrinted(extracted.totalIncl),
    supplierId: supplierId ?? (await matchSupplier(siteId, extracted.supplierName)),
  }

  return {
    ok: true,
    header,
    lines,
    matched: lines.filter((l) => l.productId !== null).length,
    unmatched: lines.filter((l) => l.productId === null).length,
  }
}

/**
 * The structured output, from wherever the SDK put it.
 *
 * Two places, because two SDK paths populate different ones: messages.parse()
 * pre-parses into `parsed_output`, while messages.create() — which this module
 * uses, for the adaptive-thinking and document-block shape — leaves the JSON in
 * the first text block. Reading both means an SDK upgrade that starts filling
 * `parsed_output` cannot break this, and neither can one that stops.
 */
function readJson<T>(response: { content: unknown[] }): T | null {
  const withParsed = response as { parsed_output?: T }
  if (withParsed.parsed_output) return withParsed.parsed_output

  for (const block of response.content) {
    const text = (block as { type?: string; text?: string })
    if (text.type !== 'text' || !text.text) continue
    try {
      return JSON.parse(text.text) as T
    } catch {
      // A text block that is not the payload — thinking summaries and any
      // preamble land here. Keep looking rather than failing on the first.
    }
  }
  return null
}

/** A discount outside 0–100 is a misread, not an instruction. */
function clampPct(value: number | null): number | null {
  if (value === null) return null
  return value >= 0 && value <= 100 ? value : null
}

/** Only a genuine ISO date survives; anything else is left for the buyer. */
function isoDateOrNull(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  const when = new Date(`${trimmed}T00:00:00Z`)
  return Number.isNaN(when.getTime()) ? null : trimmed
}

/* ── resolution ────────────────────────────────────────────────────────────── */

type ResolvedProduct = {
  id: number
  code: string
  description: string
  productType: string
  packSize: number
}

type Resolution = { kind: MatchKind; product: ResolvedProduct }

/**
 * Finds each scanned line's product, best identifier first.
 *
 * The order is the order of confidence, and it matters more than it looks:
 *
 *   1. THEIR code, for this supplier. An invoice quotes the supplier's own
 *      code, and product_suppliers is the table that holds it. This is the
 *      match that makes the feature worth having — and the one that gets
 *      better every time a buyer resolves an unmatched line, because doing so
 *      writes the code back.
 *   2. Our code, then barcode. Same as a spreadsheet import.
 *   3. Description, exact and normalised. Last because two products can share
 *      a description and the loser is silent; it is reported as a weak match
 *      so the screen can say so.
 *
 * A description hit that finds MORE than one product is not a match at all —
 * an ambiguous guess presented as an answer is worse than no answer.
 */
async function resolveScanned(
  siteId: number,
  supplierId: number | null,
  rows: readonly { reference: string; description: string }[],
): Promise<(Resolution | null)[]> {
  const references = [...new Set(rows.map((r) => r.reference.trim()).filter(Boolean))]
  const descriptions = [...new Set(rows.map((r) => r.description.trim()).filter(Boolean))]

  const bySupplierCode = new Map<string, ResolvedProduct>()
  const byCode = new Map<string, ResolvedProduct>()
  const byBarcode = new Map<string, ResolvedProduct>()
  const byDescription = new Map<string, ResolvedProduct | 'ambiguous'>()

  const CHUNK = 400

  // ── 1. their code ─────────────────────────────────────────────────────────
  if (references.length > 0) {
    for (let i = 0; i < references.length; i += CHUNK) {
      const batch = references.slice(i, i + CHUNK)
      const holders = batch.map(() => '?').join(',')
      const scoped = supplierId ? 'AND ps.supplier_id = ?' : ''
      const rowsOut = await siteQuery<
        RowDataPacket & {
          id: number
          code: string
          description: string
          product_type: string
          pack_size: string | number
          supplier_code: string
        }
      >(
        siteId,
        `SELECT p.id, p.code, p.description, p.product_type,
                ps.pack_size, ps.supplier_code
           FROM product_suppliers ps
           JOIN products p ON p.id = ps.product_id
          WHERE p.is_archived = 0 AND p.has_variants = 0
            AND ps.supplier_code IN (${holders}) ${scoped}
          -- The supplier's preferred row wins when the same code appears twice.
          ORDER BY ps.is_preferred DESC, p.id ASC`,
        supplierId ? [...batch, supplierId] : batch,
      )
      for (const row of rowsOut) {
        const key = norm(String(row.supplier_code))
        if (!bySupplierCode.has(key)) bySupplierCode.set(key, toProduct(row))
      }
    }
  }

  // ── 2. our code and barcode ───────────────────────────────────────────────
  if (references.length > 0) {
    for (let i = 0; i < references.length; i += CHUNK) {
      const batch = references.slice(i, i + CHUNK)
      const holders = batch.map(() => '?').join(',')
      const rowsOut = await siteQuery<
        RowDataPacket & {
          id: number
          code: string
          barcode: string | null
          description: string
          product_type: string
        }
      >(
        siteId,
        `SELECT id, code, barcode, description, product_type
           FROM products
          WHERE is_archived = 0 AND has_variants = 0
            AND (code IN (${holders}) OR barcode IN (${holders}))`,
        [...batch, ...batch],
      )
      for (const row of rowsOut) {
        const product = toProduct({ ...row, pack_size: 1 })
        if (row.barcode) {
          const key = norm(String(row.barcode))
          if (!byBarcode.has(key)) byBarcode.set(key, product)
        }
        byCode.set(norm(String(row.code)), product)
      }
    }
  }

  // ── 3. description ────────────────────────────────────────────────────────
  if (descriptions.length > 0) {
    for (let i = 0; i < descriptions.length; i += CHUNK) {
      const batch = descriptions.slice(i, i + CHUNK)
      const holders = batch.map(() => '?').join(',')
      const rowsOut = await siteQuery<
        RowDataPacket & {
          id: number
          code: string
          description: string
          product_type: string
        }
      >(
        siteId,
        `SELECT id, code, description, product_type
           FROM products
          WHERE is_archived = 0 AND has_variants = 0
            AND description IN (${holders})`,
        batch,
      )
      for (const row of rowsOut) {
        const key = norm(String(row.description))
        // Two products with one description is not a match — see the header.
        byDescription.set(key, byDescription.has(key) ? 'ambiguous' : toProduct({ ...row, pack_size: 1 }))
      }
    }
  }

  return rows.map((row) => {
    const reference = norm(row.reference)
    if (reference) {
      const supplierHit = bySupplierCode.get(reference)
      if (supplierHit) return { kind: 'supplier_code' as const, product: supplierHit }
      const codeHit = byCode.get(reference)
      if (codeHit) return { kind: 'code' as const, product: codeHit }
      const barcodeHit = byBarcode.get(reference)
      if (barcodeHit) return { kind: 'barcode' as const, product: barcodeHit }
    }
    const descriptionHit = byDescription.get(norm(row.description))
    if (descriptionHit && descriptionHit !== 'ambiguous') {
      return { kind: 'description' as const, product: descriptionHit }
    }
    return null
  })
}

function toProduct(row: {
  id: number
  code: string
  description: string
  product_type: string
  pack_size: string | number
}): ResolvedProduct {
  return {
    id: Number(row.id),
    code: String(row.code),
    description: String(row.description),
    productType: String(row.product_type),
    packSize: Number(row.pack_size) || 1,
  }
}

/**
 * Which supplier the document came from, when the screen did not already know.
 *
 * Exact on name or code only. A fuzzy supplier match is a whole document posted
 * to the wrong creditor — the one error here that is genuinely expensive to
 * unwind — so anything less than certain returns null and the buyer picks.
 */
async function matchSupplier(siteId: number, name: string | null): Promise<number | null> {
  const trimmed = name?.trim()
  if (!trimmed) return null

  // `status <> 'closed'` rather than an archived flag — suppliers carry the
  // same four-state enum customers do, and a closed one is the only state that
  // must never be proposed. An on-hold supplier still gets deliveries for what
  // was already booked, so it stays matchable.
  const rows = await supplierQuery<RowDataPacket & { id: number }>(
    siteId,
    `SELECT id FROM suppliers
      WHERE status <> 'closed' AND (UPPER(name) = ? OR UPPER(code) = ?)
      LIMIT 2`,
    [norm(trimmed), norm(trimmed)],
  )
  return rows.length === 1 ? Number(rows[0].id) : null
}

/* ── learning from a correction ────────────────────────────────────────────── */

/**
 * Remembers that this supplier's code means this product.
 *
 * The whole reason the unmatched panel is worth building rather than just
 * listing problems: a buyer who resolves "ABC-1234" once should never be asked
 * again. Writes product_suppliers, which is the same table the order screen and
 * the price list read, so the correction improves those too.
 *
 * Never overwrites an existing code. A row already carrying a supplier code is
 * a deliberate setup someone made, and a mis-scan should not quietly replace
 * it — that is how one bad delivery poisons every future one.
 */
export async function rememberSupplierCode(
  siteId: number,
  supplierId: number,
  productId: number,
  supplierCode: string,
): Promise<void> {
  const code = supplierCode.trim().slice(0, 48)
  if (!code) return

  await siteQuery(
    siteId,
    `INSERT INTO product_suppliers (product_id, supplier_id, supplier_code)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       supplier_code = COALESCE(NULLIF(supplier_code, ''), VALUES(supplier_code))`,
    [productId, supplierId, code],
  )
}
