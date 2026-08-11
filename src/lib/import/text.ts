/**
 * Reading the text a spreadsheet actually contains.
 *
 * These primitives were written for the bank statement importer, where every
 * bank exports a different CSV and none of them can be told what shape they
 * are. That turned out to be the general case: a customer's product catalogue
 * or debtors list arrives in whatever shape the previous system emitted, and
 * the importer either sniffs it or refuses half the files it is given.
 *
 * They live here rather than in `bankImport.ts` because two importers with two
 * copies of `parseAmount` will disagree about `1,234` within a month, and the
 * one that disagrees quietly is the one that posts the wrong number.
 *
 * Deliberately NOT `server-only`: the import wizard runs these in the browser
 * to preview a file before anything is sent, and again on the server before
 * anything is written. Being able to run the identical function on both sides
 * is what makes that re-check meaningful rather than theatre.
 */

/**
 * Splits one CSV line, honouring quotes.
 *
 * Descriptions contain commas constantly ('PAYMENT TO SMITH, T', 'Smith, T
 * (Pty) Ltd'), so a naive split on ',' shifts every later column on those rows
 * — which shows up as a date in the amount field, or worse, an amount that
 * parses but is wrong.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      out.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  out.push(current.trim())
  return out
}

/** Semicolon and tab exports exist. Picks whichever appears most in the header. */
export function sniffDelimiter(line: string): string {
  const counts = [
    { d: ',', n: (line.match(/,/g) ?? []).length },
    { d: ';', n: (line.match(/;/g) ?? []).length },
    { d: '\t', n: (line.match(/\t/g) ?? []).length },
  ].sort((a, b) => b.n - a.n)
  return counts[0].n > 0 ? counts[0].d : ','
}

/**
 * Reduces a heading to something two spellings of it agree on.
 *
 * 'Product Code', 'product_code' and 'PRODUCT CODE ' are one column with three
 * spellings, and a header map that treats them as three is a map that silently
 * drops two of them.
 */
export function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Parses a date without guessing between ambiguous formats.
 *
 * 03/04/2026 is 3 April in South Africa and 4 March in the United States, and
 * no amount of cleverness resolves that from one row. So the format is decided
 * once for the whole file by looking for a day > 12 somewhere in it — the only
 * unambiguous evidence available — and defaulting to day-first, which is what
 * every South African system exports.
 */
export function detectDateFormat(samples: readonly string[]): string | null {
  let sawIso = false
  let dayFirstProof = false
  let monthFirstProof = false

  for (const raw of samples) {
    const value = raw.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      sawIso = true
      continue
    }
    const parts = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
    if (!parts) continue
    const first = Number(parts[1])
    const second = Number(parts[2])
    if (first > 12) dayFirstProof = true
    if (second > 12) monthFirstProof = true
  }

  if (sawIso && !dayFirstProof && !monthFirstProof) return 'yyyy-mm-dd'
  if (monthFirstProof && !dayFirstProof) return 'mm/dd/yyyy'
  return 'dd/mm/yyyy'
}

export function parseDate(value: string, format: string | null): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`

  // '15 Mar 2026' and '15-Mar-26' both appear in the wild.
  const named = trimmed.match(/^(\d{1,2})[\s/.-]([A-Za-z]{3,})[\s/.-](\d{2,4})/)
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (month) return `${expandYear(named[3])}-${month}-${pad(named[1])}`
  }

  const numeric = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (numeric) {
    const [, a, b, y] = numeric
    const day = format === 'mm/dd/yyyy' ? b : a
    const month = format === 'mm/dd/yyyy' ? a : b
    if (Number(month) < 1 || Number(month) > 12) return null
    if (Number(day) < 1 || Number(day) > 31) return null
    return `${expandYear(y)}-${pad(month)}-${pad(day)}`
  }

  return null
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

function pad(value: string | number): string {
  return String(value).padStart(2, '0')
}

/** Two-digit years: 70-99 are 1900s, everything else 2000s. */
function expandYear(value: string): string {
  if (value.length === 4) return value
  const n = Number(value)
  return n >= 70 ? `19${pad(n)}` : `20${pad(n)}`
}

/**
 * Parses an amount the way people write them.
 *
 * Handles thousands separators, a trailing minus ('1234.56-' from older
 * systems), parenthesised negatives, and currency symbols. Comma-as-decimal is
 * deliberately NOT guessed at globally: '1,234' is a thousand-something in one
 * locale and 1.234 in another. It is treated as a decimal separator only when
 * the string has no dot AND exactly two digits follow the last comma, which is
 * the one case that cannot mean thousands.
 */
export function parseAmount(value: string): number | null {
  let text = value.trim().replace(/[R$€£\s]/g, '')
  if (!text) return null

  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  if (text.endsWith('-')) {
    negative = true
    text = text.slice(0, -1)
  }
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1)
  }
  if (text.startsWith('+')) text = text.slice(1)

  // Comma is the decimal separator when two digits follow the LAST comma and
  // that comma sits after any dot — '1.234.567,89' and '1234,56'. Otherwise
  // commas are thousands separators and the dot is decimal. Deciding by
  // position rather than by presence is what tells the two apart.
  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  if (lastComma > lastDot && /,\d{2}$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else {
    text = text.replace(/,/g, '')
  }

  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null

  const amount = Number(text)
  if (!Number.isFinite(amount)) return null
  return negative ? -amount : amount
}

/**
 * Reads a spreadsheet's idea of true and false.
 *
 * Excel writes TRUE/FALSE, an exported system writes 1/0, and a person typing
 * the column by hand writes Yes/Y/y. An unrecognised value returns null rather
 * than falling back to false, because 'Visible in POS: maybe' silently becoming
 * 'no' hides products from the till with nothing on screen to explain it.
 */
export function parseBool(value: string): boolean | null {
  const text = value.trim().toLowerCase()
  if (!text) return null
  if (['true', 'yes', 'y', '1', 't'].includes(text)) return true
  if (['false', 'no', 'n', '0', 'f'].includes(text)) return false
  return null
}
