/**
 * What a barcode on a document carries.
 *
 * ── THE SAME REASONING AS A QR TARGET, A DIFFERENT ANSWER ─────────────────
 *
 * A QR points somewhere and the valuable version varies per document, so its
 * targets are named kinds. A barcode does not point anywhere — it IS a string,
 * and the useful string is nearly always something the document already shows:
 * the number a person would otherwise key in at a counter.
 *
 * So the sources are named too, and for the same reason: a shop that typed a
 * fixed number into a design would have one barcode on every document, which is
 * the opposite of useful.
 *
 * ── WHY CODE128 AND NOTHING ELSE ──────────────────────────────────────────
 *
 * lib/labels/code128.ts already encodes it, the thermal head has it built in,
 * and every scanner in a shop reads it. Offering EAN-13 as well would mean a
 * second encoder, a check-digit rule, and a shop discovering that its document
 * number does not fit a format designed for retail products.
 */

export const BARCODE_SOURCES = ['docNumber', 'reference', 'customerCode', 'custom'] as const
export type BarcodeSource = (typeof BARCODE_SOURCES)[number]

export type BarcodeSourceDef = {
  source: BarcodeSource
  label: string
  hint: string
  /** The token it reads, where it reads one. */
  token?: string
}

export const BARCODE_SOURCE_INFO: readonly BarcodeSourceDef[] = [
  {
    source: 'docNumber',
    label: 'The document number',
    hint: 'What a counter scans to pull the sale up again. Different on every document.',
    token: 'doc.number',
  },
  {
    source: 'reference',
    label: 'The reference',
    hint: 'Your own reference on this document, where it has one.',
    token: 'doc.reference',
  },
  {
    source: 'customerCode',
    label: 'The customer account',
    hint: 'Their account code — for a statement a clerk scans to find them.',
    token: 'customer.code',
  },
  {
    source: 'custom',
    label: 'Words you type',
    hint: 'A fixed code — the same on every document.',
  },
]

const SOURCE_SET = new Set<string>(BARCODE_SOURCES)

export function isBarcodeSource(value: unknown): value is BarcodeSource {
  return typeof value === 'string' && SOURCE_SET.has(value)
}

/**
 * What CODE128 can carry: printable ASCII, and not much of it.
 *
 * Cleaned rather than refused, because the failure it prevents is subtle. A
 * barcode containing a character the symbology cannot express does not fail to
 * print — the encoder returns null and the block prints nothing, which a shop
 * reads as "the barcode is broken" without knowing why. Stripping here means
 * the designer can say what will actually be encoded.
 */
export function cleanBarcodeText(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  // Printable ASCII only — CODE128 Code B is 32–126.
  const usable = [...trimmed].filter((c) => {
    const code = c.charCodeAt(0)
    return code >= 32 && code <= 126
  })
  // A brace would have to be doubled for the printer's {B prefix scheme; a
  // document number never has one, and dropping it beats encoding it wrongly.
  const cleaned = usable.filter((c) => c !== '{').join('').slice(0, 48)
  return cleaned || null
}

/**
 * The string a barcode block should encode, or null when there is none.
 *
 * `values` is the document's own token bag, so a barcode reads exactly what the
 * page prints — the number under the bars and the number in the corner cannot
 * disagree.
 */
export function resolveBarcodeText(
  source: BarcodeSource,
  custom: string | undefined,
  values: Record<string, unknown>,
): string | null {
  if (source === 'custom') return cleanBarcodeText(custom ?? '')

  const def = BARCODE_SOURCE_INFO.find((s) => s.source === source)
  if (!def?.token) return null

  const raw = values[def.token]
  return typeof raw === 'string' || typeof raw === 'number'
    ? cleanBarcodeText(String(raw))
    : null
}

/**
 * The same question, asked of a receipt.
 *
 * A slip has no token bag — it has a ReceiptData — so the sources are mapped
 * across here rather than the receipt being made to pretend it is a document.
 * The same two-small-mappings-beat-one-leaky-abstraction call the slip's
 * conditions made.
 *
 * A slip has no reference of its own, so that source resolves to nothing; the
 * designer does not offer it.
 */
export function resolveSlipBarcodeText(
  source: BarcodeSource,
  custom: string | undefined,
  data: { documentNumber?: string; customerName?: string | null },
): string | null {
  switch (source) {
    case 'custom':
      return cleanBarcodeText(custom ?? '')
    case 'docNumber':
      return cleanBarcodeText(data.documentNumber ?? '')
    default:
      return null
  }
}
