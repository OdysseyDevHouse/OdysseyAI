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
