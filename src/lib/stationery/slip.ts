import { isConditionRule, type ConditionRule } from './conditions'
import { isQrTarget, cleanCustomUrl, type QrTarget } from './qrTarget'
/**
 * The till slip's design, as an ordered list of BLOCKS.
 *
 * ── WHY THIS IS NOT HTML ──────────────────────────────────────────────────
 *
 * An A4 document is designed as markup because a browser renders it. A slip is
 * not: it goes to a thermal head over ESC/POS, and that device has no CSS, no
 * boxes and no fonts to choose from. Its entire vocabulary is the encoder's —
 * align, bold, size, a line of text, feed, cut (see lib/escpos/encoder.ts).
 * Handing a shop an HTML editor for a slip would be offering control that
 * cannot survive the trip to the printer.
 *
 * So a slip design is a LIST, and every block maps onto something the head can
 * actually do. What a designer chooses is which blocks appear, in what order,
 * with what emphasis, and what the free text says.
 *
 * ── ONE SPEC, TWO RENDERERS, AND THAT IS THE POINT ────────────────────────
 *
 * lib/escpos/slips.ts states the existing rule: the browser print and the
 * thermal print consume the SAME data object so they cannot disagree. A design
 * that only one of them honoured would break exactly that, so this spec
 * compiles to both — `toEscPos` and `toSlipHtml` walk the same block list.
 *
 * ── WHAT A DESIGNER CANNOT MOVE ───────────────────────────────────────────
 *
 * Some blocks are not layout. `lines` is the sale; `tax` is the VAT analysis a
 * vendor is obliged to print. Those may be reordered but not removed, and the
 * validator enforces it — the same reason the A4 validator refuses an invoice
 * with no document number. A shop that could delete its VAT breakdown would
 * produce slips that are not tax invoices, which is the one thing a till slip
 * has to be.
 *
 * ── GIFT MODE IS NOT A DESIGN CHOICE ──────────────────────────────────────
 *
 * It is a property of the PRINT (`?gift=1`), and it suppresses money in the
 * renderer regardless of the design. A designer cannot switch it on or off, and
 * a money block simply renders nothing on a gift slip. Making it designable
 * would let a shop produce a "gift receipt" with prices on it.
 */

/** Every kind of block a slip design may contain. */
export const SLIP_BLOCK_KINDS = [
  'siteName',
  'vatNumber',
  'title',
  'docLine',
  'staffLine',
  'customer',
  'copyBanner',
  'giftNote',
  'lines',
  'totals',
  'tenders',
  'tax',
  'loyalty',
  'text',
  'qr',
  'rule',
  'feed',
] as const

export type SlipBlockKind = (typeof SLIP_BLOCK_KINDS)[number]

export type SlipAlign = 'left' | 'center' | 'right'

export type SlipBlock = {
  kind: SlipBlockKind
  align?: SlipAlign
  bold?: boolean
  /** Height multiplier, 1–3. Width follows on the one block that uses it. */
  size?: 1 | 2 | 3
  /** `text` only — the words. Everything else ignores it. */
  text?: string
  /**
   * Print this line only when the sale answers a named question — see
   * lib/stationery/conditions, and SLIP_CONDITIONS for the short list a slip
   * can actually answer.
   *
   * Absent means always, which is what every design saved before this means.
   */
  showWhen?: ConditionRule
  /** qr only: what the code points at. See lib/stationery/qrTarget. */
  qrTarget?: QrTarget
  /** qr only: the typed address, for the `custom` target and nothing else. */
  qrUrl?: string
  /** qr only: words under the square. */
  qrCaption?: string
}

export type SlipSpec = {
  version: 1
  blocks: SlipBlock[]
}

/** What each block is called in the designer, and what it puts on paper. */
export const SLIP_BLOCK_INFO: Record<
  SlipBlockKind,
  { label: string; hint: string; required?: boolean; fixedText?: boolean }
> = {
  siteName: { label: 'Business name', hint: 'The shop name, large and centred by default.' },
  vatNumber: { label: 'VAT number', hint: 'Prints nothing if the business is not a VAT vendor.' },
  title: {
    label: 'TAX INVOICE heading',
    hint: 'Says TAX INVOICE, or GIFT RECEIPT on a gift slip. Required.',
    required: true,
  },
  docLine: {
    label: 'Number and date',
    hint: 'The slip number and the date of sale. Required.',
    required: true,
  },
  staffLine: { label: 'Cashier, till and time', hint: 'Who served, which till, when.' },
  customer: { label: 'Customer', hint: 'Name, and VAT number when the customer has one.' },
  copyBanner: { label: 'COPY banner', hint: 'Prints only on a reprint, so a duplicate is obvious.' },
  giftNote: {
    label: 'Gift-receipt note',
    hint: 'Explains why there are no prices. Prints only on a gift slip.',
  },
  lines: { label: 'What was bought', hint: 'The sale itself. Required.', required: true },
  totals: { label: 'Discount, total and rounding', hint: 'Required.', required: true },
  tenders: { label: 'How it was paid', hint: 'Each tender, and change given.' },
  tax: {
    label: 'VAT breakdown',
    hint: 'VAT by rate. A vendor is obliged to show it — required.',
    required: true,
  },
  loyalty: { label: 'Loyalty points', hint: 'Points earned and the balance, when the sale had a customer.' },
  qr: {
    label: 'A QR code',
    hint: 'A square customers scan. The printer draws it — see EscPos.qr.',
  },
  text: { label: 'Your own words', hint: 'A returns policy, a thank-you, opening hours.' },
  rule: { label: 'A dividing line', hint: 'A row of dashes across the slip.' },
  feed: { label: 'Blank space', hint: 'One blank line.' },
}

/**
 * The slip we ship, which is the current hard-coded layout as a spec.
 *
 * Byte-for-byte the same slip renderReceipt() produced before this existed —
 * proved by the test suite, and the reason switching a site onto the designer
 * changes nothing until the site changes something.
 */
export const SLIP_DEFAULT: SlipSpec = {
  version: 1,
  blocks: [
    { kind: 'siteName', align: 'center', size: 2 },
    { kind: 'vatNumber', align: 'center' },
    { kind: 'title', align: 'center', bold: true },
    { kind: 'docLine', align: 'center' },
    { kind: 'staffLine', align: 'center' },
    { kind: 'customer', align: 'center' },
    { kind: 'copyBanner', align: 'center', bold: true },
    { kind: 'giftNote', align: 'center' },
    { kind: 'rule' },
    { kind: 'lines' },
    { kind: 'rule' },
    { kind: 'totals' },
    { kind: 'tenders' },
    { kind: 'rule' },
    { kind: 'tax' },
    { kind: 'loyalty', align: 'center' },
    { kind: 'text', align: 'center' },
  ],
}

const KIND_SET = new Set<string>(SLIP_BLOCK_KINDS)

export const REQUIRED_KINDS: SlipBlockKind[] = SLIP_BLOCK_KINDS.filter(
  (k) => SLIP_BLOCK_INFO[k].required,
)

/** How many blocks a slip may have. A roll is not infinite and neither is patience. */
export const MAX_SLIP_BLOCKS = 40

export type SlipValidation = { ok: boolean; errors: string[] }

/**
 * Whether a slip design is fit to print.
 *
 * Mirrors validateTemplate for the A4 side: structure, then the obligations. A
 * slip missing its VAT breakdown or its number is not a tax invoice, and a till
 * that prints one is a problem for the shop rather than a matter of taste.
 */
export function validateSlip(spec: SlipSpec): SlipValidation {
  const errors: string[] = []

  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.blocks)) {
    return { ok: false, errors: ['That slip design cannot be read.'] }
  }
  if (spec.blocks.length > MAX_SLIP_BLOCKS) {
    errors.push(`A slip may have at most ${MAX_SLIP_BLOCKS} blocks.`)
  }

  const seen = new Set<string>()
  for (const b of spec.blocks) {
    if (!b || !KIND_SET.has(b.kind)) {
      errors.push('The design contains a block this till does not understand.')
      continue
    }
    // Everything except text, rule and feed is a section of the sale, and two
    // copies of the totals is a slip nobody can reconcile.
    if (b.kind !== 'text' && b.kind !== 'rule' && b.kind !== 'feed') {
      if (seen.has(b.kind)) {
        errors.push(`"${SLIP_BLOCK_INFO[b.kind].label}" appears more than once.`)
      }
      seen.add(b.kind)
    }
  }

  for (const k of REQUIRED_KINDS) {
    if (!seen.has(k)) {
      errors.push(`A till slip must show "${SLIP_BLOCK_INFO[k].label}".`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Read a stored design back, dropping anything no longer recognised.
 *
 * The saved_reports rule, applied here: a spec outlives the code that wrote it,
 * so a block kind removed in a later version costs that block rather than the
 * whole slip. Returns null only when the JSON itself is unreadable, so the
 * caller falls back to the shipped design.
 */
export function parseSlip(json: string): SlipSpec | null {
  try {
    const raw = JSON.parse(json) as unknown
    if (!raw || typeof raw !== 'object') return null
    const blocks = (raw as { blocks?: unknown }).blocks
    if (!Array.isArray(blocks)) return null

    const clean: SlipBlock[] = []
    for (const b of blocks.slice(0, MAX_SLIP_BLOCKS)) {
      if (!b || typeof b !== 'object') continue
      const kind = (b as { kind?: unknown }).kind
      if (typeof kind !== 'string' || !KIND_SET.has(kind)) continue

      const align = (b as { align?: unknown }).align
      const size = (b as { size?: unknown }).size
      const text = (b as { text?: unknown }).text
      // Kept only when this build still has the rule — see parseSpec's note.
      const when = (b as { showWhen?: unknown }).showWhen
      const rawTarget = (b as { qrTarget?: unknown }).qrTarget
      const rawQrUrl = (b as { qrUrl?: unknown }).qrUrl
      const rawQrCaption = (b as { qrCaption?: unknown }).qrCaption

      clean.push({
        kind: kind as SlipBlockKind,
        ...(align === 'left' || align === 'center' || align === 'right' ? { align } : {}),
        ...(size === 1 || size === 2 || size === 3 ? { size } : {}),
        ...(typeof text === 'string' ? { text: text.slice(0, 300) } : {}),
        ...((b as { bold?: unknown }).bold === true ? { bold: true } : {}),
        ...(isConditionRule(when) && when !== 'always' ? { showWhen: when } : {}),
        ...(isQrTarget(rawTarget) ? { qrTarget: rawTarget } : {}),
        ...(typeof rawQrUrl === 'string' && cleanCustomUrl(rawQrUrl)
          ? { qrUrl: cleanCustomUrl(rawQrUrl) as string }
          : {}),
        ...(typeof rawQrCaption === 'string' && rawQrCaption.trim()
          ? { qrCaption: rawQrCaption.slice(0, 40) }
          : {}),
      })
    }
    return { version: 1, blocks: clean }
  } catch {
    return null
  }
}

export function serialiseSlip(spec: SlipSpec): string {
  return JSON.stringify({ version: 1, blocks: spec.blocks })
}
