/**
 * CODE128, encoded by hand.
 *
 * No barcode dependency exists in this repo and none is being added for ~90
 * lines of table and checksum. Pure and client-safe, like barcodes.ts.
 *
 * Code Set B (ASCII 32–126) with a Code C optimisation for digit runs — the
 * standard trick that keeps an EAN-13 rendered as CODE128 half the width.
 */

/* The 107 module-width patterns, indexed by symbol value. Six digits each =
   bar,space,bar,space,bar,space widths; the stop pattern has seven. */
const WIDTHS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
] as const

const START_B = 104
const START_C = 105
const SWITCH_B = 100
const SWITCH_C = 99
const STOP = 106

/**
 * The symbol values for `text`, or null when a character cannot be encoded.
 * Digit runs of 4+ (6+ mid-string) switch to Code C, two digits per symbol.
 */
export function encodeCode128(text: string): number[] | null {
  if (!text) return null
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code > 126) return null
  }

  const symbols: number[] = []
  let mode: 'B' | 'C' | null = null
  let i = 0

  const digitRun = (from: number): number => {
    let n = 0
    while (from + n < text.length && text[from + n] >= '0' && text[from + n] <= '9') n++
    return n
  }

  while (i < text.length) {
    const run = digitRun(i)
    const worthC =
      run >= 6 || (run >= 4 && (i === 0 || i + run === text.length)) || (mode === 'C' && run >= 2)

    if (worthC && run >= 2) {
      const pairs = Math.floor(run / 2) * 2
      if (mode === null) symbols.push(START_C)
      else if (mode !== 'C') symbols.push(SWITCH_C)
      mode = 'C'
      for (let j = 0; j < pairs; j += 2) {
        symbols.push(Number(text.slice(i + j, i + j + 2)))
      }
      i += pairs
    } else {
      if (mode === null) symbols.push(START_B)
      else if (mode !== 'B') symbols.push(SWITCH_B)
      mode = 'B'
      symbols.push(text.charCodeAt(i) - 32)
      i += 1
    }
  }

  // The checksum: start value + Σ valueᵢ·positionᵢ, mod 103.
  let checksum = symbols[0]
  for (let p = 1; p < symbols.length; p++) checksum += symbols[p] * p
  symbols.push(checksum % 103)
  symbols.push(STOP)
  return symbols
}

export type BarcodeBar = { x: number; width: number }

/**
 * The bars, as x/width in MODULES, plus the total width including 10-module
 * quiet zones each side. Null when the text cannot be encoded.
 */
export function code128Bars(text: string): { bars: BarcodeBar[]; totalModules: number } | null {
  const symbols = encodeCode128(text)
  if (!symbols) return null

  const QUIET = 10
  const bars: BarcodeBar[] = []
  let x = QUIET
  for (const symbol of symbols) {
    const pattern = WIDTHS[symbol]
    for (let k = 0; k < pattern.length; k++) {
      const width = Number(pattern[k])
      if (k % 2 === 0) bars.push({ x, width })
      x += width
    }
  }
  // The stop pattern ends on a bar (odd count), so x already includes it.
  return { bars, totalModules: x + QUIET }
}
