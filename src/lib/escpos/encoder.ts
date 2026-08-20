/**
 * ESC/POS, as bytes.
 *
 * Pure and dependency-free — runs in the browser (the till builds the job and
 * hands raw bytes to the local bridge) and in Node (the test suite pins every
 * sequence). Nothing here knows what a receipt is; layouts live in slips.ts.
 *
 * ── CODE PAGE ─────────────────────────────────────────────────────────────
 *
 * CP858 (ESC t 19): Latin-1-ish with the Euro — what accented product names
 * need. The rand is plain ASCII "R" (that is what formatMoney emits), so
 * money needs no code-page tricks. Anything unmappable prints "?" rather
 * than shifting the whole line one byte over, which is how a slip turns to
 * confetti.
 */

const ESC = 0x1b
const GS = 0x1d

/** CP858 high-half for the characters a SA product file actually holds. */
const CP858: Record<string, number> = {
  'é': 0x82, 'è': 0x8a, 'ê': 0x88, 'ë': 0x89,
  'á': 0xa0, 'à': 0x85, 'â': 0x83, 'ä': 0x84,
  'í': 0xa1, 'ì': 0x8d, 'î': 0x8c, 'ï': 0x8b,
  'ó': 0xa2, 'ò': 0x95, 'ô': 0x93, 'ö': 0x94,
  'ú': 0xa3, 'ù': 0x97, 'û': 0x96, 'ü': 0x81,
  'ç': 0x87, 'ñ': 0xa4, 'É': 0x90, 'Ä': 0x8e, 'Ö': 0x99, 'Ü': 0x9a,
  '°': 0xf8, '½': 0xab, '¼': 0xac, '×': 0x9e, '€': 0xd5,
  // Typographic marks the app's own copy uses — mapped to plain ASCII.
  '’': 0x27, '‘': 0x27, '“': 0x22, '”': 0x22, '—': 0x2d, '–': 0x2d, '…': 0x2e, '·': 0x2e,
  '−': 0x2d, '→': 0x3e,
}

export function encodeCp858(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    if (code >= 0x20 && code <= 0x7e) bytes[n++] = code
    else if (ch === '\n') bytes[n++] = 0x0a
    else if (CP858[ch] !== undefined) bytes[n++] = CP858[ch]
    else bytes[n++] = 0x3f // '?'
  }
  return bytes.slice(0, n)
}

/** A small byte builder. Every method returns `this`, so jobs read as prose. */
export class EscPos {
  private chunks: Uint8Array[] = []

  raw(...bytes: number[]): this {
    this.chunks.push(new Uint8Array(bytes))
    return this
  }

  /** ESC @ then the CP858 code page — the start of every job. */
  init(): this {
    return this.raw(ESC, 0x40).raw(ESC, 0x74, 19)
  }

  text(value: string): this {
    this.chunks.push(encodeCp858(value))
    return this
  }

  line(value = ''): this {
    return this.text(value).raw(0x0a)
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0)
  }

  align(where: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, where === 'left' ? 0 : where === 'center' ? 1 : 2)
  }

  /** GS ! — width/height multipliers, 1–8 each. size(1,1) is normal. */
  size(width: number, height: number): this {
    const w = Math.min(Math.max(width, 1), 8) - 1
    const h = Math.min(Math.max(height, 1), 8) - 1
    return this.raw(GS, 0x21, (w << 4) | h)
  }

  feed(lines: number): this {
    return this.raw(ESC, 0x64, Math.min(Math.max(lines, 0), 255))
  }

  /**
   * GS ( k — a QR code, encoded by the PRINTER.
   *
   * ── WHY THE HEAD DOES THE WORK ──────────────────────────────────────────
   *
   * A4 and PDF documents build their QR as pixels, from a module matrix (see
   * lib/stationery/qr). A thermal printer needs none of that: it takes the
   * payload as text and lays the modules down itself, at exactly its own dot
   * pitch. Sending a raster instead would be slower, coarser and larger, and it
   * would look worse than what the firmware produces.
   *
   * So this is the one place the QR never becomes an image.
   *
   * ── THE FOUR COMMANDS, IN ORDER ─────────────────────────────────────────
   *
   *   165 49  model — model 2, what every scanner made this century expects
   *   167 n   module size in dots; 3–8 is the useful range on 203dpi
   *   169 n   error correction: 48=L 49=M 50=Q 51=H
   *   180 48  store the payload
   *   181 48  print what was stored
   *
   * ── THE LENGTH IS THE TRAP ──────────────────────────────────────────────
   *
   * Every GS ( k command carries `pL pH` — its length as two bytes, LOW FIRST.
   * For the store command that length is the payload plus THREE (the two
   * function bytes and the mode byte), and a payload over 255 characters is the
   * only case where pH is not zero. Getting that split wrong prints nothing at
   * all, silently, and only on long payloads — which is precisely the case a
   * hand test never covers. The suite asserts it with a 300-byte payload.
   */
  qr(data: string, opts: { size?: number; ecc?: 'L' | 'M' | 'Q' | 'H' } = {}): this {
    /*
     * The payload is encoded as bytes BEFORE it is measured. A length counted
     * in JavaScript characters would be wrong for any non-ASCII payload, and
     * the printer would then read the tail of the URL as commands.
     */
    const bytes = encodeCp858(data)
    if (bytes.length === 0 || bytes.length > 7089) return this

    const size = Math.min(Math.max(Math.round(opts.size ?? 6), 1), 16)
    const ecc = { L: 48, M: 49, Q: 50, H: 51 }[opts.ecc ?? 'M']

    // Model 2.
    this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0)
    // Module size.
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 67, size)
    // Error correction.
    this.raw(GS, 0x28, 0x6b, 3, 0, 49, 69, ecc)

    // Store: the payload plus the three bytes that follow the length.
    const len = bytes.length + 3
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 49, 80, 48)
    this.chunks.push(bytes)

    // Print.
    return this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48)
  }

  /**
   * GS k 73 — a CODE128 barcode, drawn by the PRINTER.
   *
   * The same bargain the QR makes: the head has a barcode generator built in,
   * so sending the text costs a few dozen bytes where a raster would cost
   * thousands and look worse at 203dpi.
   *
   * ── FUNCTION B, BECAUSE FUNCTION A CANNOT SAY WHERE IT ENDS ─────────────
   *
   * `GS k m d1…dk NUL` (function A) terminates on a null byte and has no
   * length, so it cannot carry arbitrary data safely. Function B — `GS k 73 n
   * d1…dn` — states the length up front, which is both safer and the only form
   * that can encode the code-set selector below.
   *
   * ── THE {B PREFIX IS NOT OPTIONAL ──────────────────────────────────────
   *
   * CODE128 has three code sets and the data must say which it starts in. `{B`
   * (0x7b 0x42) selects Code B — the printable ASCII set — matching what
   * lib/labels/code128.ts emits for a document number. Without it the printer
   * either refuses the symbol or encodes something else entirely, and the
   * failure is a barcode that scans as the wrong thing rather than one that
   * does not scan at all.
   *
   * A literal `{` in the payload would therefore have to be doubled; a document
   * number never contains one, and the caller filters what it sends.
   */
  barcode(data: string, opts: { height?: number; width?: number } = {}): this {
    const bytes = encodeCp858(data)
    // n is one byte, and the {B prefix costs two of it.
    if (bytes.length === 0 || bytes.length > 253) return this

    const height = Math.min(Math.max(Math.round(opts.height ?? 60), 1), 255)
    const width = Math.min(Math.max(Math.round(opts.width ?? 2), 2), 6)

    this.raw(GS, 0x68, height) // GS h — bar height in dots
    this.raw(GS, 0x77, width) // GS w — module width
    // GS H 2 — print the digits under the bars, so a human can read it back
    // when a scanner will not.
    this.raw(GS, 0x48, 2)

    const payload = new Uint8Array(bytes.length + 2)
    payload[0] = 0x7b // {
    payload[1] = 0x42 // B
    payload.set(bytes, 2)

    this.raw(GS, 0x6b, 73, payload.length)
    this.chunks.push(payload)
    return this
  }

  /** GS V 66 — partial cut with feed, the one every 80mm thermal honours. */
  cut(): this {
    return this.raw(GS, 0x56, 66, 0)
  }

  /**
   * ESC p — the cash-drawer kick pulse. THE consumer of the tender flag
   * `opens_cash_drawer`: 50ms on, 500ms off, on the standard pin 2 (pin 0
   * here; pin 1 is the rare second drawer).
   */
  drawerKick(pin: 0 | 1 = 0): this {
    return this.raw(ESC, 0x70, pin, 25, 250)
  }

  build(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

/* ── Column arithmetic — the whole art of a slip ─────────────────────────── */

/** `left` padded, `right` flush against the last column. Truncates the left. */
export function twoCol(left: string, right: string, columns: number): string {
  const room = columns - right.length - 1
  const clipped = left.length > room ? left.slice(0, Math.max(room, 0)) : left
  return `${clipped.padEnd(Math.max(room, 0))} ${right}`
}

/** Wraps at word boundaries where it can, hard-breaks where it must. */
export function wrapText(value: string, columns: number): string[] {
  const out: string[] = []
  for (const raw of value.split('\n')) {
    let line = raw
    while (line.length > columns) {
      let cut = line.lastIndexOf(' ', columns)
      if (cut <= 0) cut = columns
      out.push(line.slice(0, cut))
      line = line.slice(cut).trimStart()
    }
    out.push(line)
  }
  return out
}
