import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '@/lib/siteDb'
import { readCsv, readXlsx, aliasSet } from './sheet'
import { autoMap } from './map'
import { splitCsvLine, parseAmount } from './text'
import { norm } from './lookups'

/**
 * Reading a file of document lines.
 *
 * ── WHY THIS IS NOT AN ImportSpec ────────────────────────────────────────
 *
 * Because it never writes anything. An order, a GRV and a stock take already
 * have screens that know how to build and post them — with the cost preview,
 * the serial capture, the VAT-period lock, the tie-out against the supplier's
 * invoice total. Importing lines means filling those screens in, not going
 * around them.
 *
 * That is the whole design: the file becomes rows in the grid the user already
 * knows, they check the costs and quantities the way they would if they had
 * keyed them, and they press the same Post button. No second posting path, no
 * second set of document numbers, and nothing writes stock or the creditor
 * ledger until a person has looked at it.
 *
 * So this module resolves and reports. What comes back is a list of lines and a
 * list of problems, and the screen decides what to do with them.
 */

export type LineDraft = {
  line: number
  /** Whatever the file called the product — a code, a barcode, a supplier's code. */
  reference: string
  productId: number
  code: string
  description: string
  productType: string
  qty: number
  unitCostExcl: number | null
  discountPct: number | null
  /** Per line, because one delivery can land in several rooms. */
  locationCode: string | null
  serials: string[]
}

export type LineProblem = { line: number; reference: string; reason: string }

export type LineReadResult =
  | { ok: true; lines: LineDraft[]; problems: LineProblem[]; matched: number }
  | { ok: false; error: string }

/** What a line file may call each column. */
const FIELDS = [
  { key: 'reference', label: 'Product', required: true,
    aliases: ['Product Code', 'Code', 'Item Code', 'SKU', 'Barcode', 'Stock Code', 'Product'] },
  { key: 'qty', label: 'Quantity', required: true,
    aliases: ['Quantity', 'Qty', 'Ordered', 'Received', 'Count', 'Counted'] },
  { key: 'cost', label: 'Unit cost',
    aliases: ['Unit Cost', 'Cost', 'Price', 'Cost Excl', 'Unit Price'] },
  { key: 'discount', label: 'Discount %',
    aliases: ['Discount', 'Discount %', 'Disc'] },
  { key: 'location', label: 'Location',
    aliases: ['Location', 'Store', 'Warehouse', 'Room'] },
  { key: 'serials', label: 'Serial numbers',
    aliases: ['Serial', 'Serials', 'Serial Numbers', 'IMEI'] },
] as const

/**
 * Turns a file into lines, resolving each product against the catalogue.
 *
 * Products are resolved in ONE query rather than per row: a 500-line GRV would
 * otherwise be 500 round trips. Code and barcode are both accepted because a
 * supplier's file quotes whichever it holds, and a shop scanning a delivery has
 * barcodes.
 */
export async function readDocumentLines(
  siteId: number,
  file: { name: string; text?: string; buffer?: ArrayBuffer },
): Promise<LineReadResult> {
  const aliases = aliasSet(FIELDS)
  const read = file.buffer
    ? readXlsx(file.buffer, aliases)
    : readCsv(file.text ?? '', aliases)

  if (!read.ok) return read

  const mapping = autoMap(read.sheet.headers, FIELDS)
  if (mapping.reference == null) {
    return { ok: false, error: 'No product code column was recognised. The file needs a Product Code or Barcode column.' }
  }
  if (mapping.qty == null) {
    return { ok: false, error: 'No quantity column was recognised. The file needs a Quantity column.' }
  }

  const references = read.sheet.rows
    .map((row) => (row[mapping.reference as number] ?? '').trim())
    .filter(Boolean)

  const found = await resolveProducts(siteId, references)

  const lines: LineDraft[] = []
  const problems: LineProblem[] = []

  read.sheet.rows.forEach((row, index) => {
    const line = read.sheet.headerLine + 1 + index
    const at = (key: string) => {
      const column = mapping[key]
      return column == null ? '' : (row[column] ?? '').trim()
    }

    const reference = at('reference')
    if (!reference) return

    const product = found.get(norm(reference))
    if (!product) {
      problems.push({ line, reference, reason: 'Not in the catalogue. Import products first, or take the row out.' })
      return
    }

    const qty = parseAmount(at('qty'))
    if (qty === null) {
      problems.push({ line, reference, reason: `"${at('qty')}" is not a quantity.` })
      return
    }
    if (qty <= 0) {
      problems.push({ line, reference, reason: 'A quantity has to be more than zero.' })
      return
    }

    const cost = mapping.cost == null ? null : parseAmount(at('cost'))
    if (mapping.cost != null && at('cost') && cost === null) {
      problems.push({ line, reference, reason: `"${at('cost')}" is not a cost.` })
      return
    }

    const discount = mapping.discount == null ? null : parseAmount(at('discount'))
    if (discount !== null && (discount < 0 || discount > 100)) {
      problems.push({ line, reference, reason: 'A discount has to be between 0 and 100.' })
      return
    }

    lines.push({
      line,
      reference,
      productId: product.id,
      code: product.code,
      description: product.description,
      productType: product.productType,
      qty,
      // A cost of zero is a real instruction; a missing column is not. Null
      // means "leave what the grid worked out from the product".
      unitCostExcl: cost,
      discountPct: discount,
      locationCode: at('location') || null,
      serials: at('serials')
        ? splitCsvLine(at('serials'), ';').flatMap((s) => s.split(/[,|]/)).map((s) => s.trim()).filter(Boolean)
        : [],
    })
  })

  return { ok: true, lines, problems, matched: lines.length }
}

/**
 * Finds every referenced product in one query.
 *
 * Archived products and variant parents are excluded: neither can be bought or
 * counted, and matching one would produce a line that fails at posting time
 * with a message about something the user did not think they had picked.
 */
async function resolveProducts(
  siteId: number,
  references: readonly string[],
): Promise<Map<string, { id: number; code: string; description: string; productType: string }>> {
  const unique = [...new Set(references.map((r) => r.trim()).filter(Boolean))]
  const out = new Map<string, { id: number; code: string; description: string; productType: string }>()
  if (unique.length === 0) return out

  // Chunked because a 20,000-line file would otherwise build a single IN list
  // long enough to exceed max_allowed_packet.
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK)
    const holders = batch.map(() => '?').join(',')
    const rows = await siteQuery<RowDataPacket & {
      id: number; code: string; barcode: string | null; description: string; product_type: string
    }>(
      siteId,
      `SELECT id, code, barcode, description, product_type
         FROM products
        WHERE is_archived = 0 AND has_variants = 0
          AND (code IN (${holders}) OR barcode IN (${holders}))`,
      [...batch, ...batch],
    )

    for (const row of rows) {
      const entry = {
        id: Number(row.id),
        code: String(row.code),
        description: String(row.description),
        productType: String(row.product_type),
      }
      // Keyed by both, so whichever the file quoted resolves. Code wins a tie:
      // a barcode that happens to equal another product's code is vanishingly
      // rare, and the code is the more deliberate identifier.
      if (row.barcode) {
        const key = norm(String(row.barcode))
        if (!out.has(key)) out.set(key, entry)
      }
      out.set(norm(String(row.code)), entry)
    }
  }

  return out
}
