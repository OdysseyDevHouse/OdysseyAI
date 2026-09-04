/**
 * MAKING a barcode, as opposed to reading one — pure, and deliberately not
 * `server-only`: the product screen generates a code in the browser and shows
 * it before anything is saved, so the maths has to run on both sides.
 *
 * `./barcodes` is the other half of this pair. It PARSES a scale label a
 * supplier's machine printed; this mints an in-store code for a product that
 * arrived without one — a loose line, a repacked item, anything a shop sells
 * that GS1 never issued a number for.
 */

/**
 * The prefixes a shop may mint under, most useful first.
 *
 * 20–29 is the RESERVED in-store range: GS1 guarantees it is never issued to a
 * manufacturer, so a code minted here can never collide with a real product's
 * barcode arriving on a delivery later. 60 leads because it is South Africa's
 * own GS1 prefix and it is what the shops coming off the legacy system have
 * always used — but it is a real, allocated range, so a 60 code is only safe
 * for a product that will never be bought in.
 */
export const BARCODE_PREFIXES = ['60', '29', '28', '27', '26', '25', '24', '23', '22', '21', '20']

/** True for the reserved range that can never clash with a supplier's code. */
export function isInStorePrefix(prefix: string): boolean {
  return /^2[0-9]$/.test(prefix)
}

/**
 * The 13th digit of an EAN-13, from the first twelve.
 *
 * Alternating weights of 1 and 3 from the left, then whatever is needed to
 * round the sum up to a multiple of ten. Every scanner in the shop recomputes
 * this and rejects the label if it disagrees, which is precisely why the
 * generator must not hand back a bare concatenation.
 */
export function ean13CheckDigit(twelve: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) {
    // Positions are counted from the left starting at 0, so the EVEN indices
    // are the odd-numbered digits and carry weight 1.
    sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3)
  }
  return (10 - (sum % 10)) % 10
}

export type GeneratedBarcode =
  | { ok: true; barcode: string }
  | { ok: false; error: string }

/**
 * Mint an EAN-13 from a prefix and a product code.
 *
 * The code is right-aligned and zero-padded into whatever the prefix leaves of
 * the first twelve digits, then the check digit is computed over the lot — so
 * prefix 60 and code 5159 give 6000000051599, which is what the legacy screen
 * produced and what the shop's existing labels already carry.
 *
 * Padding rather than truncating on overflow: a code too long to fit is a
 * refusal, not a silently different product. Two products whose codes differ
 * only in the digits that got cut would mint the SAME barcode, and the till
 * would ring up whichever one it found first — for as long as it took someone
 * to notice.
 */
export function generateEan13(prefix: string, productCode: string): GeneratedBarcode {
  const cleanPrefix = prefix.trim()
  if (!/^[0-9]{1,11}$/.test(cleanPrefix)) {
    return { ok: false, error: 'Pick a prefix.' }
  }

  // Digits only, and never the shop's letters: a stock code like "BR-100" is a
  // perfectly good product code and a meaningless barcode. Stripping is kinder
  // than refusing — the digits in it are what the user means.
  const digits = productCode.replace(/\D/g, '')
  if (!digits) return { ok: false, error: 'Type the product code — digits only.' }

  const room = 12 - cleanPrefix.length
  if (digits.length > room) {
    return {
      ok: false,
      error: `That code is ${digits.length} digits and only ${room} fit after the ${cleanPrefix} prefix.`,
    }
  }

  const twelve = cleanPrefix + digits.padStart(room, '0')
  return { ok: true, barcode: twelve + String(ean13CheckDigit(twelve)) }
}
