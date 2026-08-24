/**
 * Reading a GS1-128 / GS1 DataBar element string — pure, and deliberately NOT
 * `server-only`, for the reason `barcodes.ts` gives: the OFFLINE till calls it.
 *
 * ── TWO KINDS OF BARCODE, AND THEY DO NOT OVERLAP ────────────────────────
 *
 * `parseVariableBarcode` (barcodes.ts) reads a SCALE label: prefix + PLU +
 * embedded value, pure digits, positional. Its shape is a shop setting because
 * it varies by scale vendor.
 *
 * `parseGs1` reads an ELEMENT STRING: a sequence of (Application Identifier,
 * value) pairs that can carry the batch and expiry printed on the pack. Its
 * shape is a published standard, so nothing about it is configurable — which is
 * why there is no "GS1 format" setting to get wrong.
 *
 * They are told apart by structure, not by a setting: an element string starts
 * with a known AI and a scale label is all digits with no AI framing. Each
 * returns null on the other's input, so a caller can try both in either order.
 */

/** What a GS1 barcode told us. Every field is optional — packs vary. */
export type Gs1Barcode = {
  /** AI 01, as printed: 14 digits. Match it with `gtinCandidates`. */
  gtin: string | null
  /** AI 10 — the lot. Upper-cased, because GS1 lot codes are case-insensitive. */
  batchNo: string | null
  /** AI 17 or 15, as `YYYY-MM-DD`. */
  expiryDate: string | null
  /** AI 310n — net weight in kg, decimal already applied. */
  weight: number | null
  /** AI 21. Parsed so it can never be mistaken for a lot; not otherwise used. */
  serial: string | null
  /**
   * The lot looks like it RAN ON into the next field.
   *
   * Set when a batch ends in something shaped like an AI plus its value — the
   * signature of a scanner that sends no FNC1 on a pack whose lot is not last.
   * The read is still the standard's correct one and is used as-is; this only
   * lets a caller warn, because "L2408A17260831" appearing as a lot number is
   * a scanner-configuration problem that looks exactly like a data-entry one.
   */
  runOnRisk: boolean
}

/**
 * The fixed-length AIs this reads.
 *
 * Only the ones a retail pack actually carries. An unknown AI is not an error —
 * it ends the parse, keeping whatever was already read, because a partial answer
 * from a real barcode beats discarding the lot number over a field we had no
 * opinion about.
 */
const FIXED_AI: Record<string, number> = {
  '00': 18, // SSCC
  '01': 14, // GTIN
  '02': 14, // GTIN of contained trade items
  '11': 6, // production date
  '13': 6, // packaging date
  '15': 6, // best before
  '16': 6, // sell by
  '17': 6, // expiry
  '20': 2, // variant
}

/** Variable-length AIs, with the maximum the standard allows. */
const VARIABLE_AI: Record<string, number> = {
  '10': 20, // batch / lot
  '21': 20, // serial
  '22': 20, // consumer product variant
  '30': 8, // variable count
  '37': 8, // count of trade items
  '240': 30, // additional product id
  '241': 30, // customer part number
}

/**
 * FNC1, as the various things a scanner may actually transmit.
 *
 * GS (29) is the norm; RS (30) and EOT (4) appear on some configurations, and a
 * pipe is what a few guns emit when told to use a "printable" separator.
 */
const SEPARATORS = ['\x1d', '\x1e', '\x04', '|']

/**
 * Reads a GS1-128 / GS1 DataBar element string.
 *
 * ── WHY THIS IS NOT A REGEX ──────────────────────────────────────────────
 *
 * An element string is a CONCATENATION of variable-length fields. Where one ends
 * is decided by the AI that started it, so it can only be read left to right,
 * one field at a time. A regex would have to guess.
 *
 * ── THE SEPARATOR IS THE HARD PART ───────────────────────────────────────
 *
 * A variable-length field ends at FNC1. In the printed symbol that is a real
 * character, but a keyboard-wedge scanner has to TRANSMIT it as something, and
 * what it picks depends on how the shop configured the gun: usually GS, sometimes
 * RS, EOT or a pipe, and sometimes — the case that bites — NOTHING AT ALL.
 *
 * So: end a variable field at any known separator, and when it runs to the end of
 * the string with none, take the rest. That is why a lot number must be the LAST
 * field on a pack whose scanner omits separators, and why a shop seeing truncated
 * lots should be told to turn GS transmission on rather than having us guess.
 *
 * Returns null for anything that is not an element string — an ordinary EAN-13, a
 * scale label, a typed product code — so callers can try this first and fall
 * through at the cost of one comparison.
 */
export function parseGs1(scanned: string): Gs1Barcode | null {
  let code = scanned.trim()
  if (!code) return null

  // Some scanners prefix the symbology id. ]C1 is GS1-128, ]e0 DataBar.
  if (code.startsWith(']')) code = code.slice(3)
  // A leading FNC1 is the standard's own start marker.
  while (code.length > 0 && SEPARATORS.includes(code[0]!)) code = code.slice(1)
  if (!code) return null

  const out: Gs1Barcode = {
    gtin: null,
    batchNo: null,
    expiryDate: null,
    weight: null,
    serial: null,
    runOnRisk: false,
  }
  let read = 0
  let pos = 0

  while (pos < code.length) {
    // AIs are two, three or four digits. Longest first — '310' must not be read
    // as '31', and '3103' names a different decimal place from '3102'.
    const four = code.slice(pos, pos + 4)
    const three = code.slice(pos, pos + 3)
    const two = code.slice(pos, pos + 2)

    let ai: string
    let length: number
    let variable = false

    if (/^310\d$/.test(four)) {
      // 310n — net weight in kg. The last digit is the decimal position.
      ai = four
      length = 6
    } else if (VARIABLE_AI[three] !== undefined) {
      ai = three
      length = VARIABLE_AI[three]!
      variable = true
    } else if (FIXED_AI[two] !== undefined) {
      ai = two
      length = FIXED_AI[two]!
    } else if (VARIABLE_AI[two] !== undefined) {
      ai = two
      length = VARIABLE_AI[two]!
      variable = true
    } else {
      // An AI we have no opinion about. Stop rather than guess its length —
      // reading on would slice the next field in the wrong place and could put
      // somebody else's digits into `batchNo`.
      break
    }

    pos += ai.length
    let value: string

    if (variable) {
      // To the next separator, or to the end when the scanner sends none.
      let end = code.length
      for (const sep of SEPARATORS) {
        const at = code.indexOf(sep, pos)
        if (at !== -1 && at < end) end = at
      }
      value = code.slice(pos, Math.min(end, pos + length))
      pos = end < code.length ? end + 1 : code.length
    } else {
      value = code.slice(pos, pos + length)
      if (value.length < length) break // truncated — keep what we already read
      pos += length
      // A fixed-length field may still be FOLLOWED by a separator.
      while (pos < code.length && SEPARATORS.includes(code[pos]!)) pos += 1
    }

    if (!value) break
    read += 1

    switch (ai) {
      case '01':
      case '02':
        if (/^\d{14}$/.test(value)) out.gtin = value
        break
      case '10':
        // Upper-cased so 'l2408a' and 'L2408A' are one lot rather than two.
        out.batchNo = value.toUpperCase()
        // A lot that swallowed a following AI because the scanner sent no
        // separator. UNAVOIDABLE here — with no terminator, `10L2408A17260831`
        // genuinely is one field per the standard, which is why GS1 requires
        // variable-length AIs to come last. We cannot un-guess it, but we can
        // say so: silently minting lot "L2408A17260831" would have somebody
        // hunting a data bug for a day.
        if (/\d{2}(\d{6}|\d{14})$/.test(value) && value.length > 12) out.runOnRisk = true
        break
      case '21':
        // Read ONLY so it cannot be mistaken for a lot. A serial identifies a
        // unit; putting one in batch_no would mint a new lot per item sold.
        out.serial = value
        break
      case '15':
      case '17': {
        const date = gs1Date(value)
        // 17 is the real expiry; 15 is a best-before and only fills a gap.
        if (date && (ai === '17' || !out.expiryDate)) out.expiryDate = date
        break
      }
      default:
        if (/^310\d$/.test(ai) && /^\d{6}$/.test(value)) {
          const weight = Number(value) / 10 ** Number(ai[3])
          if (Number.isFinite(weight) && weight > 0) out.weight = weight
        }
        break
    }
  }

  // Nothing recognised means this was not an element string at all.
  if (read === 0) return null
  if (!out.gtin && !out.batchNo && !out.expiryDate && !out.weight && !out.serial) return null
  return out
}

/**
 * `YYMMDD` as `YYYY-MM-DD`, or null.
 *
 * Two traps. DD=00 is legal GS1 and means "end of that month" — read as a date it
 * becomes the last day of the month BEFORE, which would expire a lot early and
 * pull good stock off a shelf. And YY is a two-digit year; for expiry dates in
 * practice that means 20xx.
 */
function gs1Date(value: string): string | null {
  if (!/^\d{6}$/.test(value)) return null
  const year = 2000 + Number(value.slice(0, 2))
  const month = Number(value.slice(2, 4))
  const day = Number(value.slice(4, 6))
  if (month < 1 || month > 12) return null

  // Day 00 means the last day of the month. Date.UTC(y, month, 0) is the last
  // day of `month` because its months are zero-based — one past, day zero.
  const resolved = day === 0 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : day
  if (resolved < 1 || resolved > 31) return null

  return `${year}-${String(month).padStart(2, '0')}-${String(resolved).padStart(2, '0')}`
}

/**
 * The codes a GS1 GTIN might be stored as, most specific first.
 *
 * A pack carries GTIN-14; a shop's product file almost always holds the EAN-13
 * printed on the consumer unit, which is the same number with a leading
 * packaging-level digit. So a GTIN whose extra digit is 0 is an EAN-13 wearing a
 * hat, and matching has to try both.
 *
 * A NON-ZERO leading digit is a genuine outer-case code and is NOT the consumer
 * unit — stripping it would ring up a single where a case was scanned, which is
 * why only a leading zero is dropped.
 */
export function gtinCandidates(gtin: string): string[] {
  if (!/^\d{14}$/.test(gtin)) return [gtin]
  const out = [gtin]
  if (gtin.startsWith('0')) {
    const ean13 = gtin.slice(1)
    out.push(ean13)
    // Some files store the EAN-13 with its own leading zeros trimmed.
    const trimmed = ean13.replace(/^0+/, '')
    if (trimmed && trimmed.length >= 8 && trimmed !== ean13) out.push(trimmed)
  }
  return out
}

/* ── Lot capture mode ─────────────────────────────────────────────────────── */

/** How the till learns which lot a sale came from. See 234_lot_capture.sql. */
export type LotCaptureMode = 'fefo' | 'barcode' | 'prompt'

export type LotCapture = {
  mode: LotCaptureMode
  /** Refuse the line when no lot could be captured. Never true under 'fefo'. */
  strict: boolean
}

/**
 * Resolves the stored setting pair into the rule actually in force.
 *
 * Lives here — pure, no database — because BOTH tills need it and the offline
 * one has no connection to ask. The catalog feed ships the two raw values and
 * this turns them into a decision, so the online and offline tills cannot
 * interpret the same settings differently.
 *
 * ── WHY STRICT IS FORCED OFF UNDER FEFO ──────────────────────────────────
 *
 * Under 'fefo' nothing is captured, so nothing can fail to be captured — a
 * stored strict=1 there is a promise about an event that never occurs. Rather
 * than have `validateSetting` reach across keys (it validates one at a time,
 * and reading the other would put a database call inside a pure function and
 * still race a screen saving both), the pair is reconciled HERE, at the point
 * of use, which is the only place both values are known to be the ones in
 * force.
 */
export function lotCaptureFor(settings: {
  lot_capture_mode?: string | null
  lot_capture_strict?: string | null
}): LotCapture {
  const raw = settings.lot_capture_mode
  const mode: LotCaptureMode = raw === 'barcode' || raw === 'prompt' ? raw : 'fefo'
  return { mode, strict: mode !== 'fefo' && settings.lot_capture_strict === '1' }
}
